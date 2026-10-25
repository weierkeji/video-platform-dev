import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { AnimationMixer, LoopOnce, Matrix4, Quaternion, SkinnedMesh, Vector3 } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { validateBytes } from 'gltf-validator';
import { newProject } from '../src/core/factory';
import {
  id,
  identity,
  migrateProject,
  PROJECT_VERSION,
  type Entity,
  type RetargetProfile,
} from '../src/core/model';
import { applyCommands } from '../src/core/commands';
import { sceneEvaluator, transformMatrix } from '../src/core/constraints';
import { restWorld } from '../src/core/rest-pose';
import { retargetAnimation } from '../src/core/retarget';
import { retargetSubtree } from '../src/core/retarget-profile';
import type { BakeOptions } from '../src/core/bake';
import { Store } from '../server/store';
import { retargetFixture } from '../scripts/retarget-fixture';
import { exportGLB } from '../src/core/gltf';
import { deformGeometry } from '../src/core/skin';

const near = (a: number[], b: number[], epsilon = 1e-7) =>
  a.forEach((v, i) => assert.ok(Math.abs(v - b[i]) < epsilon, `${v} != ${b[i]}`));
const qnear = (a: Quaternion, b: Quaternion, epsilon = 1e-7) =>
  assert.ok(1 - Math.abs(a.dot(b)) < epsilon, `${a.toArray()} != ${b.toArray()}`);
function minimal() {
  const p = newProject(),
    sceneId = p.scenes[0].id;
  function joint(
    name: string,
    parentId: string | null,
    position: [number, number, number],
    rotation: [number, number, number],
  ): Entity {
    return {
      id: id(),
      name,
      sceneId,
      kind: 'group',
      joint: true,
      parentId,
      visible: true,
      transform: { ...identity(), position, rotation },
    };
  }
  const sp = joint('source placement', null, [-5, 0, 1], [0, 0.3, 0]),
    s0 = joint('a', sp.id, [0, 1, 0], [0.1, 0, 0.3]),
    s1 = joint('b', s0.id, [0, 1, 0], [0, 0.2, 0]),
    tp = joint('target placement', null, [4, 0, -2], [0, -0.4, 0]),
    t0 = joint('hip', tp.id, [0, 0.5, 0], [-0.2, 0.4, 0]),
    t1 = joint('hand', t0.id, [0, 2, 0], [0.3, -0.1, 0.4]);
  p.entities.push(sp, s0, s1, tp, t0, t1);
  const profile: RetargetProfile = {
    id: id(),
    name: 'different rests',
    sourceRootId: s0.id,
    targetRootId: t0.id,
    mappings: [
      { sourceId: s0.id, targetId: t0.id },
      { sourceId: s1.id, targetId: t1.id },
    ],
    rootMotion: 'scaled',
    motionScale: 2,
    alignment: [0, 0, 0, 1],
  };
  const options: BakeOptions = {
    start: 0,
    end: 24,
    step: 1,
    actionId: null,
    interpolation: 'linear',
    rebase: false,
  };
  return { p, sceneId, sp, s0, s1, tp, t0, t1, profile, options };
}
function baked(f: ReturnType<typeof minimal>) {
  const action = { id: id(), sceneId: f.sceneId, name: 'transferred' };
  const p = applyCommands(f.p, [
    { type: 'retarget.put', profile: f.profile },
    { type: 'retarget.bake', profileId: f.profile.id, action, options: f.options, activate: true },
  ]).project;
  return { p, action };
}
function orientation(m: Matrix4) {
  // Independent Gram-Schmidt basis; sign/reflection is assigned to the third axis.
  const x = new Vector3().setFromMatrixColumn(m, 0).normalize(),
    y = new Vector3().setFromMatrixColumn(m, 1);
  y.addScaledVector(x, -x.dot(y)).normalize();
  return new Quaternion().setFromRotationMatrix(
    new Matrix4().makeBasis(x, y, new Vector3().crossVectors(x, y)),
  );
}

