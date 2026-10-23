import test from 'node:test';
import assert from 'node:assert/strict';
import {
  Texture,
  SRGBColorSpace,
  NoColorSpace,
  Vector3,
  RepeatWrapping,
  MirroredRepeatWrapping,
  NearestFilter,
} from 'three';
import { validateBytes } from 'gltf-validator';
import { pngPixels, textureFixture } from '../scripts/texture-fixture';
import { imageInfo, checkedImage, sha256 } from '../src/core/image';
import { importGLTF, exportGLB, exportGLBWithAssets } from '../src/core/gltf';
import { textureBinding, textureSlots, migrateProject } from '../src/core/model';
import { applyCommands } from '../src/core/commands';
import { newProject } from '../src/core/factory';
import { projectUV, primitive } from '../src/core/geometry';
import { configureTexture, textureMatrix } from '../src/render/textures';
const encode = (v: unknown) => new TextEncoder().encode(JSON.stringify(v));
const sample = async () => {
  const fixture = textureFixture(),
    result = await importGLTF(encode(fixture.document), fixture.files);
  return { ...result, project: applyCommands(newProject(), [result.command]).project };
};
test('image headers, hashes and allocation limits are checked before texture decoding', async () => {
  const bytes = pngPixels(4, 2, () => [40, 70, 200, 255]);
  assert.deepEqual(imageInfo(bytes), { mime: 'image/png', width: 4, height: 2 });
  const asset = {
    id: 'image',
    name: 'image',
    kind: 'image' as const,
    mime: 'image/png' as const,
    bytes: bytes.length,
    blobId: await sha256(bytes),
  };
  await checkedImage(bytes, asset);
  await assert.rejects(() => checkedImage(bytes, { ...asset, blobId: '0'.repeat(64) }), /哈希/);
  assert.throws(() => imageInfo(bytes.subarray(0, 35)), /PNG/);
  const large = Buffer.from(bytes);
  large.writeUInt32BE(9000, 16);
  assert.throws(() => imageInfo(large), /尺寸/);
});
test('five PBR maps share image assets while retaining UV sets, sampler modes and tangent basis', async () => {
  const { command, images, project } = await sample();
  assert.equal(images.length, 2);
  assert.equal(command.assets?.length, 2);
  assert.equal(command.geometries[0].uv1?.length, 4);
  assert.equal(command.geometries[0].tangents?.[0][3], -1);
  const m = command.materials[0];
  assert.deepEqual(Object.keys(m.textures!).sort(), [...textureSlots].sort());
  assert.equal(m.textures?.occlusion?.texCoord, 1);
  assert.equal(m.textures?.baseColor?.wrapT, 'mirror');
  assert.equal(m.textures?.baseColor?.assetId, m.textures?.emissive?.assetId);
  assert.equal(m.normalScale, 0.2);
  assert.equal(m.occlusionStrength, 0.3);
  assert.throws(
    () => applyCommands(project, [{ type: 'asset.delete', id: images[0].asset.id }]),
    /材质/,
  );
  const binding = { ...m.textures!.baseColor!, assetId: 'missing' };
  assert.throws(
    () =>
      applyCommands(project, [
        { type: 'material.update', id: m.id, patch: { textures: { baseColor: binding } } },
      ]),
    /图片素材/,
  );
});
test('GLB carries original image bytes and PBR texture references through independent validation and reimport', async () => {
  const { project, command, images, defaultSceneId } = await sample();
  const output = await exportGLBWithAssets(
    project,
    defaultSceneId,
    0,
    async (asset) => images.find((i) => i.asset.id === asset.id)!.bytes,
  );
  const report = await validateBytes(output.bytes);
  assert.equal(report.issues.numErrors, 0, JSON.stringify(report.issues));
  assert.equal(report.issues.numWarnings, 0, JSON.stringify(report.issues));
  const next = await importGLTF(output.bytes);
  assert.deepEqual(
    next.images.map((i) => i.asset.blobId),
    images.map((i) => i.asset.blobId),
  );
  next.images.forEach((i, n) =>
    assert.deepEqual(Buffer.from(i.bytes), Buffer.from(images[n].bytes)),
  );
  assert.deepEqual(next.command.geometries[0].uv1, command.geometries[0].uv1);
  assert.deepEqual(next.command.geometries[0].tangents, command.geometries[0].tangents);
  for (const slot of textureSlots)
    assert.deepEqual(
      { ...next.command.materials[0].textures![slot], assetId: '' },
      { ...command.materials[0].textures![slot], assetId: '' },
    );
  assert.throws(() => exportGLB(project, defaultSceneId, 0), /原始字节/);
});
test('texture color spaces and explicit offset-rotation-scale matrix follow slot semantics', () => {
  const b = textureBinding('asset');
  b.wrapT = 'mirror';
  b.magFilter = 'nearest';
  b.rotation = Math.PI / 2;
  b.scale = [2, 0.5];
  b.offset = [0.1, 0.2];
  const uv = new Vector3(0.2, 0.4, 1).applyMatrix3(textureMatrix(b));
  assert.ok(Math.abs(uv.x + 0.1) < 1e-12);
  assert.ok(Math.abs(uv.y - 0.6) < 1e-12);
  const color = configureTexture(new Texture(), b, true),
    data = configureTexture(new Texture(), b, false);
  assert.equal(color.colorSpace, SRGBColorSpace);
  assert.equal(data.colorSpace, NoColorSpace);
  assert.equal(color.flipY, false);
  assert.equal(color.wrapS, RepeatWrapping);
  assert.equal(color.wrapT, MirroredRepeatWrapping);
  assert.equal(color.magFilter, NearestFilter);
  assert.equal(color.matrixAutoUpdate, false);
  color.dispose();
  data.dispose();
});
test('box UV projection preserves the actual triangles, propagates both UV sets and is atomic', async () => {
  const g = primitive('box'),
    original = structuredClone(g);
  projectUV(g, 0);
  projectUV(g, 1);
  assert.deepEqual(
    g.triangles.map((t) => t.map((i) => g.positions[i])),
    original.triangles.map((t) => t.map((i) => original.positions[i])),
  );
  assert.equal(g.uv?.length, g.positions.length);
  assert.equal(g.uv1?.length, g.positions.length);
  const { project, command } = await sample(),
    target = command.geometries[0];
  const edited = applyCommands(project, [
    { type: 'geometry.subdivide', id: target.id },
  ]).project.geometries.find((g) => g.id === target.id)!;
  assert.equal(edited.uv?.length, edited.positions.length);
  assert.equal(edited.uv1?.length, edited.positions.length);
  assert.equal(edited.tangents, undefined);
  assert.ok(target.tangents);
  const missing = newProject(),
    material = missing.materials[0];
  assert.throws(
    () =>
      applyCommands(missing, [
        { type: 'asset.add', asset: command.assets![0] },
        {
          type: 'material.update',
          id: material.id,
          patch: { textures: { baseColor: textureBinding(command.assets![0].id) } },
        },
      ]),
    /UV0/,
  );
  assert.equal(missing.assets.length, 0);
  assert.deepEqual(migrateProject({ ...missing, schemaVersion: 6 }), missing);
});
test('KHR texture transform and embedded image URI preserve values while bad paths and MIME fail', async () => {
  const { document, files } = textureFixture();
  const info = document.materials[0].pbrMetallicRoughness.baseColorTexture as Record<
    string,
    unknown
  >;
  info.extensions = {
    KHR_texture_transform: { offset: [0.1, 0.4], scale: [2, 0.3], rotation: 0.7, texCoord: 1 },
  };
  document.extensionsUsed.push('KHR_texture_transform');
  document.images[0].uri =
    'data:image/png;base64,' + Buffer.from(files[1].bytes).toString('base64');
  const result = await importGLTF(encode(document), files),
    binding = result.command.materials[0].textures!.baseColor!;
  assert.deepEqual(binding.offset, [0.1, 0.4]);
  assert.deepEqual(binding.scale, [2, 0.3]);
  assert.equal(binding.rotation, 0.7);
  assert.equal(binding.texCoord, 1);
  const project = applyCommands(newProject(), [result.command]).project;
  const glb = exportGLB(
    project,
    result.defaultSceneId,
    0,
    new Map(result.images.map((i) => [i.asset.id, i.bytes])),
  );
  assert.equal((await validateBytes(glb.bytes)).issues.numErrors, 0);
  assert.equal(
    (await importGLTF(glb.bytes)).command.materials[0].textures!.baseColor!.rotation,
    0.7,
  );
  document.images[0].uri = 'https://example.invalid/texture.png';
  await assert.rejects(() => importGLTF(encode(document), files), /相对路径/);
  document.images[0].uri = 'color.png';
  document.images[0].mimeType = 'image/jpeg';
  await assert.rejects(() => importGLTF(encode(document), files), /MIME/);
  delete (document.images[0] as { mimeType?: string }).mimeType;
  document.images[0].uri =
    'data:image/jpeg;base64,' + Buffer.from(files[1].bytes).toString('base64');
  await assert.rejects(() => importGLTF(encode(document), files), /MIME/);
  project.entities
    .filter((e) => e.sceneId === result.defaultSceneId && e.kind === 'mesh')
    .forEach((e) => {
      e.visible = false;
    });
  let loads = 0;
  const hidden = await exportGLBWithAssets(project, result.defaultSceneId, 0, async () => {
    loads++;
    throw new Error('hidden image must not load');
  });
  assert.equal(loads, 0);
  assert.equal((await validateBytes(hidden.bytes)).issues.numErrors, 0);
  project.entities
    .filter((e) => e.sceneId === result.defaultSceneId && e.kind === 'mesh')
    .forEach((e) => {
      e.visible = true;
      project.geometries.find((g) => g.id === e.geometryId)!.triangles = [];
    });
  await exportGLBWithAssets(project, result.defaultSceneId, 0, async () => {
    throw new Error('empty mesh image must not load');
  });
});
