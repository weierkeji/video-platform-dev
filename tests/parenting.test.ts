import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Matrix4, Vector3, AnimationMixer, LoopOnce, SkinnedMesh } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { validateBytes } from 'gltf-validator';
import { parentingFixture } from '../scripts/parenting-fixture';
import { ikFixture } from '../scripts/ik-fixture';
import { retargetFixture } from '../scripts/retarget-fixture';
import { applyCommands } from '../src/core/commands';
import { ReparentSchema } from '../src/core/parenting';
import {
  id,
  identity,
  parseProject,
  migrateProject,
  PROJECT_VERSION,
  type Entity,
  type Project,
} from '../src/core/model';
import { parentBasis, localBasis, sceneEvaluator, transformMatrix } from '../src/core/constraints';
import { restWorld, restProject } from '../src/core/rest-pose';
import { deformGeometry } from '../src/core/skin';
import { bakedProject, type BakeOptions } from '../src/core/bake';
import { exportGLB } from '../src/core/gltf';
import { Store } from '../server/store';

const near = (a: number[], b: number[], tolerance = 1e-7) =>
  a.forEach((v, i) => assert.ok(Math.abs(v - b[i]) < tolerance, `${v} != ${b[i]}`));
const reparent = (ids: string[], parentId: string | null, frame = 12, keepWorld = true) =>
  ReparentSchema.parse({ type: 'entity.reparent', entityIds: ids, parentId, frame, keepWorld });
const samePose = (a: Project, b: Project, scene: string, frame: number) => {
  const before = sceneEvaluator(a, scene)(frame),
    after = sceneEvaluator(b, scene)(frame);
  for (const [id, m] of before.world) near(m.elements, after.world.get(id)!.elements);
};
const options: BakeOptions = {
  start: 0,
  end: 48,
  step: 0.25,
  actionId: null,
  rebase: false,
  interpolation: 'linear',
};

test('affine reparent preserves descendants, skin, original channels and static-parent animation without losing shear', () => {
  const f = parentingFixture(),
    before = structuredClone(f.p);
  const changed = applyCommands(f.p, [reparent(f.selected, f.newParent)]).project;
  for (let frame = 0; frame <= 48; frame += 0.75) samePose(f.p, changed, f.sceneId, frame);
  assert.deepEqual(changed.animationTracks, f.p.animationTracks);
  assert.deepEqual(changed.geometries, f.p.geometries);
  for (const key of f.selected) {
    const old = f.p.entities.find((e) => e.id === key)!,
      next = changed.entities.find((e) => e.id === key)!;
    assert.equal(next.parentId, f.newParent);
    assert.ok(next.parentOffset?.enabled);
    assert.deepEqual(next.transform, old.transform);
    assert.deepEqual(next.skin, old.skin);
  }
  const mesh = changed.entities.find((e) => e.id === f.meshId)!,
    geometry = changed.geometries.find((g) => g.id === mesh.geometryId)!;
  const originalSkin = deformGeometry(
    geometry,
    mesh.skin!,
    sceneEvaluator(f.p, f.sceneId)(17.5).world,
  );
  const nextSkin = deformGeometry(
    geometry,
    mesh.skin!,
    sceneEvaluator(changed, f.sceneId)(17.5).world,
  );
  originalSkin.positions.forEach((v, i) => near(v, nextSkin.positions[i]));
  assert.throws(() => exportGLB(changed, f.sceneId, 12), /剪切/);
  assert.throws(() => exportGLB(changed, f.sceneId, 12, new Map(), true), /层级补偿/);
  assert.deepEqual(f.p, before);
});