test('rest maps to target rest with different names, lengths, rotations and actor placements', () => {
  const f = minimal(),
    original = structuredClone(f.p),
    { p } = baked(f),
    reference = restWorld(f.p, f.sceneId);
  for (const frame of [0, 5.25, 24])
    for (const node of [f.t0, f.t1])
      near(
        sceneEvaluator(p, f.sceneId)(frame).world.get(node.id)!.elements,
        reference.get(node.id)!.elements,
      );
  assert.deepEqual(f.p, original);
  assert.deepEqual(p.entities, original.entities);
  assert.equal(p.animationTracks.length, 6);
});

test('actor-space rotation delta and aligned/scaled root translation preserve target bone offsets', () => {
  const f = minimal(),
    c = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), Math.PI / 2);
  f.profile.alignment = c.toArray();
  f.p.animationTracks = [
    {
      id: id(),
      entityId: f.s0.id,
      property: 'position',
      keys: [{ id: id(), frame: 0, value: [1, 1, 0], interpolation: 'linear' }],
    },
    {
      id: id(),
      entityId: f.s1.id,
      property: 'rotation',
      keys: [{ id: id(), frame: 0, value: [0.4, -0.2, 0.6], interpolation: 'linear' }],
    },
  ];
  const { p } = baked(f),
    rest = restWorld(f.p, f.sceneId),
    source = sceneEvaluator(f.p, f.sceneId)(0, null),
    target = sceneEvaluator(p, f.sceneId)(0);
  const si = rest.get(f.sp.id)!.clone().invert(),
    ti = rest.get(f.tp.id)!.clone().invert();
  const delta = orientation(si.clone().multiply(source.world.get(f.s1.id)!)).multiply(
    orientation(si.clone().multiply(rest.get(f.s1.id)!)).invert(),
  );
  const desired = c
    .clone()
    .multiply(delta)
    .multiply(c.clone().invert())
    .multiply(orientation(ti.clone().multiply(rest.get(f.t1.id)!)));
  qnear(orientation(ti.clone().multiply(target.world.get(f.t1.id)!)), desired);
  near(new Vector3().setFromMatrixPosition(target.local.get(f.t0.id)!).toArray(), [0, 0.5, -2]);
  near(new Vector3().setFromMatrixPosition(target.local.get(f.t1.id)!).toArray(), [0, 2, 0]);
  f.profile.rootMotion = 'none';
  const frozen = baked(f).p;
  near(
    new Vector3()
      .setFromMatrixPosition(sceneEvaluator(frozen, f.sceneId)(0).local.get(f.t0.id)!)
      .toArray(),
    f.t0.transform.position,
  );
});

test('nonuniform and reflected parents retain requested actor orientation without copying source scales', () => {
  const f = minimal();
  f.s0.transform.scale = [1.2, 0.8, -1.1];
  f.t0.transform.scale = [-1.4, 0.7, 1.3];
  f.tp.transform.scale = [0.7, 1.4, -1.2];
  f.p.animationTracks = [
    {
      id: id(),
      entityId: f.s1.id,
      property: 'rotation',
      keys: [
        { id: id(), frame: 0, value: [0.5, 0.3, -0.7], interpolation: 'linear' },
        { id: id(), frame: 24, value: [-0.3, 0.6, 0.8], interpolation: 'linear' },
      ],
    },
  ];
  const { p } = baked(f),
    rest = restWorld(f.p, f.sceneId),
    si = rest.get(f.sp.id)!.clone().invert(),
    ti = rest.get(f.tp.id)!.clone().invert();
  for (const frame of [0, 7, 24]) {
    const source = sceneEvaluator(f.p, f.sceneId)(frame, null).world,
      target = sceneEvaluator(p, f.sceneId)(frame).world;
    for (const pair of f.profile.mappings) {
      const desired = orientation(si.clone().multiply(source.get(pair.sourceId)!))
        .multiply(orientation(si.clone().multiply(rest.get(pair.sourceId)!)).invert())
        .multiply(orientation(ti.clone().multiply(rest.get(pair.targetId)!)));
      qnear(orientation(ti.clone().multiply(target.get(pair.targetId)!)), desired);
    }
  }
  near(
    p.animationTracks.find((t) => t.entityId === f.t0.id && t.property === 'scale')!.keys[0].value,
    [1.4, 0.7, -1.3],
  );
});

