import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { Matrix4 } from 'three';
import { hierarchyCopyFixture } from '../scripts/hierarchy-copy-fixture';
import { objectGroupFixture } from '../scripts/object-group-fixture';
import { retargetFixture } from '../scripts/retarget-fixture';
import { applyCommands } from '../src/core/commands';
import {
  HierarchyCopySchema,
  planHierarchyCopy,
  duplicateHierarchy,
} from '../src/core/hierarchy-copy';
import { id, identity, parseProject } from '../src/core/model';
import { sceneEvaluator } from '../src/core/constraints';
import { deformGeometry } from '../src/core/skin';
import { Store } from '../server/store';

const command = (ids: string[], extra = {}) =>
  HierarchyCopySchema.parse({
    type: 'entities.duplicate',
    batchId: id(),
    entityIds: ids,
    ...extra,
  });
const near = (a: number[], b: number[], tolerance = 1e-7) =>
  a.forEach((n, i) => assert.ok(Math.abs(n - b[i]) < tolerance, `${n} != ${b[i]}`));
const copied = (p: ReturnType<typeof hierarchyCopyFixture>['p'], c: ReturnType<typeof command>) => {
  const draft = structuredClone(p),
    result = duplicateHierarchy(draft, c);
  return { p: applyCommands(p, [c]).project, ...result };
};

test('whole subtrees preserve every source and copied pose, rig binding and sampled skin vertex', () => {
  const f = hierarchyCopyFixture(),
    before = structuredClone(f.p),
    c = command([f.assemblyId, f.root, f.meshId]);
  const { p, map, roots } = copied(f.p, c);
  assert.deepEqual(roots, [map.get(f.assemblyId)]);
  const scope = planHierarchyCopy(f.p, {
    entityIds: c.entityIds,
    geometry: c.geometry,
    materials: c.materials,
    external: c.external,
  });
  assert.equal(p.entities.length, before.entities.length + scope.selected.length);
  assert.deepEqual(p.entities.slice(0, before.entities.length), before.entities);
  for (const actionId of [f.baseActionId, f.layerActionId, null])
    for (const frame of [0, 7.5, 12, 24, 37.25, 48]) {
      const a = sceneEvaluator(before, f.sceneId)(frame, actionId),
        b = sceneEvaluator(p, f.sceneId)(frame, actionId);
      for (const e of scope.selected)
        near(a.world.get(e.id)!.elements, b.world.get(map.get(e.id)!)!.elements);
      for (const e of before.entities)
        near(a.world.get(e.id)!.elements, b.world.get(e.id)!.elements);
      const originalMesh = before.entities.find((e) => e.id === f.meshId)!,
        mesh = p.entities.find((e) => e.id === map.get(f.meshId))!;
      assert.deepEqual(mesh.skin!.inverseBindMatrices, originalMesh.skin!.inverseBindMatrices);
      assert.deepEqual(
        mesh.skin!.joints,
        originalMesh.skin!.joints.map((key) => map.get(key)),
      );
      const oldVertices = deformGeometry(
        before.geometries.find((g) => g.id === originalMesh.geometryId)!,
        originalMesh.skin!,
        a.world,
      );
      const newVertices = deformGeometry(
        p.geometries.find((g) => g.id === mesh.geometryId)!,
        mesh.skin!,
        b.world,
      );
      oldVertices.positions.forEach((v, i) => near(v, newVertices.positions[i]));
    }
  assert.deepEqual(f.p, before);
});

test('independent geometry and materials copy once per source while preserving internal sharing', () => {
  const f = hierarchyCopyFixture(),
    { p, map } = copied(f.p, command([f.assemblyId]));
  const wrist = p.entities.find((e) => e.id === map.get(f.wristId))!,
    twin = p.entities.find((e) => e.id === map.get(f.twinId))!;
  const original = f.p.entities.find((e) => e.id === f.wristId)!;
  assert.equal(wrist.geometryId, twin.geometryId);
  assert.equal(wrist.materialId, twin.materialId);
  assert.notEqual(wrist.geometryId, original.geometryId);
  assert.notEqual(wrist.materialId, original.materialId);
  const geometry = p.geometries.find((g) => g.id === wrist.geometryId)!;
  geometry.positions[0][0] += 1;
  p.materials.find((m) => m.id === wrist.materialId)!.color = '#123456';
  assert.deepEqual(
    p.geometries.find((g) => g.id === original.geometryId),
    f.p.geometries.find((g) => g.id === original.geometryId),
  );
  assert.deepEqual(
    p.materials.find((m) => m.id === original.materialId),
    f.p.materials.find((m) => m.id === original.materialId),
  );
});