test('animated new parent preserves the chosen frame then supplies its future motion; local mode retains the local basis', () => {
  const f = parentingFixture(),
    p = f.p,
    newParent = p.entities.find((e) => e.id === f.newParent)!;
  p.animationTracks.push({
    id: id(),
    entityId: newParent.id,
    property: 'position',
    keys: [0, 24].map((frame, i) => ({
      id: id(),
      frame,
      value: [i * 2, 0.4, 0.1],
      interpolation: 'linear',
    })),
  });
  const next = applyCommands(p, [reparent([f.cubeId], f.newParent)]).project;
  samePose(p, next, f.sceneId, 12);
  const cube = next.entities.find((e) => e.id === f.cubeId)!;
  const a = sceneEvaluator(next, f.sceneId)(24),
    old = sceneEvaluator(p, f.sceneId)(24);
  assert.ok(
    Math.abs(a.world.get(f.cubeId)!.elements[12] - old.world.get(f.cubeId)!.elements[12]) > 0.5,
  );
  const expected = a.world
    .get(f.newParent)!
    .clone()
    .multiply(parentBasis(cube))
    .multiply(transformMatrix({ ...cube.transform, position: [1.9, 1.1, 0] }));
  near(a.world.get(cube.id)!.elements, expected.elements);
  const local = applyCommands(next, [reparent([f.cubeId], null, 12, false)]).project;
  assert.deepEqual(local.entities.find((e) => e.id === f.cubeId)!.parentOffset, cube.parentOffset);
  near(
    sceneEvaluator(local, f.sceneId)(12).world.get(cube.id)!.elements,
    sceneEvaluator(next, f.sceneId)(12).local.get(cube.id)!.elements,
  );
});

test('detach, repeated attachments and selected ancestor/child batches use the original hierarchy snapshot', () => {
  const f = parentingFixture();
  const child: Entity = {
    id: id(),
    name: 'Cube child',
    sceneId: f.sceneId,
    parentId: f.cubeId,
    kind: 'group',
    visible: true,
    transform: { ...identity(), position: [0, 2, 0] },
  };
  f.p.entities.push(child);
  const selected = [f.cubeId, child.id];
  assert.throws(() => applyCommands(f.p, [reparent([f.root, f.joint0], f.newParent)]), /骨架根/);
  let p = applyCommands(f.p, [reparent(selected, f.newParent)]).project;
  samePose(f.p, p, f.sceneId, 12);
  for (const parentId of [null, f.oldParent, f.newParent, null]) {
    p = applyCommands(p, [reparent(selected, parentId)]).project;
    samePose(f.p, p, f.sceneId, 12);
  }
});

test('parent cycles, cross-scene targets, missing IDs, singular animation and malformed matrices reject atomically', () => {
  const f = parentingFixture(),
    p = f.p,
    before = structuredClone(p);
  for (const command of [
    reparent([f.root], f.joint0),
    reparent([f.root], f.root),
    reparent([f.root, f.root], null),
    reparent(['missing'], null),
    reparent([f.root], 'missing'),
  ]) {
    assert.throws(() => applyCommands(p, [command]));
    assert.deepEqual(p, before);
  }
  const another = structuredClone(p),
    sceneId = id();
  another.scenes.push({ ...another.scenes[0], id: sceneId });
  const foreign = {
    id: id(),
    sceneId,
    parentId: null,
    name: 'Other',
    kind: 'group' as const,
    visible: true,
    transform: identity(),
  };
  another.entities.push(foreign);
  assert.throws(() => applyCommands(another, [reparent([f.root], foreign.id)]), /同一场景/);
  const zero = structuredClone(p);
  zero.animationTracks.push({
    id: id(),
    entityId: f.newParent,
    property: 'scale',
    keys: [0, 24].map((frame, i) => ({
      id: id(),
      frame,
      interpolation: 'linear',
      value: [i ? -1 : 1, 1, 1],
    })),
  });
  assert.throws(() => applyCommands(zero, [reparent([f.root], f.newParent)]), /不可逆/);
  for (const matrix of [
    new Matrix4().makeScale(0, 1, 1).toArray(),
    new Matrix4().toArray().map((v, i) => (i === 3 ? 1 : v)),
    new Matrix4().toArray().map((v, i) => (i === 12 ? 1e8 : v)),
  ])
    assert.throws(() =>
      applyCommands(p, [
        { type: 'entity.update', id: f.cubeId, patch: { parentOffset: { enabled: true, matrix } } },
      ]),
    );
});