test('partial maps preserve unmapped local rest and reuse one source for multiple destinations', () => {
  const f = minimal();
  f.profile.mappings = [{ sourceId: f.s0.id, targetId: f.t0.id }];
  f.p.animationTracks = [
    {
      id: id(),
      entityId: f.s0.id,
      property: 'rotation',
      keys: [{ id: id(), frame: 0, value: [0.6, 0.2, 0], interpolation: 'linear' }],
    },
  ];
  near(
    sceneEvaluator(baked(f).p, f.sceneId)(0).local.get(f.t1.id)!.elements,
    transformMatrix(f.t1.transform).elements,
  );
  f.profile.mappings.push({ sourceId: f.s0.id, targetId: f.t1.id });
  assert.doesNotThrow(() => baked(f));
});

test('IK FK source and extra target hierarchy sample fractional transitions; activation preserves source, bindings and stored reference', () => {
  const f = retargetFixture(),
    original = structuredClone(f.p),
    result = retargetAnimation(f.p, f.profile, f.options);
  assert.ok(result.stats.guarded > 0);
  assert.equal(result.stats.entities, 4);
  assert.equal(result.stats.mapped, 3);
  const p = applyCommands(f.p, [
    { type: 'retarget.put', profile: f.profile },
    {
      type: 'retarget.bake',
      profileId: f.profile.id,
      action: result.action,
      options: f.options,
      activate: true,
    },
  ]).project;
  assert.deepEqual(
    p.entities.filter((e) => e.sceneId === f.source.sceneId),
    original.entities.filter((e) => e.sceneId === f.source.sceneId),
  );
  assert.deepEqual(p.ikChains, original.ikChains);
  assert.deepEqual(p.geometries, original.geometries);
  assert.deepEqual(
    p.entities.find((e) => e.id === f.target.meshId)!.skin,
    original.entities.find((e) => e.id === f.target.meshId)!.skin,
  );
  assert.equal(p.entities.find((e) => e.id === f.target.joint1)!.restPose!.enabled, false);
  const repeat = retargetAnimation(p, f.profile, f.options);
  assert.deepEqual(
    repeat.tracks.map((t) => t.keys.map((k) => [k.frame, k.value])),
    result.tracks.map((t) => t.keys.map((k) => [k.frame, k.value])),
  );
  near(
    sceneEvaluator(p, f.target.sceneId)(12).local.get(f.extraId)!.elements,
    transformMatrix(p.entities.find((e) => e.id === f.extraId)!.transform).elements,
  );
  // Fractional source ranges are rebased on the same Float32 event grid as GLB.
  const rebased = retargetAnimation(f.p, f.profile, {
    ...f.options,
    start: 6.25,
    end: 36.5,
    rebase: true,
  });
  assert.equal(rebased.tracks[0].keys[0].frame, 0);
  assert.ok(Math.abs(rebased.tracks[0].keys.at(-1)!.frame - 30.25) < 1e-5);
});

