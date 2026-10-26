import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { Matrix4, Vector3 } from 'three';
import { objectGroupFixture } from '../scripts/object-group-fixture';
import { parentingFixture } from '../scripts/parenting-fixture';
import { ikFixture } from '../scripts/ik-fixture';
import { applyCommands } from '../src/core/commands';
import { ObjectTransformSchema, type ObjectPivot } from '../src/core/object-transform';
import { sceneEvaluator, transformMatrix } from '../src/core/constraints';
import { id, identity, type Entity, type Vec3 } from '../src/core/model';
import { chooseObjects, sceneRows, visibleObjects } from '../src/ui/object-selection';
import { Store } from '../server/store';
import { exportGLB } from '../src/core/gltf';
import { validateBytes } from 'gltf-validator';
import { deformGeometry } from '../src/core/skin';

const near = (a: number[], b: number[], tolerance = 1e-7) =>
  a.forEach((n, i) => assert.ok(Math.abs(n - b[i]) < tolerance, `${n} != ${b[i]}`));
const command = (ids: string[], delta = identity(), pivot: ObjectPivot = 'median', frame = 12) =>
  ObjectTransformSchema.parse({
    type: 'entities.transform',
    entityIds: ids,
    activeId: ids.at(-1),
    frame,
    pivot,
    delta,
  });

test('visibility above the ordinary command batch limit changes only selected flags atomically', () => {
  const f = objectGroupFixture();
  const source = f.p.entities.find((e) => e.id === f.a)!;
  const ids: string[] = Array.from({ length: 101 }, () => {
    const entity = { ...structuredClone(source), id: id() };
    f.p.entities.push(entity);
    return entity.id;
  });
  const before = structuredClone(f.p);
  const p = applyCommands(f.p, [
    { type: 'entities.visibility', entityIds: ids, visible: false },
  ]).project;
  assert.ok(p.entities.filter((e) => ids.includes(e.id)).every((e) => !e.visible));
  assert.deepEqual(
    p.entities.filter((e) => !ids.includes(e.id)),
    before.entities.filter((e) => !ids.includes(e.id)),
  );
  const restored = applyCommands(p, [
    { type: 'entities.visibility', entityIds: ids, visible: true },
  ]).project;
  assert.deepEqual(restored.entities, before.entities);
  for (const invalid of [
    [...ids, id()],
    [...ids, ids[0]],
  ])
    assert.throws(() =>
      applyCommands(f.p, [{ type: 'entities.visibility', entityIds: invalid, visible: false }]),
    );
  assert.deepEqual(f.p, before);
});

test('common world displacement edits each channel once and never doubles a selected descendant', () => {
  const f = objectGroupFixture(),
    before = structuredClone(f.p),
    c = command(f.ids, { ...identity(), position: [0.8, -0.3, 0.2] });
  const p = applyCommands(f.p, [c]).project,
    a = sceneEvaluator(f.p, f.sceneId)(12),
    b = sceneEvaluator(p, f.sceneId)(12);
  for (const key of f.ids)
    near(
      new Matrix4().makeTranslation(0.8, -0.3, 0.2).multiply(a.world.get(key)!).elements,
      b.world.get(key)!.elements,
    );
  assert.deepEqual(
    p.entities.find((e) => e.id === f.child),
    f.p.entities.find((e) => e.id === f.child),
  );
  assert.equal(p.animationTracks.length, 2);
  assert.equal(p.animationTracks[0].keys.length, 4);
  assert.deepEqual(p.animationTracks[1], f.p.animationTracks[1]);
  for (const key of f.p.animationTracks[0].keys)
    assert.deepEqual(
      p.animationTracks[0].keys.find((k) => k.id === key.id),
      key,
    );
  assert.deepEqual(f.p, before);
});