test('world constraints remain stable and local-space dependent changes are rejected instead of silently moving followers', () => {
  const f = parentingFixture(),
    p = f.p,
    cube = p.entities.find((e) => e.id === f.cubeId)!;
  cube.constraints = [
    {
      id: id(),
      name: 'World copy',
      type: 'copy-position',
      enabled: true,
      influence: 0.5,
      targetId: f.meshId,
      ownerSpace: 'world',
      targetSpace: 'world',
    },
  ];
  const changed = applyCommands(p, [reparent([cube.id], f.newParent)]).project;
  samePose(p, changed, f.sceneId, 12);
  if (cube.constraints[0].type !== 'aim') cube.constraints[0].ownerSpace = 'local';
  assert.throws(() => applyCommands(p, [reparent([cube.id], f.newParent)]), /局部约束或 IK/);
  delete cube.constraints;
  const follower: Entity = {
    id: id(),
    name: 'Local reader',
    sceneId: f.sceneId,
    parentId: null,
    kind: 'group',
    visible: true,
    transform: identity(),
    constraints: [
      {
        id: id(),
        name: 'local target',
        type: 'copy-position',
        enabled: true,
        influence: 1,
        targetId: cube.id,
        ownerSpace: 'world',
        targetSpace: 'local',
      },
    ],
  };
  p.entities.push(follower);
  assert.throws(() => applyCommands(p, [reparent([cube.id], f.newParent)]), /Local reader/);
});

test('IK chain continuity is protected and a compensated chain root retains solved world pose', () => {
  const f = ikFixture(),
    p = f.p,
    chain = p.ikChains![0];
  p.entities.find((e) => e.id === f.meshId)!.skin!.skeletonId = chain.joints[0];
  const parent: Entity = {
    id: id(),
    name: 'IK attachment',
    sceneId: chain.sceneId,
    parentId: null,
    kind: 'group',
    visible: true,
    transform: { ...identity(), position: [1, 0, 0], rotation: [0, 0.3, 0] },
  };
  p.entities.push(parent);
  assert.throws(() => applyCommands(p, [reparent([chain.joints[1]], parent.id)]), /直接父子/);
  const next = applyCommands(p, [reparent([chain.joints[0]], parent.id, 0)]).project;
  samePose(p, next, chain.sceneId, 0);
  const fk = applyCommands(next, [
    { type: 'ik.match', chainId: chain.id, frame: 0, mode: 'fk', interpolation: 'constant' },
  ]).project;
  samePose(next, fk, chain.sceneId, 0);
});