test('mapping references, root overlap, duplicates, invalid alignment and output action are rejected atomically', () => {
  const f = minimal(),
    before = structuredClone(f.p);
  for (const profile of [
    { ...f.profile, targetRootId: f.s1.id },
    { ...f.profile, mappings: [f.profile.mappings[1]] },
    { ...f.profile, mappings: [...f.profile.mappings, f.profile.mappings[1]] },
    { ...f.profile, alignment: [0, 0, 0, 2] },
    { ...f.profile, mappings: [f.profile.mappings[0], { sourceId: f.sp.id, targetId: f.t1.id }] },
  ])
    assert.throws(() => applyCommands(f.p, [{ type: 'retarget.put', profile }]));
  assert.deepEqual(f.p, before);
  const p = applyCommands(f.p, [{ type: 'retarget.put', profile: f.profile }]).project;
  assert.throws(() => applyCommands(p, [{ type: 'entity.delete', id: f.s1.id }]), /重定向/);
  assert.doesNotThrow(() =>
    applyCommands(p, [
      { type: 'retarget.delete', id: f.profile.id },
      { type: 'entity.delete', id: f.s1.id },
    ]),
  );
  assert.throws(() => retargetAnimation(p, f.profile, { ...f.options, actionId: id() }), /源场景/);
  assert.throws(
    () => retargetAnimation(p, f.profile, f.options, { id: id(), name: 'invalid', sceneId: id() }),
    /目标场景/,
  );
  assert.throws(
    () => retargetAnimation(p, f.profile, { ...f.options, end: 1e6, step: 0.01 }),
    /10000/,
  );
});

test('activation disables only complete target driving scope and rejects partial IK-chain activation', () => {
  const f = retargetFixture();
  // Reverse the mapping so the target is part of the source IK chain.
  const profile = {
    ...f.profile,
    sourceRootId: f.target.joint0,
    targetRootId: f.source.elbowId,
    mappings: [
      { sourceId: f.target.joint0, targetId: f.source.elbowId },
      { sourceId: f.target.joint1, targetId: f.source.tipId },
    ],
  };
  const p = applyCommands(f.p, [{ type: 'retarget.put', profile }]).project;
  const command = {
    type: 'retarget.bake',
    profileId: profile.id,
    action: { id: id(), sceneId: f.source.sceneId, name: 'partial' },
    options: { ...f.options, actionId: f.targetActionId, end: 1 },
    activate: true,
  };
  assert.throws(() => applyCommands(p, [command]), /一部分/);
  assert.doesNotThrow(() => applyCommands(p, [{ ...command, activate: false }]));
  assert.deepEqual(p.ikChains, f.p.ikChains);
});

test('retarget profiles/actions survive SQLite restart, undo/redo and v16 migration without touching previous snapshots', () => {
  const parent = resolve(tmpdir()),
    directory = mkdtempSync(join(parent, 'frameforge-retarget-'));
  let store = new Store(directory);
  try {
    const f = minimal(),
      p = store.create(f.p).project,
      action = { id: id(), name: 'durable', sceneId: f.sceneId };
    const saved = store.change(
      p.id,
      p.revision,
      [
        { type: 'retarget.put', profile: f.profile },
        {
          type: 'retarget.bake',
          profileId: f.profile.id,
          action,
          options: f.options,
          activate: true,
        },
      ],
      'agent',
      'retarget',
    ).project;
    store.close();
    store = new Store(directory);
    assert.deepEqual(store.get(p.id).project, saved);
    const undo = store.change(p.id, saved.revision, undefined, 'user', 'undo', 'undo').project;
    assert.equal(undo.retargetProfiles, undefined);
    assert.equal(undo.animationTracks.length, 0);
    const redo = store.change(p.id, undo.revision, undefined, 'user', 'redo', 'redo').project;
    assert.deepEqual(redo.retargetProfiles, saved.retargetProfiles);
    assert.deepEqual(redo.animationTracks, saved.animationTracks);
    const old = { ...structuredClone(f.p), schemaVersion: 16 },
      upgraded = migrateProject(old);
    assert.equal(old.schemaVersion, 16);
    assert.deepEqual(upgraded, { ...old, schemaVersion: PROJECT_VERSION });
  } finally {
    store.close();
    assert.ok(resolve(directory).startsWith(parent + sep));
    rmSync(directory, { recursive: true });
  }
});