test('median and active pivots compose rotation and scale, while individual origins keep each selected world position', () => {
  const f = objectGroupFixture(),
    before = sceneEvaluator(f.p, f.sceneId)(12);
  for (const pivot of ['median', 'active', 'individual'] as const) {
    const delta = {
      position: [0, 0, 0] as Vec3,
      rotation: [0, 0.6, 0] as Vec3,
      scale: [1.3, 1.3, 1.3] as Vec3,
    };
    const p = applyCommands(f.p, [command(f.ids, delta, pivot)]).project,
      after = sceneEvaluator(p, f.sceneId)(12);
    const center =
      pivot === 'active'
        ? new Vector3().setFromMatrixPosition(before.world.get(f.b)!)
        : f.ids
            .reduce(
              (sum, key) => sum.add(new Vector3().setFromMatrixPosition(before.world.get(key)!)),
              new Vector3(),
            )
            .multiplyScalar(1 / f.ids.length);
    for (const key of f.ids) {
      const origin =
        pivot === 'individual'
          ? new Vector3().setFromMatrixPosition(before.world.get(key)!)
          : center;
      const expected = new Matrix4()
        .makeTranslation(origin.x, origin.y, origin.z)
        .multiply(transformMatrix(delta))
        .multiply(new Matrix4().makeTranslation(-origin.x, -origin.y, -origin.z))
        .multiply(before.world.get(key)!);
      near(expected.elements, after.world.get(key)!.elements);
    }
    if (pivot !== 'individual')
      assert.deepEqual(
        p.entities.find((e) => e.id === f.child)!.transform,
        f.p.entities.find((e) => e.id === f.child)!.transform,
      );
    else
      for (const key of f.ids)
        near(
          after.world.get(key)!.elements.slice(12, 15),
          before.world.get(key)!.elements.slice(12, 15),
        );
    assert.equal(p.animationTracks.find((t) => t.entityId === f.b)!.property, 'quaternion');
  }
});

test('affine attachments and rest bases are inverted, preserving mirror scales and multi-turn Euler on translation', () => {
  const f = objectGroupFixture(),
    a = f.p.entities.find((e) => e.id === f.a)!;
  a.transform.rotation = [0, Math.PI * 8, 0];
  a.transform.scale = [-0.5, 0.6, 0.5];
  a.restPose = {
    enabled: true,
    reference: structuredClone(a.transform),
    transform: { ...structuredClone(a.transform), position: [-1.2, 1, 0] },
  };
  const attached = applyCommands(f.p, [
    {
      type: 'entity.reparent',
      entityIds: [f.a, f.b],
      parentId: f.destination,
      frame: 12,
      layers: true,
      rest: false,
      keepWorld: true,
    },
  ]).project;
  const p = applyCommands(attached, [
    command(f.ids, { ...identity(), position: [0.4, 0, 0] }),
  ]).project;
  const old = sceneEvaluator(attached, f.sceneId)(12),
    next = sceneEvaluator(p, f.sceneId)(12);
  for (const key of f.ids)
    near(
      new Matrix4().makeTranslation(0.4, 0, 0).multiply(old.world.get(key)!).elements,
      next.world.get(key)!.elements,
    );
  assert.deepEqual(p.entities.find((e) => e.id === f.a)!.transform, a.transform);
  assert.deepEqual(p.entities.find((e) => e.id === f.a)!.restPose, a.restPose);
});

test('small world moves at large positions are retained; existing current keys preserve identities and interpolation', () => {
  const f = objectGroupFixture();
  f.p.entities.find((e) => e.id === f.right)!.transform.position = [9e6, 0, 0];
  const old = sceneEvaluator(f.p, f.sceneId)(24),
    p = applyCommands(f.p, [
      command([f.a, f.b], { ...identity(), position: [0.01, 0, 0] }, 'active', 24),
    ]).project;
  const next = sceneEvaluator(p, f.sceneId)(24);
  near(
    next.world.get(f.b)!.elements.slice(12, 15),
    [
      old.world.get(f.b)!.elements[12] + 0.01,
      old.world.get(f.b)!.elements[13],
      old.world.get(f.b)!.elements[14],
    ],
    1e-6,
  );
  const oldKey = f.p.animationTracks[0].keys[1],
    key = p.animationTracks[0].keys[1];
  assert.equal(key.id, oldKey.id);
  assert.equal(key.interpolation, oldKey.interpolation);
  assert.deepEqual(key.inTangent, oldKey.inTangent);
});