test('mirrored parents, rest offsets and the chosen layer preview scope compose without changing authored data', () => {
  const f = parentingFixture(),
    p = f.p,
    old = p.entities.find((e) => e.id === f.oldParent)!,
    next = p.entities.find((e) => e.id === f.newParent)!;
  next.transform.scale[0] *= -1;
  old.restPose = {
    enabled: true,
    reference: structuredClone(old.transform),
    transform: { ...structuredClone(old.transform), position: [0.8, 0.6, 0] },
  };
  const action = { id: id(), sceneId: f.sceneId, name: 'Parent layer' };
  p.animationActions = [action];
  p.animationTracks.push({
    id: id(),
    entityId: next.id,
    actionId: action.id,
    property: 'position',
    keys: [{ id: id(), frame: 0, value: [4, 2, 1], interpolation: 'linear' }],
  });
  p.animationLayers = [
    {
      id: id(),
      entityId: next.id,
      actionId: action.id,
      name: 'Offset layer',
      enabled: true,
      blend: 'replace',
      weight: 0.7,
      channels: ['position'],
      start: 0,
      duration: 48,
      sourceIn: 0,
      playback: { rate: 1, rangeStart: 0, rangeEnd: 48, mode: 'hold' },
      fadeIn: 0,
      fadeOut: 0,
    },
  ];
  for (const scope of [
    { layers: true, rest: false },
    { layers: false, rest: false },
    { layers: true, rest: true },
  ]) {
    const changed = applyCommands(p, [{ ...reparent(f.selected, next.id), ...scope }]).project;
    const before = sceneEvaluator(scope.rest ? restProject(p) : p, f.sceneId)(
      scope.rest ? undefined : 12,
      undefined,
      scope.layers,
    );
    const after = sceneEvaluator(scope.rest ? restProject(changed) : changed, f.sceneId)(
      scope.rest ? undefined : 12,
      undefined,
      scope.layers,
    );
    for (const [key, m] of before.world) near(m.elements, after.world.get(key)!.elements);
    assert.deepEqual(p.animationTracks, changed.animationTracks);
    assert.deepEqual(p.animationLayers, changed.animationLayers);
    assert.deepEqual(old.restPose, changed.entities.find((e) => e.id === old.id)!.restPose);
  }
});

test('rest pose capture removes the attachment basis once and skin-preserving rest edits remain valid', () => {
  const f = parentingFixture();
  f.p.entities.find((e) => e.id === f.meshId)!.skin!.skeletonId = f.joint0;
  let p = applyCommands(f.p, [reparent([f.joint0], f.newParent)]).project;
  const rest = restWorld(p, f.sceneId);
  p = applyCommands(p, [
    { type: 'rig.rest.capture', entityIds: [f.joint0], frame: 0, preserveShape: true },
  ]).project;
  near(restWorld(p, f.sceneId).get(f.joint0)!.elements, rest.get(f.joint0)!.elements);
  samePose(f.p, p, f.sceneId, 0);
  const e = p.entities.find((e) => e.id === f.joint0)!;
  near(
    localBasis(e).multiply(transformMatrix(e.transform)).elements,
    sceneEvaluator(p, f.sceneId)(0).local.get(e.id)!.elements,
  );
});

test('bake activation disables stored offsets and independent GLB playback retains skinned vertices', async () => {
  const f = parentingFixture();
  const p = applyCommands(f.p, [
    reparent(f.selected, f.newParent),
    reparent(f.selected, f.oldParent),
  ]).project;
  const action = { id: id(), sceneId: f.sceneId, name: 'Attached bake' };
  const activated = applyCommands(p, [
    { type: 'action.bake', action, options, activate: true },
  ]).project;
  assert.ok(
    activated.entities
      .filter((e) => f.selected.includes(e.id))
      .every((e) => e.parentOffset && !e.parentOffset.enabled),
  );
  assert.deepEqual(activated.animationTracks.slice(0, p.animationTracks.length), p.animationTracks);
  samePose(p, activated, f.sceneId, 24);
  const out = exportGLB(bakedProject(p, f.sceneId, options).project, f.sceneId, 0, new Map(), true);
  const report = await validateBytes(out.bytes);
  assert.equal(report.issues.numErrors, 0);
  assert.equal(report.issues.numWarnings, 0);
  const loaded = await new GLTFLoader().parseAsync(Uint8Array.from(out.bytes).buffer, ''),
    mixer = new AnimationMixer(loaded.scene),
    play = mixer.clipAction(loaded.animations[0]);
  play.setLoop(LoopOnce, 1);
  play.clampWhenFinished = true;
  play.play();
  let skin: SkinnedMesh | undefined;
  loaded.scene.traverse((o) => {
    if (o instanceof SkinnedMesh) skin = o;
  });
  assert.ok(skin);
  const mesh = p.entities.find((e) => e.id === f.meshId)!,
    g = p.geometries.find((g) => g.id === mesh.geometryId)!;
  for (const frame of [0, 6, 12, 24, 36, 47]) {
    mixer.setTime(frame / 24);
    loaded.scene.updateMatrixWorld(true);
    skin.skeleton.update();
    const expected = deformGeometry(g, mesh.skin!, sceneEvaluator(p, f.sceneId)(frame).world);
    g.triangles
      .flat()
      .forEach((index, i) =>
        near(
          skin!.getVertexPosition(i, new Vector3()).applyMatrix4(skin!.matrixWorld).toArray(),
          expected.positions[index],
          3e-5,
        ),
      );
  }
});

