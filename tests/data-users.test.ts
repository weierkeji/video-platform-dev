import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join, sep } from 'node:path';
import { validateBytes } from 'gltf-validator';
import { dataUsersFixture } from '../scripts/data-users-fixture';
import { applyCommands } from '../src/core/commands';
import { dataUsers, DataIsolationSchema, planDataIsolation } from '../src/core/data-users';
import { id } from '../src/core/model';
import { sceneEvaluator } from '../src/core/constraints';
import { deformGeometry } from '../src/core/skin';
import { exportGLB, importGLTF } from '../src/core/gltf';
import { Store } from '../server/store';

const command = (entityIds: string[], extra = {}) =>
  DataIsolationSchema.parse({
    type: 'entities.data.isolate',
    entityIds,
    resources: ['geometry', 'material'],
    mode: 'individual',
    batchId: id(),
    ...extra,
  });

test('users include hidden cross-scene entities and grouped isolation keeps only the selected internal links', () => {
  const f = dataUsersFixture(),
    before = structuredClone(f.p);
  assert.deepEqual(
    dataUsers(f.p, 'geometry', f.geometryId).map((e) => e.id),
    [f.meshId, f.rightId, f.foreignId],
  );
  const p = applyCommands(f.p, [command([f.meshId, f.rightId], { mode: 'selection' })]).project;
  const left = p.entities.find((e) => e.id === f.meshId)!,
    right = p.entities.find((e) => e.id === f.rightId)!,
    foreign = p.entities.find((e) => e.id === f.foreignId)!;
  assert.equal(left.geometryId, right.geometryId);
  assert.equal(left.materialId, right.materialId);
  assert.notEqual(left.geometryId, f.geometryId);
  assert.notEqual(left.materialId, f.materialId);
  assert.equal(foreign.geometryId, f.geometryId);
  assert.equal(foreign.materialId, f.materialId);
  assert.equal(p.geometries.length, before.geometries.length + 1);
  assert.equal(p.materials.length, before.materials.length + 1);
  assert.deepEqual(f.p, before);
  assert.throws(
    () => applyCommands(p, [command([f.meshId, f.rightId], { mode: 'selection' })]),
    /已经满足/,
  );
});

test('individual isolation of every user leaves one original owner and no new orphan data', () => {
  const f = dataUsersFixture(),
    ids = [f.meshId, f.rightId, f.foreignId];
  const p = applyCommands(f.p, [command(ids)]).project;
  assert.equal(p.geometries.length, f.p.geometries.length + 2);
  assert.equal(p.materials.length, f.p.materials.length + 2);
  assert.equal(p.entities.find((e) => e.id === f.meshId)!.geometryId, f.geometryId);
  for (const key of ids) {
    const e = p.entities.find((e) => e.id === key)!;
    assert.equal(dataUsers(p, 'geometry', e.geometryId!).length, 1);
    assert.equal(dataUsers(p, 'material', e.materialId!).length, 1);
  }
  assert.ok(p.geometries.every((g) => dataUsers(p, 'geometry', g.id).length));
  assert.ok(p.materials.every((m) => dataUsers(p, 'material', m.id).length));
  assert.throws(() => applyCommands(p, [command(ids)]), /已经满足/);
});

