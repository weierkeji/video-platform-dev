import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { AnimationMixer, LoopOnce, SkinnedMesh, Vector3 } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { validateBytes } from 'gltf-validator';
import { id, identity, parseProject, type Project } from '../src/core/model';
import { applyCommands } from '../src/core/commands';
import { sceneEvaluator } from '../src/core/constraints';
import { evaluatedIK } from '../src/core/ik-animation';
import { evaluatedBaseTransform } from '../src/core/evaluate';
import { deformGeometry } from '../src/core/skin';
import { exportGLB } from '../src/core/gltf';
import { Store } from '../server/store';
import { ikFixture } from '../scripts/ik-fixture';
import { ikLimitsFixture } from '../scripts/ik-limits-fixture';
import { ikMatchFixture } from '../scripts/ik-match-fixture';

globalThis.ProgressEvent ||= class extends Event {
  lengthComputable = false;
  loaded = 0;
  total = 0;
} as typeof ProgressEvent;
const near = (a: number[], b: number[], tolerance = 1e-6) => {
  assert.equal(a.length, b.length);
  a.forEach((v, i) => assert.ok(Math.abs(v - b[i]) < tolerance, `${v} != ${b[i]}`));
};
const match = (p: Project, mode: 'fk' | 'ik', frame = 17.25) =>
  applyCommands(p, [
    { type: 'ik.match', chainId: p.ikChains![0].id, frame, mode, interpolation: 'constant' },
  ]).project;
function samePose(a: Project, b: Project, frame = 17.25) {
  const before = sceneEvaluator(a, a.scenes[0].id)(frame),
    after = sceneEvaluator(b, b.scenes[0].id)(frame);
  for (const id of a.ikChains![0].joints)
    near(before.world.get(id)!.elements, after.world.get(id)!.elements);
  for (const mesh of a.entities.filter((e) => e.skin)) {
    const g = a.geometries.find((g) => g.id === mesh.geometryId)!;
    const old = deformGeometry(g, mesh.skin!, before.world),
      next = deformGeometry(g, mesh.skin!, after.world);
    old.positions.forEach((v, i) => near(v, next.positions[i]));
  }
  assert.deepEqual(a.geometries, b.geometries);
  assert.deepEqual(
    a.entities.map((e) => e.skin),
    b.entities.map((e) => e.skin),
  );
  assert.deepEqual(
    a.entities.map((e) => e.restPose),
    b.entities.map((e) => e.restPose),
  );
}

test('matching captures partial IK, retains every joint and skin matrix, then returns to controllable IK', () => {
  const f = ikFixture(),
    p = f.p;
  p.ikChains![0].influence = 0.43;
  const fk = match(p, 'fk');
  samePose(p, fk);
  assert.equal(evaluatedIK(fk, fk.ikChains![0], 17.25).influence, 0);
  const ik = match(fk, 'ik');
  samePose(fk, ik);
  assert.equal(evaluatedIK(ik, ik.ikChains![0], 17.25).influence, 1);
  const target = ik.animationTracks.find(
    (t) => t.entityId === f.targetId && t.property === 'position',
  )!;
  const key = target.keys.find((k) => k.frame === 17.25)!;
  const moved = applyCommands(ik, [
    {
      type: 'key.update',
      trackId: target.id,
      keyId: key.id,
      patch: { value: [key.value[0] + 0.15, key.value[1], key.value[2]] },
    },
  ]).project;
  const before = sceneEvaluator(ik, f.sceneId)(17.25).world.get(f.tipId)!,
    after = sceneEvaluator(moved, f.sceneId)(17.25).world.get(f.tipId)!;
  assert.ok(
    new Vector3()
      .setFromMatrixPosition(before)
      .distanceTo(new Vector3().setFromMatrixPosition(after)) > 0.1,
  );
});