test('source layers and constraints enter the shared event grid; target drivers outside the subtree stay enabled', () => {
  const f = minimal(),
    actionId = id();
  f.p.animationActions = [{ id: actionId, name: 'layer source', sceneId: f.sceneId }];
  f.p.animationTracks.push({
    id: id(),
    entityId: f.s0.id,
    actionId,
    property: 'rotation',
    keys: [
      { id: id(), frame: 0, value: [0.4, 0.1, 0.6], interpolation: 'constant' },
      { id: id(), frame: 6.25, value: [-0.2, 0.3, -0.4], interpolation: 'linear' },
    ],
  });
  const layer = {
    id: id(),
    name: 'source layer',
    entityId: f.s0.id,
    actionId,
    enabled: true,
    blend: 'replace' as const,
    weight: 0.6,
    channels: ['rotation' as const],
    start: 4,
    duration: 8,
    sourceIn: 0,
    playback: { rate: 1, rangeStart: 0, rangeEnd: 24, mode: 'hold' as const },
    fadeIn: 0,
    fadeOut: 0,
  };
  f.p.animationLayers = [
    layer,
    { ...layer, id: id(), entityId: f.t0.id },
    { ...layer, id: id(), entityId: f.tp.id },
  ];
  f.s1.constraints = [
    {
      id: id(),
      name: 'source rotation',
      type: 'copy-transform',
      targetId: f.sp.id,
      enabled: true,
      influence: 0.4,
      ownerSpace: 'world',
      targetSpace: 'world',
    },
  ];
  f.t0.constraints = [{ ...f.s1.constraints[0], id: id(), targetId: f.tp.id }];
  f.options.step = 0.25;
  const out = retargetAnimation(f.p, f.profile, f.options),
    { p } = baked(f),
    rest = restWorld(f.p, f.sceneId),
    si = rest.get(f.sp.id)!.clone().invert();
  assert.ok(out.stats.guarded >= 3);
  assert.equal(p.animationLayers![0].enabled, true);
  assert.equal(p.animationLayers![1].enabled, false);
  assert.equal(p.animationLayers![2].enabled, true);
  assert.equal(p.entities.find((e) => e.id === f.s1.id)!.constraints![0].enabled, true);
  assert.equal(p.entities.find((e) => e.id === f.t0.id)!.constraints![0].enabled, false);
  const referenceTarget = rest.get(f.tp.id)!.clone().invert();
  // Exact source jumps may lie between adjacent Float32 output timestamps.
  // Compare away from that declared guard interval, on both sides of each jump.
  for (const frame of [3.75, 4.25, 10, 10.5, 11.75, 12.25]) {
    const source = sceneEvaluator(f.p, f.sceneId)(frame, null).world,
      target = sceneEvaluator(p, f.sceneId)(frame).world;
    const targetParent = target.get(f.tp.id)!.clone().invert();
    for (const pair of f.profile.mappings) {
      const desired = orientation(si.clone().multiply(source.get(pair.sourceId)!))
        .multiply(orientation(si.clone().multiply(rest.get(pair.sourceId)!)).invert())
        .multiply(orientation(referenceTarget.clone().multiply(rest.get(pair.targetId)!)));
      qnear(orientation(targetParent.clone().multiply(target.get(pair.targetId)!)), desired);
    }
  }
});