test('isolation preserves raw geometry, both UV sets, weights, binding and all sampled skin poses', () => {
  const f = dataUsersFixture(),
    p = applyCommands(f.p, [command([f.rightId])]).project;
  const before = f.p.entities.find((e) => e.id === f.rightId)!,
    after = p.entities.find((e) => e.id === f.rightId)!;
  const source = f.p.geometries.find((g) => g.id === before.geometryId)!,
    target = p.geometries.find((g) => g.id === after.geometryId)!;
  assert.deepEqual({ ...target, id: source.id, name: source.name }, source);
  assert.deepEqual(after.skin, before.skin);
  assert.deepEqual(p.animationTracks, f.p.animationTracks);
  assert.deepEqual(p.assets, f.p.assets);
  const oldMaterial = f.p.materials.find((m) => m.id === before.materialId)!,
    material = p.materials.find((m) => m.id === after.materialId)!;
  assert.deepEqual({ ...material, id: oldMaterial.id, name: oldMaterial.name }, oldMaterial);
  assert.equal(material.textures!.baseColor!.assetId, f.assetId);
  for (const frame of [0, 7.5, 12, 24, 47]) {
    const a = deformGeometry(source, before.skin!, sceneEvaluator(f.p, f.sceneId)(frame).world);
    const b = deformGeometry(target, after.skin!, sceneEvaluator(p, f.sceneId)(frame).world);
    assert.deepEqual({ ...b, id: a.id, name: a.name }, a);
  }
});

test('geometry, weight and material edits affect shared users until their selected data is isolated', () => {
  const f = dataUsersFixture(),
    originalGeometry = f.p.geometries.find((g) => g.id === f.geometryId)!;
  const shared = applyCommands(f.p, [
    { type: 'geometry.vertex', id: f.geometryId, index: 0, position: [-0.8, 0, -0.22] },
  ]).project;
  assert.equal(shared.entities.find((e) => e.id === f.rightId)!.geometryId, f.geometryId);
  assert.equal(shared.entities.find((e) => e.id === f.foreignId)!.geometryId, f.geometryId);
  let p = applyCommands(f.p, [command([f.rightId])]).project;
  const right = p.entities.find((e) => e.id === f.rightId)!;
  p = applyCommands(p, [
    { type: 'geometry.vertex', id: right.geometryId!, index: 0, position: [-0.8, 0, -0.22] },
    { type: 'skin.weights', entityId: right.id, indices: [1], weights: [{ joint: 1, weight: 1 }] },
    { type: 'material.update', id: right.materialId!, patch: { color: '#55b8cf' } },
  ]).project;
  assert.deepEqual(
    p.geometries.find((g) => g.id === f.geometryId),
    originalGeometry,
  );
  assert.deepEqual(
    p.materials.find((m) => m.id === f.materialId),
    f.p.materials.find((m) => m.id === f.materialId),
  );
  assert.deepEqual(
    p.entities.find((e) => e.id === f.foreignId),
    f.p.entities.find((e) => e.id === f.foreignId),
  );
  assert.deepEqual(p.geometries.find((g) => g.id === right.geometryId)!.influences![1], [
    { joint: 1, weight: 1 },
  ]);
});

test('resource choices are independent and invalid or capacity-limited transactions never partly isolate', () => {
  const f = dataUsersFixture(),
    before = structuredClone(f.p);
  const materialOnly = applyCommands(f.p, [
    command([f.meshId], { resources: ['material'] }),
  ]).project;
  assert.equal(materialOnly.entities.find((e) => e.id === f.meshId)!.geometryId, f.geometryId);
  const geometryOnly = applyCommands(f.p, [
    command([f.meshId], { resources: ['geometry'] }),
  ]).project;
  assert.equal(geometryOnly.entities.find((e) => e.id === f.meshId)!.materialId, f.materialId);
  for (const ids of [[f.root], [f.meshId, f.meshId], [id()], []])
    assert.throws(() =>
      applyCommands(f.p, [
        {
          type: 'entities.data.isolate',
          entityIds: ids,
          resources: ['geometry'],
          mode: 'individual',
          batchId: id(),
        },
      ]),
    );
  assert.throws(
    () => applyCommands(f.p, [command([f.meshId], { resources: ['geometry', 'geometry'] })]),
    /不能重复/,
  );
  const full = structuredClone(f.p);
  while (full.materials.length < 2000) full.materials.push({ ...full.materials[0], id: id() });
  assert.throws(() => applyCommands(full, [command([f.meshId])]), /上限/);
  assert.deepEqual(f.p, before);
  assert.deepEqual(
    planDataIsolation(f.p, {
      entityIds: [f.meshId, f.rightId, f.foreignId],
      resources: ['geometry'],
      mode: 'selection',
    }).copies,
    [],
  );
});