test('rest offsets and reflected nonuniform controller parents are inverted without changing bindings', () => {
  const f = ikFixture();
  let p = f.p;
  const parent = {
    id: id(),
    name: 'Control parent',
    sceneId: f.sceneId,
    kind: 'group' as const,
    parentId: null,
    visible: true,
    transform: {
      ...identity(),
      scale: [-1.4, 0.8, 1.2] as [number, number, number],
      rotation: [0.2, 0.1, -0.3] as [number, number, number],
    },
  };
  p.entities.push(parent);
  p.entities.find((e) => e.id === f.targetId)!.parentId = parent.id;
  p.entities.find((e) => e.id === f.poleId)!.parentId = f.targetId;
  const joint = p.entities.find((e) => e.id === f.elbowId)!;
  p = applyCommands(p, [
    {
      type: 'rig.rest.update',
      preserveShape: true,
      updates: [
        { entityId: joint.id, transform: { ...joint.transform, rotation: [0.15, -0.2, 0.25] } },
      ],
    },
  ]).project;
  const fk = match(p, 'fk');
  samePose(p, fk);
  const ik = match(fk, 'ik');
  samePose(fk, ik);
});

test('matching reverses additive and partial replacement layers including the near-linear quaternion branch', () => {
  for (const angle of [0.03, 0.4]) {
    const f = ikFixture(),
      p = f.p,
      action = { id: id(), sceneId: f.sceneId, name: 'Layer source' };
    p.animationActions = [action];
    p.animationTracks.push({
      id: id(),
      entityId: f.elbowId,
      actionId: action.id,
      property: 'rotation',
      keys: [{ id: id(), frame: 0, value: [angle, 0, 0], interpolation: 'linear' }],
    });
    p.animationTracks.push({
      id: id(),
      entityId: f.rootJointId,
      actionId: action.id,
      property: 'position',
      keys: [{ id: id(), frame: 0, value: [0.2, 0.1, 0.1], interpolation: 'linear' }],
    });
    const layer = {
      id: id(),
      name: 'Mix',
      entityId: f.elbowId,
      actionId: action.id,
      enabled: true,
      blend: 'replace' as const,
      weight: 0.2,
      channels: ['rotation'] as 'rotation'[],
      start: 0,
      duration: 49,
      fadeIn: 2,
      fadeOut: 2,
      sourceIn: 0,
      playback: { rate: 1, rangeStart: 0, rangeEnd: 48, mode: 'hold' as const },
    };
    p.animationLayers = [
      layer,
      {
        ...layer,
        id: id(),
        entityId: f.rootJointId,
        channels: ['position'],
        blend: 'additive',
        weight: 0.4,
      },
    ];
    const fk = match(parseProject(p), 'fk');
    samePose(p, fk);
    const ik = match(fk, 'ik');
    samePose(fk, ik);
    assert.deepEqual(ik.animationLayers, p.animationLayers);
    assert.deepEqual(
      ik.animationTracks.filter((t) => t.actionId === action.id),
      p.animationTracks.filter((t) => t.actionId === action.id),
    );
    // Start from a tiny FK rotation to exercise the normalized-linear branch.
    p.ikChains![0].influence = 0;
    const fromFK = match(p, 'ik');
    samePose(p, fromFK);
    near(
      evaluatedBaseTransform(fromFK, fromFK.entities.find((e) => e.id === f.elbowId)!, 17.25)
        .rotation,
      [0, 0, 0],
      1e-8,
    );
    p.animationLayers![0].weight = 1;
    samePose(p, match(p, 'ik'));
  }
});

test('matching inverts feasible IK parameter layers while retaining their actions and masks', () => {
  for (const mode of ['fk', 'ik'] as const) {
    const f = ikFixture(),
      p = f.p,
      chain = p.ikChains![0];
    const action = { id: id(), name: 'Parameter source', sceneId: f.sceneId };
    p.animationActions = [action];
    chain.influence = mode === 'fk' ? 1 : 0;
    p.ikTracks = [
      {
        id: id(),
        chainId: chain.id,
        entityId: chain.joints[0],
        property: 'influence',
        actionId: action.id,
        keys: [{ id: id(), frame: 0, value: [mode === 'fk' ? 0 : 1], interpolation: 'constant' }],
      },
    ];
    p.animationLayers = [
      {
        id: id(),
        name: 'Parameter mix',
        entityId: chain.joints[0],
        actionId: action.id,
        enabled: true,
        blend: 'replace',
        weight: 0.35,
        channels: ['ik'],
        start: 0,
        duration: 49,
        fadeIn: 0,
        fadeOut: 0,
        sourceIn: 0,
        playback: { rate: 1, rangeStart: 0, rangeEnd: 48, mode: 'hold' },
      },
    ];
    const next = match(parseProject(p), mode);
    samePose(p, next);
    assert.equal(evaluatedIK(next, chain, 17.25).influence, mode === 'fk' ? 0 : 1);
    assert.deepEqual(next.animationLayers, p.animationLayers);
    assert.deepEqual(
      next.ikTracks!.filter((t) => t.actionId),
      p.ikTracks,
    );
  }
});