test('a complete target IK chain is deactivated while outside followers remain live', () => {
  const f = retargetFixture(),
    profile = {
      ...f.profile,
      sourceRootId: f.target.joint0,
      targetRootId: f.source.rootJointId,
      mappings: [
        { sourceId: f.target.joint0, targetId: f.source.rootJointId },
        { sourceId: f.spacerId, targetId: f.source.elbowId },
        { sourceId: f.target.joint1, targetId: f.source.tipId },
      ],
    };
  const p = applyCommands(f.p, [
    { type: 'retarget.put', profile },
    {
      type: 'retarget.bake',
      profileId: profile.id,
      action: { id: id(), sceneId: f.source.sceneId, name: 'reverse' },
      options: { ...f.options, actionId: f.targetActionId, end: 1 },
      activate: true,
    },
  ]).project;
  assert.equal(p.ikChains![0].enabled, false);
  const outside = f.p.entities.find((e) => e.name === 'Tip follower')!;
  assert.deepEqual(p.entities.find((e) => e.id === outside.id)!.constraints, outside.constraints);
  assert.ok(outside.constraints!.some((c) => c.enabled));
});

test('cyclic drafts and singular evaluated sources reject instead of hanging or emitting partial actions', () => {
  const f = minimal();
  const cyclic = structuredClone(f.p);
  cyclic.entities.find((e) => e.id === f.s0.id)!.parentId = f.s1.id;
  assert.throws(() => retargetSubtree(cyclic, f.s0.id), /循环/);
  f.p.animationTracks.push({
    id: id(),
    entityId: f.s1.id,
    property: 'scale',
    keys: [
      { id: id(), frame: 0, value: [0, 1, 1], interpolation: 'linear' },
      { id: id(), frame: 2, value: [-1, 1, 1], interpolation: 'linear' },
    ],
  });
  const before = structuredClone(f.p);
  assert.throws(() => baked(f), /奇异/);
  assert.deepEqual(f.p, before);
});

globalThis.ProgressEvent ||= class extends Event {
  lengthComputable = false;
  loaded = 0;
  total = 0;
} as typeof ProgressEvent;
test('retarget action exports as valid GLB and independent loader reproduces every skinned triangle vertex', async () => {
  const f = retargetFixture(),
    action = { id: id(), sceneId: f.target.sceneId, name: 'Transferred performance' },
    p = applyCommands(f.p, [
      { type: 'retarget.put', profile: f.profile },
      {
        type: 'retarget.bake',
        profileId: f.profile.id,
        action,
        options: f.options,
        activate: true,
      },
    ]).project;
  const out = exportGLB(p, f.target.sceneId, 0, new Map(), true),
    report = await validateBytes(out.bytes);
  assert.equal(report.issues.numErrors, 0);
  assert.equal(report.issues.numWarnings, 0);
  const loaded = await new GLTFLoader().parseAsync(Uint8Array.from(out.bytes).buffer, ''),
    mixer = new AnimationMixer(loaded.scene);
  const clip = loaded.animations.find((c) => c.name === action.name)!;
  assert.ok(clip);
  const play = mixer.clipAction(clip);
  play.setLoop(LoopOnce, 1);
  play.clampWhenFinished = true;
  play.play();
  let skin: SkinnedMesh | undefined;
  loaded.scene.traverse((o) => {
    if (o instanceof SkinnedMesh) skin = o;
  });
  assert.ok(skin);
  const mesh = p.entities.find((e) => e.id === f.target.meshId)!,
    g = p.geometries.find((g) => g.id === mesh.geometryId)!;
  for (const frame of [0, 6.25, 12, 24, 36, 36.5, 47]) {
    mixer.setTime(frame / 24);
    loaded.scene.updateMatrixWorld(true);
    skin.skeleton.update();
    const pose = sceneEvaluator(p, f.target.sceneId)(frame),
      expected = deformGeometry(g, mesh.skin!, pose.world);
    g.triangles
      .flat()
      .forEach((index, i) =>
        near(
          skin!.getVertexPosition(i, new Vector3()).applyMatrix4(skin!.matrixWorld).toArray(),
          expected.positions[index],
          2e-5,
        ),
      );
    const camera = p.entities.find((e) => e.sceneId === f.target.sceneId && e.kind === 'camera')!;
    near(loaded.cameras[0].matrixWorld.elements, pose.world.get(camera.id)!.elements, 1e-5);
  }
});