test('linked data is explicit and independent tracks, key identities and layers retain all action semantics', () => {
  const f = hierarchyCopyFixture(),
    { p, map } = copied(f.p, command([f.assemblyId], { geometry: 'linked', materials: 'linked' }));
  assert.deepEqual(p.geometries, f.p.geometries);
  assert.deepEqual(p.materials, f.p.materials);
  assert.deepEqual(p.animationActions, f.p.animationActions);
  assert.deepEqual(p.scenes, f.p.scenes);
  for (const old of [...f.p.animationTracks, ...f.p.ikTracks!]) {
    const next = [...p.animationTracks, ...p.ikTracks!].find((t) => t.id === map.get(old.id))!;
    assert.equal(next.actionId, old.actionId);
    assert.equal(next.entityId, map.get(old.entityId));
    for (let i = 0; i < old.keys.length; i++) {
      assert.notEqual(next.keys[i].id, old.keys[i].id);
      assert.deepEqual({ ...next.keys[i], id: old.keys[i].id }, old.keys[i]);
    }
    next.keys[0].value[0] += 0.05;
  }
  assert.deepEqual(p.animationTracks.slice(0, f.p.animationTracks.length), f.p.animationTracks);
  const layer = p.animationLayers!.at(-1)!;
  assert.equal(layer.entityId, map.get(f.p.animationLayers![0].entityId));
  assert.equal(layer.actionId, f.layerActionId);
  assert.notEqual(layer.id, f.p.animationLayers![0].id);
});

test('external references preserve or recursively include controllers while incoming users stay original', () => {
  const f = hierarchyCopyFixture(),
    externalId = id();
  f.p.entities.push({
    id: externalId,
    name: '外部观察者',
    sceneId: f.sceneId,
    parentId: null,
    kind: 'group',
    visible: true,
    transform: identity(),
    constraints: [
      {
        id: id(),
        name: '原控制器',
        targetId: f.targetId,
        enabled: true,
        influence: 1,
        type: 'copy-position',
        targetSpace: 'world',
        ownerSpace: 'world',
      },
    ],
  });
  const preserved = copied(f.p, command([f.root]));
  const chain = preserved.p.ikChains!.find((c) => c.id === preserved.map.get(f.chainId))!;
  assert.equal(chain.targetId, f.targetId);
  assert.equal(chain.poleId, f.poleId);
  assert.throws(() => applyCommands(f.p, [command([f.root], { external: 'reject' })]), /外部/);
  const included = copied(f.p, command([f.root], { external: 'include' }));
  assert.ok(included.map.has(f.targetId) && included.map.has(f.poleId));
  assert.equal(included.p.ikChains!.at(-1)!.targetId, included.map.get(f.targetId));
  assert.deepEqual(
    included.p.entities.find((e) => e.id === externalId),
    f.p.entities.find((e) => e.id === externalId),
  );
  assert.equal(
    included.p.entities.find((e) => e.id === included.map.get(f.root))!.parentId,
    f.assemblyId,
  );
});

test('partial IK selection rejects atomically or expands to an intact copied chain including limits', () => {
  const f = hierarchyCopyFixture();
  f.p.ikChains![0].limits = [
    {
      jointId: f.elbowId,
      enabled: false,
      kind: 'cone',
      reference: [0, 0, 0, 1],
      axis: [1, 0, 0],
      min: -1,
      max: 1,
      swing: 1,
    },
  ];
  const before = structuredClone(f.p);
  assert.throws(() => applyCommands(f.p, [command([f.elbowId])]), /部分 IK/);
  assert.deepEqual(f.p, before);
  const { p, map } = copied(f.p, command([f.elbowId], { external: 'include' }));
  assert.deepEqual(
    p.ikChains!.at(-1)!.joints,
    f.p.ikChains![0].joints.map((key) => map.get(key)),
  );
  assert.equal(p.ikChains!.at(-1)!.limits![0].jointId, map.get(f.elbowId));
  assert.equal(p.ikTracks!.at(-1)!.chainId, map.get(f.chainId));
});

test('retarget recipes belong to the copied target and include mode follows cross-scene sources', () => {
  const f = retargetFixture(),
    profile = f.profile;
  f.p = applyCommands(f.p, [{ type: 'retarget.put', profile }]).project;
  const target = copied(f.p, command([profile.targetRootId]));
  assert.equal(target.p.retargetProfiles!.at(-1)!.sourceRootId, profile.sourceRootId);
  assert.equal(
    target.p.retargetProfiles!.at(-1)!.targetRootId,
    target.map.get(profile.targetRootId),
  );
  const both = copied(f.p, command([profile.targetRootId], { external: 'include' }));
  const recipe = both.p.retargetProfiles!.at(-1)!;
  assert.equal(recipe.sourceRootId, both.map.get(profile.sourceRootId));
  assert.deepEqual(
    recipe.mappings,
    profile.mappings.map((pair) => ({
      sourceId: both.map.get(pair.sourceId),
      targetId: both.map.get(pair.targetId),
    })),
  );
  assert.ok(
    both.p.entities.find((e) => e.id === recipe.sourceRootId)!.sceneId !==
      both.p.entities.find((e) => e.id === recipe.targetRootId)!.sceneId,
  );
  const sourceOnly = copied(f.p, command([profile.sourceRootId], { external: 'include' }));
  assert.deepEqual(sourceOnly.p.retargetProfiles, f.p.retargetProfiles);
});

