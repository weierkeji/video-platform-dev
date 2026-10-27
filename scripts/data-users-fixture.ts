import { createHash } from 'node:crypto';
import { skinFixture } from './skin-fixture';
import { pngPixels } from './texture-fixture';
import { duplicateHierarchy, HierarchyCopySchema } from '../src/core/hierarchy-copy';
import { id, parseProject, textureBinding } from '../src/core/model';

/** Original linked sculptures, including a hidden user in a separate scene. */
export function dataUsersFixture() {
  const f = skinFixture(),
    p = f.p;
  p.name = '共享数据与独立造型';
  p.scenes[0].name = '共享造型';
  const mesh = p.entities.find((e) => e.id === f.meshId)!,
    geometry = p.geometries.find((g) => g.id === mesh.geometryId)!;
  mesh.name = '左侧造型';
  geometry.uv = geometry.positions.map(([x, y]) => [(x + 0.3) / 0.6, y / 2.4]);
  geometry.uv1 = geometry.uv.map(([u, v]) => [1 - u, v]);
  const pixels = pngPixels(16, 16, (x, y) =>
    (Math.floor(x / 4) + Math.floor(y / 4)) % 2 ? [235, 235, 235, 255] : [125, 145, 155, 255],
  );
  const asset = {
    id: id(),
    name: '原创方格.png',
    kind: 'image' as const,
    mime: 'image/png' as const,
    blobId: createHash('sha256').update(pixels).digest('hex'),
    bytes: pixels.length,
    width: 16,
    height: 16,
  };
  p.assets.push(asset);
  p.materials.find((m) => m.id === mesh.materialId)!.textures = {
    baseColor: textureBinding(asset.id),
  };
  const clone = () =>
    duplicateHierarchy(
      p,
      HierarchyCopySchema.parse({
        type: 'entities.duplicate',
        batchId: id(),
        entityIds: [f.root],
        geometry: 'linked',
        materials: 'linked',
      }),
    );
  const second = clone(),
    rightId = second.map.get(f.meshId)!;
  p.entities.find((e) => e.id === second.map.get(f.root))!.transform.position[0] += 2.2;
  p.entities.find((e) => e.id === rightId)!.name = '右侧造型';
  const third = clone(),
    foreignSceneId = id(),
    foreignId = third.map.get(f.meshId)!;
  p.scenes.push({ id: foreignSceneId, name: '其他场景', background: '#182330', ambient: 0.4 });
  for (const key of third.map.values()) {
    const e = p.entities.find((e) => e.id === key);
    if (e) e.sceneId = foreignSceneId;
  }
  p.entities.find((e) => e.id === foreignId)!.name = '隐藏共享用户';
  p.entities.find((e) => e.id === foreignId)!.visible = false;
  const camera = p.entities.find((e) => e.kind === 'camera')!;
  camera.transform.position = [6, 4.3, 9];
  camera.transform.rotation = [-Math.atan2(3.2, 9), Math.atan2(5.3, Math.hypot(3.2, 9)), 0];
  return {
    ...f,
    p: parseProject(p),
    rightId,
    foreignId,
    foreignSceneId,
    geometryId: geometry.id,
    materialId: mesh.materialId!,
    assetId: asset.id,
    pixels,
    blobs: [{ id: asset.blobId, mime: asset.mime, base64: pixels.toString('base64') }],
  };
}