test('one batch namespace deterministically recreates resources and reused namespace conflicts are atomic', () => {
  const f = dataUsersFixture(),
    c = command([f.meshId], { resources: ['geometry'] });
  const first = applyCommands(f.p, [c]).project,
    again = applyCommands(f.p, [c]).project;
  assert.deepEqual(first.geometries, again.geometries);
  assert.throws(() => applyCommands(first, [{ ...c, entityIds: [f.rightId] }]), /批次 ID/);
});

test('isolated textured skin exports and reimports with its original image bytes and independent resource users', async () => {
  const f = dataUsersFixture(),
    p = applyCommands(f.p, [command([f.rightId])]).project;
  const result = exportGLB(p, f.sceneId, 12, new Map([[f.assetId, f.pixels]]), true);
  const validation = await validateBytes(result.bytes);
  assert.equal(validation.issues.numErrors, 0);
  assert.equal(validation.issues.numWarnings, 0);
  // Read the standard GLB JSON independently to check distinct mesh/material ownership.
  const bytes = Buffer.from(result.bytes),
    document = JSON.parse(bytes.subarray(20, 20 + bytes.readUInt32LE(12)).toString());
  const left = document.nodes.find((n: { name: string }) => n.name === '左侧造型 · 蒙皮'),
    right = document.nodes.find((n: { name: string }) => n.name === '右侧造型 · 蒙皮');
  assert.notEqual(left.mesh, right.mesh);
  assert.notEqual(
    document.meshes[left.mesh].primitives[0].material,
    document.meshes[right.mesh].primitives[0].material,
  );
  assert.equal(document.images.length, 1);
  const image = document.bufferViews[document.images[0].bufferView],
    binStart = 20 + bytes.readUInt32LE(12) + 8;
  assert.deepEqual(
    bytes.subarray(binStart + image.byteOffset, binStart + image.byteOffset + image.byteLength),
    f.pixels,
  );
  const imported = await importGLTF(result.bytes),
    meshes = imported.command.entities.filter((e) => e.kind === 'mesh');
  assert.equal(meshes.length, 2);
  assert.equal(new Set(meshes.map((e) => e.geometryId)).size, 2);
  assert.equal(new Set(meshes.map((e) => e.materialId)).size, 2);
  assert.ok(meshes.every((e) => e.skin?.joints.length === 2));
  assert.equal(imported.images.length, 1);
  assert.deepEqual(Buffer.from(imported.images[0].bytes), f.pixels);
});

test('isolated assignments and original shared data survive SQLite restart and a single undo/redo', () => {
  const root = resolve(tmpdir()),
    directory = mkdtempSync(join(root, 'ff-data-users-'));
  let store = new Store(directory);
  try {
    const f = dataUsersFixture(),
      before = store.create(f.p).project;
    const after = store.change(
      before.id,
      before.revision,
      [command([f.meshId, f.rightId], { mode: 'selection' })],
      'user',
      'isolate',
    ).project;
    store.close();
    store = new Store(directory);
    assert.deepEqual(store.get(before.id).project, after);
    const undo = store.change(before.id, after.revision, undefined, 'user', 'undo', 'undo').project;
    assert.deepEqual(undo.entities, before.entities);
    assert.deepEqual(undo.geometries, before.geometries);
    assert.deepEqual(undo.materials, before.materials);
    const redo = store.change(before.id, undo.revision, undefined, 'user', 'redo', 'redo').project;
    assert.deepEqual(redo.entities, after.entities);
    assert.deepEqual(redo.geometries, after.geometries);
  } finally {
    store.close();
    assert.ok(resolve(directory).startsWith(root + sep));
    rmSync(directory, { recursive: true, force: true });
  }
});