test('shear, unsupported selected drivers, missing/duplicate/cross-scene selection and late dependency drift reject atomically', () => {
  const f = objectGroupFixture(),
    p = f.p,
    snapshot = structuredClone(p);
  for (const c of [
    command([f.a, f.a]),
    command(['missing']),
    { ...command(f.ids), activeId: f.left },
    { ...command(f.ids), delta: { ...identity(), scale: [0, 1, 1] } },
  ]) {
    assert.throws(() => applyCommands(p, [c]));
    assert.deepEqual(p, snapshot);
  }
  const shear = structuredClone(p);
  shear.entities.find((e) => e.id === f.left)!.transform.scale = [1.8, 0.6, 1.2];
  assert.throws(
    () => applyCommands(shear, [command([f.a, f.b], { ...identity(), rotation: [0, 0.3, 0] })]),
    /剪切/,
  );
  const constrained = structuredClone(p);
  constrained.entities.find((e) => e.id === f.left)!.constraints = [
    {
      id: id(),
      name: 'Parent follows B',
      type: 'copy-position',
      targetId: f.b,
      targetSpace: 'world',
      ownerSpace: 'world',
      enabled: true,
      influence: 0.5,
    },
  ];
  assert.throws(
    () => applyCommands(constrained, [command([f.a, f.b], { ...identity(), position: [1, 0, 0] })]),
    /目标世界姿态/,
  );
  const source = structuredClone(constrained);
  assert.throws(() => applyCommands(constrained, [command([f.left, f.b])]), /启用约束/);
  assert.deepEqual(constrained, source);
  const cross = structuredClone(p),
    sceneId = id();
  cross.scenes.push({ ...cross.scenes[0], id: sceneId });
  cross.entities.find((e) => e.id === f.destination)!.sceneId = sceneId;
  assert.throws(() => applyCommands(cross, [command([f.a, f.destination])]), /同一场景/);
});

test('moving a rig ancestor and an ordinary object preserves skin bindings and moves every weighted vertex', () => {
  const f = parentingFixture(),
    p = f.p,
    mesh = p.entities.find((e) => e.id === f.meshId)!,
    geometry = p.geometries.find((g) => g.id === mesh.geometryId)!;
  const before = deformGeometry(geometry, mesh.skin!, sceneEvaluator(p, f.sceneId)(12).world);
  const next = applyCommands(p, [
    command([f.oldParent, f.newParent], { ...identity(), position: [0.3, 0.2, 0] }),
  ]).project;
  const after = deformGeometry(geometry, mesh.skin!, sceneEvaluator(next, f.sceneId)(12).world);
  before.positions.forEach((v, i) => near(after.positions[i], [v[0] + 0.3, v[1] + 0.2, v[2]]));
  assert.deepEqual(next.entities.find((e) => e.id === mesh.id)!.skin, mesh.skin);
  assert.throws(() => applyCommands(p, [command([f.meshId, f.cubeId])]), /蒙皮网格/);
});

test('batch delete validates the union of selected subtrees and protects references outside it', () => {
  const f = objectGroupFixture(),
    p = f.p;
  p.entities.find((e) => e.id === f.b)!.constraints = [
    {
      id: id(),
      name: 'A follower',
      type: 'copy-position',
      targetId: f.a,
      ownerSpace: 'world',
      targetSpace: 'world',
      enabled: true,
      influence: 1,
    },
  ];
  assert.throws(
    () => applyCommands(p, [{ type: 'entities.delete', entityIds: [f.a] }]),
    /约束引用/,
  );
  const next = applyCommands(p, [
    { type: 'entities.delete', entityIds: [f.a, f.child, f.b] },
  ]).project;
  assert.ok(f.ids.every((key) => !next.entities.some((e) => e.id === key)));
  assert.equal(next.animationTracks.length, 0);
  const camera = p.entities.find((e) => e.kind === 'camera')!;
  assert.throws(
    () => applyCommands(p, [{ type: 'entities.delete', entityIds: [f.a, camera.id] }]),
    /摄影机被镜头引用/,
  );
});

