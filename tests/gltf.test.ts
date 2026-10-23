import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { Mesh, Matrix4, Vector3, Quaternion, Euler } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { validateBytes } from 'gltf-validator';
import { gltfFixture } from '../scripts/gltf-fixture';
import { importGLTF, exportGLB, unpackGLTF } from '../src/core/gltf';
import { applyCommands } from '../src/core/commands';
import { newProject } from '../src/core/factory';
import { parseProject, migrateProject, PROJECT_VERSION } from '../src/core/model';
import { surfaceGeometry, surfaceMaterial } from '../src/core/surface';
import { MeshOverlay } from '../src/render/mesh-edit';
import { Store } from '../server/store';
const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const imported = async () => {
  const result = await importGLTF(encode(gltfFixture()));
  return { ...result, project: applyCommands(newProject(), [result.command]).project };
};

test('glTF import preserves instancing, hierarchy, interleaved attributes, linear material and lights', async () => {
  const { command, project, defaultSceneId } = await imported();
  assert.equal(command.scenes.length, 2);
  assert.equal(command.geometries.length, 1);
  const meshes = command.entities.filter((e) => e.kind === 'mesh');
  assert.equal(meshes.length, 4);
  assert.equal(new Set(meshes.map((e) => e.geometryId)).size, 1);
  assert.equal(new Set(meshes.map((e) => e.parentId)).size, 2);
  assert.equal(command.geometries[0].uv?.length, 6);
  assert.deepEqual(command.materials[0].linearColor, [0.72, 0.18, 0.04321]);
  assert.equal(command.materials[0].opacity, 0.7);
  assert.equal(
    command.entities.find((e) => e.name === 'Imported sun')?.light?.direction,
    'local-negative-z',
  );
  assert.equal(command.scenes[0].id, defaultSceneId);
  assert.ok(command.scenes[0].source?.copyright?.includes('MIT'));
  parseProject(project);
});
test('GLB static snapshot is readable by independent Three loader and round-trips shared geometry', async () => {
  const { project, defaultSceneId, command } = await imported();
  const glb = exportGLB(project, defaultSceneId, 0);
  const validation = await validateBytes(glb.bytes);
  assert.equal(validation.issues.numErrors, 0, JSON.stringify(validation.issues));
  assert.equal(validation.issues.numWarnings, 0, JSON.stringify(validation.issues));
  const loaded = await new GLTFLoader().parseAsync(glb.bytes.buffer, '');
  const mesh = loaded.scene.getObjectByName('First_instance') as Mesh;
  assert.ok(mesh?.isMesh);
  assert.equal(mesh.geometry.getAttribute('position').count, 6);
  const result = await importGLTF(glb.bytes);
  assert.deepEqual(result.command.geometries[0].positions, command.geometries[0].positions);
  assert.deepEqual(result.command.geometries[0].normals, command.geometries[0].normals);
  assert.deepEqual(result.command.geometries[0].uv, command.geometries[0].uv);
  assert.equal(result.command.geometries.length, 1);
  assert.deepEqual(result.command.materials[0].linearColor, command.materials[0].linearColor);
  assert.equal(result.command.scenes[0].source?.copyright, command.scenes[0].source?.copyright);
  loaded.scene.traverse((o) => {
    if (o instanceof Mesh) {
      o.geometry.dispose();
      for (const m of Array.isArray(o.material) ? o.material : [o.material]) m.dispose();
    }
  });
});
test('glTF sparse positions, matrix TRS, unindexed fans and normalized UV accessors are decoded', async () => {
  const bytes = new Uint8Array(64),
    view = new DataView(bytes.buffer);
  bytes.set([0, 1, 2], 0);
  [0, 0, 0, 1, 0, 0, 0, 1, 0].forEach((n, i) => view.setFloat32(4 + i * 4, n, true));
  [0, 0, 65535, 0, 0, 65535].forEach((n, i) => view.setUint16(40 + i * 2, n, true));
  const matrix = new Matrix4().compose(
    new Vector3(2, 3, 4),
    new Quaternion().setFromEuler(new Euler(0.3, 0.7, -0.2)),
    new Vector3(-2, 3, 1),
  );
  const data = {
    asset: { version: '2.0' },
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0, matrix: matrix.toArray() }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0, TEXCOORD_0: 1 }, mode: 6 }] }],
    buffers: [{ byteLength: bytes.length, uri: 'sparse.bin' }],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: 3 },
      { buffer: 0, byteOffset: 4, byteLength: 36 },
      { buffer: 0, byteOffset: 40, byteLength: 12 },
    ],
    accessors: [
      {
        componentType: 5126,
        count: 3,
        type: 'VEC3',
        sparse: {
          count: 3,
          indices: { bufferView: 0, componentType: 5121 },
          values: { bufferView: 1 },
        },
      },
      { componentType: 5123, normalized: true, count: 3, type: 'VEC2', bufferView: 2 },
    ],
  };
  const result = await importGLTF(encode(data), [{ name: 'sparse.bin', bytes }]);
  assert.deepEqual(result.command.geometries[0].triangles, [[0, 1, 2]]);
  assert.deepEqual(result.command.geometries[0].uv, [
    [0, 0],
    [1, 0],
    [0, 1],
  ]);
  const t = result.command.entities[0].transform;
  const reconstructed = new Matrix4().compose(
    new Vector3(...t.position),
    new Quaternion().setFromEuler(new Euler(...t.rotation, 'XYZ')),
    new Vector3(...t.scale),
  );
  matrix.elements.forEach((v, i) => assert.ok(Math.abs(v - reconstructed.elements[i]) < 1e-6));
});
test('malformed buffers, hierarchy, unsupported content and external URLs fail before mutations', async () => {
  const original = newProject();
  for (const change of [
    (d: any) => (d.bufferViews[0].byteLength = 16),
    (d: any) => d.nodes[0].children.push(0),
    (d: any) => d.nodes[0].children.push(1),
    (d: any) => (d.animations = [{}]),
    (d: any) => (d.materials[0].pbrMetallicRoughness.baseColorTexture = { index: 0 }),
    (d: any) => (d.extensionsRequired = ['KHR_draco_mesh_compression']),
    (d: any) => (d.buffers[0].uri = 'https://example.invalid/a.bin'),
    (d: any) => (d.buffers[0].uri = '../a.bin'),
    (d: any) => (d.meshes[0].primitives[0].attributes.COLOR_0 = 1),
    (d: any) => (d.accessors[0].count = 600001),
    (d: any) => (d.nodes[0] = { matrix: [1, 0, 0, 0, 0.5, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] }),
  ]) {
    const d = gltfFixture();
    change(d);
    await assert.rejects(() => importGLTF(encode(d)));
  }
  const result = await imported();
  const corrupt = structuredClone(result.command);
  corrupt.entities[1].parentId = original.entities[0].id;
  assert.throws(() => applyCommands(original, [corrupt]));
  assert.equal(original.scenes.length, 1);
  const glb = exportGLB(result.project, result.defaultSceneId, 0).bytes;
  await assert.rejects(() => importGLTF(glb.subarray(0, glb.length - 1)), /长度/);
  new DataView(glb.buffer).setUint32(12, 0xfffffffc, true);
  assert.throws(() => unpackGLTF(glb), /块长度/);
});
test('geometry edits preserve UV mappings, invalidate normals and undo restores original attributes', async () => {
  const { project, command } = await imported(),
    g = command.geometries[0];
  const moved = applyCommands(project, [
    { type: 'geometry.vertex', id: g.id, index: 0, position: [1.2, 0, 0] },
  ]).project;
  assert.equal(moved.geometries.find((x) => x.id === g.id)?.normals, undefined);
  const subdivided = applyCommands(project, [
    { type: 'geometry.subdivide', id: g.id },
  ]).project.geometries.find((x) => x.id === g.id)!;
  assert.equal(subdivided.uv?.length, subdivided.positions.length);
  assert.equal(subdivided.normals, undefined);
  const extruded = applyCommands(project, [
    { type: 'geometry.extrudeRegion', id: g.id, faces: [0], offset: [0, 0.3, 0] },
  ]).project.geometries.find((x) => x.id === g.id)!;
  assert.equal(extruded.uv?.length, extruded.positions.length);
  assert.deepEqual(extruded.uv?.[6], g.uv?.[0]);
  const merged = applyCommands(project, [
    { type: 'geometry.merge', id: g.id, indices: [0, 1] },
  ]).project.geometries.find((x) => x.id === g.id)!;
  assert.equal(merged.uv?.length, merged.positions.length);
  assert.deepEqual(merged.uv?.[0], g.uv?.[0]);
  const deleted = applyCommands(project, [
    { type: 'geometry.delete', id: g.id, mode: 'vertex', indices: [0] },
  ]).project.geometries.find((x) => x.id === g.id)!;
  assert.deepEqual(deleted.uv, g.uv?.slice(1));
  const mesh = new Mesh(surfaceGeometry(g), surfaceMaterial(command.materials[0]));
  const overlay = new MeshOverlay(
    g,
    mesh,
    { entityId: '', geometryId: g.id, mode: 'vertex', indices: [0] },
    false,
  );
  const copy = structuredClone(g.positions);
  copy[0][0] += 1;
  overlay.preview(copy);
  overlay.preview(structuredClone(g.positions), true);
  assert.deepEqual(Array.from(mesh.geometry.getAttribute('normal').array), g.normals!.flat());
  overlay.dispose();
  mesh.geometry.dispose();
  mesh.material.dispose();
});
test('scene import is one persisted undo unit and v5 migration preserves optional-field defaults', async () => {
  const root = resolve(tmpdir()),
    dir = mkdtempSync(join(root, 'frameforge-gltf-'));
  let store = new Store(dir);
  try {
    const p = newProject(),
      command = (await imported()).command;
    assert.deepEqual(migrateProject({ ...p, schemaVersion: 5 }), p);
    assert.equal(p.schemaVersion, PROJECT_VERSION);
    store.create(p);
    const saved = store.change(p.id, 0, [command], 'user', 'glTF import').project;
    store.close();
    store = new Store(dir);
    assert.deepEqual(store.get(p.id).project, saved);
    assert.equal(store.change(p.id, 1, undefined, 'user', 'undo', 'undo').project.scenes.length, 1);
    assert.deepEqual(
      store.change(p.id, 2, undefined, 'user', 'redo', 'redo').project.geometries,
      saved.geometries,
    );
  } finally {
    store.close();
    assert.ok(resolve(dir).startsWith(root + sep));
    rmSync(dir, { recursive: true, force: true });
  }
});
test('export evaluates animation at the requested frame and preserves legacy flat material defaults', async () => {
  let p = newProject();
  const e = p.entities.find((e) => e.kind === 'mesh')!;
  p = applyCommands(p, [
    { type: 'key.set', entityId: e.id, property: 'position', key: { frame: 0, value: [0, 1, 0] } },
    { type: 'key.set', entityId: e.id, property: 'position', key: { frame: 20, value: [4, 1, 0] } },
  ]).project;
  const result = await importGLTF(exportGLB(p, e.sceneId, 5).bytes);
  const out = result.command.entities.find((x) => x.name === e.name)!;
  assert.deepEqual(out.transform.position, [1, 1, 0]);
  assert.equal(result.command.geometries[0].positions.length, 36);
  assert.equal(result.command.materials[0].doubleSided, true);
  assert.equal(surfaceMaterial(p.materials[0]).flatShading, true);
  const validation = await validateBytes(exportGLB(p, e.sceneId, 5).bytes);
  assert.equal(validation.issues.numErrors, 0, JSON.stringify(validation.issues));
});