test('current action routing, existing key identities, rotation representation and other actions survive matching', () => {
  const f = ikFixture();
  let p = f.p;
  const action = { id: id(), name: 'Pose action', sceneId: f.sceneId };
  p = applyCommands(p, [
    { type: 'action.add', action, copyFrom: null },
    {
      type: 'key.set',
      entityId: f.rootJointId,
      property: 'quaternion',
      key: { frame: 17.25, value: [0, 0, 0, 1], interpolation: 'linear' },
    },
  ]).project;
  const rootTrack = p.animationTracks.find(
    (t) => t.entityId === f.rootJointId && t.actionId === action.id,
  )!;
  const original = structuredClone(p);
  const fk = match(p, 'fk');
  samePose(p, fk);
  const next = fk.animationTracks.find((t) => t.id === rootTrack.id)!;
  assert.equal(next.keys[0].id, rootTrack.keys[0].id);
  assert.equal(next.keys[0].interpolation, 'linear');
  assert.deepEqual(
    fk.animationTracks.filter((t) => !t.actionId),
    original.animationTracks.filter((t) => !t.actionId),
  );
  assert.ok(fk.ikTracks!.every((t) => t.actionId === action.id));
  assert.equal(
    fk.animationTracks.some(
      (t) => t.entityId === f.rootJointId && t.actionId === action.id && t.property === 'rotation',
    ),
    false,
  );
});

test('straight and fully folded limbs match without choosing a different bend direction', () => {
  for (const folded of [false, true]) {
    const f = ikFixture(),
      p = f.p;
    p.animationTracks = [];
    p.ikChains![0].influence = 0;
    p.entities.find((e) => e.id === f.elbowId)!.transform.rotation = [0, 0, folded ? Math.PI : 0];
    const ik = match(p, 'ik');
    samePose(p, ik);
    const fk = match(ik, 'fk');
    samePose(ik, fk);
  }
});

test('multi-segment input without a pole and valid limited chains remain matchable', () => {
  const f = ikFixture(),
    p = f.p,
    middle = {
      id: id(),
      name: 'Third segment',
      sceneId: f.sceneId,
      parentId: f.elbowId,
      kind: 'group' as const,
      visible: true,
      joint: true,
      transform: { ...identity(), position: [0.15, 0.7, 0.1] as [number, number, number] },
    };
  p.entities.push(middle);
  const tip = p.entities.find((e) => e.id === f.tipId)!;
  tip.parentId = middle.id;
  tip.transform.position = [0.1, 0.5, 0.2];
  p.ikChains![0].joints.splice(2, 0, middle.id);
  p.ikChains![0].poleId = null;
  p.ikChains![0].influence = 0;
  const ik = match(parseProject(p), 'ik');
  samePose(p, ik);
  const limited = ikLimitsFixture().p,
    fk = match(limited, 'fk', 24);
  samePose(limited, fk, 24);
  const back = match(fk, 'ik', 24);
  samePose(fk, back, 24);
});