test('group channel edits honor the active action, disabled layer preview and keyed zero IK influence', () => {
  const f = objectGroupFixture(),
    p = f.p;
  const main = { id: id(), sceneId: f.sceneId, name: 'Main' },
    overlay = { id: id(), sceneId: f.sceneId, name: 'Overlay' };
  p.animationActions = [main, overlay];
  p.scenes[0].activeActionId = main.id;
  p.animationTracks.forEach((t) => (t.actionId = main.id));
  const extra = structuredClone(p.animationTracks[0]);
  extra.id = id();
  extra.actionId = overlay.id;
  extra.keys.forEach((k) => (k.value[1] += 2));
  p.animationTracks.push(extra);
  p.animationLayers = [
    {
      id: id(),
      name: 'Overlay',
      entityId: f.a,
      actionId: overlay.id,
      enabled: true,
      weight: 1,
      blend: 'replace',
      channels: ['position'],
      start: 0,
      duration: 48,
      fadeIn: 0,
      fadeOut: 0,
      sourceIn: 0,
      playback: { rate: 1, rangeStart: 0, rangeEnd: 48, mode: 'hold' },
    },
  ];
  const c = command(f.ids, { ...identity(), position: [0.3, 0, 0] });
  assert.throws(() => applyCommands(p, [c]), /动作层/);
  const next = applyCommands(p, [{ ...c, layers: false }]).project;
  assert.deepEqual(
    next.animationTracks.find((t) => t.id === extra.id),
    extra,
  );
  assert.deepEqual(next.animationLayers, p.animationLayers);
  assert.equal(next.animationTracks[0].keys.length, 4);
  const oldWorld = sceneEvaluator(p, f.sceneId)(12, undefined, false).world,
    newWorld = sceneEvaluator(next, f.sceneId)(12, undefined, false).world;
  for (const key of f.ids)
    near(
      new Matrix4().makeTranslation(0.3, 0, 0).multiply(oldWorld.get(key)!).elements,
      newWorld.get(key)!.elements,
    );
  const rig = ikFixture(),
    chain = rig.p.ikChains![0],
    ikCommand = command([rig.rootJointId, rig.targetId], { ...identity(), position: [0.2, 0, 0] });
  assert.throws(() => applyCommands(rig.p, [ikCommand]), /驱动所选关节/);
  rig.p.ikTracks = [
    {
      id: id(),
      entityId: chain.joints[0],
      chainId: chain.id,
      property: 'influence',
      keys: [{ id: id(), frame: 0, value: [0], interpolation: 'constant' }],
    },
  ];
  const fk = applyCommands(rig.p, [ikCommand]).project;
  assert.deepEqual(fk.ikTracks, rig.p.ikTracks);
  const before = sceneEvaluator(rig.p, rig.sceneId)(12).world,
    after = sceneEvaluator(fk, rig.sceneId)(12).world;
  for (const key of ikCommand.entityIds)
    near(
      new Matrix4().makeTranslation(0.2, 0, 0).multiply(before.get(key)!).elements,
      after.get(key)!.elements,
    );
});

test('ordered selection keeps exactly one active ID, hierarchy order and inherited visibility', () => {
  const f = objectGroupFixture(),
    rows = sceneRows(f.p, f.sceneId);
  assert.ok(
    rows.findIndex((r) => r.entity.id === f.left) < rows.findIndex((r) => r.entity.id === f.a),
  );
  assert.equal(rows.find((r) => r.entity.id === f.child)!.depth, 2);
  assert.deepEqual(chooseObjects([f.a, f.b], [f.a], 'toggle'), [f.b]);
  assert.deepEqual(chooseObjects([f.a, f.b], [f.a], 'add'), [f.b, f.a]);
  assert.deepEqual(chooseObjects([f.a], [f.b, f.b], 'add'), [f.a, f.b]);
  f.p.entities.find((e) => e.id === f.left)!.visible = false;
  assert.ok(!visibleObjects(f.p, f.sceneId).some((key) => [f.left, f.a, f.child].includes(key)));
});

test('one group gesture survives store restart and one undo restores every object and channel', async () => {
  const root = resolve(tmpdir()),
    directory = mkdtempSync(join(root, 'ff-object-group-'));
  let store = new Store(directory);
  try {
    const f = objectGroupFixture(),
      original = store.create(f.p).project;
    const changed = store.change(
      original.id,
      original.revision,
      [command(f.ids, { ...identity(), position: [0.5, 0, 0] })],
      'user',
      'group',
    ).project;
    assert.equal(changed.revision, original.revision + 1);
    store.close();
    store = new Store(directory);
    assert.deepEqual(store.get(original.id).project, changed);
    const undo = store.change(
      original.id,
      changed.revision,
      undefined,
      'user',
      'undo',
      'undo',
    ).project;
    assert.deepEqual(undo.entities, original.entities);
    assert.deepEqual(undo.animationTracks, original.animationTracks);
    const redo = store.change(
      original.id,
      undo.revision,
      undefined,
      'user',
      'redo',
      'redo',
    ).project;
    assert.deepEqual(redo.entities, changed.entities);
    assert.deepEqual(redo.animationTracks, changed.animationTracks);
    const glb = exportGLB(redo, f.sceneId, 12, new Map(), true),
      validation = await validateBytes(glb.bytes);
    assert.equal(validation.issues.numErrors, 0);
    assert.equal(validation.issues.numWarnings, 0);
  } finally {
    store.close();
    assert.ok(resolve(directory).startsWith(root + sep));
    rmSync(directory, { recursive: true, force: true });
  }
});