test('v17 migration preserves snapshots, offsets persist across restart, and group undo restores hierarchy', () => {
  const parent = resolve(tmpdir()),
    directory = mkdtempSync(join(parent, 'frameforge-parent-'));
  let store = new Store(directory);
  try {
    const f = parentingFixture(),
      created = store.create(f.p).project;
    const legacy = { ...created, schemaVersion: 17 };
    assert.deepEqual(migrateProject(legacy), { ...legacy, schemaVersion: PROJECT_VERSION });
    store.db
      .prepare('UPDATE projects SET json=?,history=? WHERE id=?')
      .run(JSON.stringify(legacy), JSON.stringify([legacy]), created.id);
    for (const row of store.db.prepare('SELECT id,snapshot FROM revisions').all() as {
      id: string;
      snapshot: string;
    }[])
      store.db
        .prepare('UPDATE revisions SET snapshot=? WHERE id=?')
        .run(JSON.stringify({ ...JSON.parse(row.snapshot), schemaVersion: 17 }), row.id);
    store.close();
    store = new Store(directory);
    assert.equal(store.get(created.id).project.schemaVersion, 18);
    const backup = new DatabaseSync(
      join(directory, 'backups', readdirSync(join(directory, 'backups'))[0]),
      { readOnly: true },
    );
    assert.equal(
      JSON.parse((backup.prepare('SELECT json FROM projects').get() as { json: string }).json)
        .schemaVersion,
      17,
    );
    backup.close();
    const next = store.change(
      created.id,
      created.revision,
      [reparent(f.selected, f.newParent)],
      'agent',
      'reparent',
    ).project;
    store.close();
    store = new Store(directory);
    assert.deepEqual(store.get(created.id).project.entities, next.entities);
    const undone = store.change(
      created.id,
      next.revision,
      undefined,
      'user',
      'undo',
      'undo',
    ).project;
    assert.deepEqual(undone.entities, created.entities);
    const redone = store.change(
      created.id,
      undone.revision,
      undefined,
      'user',
      'redo',
      'redo',
    ).project;
    assert.deepEqual(redone.entities, next.entities);
  } finally {
    store.close();
    assert.ok(resolve(directory).startsWith(parent + sep));
    rmSync(directory, { recursive: true, force: true });
  }
});

test('retarget activation preserves an attached target reference while disabling its baked offset', () => {
  const f = retargetFixture(),
    p = f.p;
  const targetRoot = p.entities.find((e) => e.id === f.profile.targetRootId)!;
  targetRoot.parentOffset = {
    enabled: true,
    matrix: new Matrix4().makeTranslation(0.2, 0, 0).toArray(),
  };
  const before = structuredClone(p);
  const action = { id: id(), sceneId: targetRoot.sceneId, name: 'Retarget attachment' };
  const next = applyCommands(p, [
    { type: 'retarget.put', profile: f.profile },
    { type: 'retarget.bake', profileId: f.profile.id, action, options: f.options, activate: true },
  ]).project;
  assert.equal(next.entities.find((e) => e.id === targetRoot.id)!.parentOffset!.enabled, false);
  assert.deepEqual(
    next.entities.find((e) => e.id === targetRoot.id)!.parentOffset!.matrix,
    targetRoot.parentOffset.matrix,
  );
  assert.deepEqual(p, before);
  parseProject(next);
});