test('unrepresentable layers, active constraints and shear reject the entire batch with no source edits', () => {
  const f = ikFixture(),
    p = f.p,
    root = p.entities.find((e) => e.id === f.rootJointId)!;
  root.constraints = [
    {
      id: id(),
      name: 'Locked input',
      type: 'copy-transform',
      targetId: f.targetId,
      enabled: true,
      influence: 1,
      targetSpace: 'world',
      ownerSpace: 'world',
    },
  ];
  const original = structuredClone(p);
  assert.throws(() => match(p, 'fk'), /约束/);
  assert.deepEqual(p, original);
  const other = ikFixture().p;
  other.entities.find((e) => e.id === other.ikChains![0].joints[0])!.transform.scale = [
    1.8, 1, 0.7,
  ];
  assert.throws(() => match(other, 'fk'), /剪切|姿态偏差/);
  const layered = ikFixture().p,
    chain = layered.ikChains![0],
    action = { id: id(), name: 'Locked influence', sceneId: chain.sceneId };
  layered.animationActions = [action];
  layered.ikTracks = [
    {
      id: id(),
      entityId: chain.joints[0],
      chainId: chain.id,
      actionId: action.id,
      property: 'influence',
      keys: [{ id: id(), frame: 0, value: [0.5], interpolation: 'constant' }],
    },
  ];
  layered.animationLayers = [
    {
      id: id(),
      name: 'Parameter mask',
      entityId: chain.joints[0],
      actionId: action.id,
      enabled: true,
      blend: 'replace',
      weight: 1,
      channels: ['ik'],
      start: 0,
      duration: 49,
      fadeIn: 0,
      fadeOut: 0,
      sourceIn: 0,
      playback: { rate: 1, rangeStart: 0, rangeEnd: 48, mode: 'hold' },
    },
  ];
  assert.throws(() => match(layered, 'fk'), /参数层/);
  assert.throws(() => match(layered, 'ik'), /参数层/);
});

test('matching is one durable transaction with restart undo and redo', () => {
  const parent = resolve(tmpdir()),
    directory = mkdtempSync(join(parent, 'ff-ik-match-'));
  let store = new Store(directory);
  try {
    const p = store.create(ikFixture().p).project;
    const next = store.change(
      p.id,
      p.revision,
      [
        {
          type: 'ik.match',
          chainId: p.ikChains![0].id,
          frame: 17.25,
          mode: 'fk',
          interpolation: 'constant',
        },
      ],
      'user',
      'match',
    ).project;
    samePose(p, next);
    assert.equal(next.revision, p.revision + 1);
    store.close();
    store = new Store(directory);
    const restored = store.get(p.id)!.project;
    assert.deepEqual(restored.animationTracks, next.animationTracks);
    const undo = store.change(p.id, restored.revision, undefined, 'user', 'undo', 'undo').project;
    assert.deepEqual(undo.animationTracks, p.animationTracks);
    const redo = store.change(p.id, undo.revision, undefined, 'user', 'redo', 'redo').project;
    assert.deepEqual(redo.ikTracks, next.ikTracks);
    samePose(p, redo);
  } finally {
    store.close();
    assert.ok(resolve(directory).startsWith(parent + sep));
    rmSync(directory, { recursive: true, force: true });
  }
});

test('independent GLTFLoader matches switched sculpture skin and camera at switch frames and fractional frames', async () => {
  const f = ikMatchFixture(),
    p = f.p;
  const out = exportGLB(p, f.sceneId, 0, new Map(), true, {
    start: 0,
    end: 48,
    step: 0.25,
    actionId: null,
    rebase: false,
    interpolation: 'linear',
  });
  const report = await validateBytes(out.bytes);
  assert.equal(report.issues.numErrors, 0);
  assert.equal(report.issues.numWarnings, 0);
  const loaded = await new GLTFLoader().parseAsync(Uint8Array.from(out.bytes).buffer, '');
  const mixer = new AnimationMixer(loaded.scene),
    action = mixer.clipAction(loaded.animations[0]);
  action.setLoop(LoopOnce, 1);
  action.clampWhenFinished = true;
  action.play();
  let skin: SkinnedMesh | undefined;
  loaded.scene.traverse((o) => {
    if (o instanceof SkinnedMesh) skin = o;
  });
  assert.ok(skin);
  const mesh = p.entities.find((e) => e.id === f.meshId)!,
    geometry = p.geometries.find((g) => g.id === mesh.geometryId)!;
  for (const frame of [0, 6.25, 12, 24, 36, 36.5, 47]) {
    mixer.setTime(frame / 24);
    loaded.scene.updateMatrixWorld(true);
    skin.skeleton.update();
    const pose = sceneEvaluator(p, f.sceneId)(frame),
      expected = deformGeometry(geometry, mesh.skin!, pose.world);
    near(loaded.cameras[0].matrixWorld.elements, pose.world.get(f.cameraId)!.elements, 1e-5);
    geometry.triangles
      .flat()
      .forEach((index, i) =>
        near(
          skin!.getVertexPosition(i, new Vector3()).applyMatrix4(skin!.matrixWorld).toArray(),
          expected.positions[index],
          1e-5,
        ),
      );
  }
});