test('affine parent compensation, mirrored scale, rest references and original parent are preserved', () => {
  const f = objectGroupFixture();
  const a = f.p.entities.find((e) => e.id === f.a)!;
  a.parentOffset = { enabled: true, matrix: new Matrix4().makeShear(0.1, 0, 0, 0, 0, 0).toArray() };
  a.restPose = {
    enabled: true,
    transform: { ...identity(), position: [0.2, 0.1, 0] },
    reference: identity(),
  };
  a.transform.scale = [-0.5, 0.5, 0.5];
  const { p, map } = copied(f.p, command([f.a]));
  const copy = p.entities.find((e) => e.id === map.get(f.a))!;
  assert.deepEqual(copy.parentOffset, a.parentOffset);
  assert.deepEqual(copy.restPose, a.restPose);
  assert.equal(copy.parentId, a.parentId);
  for (const frame of [0, 7.5, 24, 47]) {
    const before = sceneEvaluator(f.p, f.sceneId)(frame),
      after = sceneEvaluator(p, f.sceneId)(frame);
    for (const key of [f.a, f.child])
      near(before.world.get(key)!.elements, after.world.get(map.get(key)!)!.elements);
  }
});

test('duplicate requests, unknown IDs, cross-scene selection, reused namespaces and capacity reject atomically', () => {
  const f = hierarchyCopyFixture(),
    before = structuredClone(f.p);
  for (const ids of [[f.root, f.root], [id()], []])
    assert.throws(() =>
      applyCommands(f.p, [{ type: 'entities.duplicate', entityIds: ids, batchId: id() }]),
    );
  const c = command([f.assemblyId]),
    first = applyCommands(f.p, [c]).project;
  assert.throws(() => applyCommands(first, [c]), /批次 ID/);
  const otherScene = id();
  const multi = structuredClone(f.p);
  multi.scenes.push({ ...multi.scenes[0], id: otherScene, activeActionId: null });
  const other = {
    ...multi.entities.find((e) => e.id === f.assemblyId)!,
    id: id(),
    sceneId: otherScene,
  };
  multi.entities.push(other);
  assert.throws(() => applyCommands(multi, [command([f.assemblyId, other.id])]), /同一场景/);
  const full = structuredClone(f.p);
  while (full.entities.length < 2000)
    full.entities.push({
      id: id(),
      name: '容量边界',
      sceneId: f.sceneId,
      parentId: null,
      kind: 'group',
      visible: true,
      transform: identity(),
    });
  assert.throws(() => applyCommands(full, [command([f.root])]), /上限/);
  assert.deepEqual(f.p, before);
  const again = applyCommands(f.p, [c]).project;
  assert.deepEqual(first.entities, again.entities);
  assert.deepEqual(first.animationTracks, again.animationTracks);
});

test('one atomic copy survives SQLite restart, undo, redo and portable schema validation', () => {
  const root = resolve(tmpdir()),
    directory = mkdtempSync(join(root, 'ff-hierarchy-copy-'));
  let store = new Store(directory);
  try {
    const f = hierarchyCopyFixture(),
      before = store.create(f.p).project;
    const after = store.change(
      before.id,
      before.revision,
      [command([f.assemblyId])],
      'agent',
      'copy assembly',
    ).project;
    assert.equal(after.revision, before.revision + 1);
    store.close();
    store = new Store(directory);
    assert.deepEqual(store.get(before.id).project, after);
    const undo = store.change(before.id, after.revision, undefined, 'user', 'undo', 'undo').project;
    assert.deepEqual(undo.entities, before.entities);
    assert.deepEqual(undo.ikChains, before.ikChains);
    const redo = store.change(before.id, undo.revision, undefined, 'user', 'redo', 'redo').project;
    assert.deepEqual(redo.entities, after.entities);
    assert.deepEqual(redo.animationTracks, after.animationTracks);
    assert.deepEqual(redo.ikTracks, after.ikTracks);
    assert.deepEqual(parseProject(JSON.parse(JSON.stringify(redo))), redo);
  } finally {
    store.close();
    assert.ok(resolve(directory).startsWith(root + sep));
    rmSync(directory, { recursive: true, force: true });
  }
});
