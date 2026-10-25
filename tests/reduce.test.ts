import test from 'node:test';
import assert from 'node:assert/strict';
import { Quaternion, Vector3, AnimationMixer, LoopOnce, SkinnedMesh } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { validateBytes } from 'gltf-validator';
import { mkdtempSync, rmSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { newProject } from '../src/core/factory';
import { id, type AnimationTrack, type Vec3, type Vec4, type Project } from '../src/core/model';
import { reduceAction, type ReduceOptions } from '../src/core/reduce-curves';
import { sampleCurve, type NumericCurve } from '../src/core/animation';
import { applyCommands } from '../src/core/commands';
import { ikFixture } from '../scripts/ik-fixture';
import { reduceFixture } from '../scripts/reduce-fixture';
import { Store } from '../server/store';
import { exportGLB } from '../src/core/gltf';
import { sceneEvaluator } from '../src/core/constraints';
import { deformGeometry } from '../src/core/skin';

const options: ReduceOptions = {
  actionId: null,
  start: 0,
  end: 120,
  position: 0.001,
  rotationDegrees: 0.1,
  scale: 0.001,
  influence: 0.001,
};
function base() {
  const p = newProject(),
    sceneId = p.scenes[0].id,
    entityId = p.entities.find((e) => e.kind === 'mesh')!.id;
  return { p, sceneId, entityId };
}
const curve = (
  entityId: string,
  property: AnimationTrack['property'],
  values: [number, Vec3 | Vec4][],
  interpolation: 'linear' | 'constant' | 'smooth' | 'bezier' = 'linear',
): AnimationTrack => ({
  id: id(),
  entityId,
  property,
  keys: values.map(([frame, value]) => ({ id: id(), frame, value, interpolation })),
});
function angular(a: number[], b: number[]) {
  return (
    (new Quaternion(...(a as Vec4))
      .normalize()
      .angleTo(new Quaternion(...(b as Vec4)).normalize()) *
      180) /
    Math.PI
  );
}
function compare(
  a: NumericCurve,
  b: NumericCurve,
  start: number,
  end: number,
  tolerance: number,
  samples = 1600,
) {
  let maximum = 0;
  for (let i = 0; i <= samples; i++) {
    const frame = start + ((end - start) * i) / samples,
      x = sampleCurve(a, frame)!,
      y = sampleCurve(b, frame)!;
    const difference =
      a.property === 'quaternion' ? angular(x, y) : Math.hypot(...x.map((v, k) => v - y[k]));
    assert.ok(difference <= tolerance + 1e-10, `frame ${frame}: ${difference} > ${tolerance}`);
    maximum = Math.max(maximum, difference);
  }
  return maximum;
}

test('dense linear motion reduces to endpoints with grouped vector tolerance, stable time and untouched source keys', () => {
  const { p, sceneId, entityId } = base();
  p.animationTracks = [
    curve(
      entityId,
      'position',
      Array.from({ length: 121 }, (_, frame) => [
        frame,
        [frame * 0.02, frame * 0.01, -frame * 0.03],
      ]),
    ),
    curve(
      entityId,
      'scale',
      Array.from({ length: 121 }, (_, frame) => [frame, [1, 1, 1]]),
    ),
  ];
  const snapshot = structuredClone(p),
    result = reduceAction(p, sceneId, options);
  assert.equal(result.stats.outputKeys, 4);
  assert.equal(result.stats.removed, 238);
  assert.deepEqual(p, snapshot);
  for (let i = 0; i < p.animationTracks.length; i++) {
    compare(p.animationTracks[i], result.tracks[i], -3, 130, 1e-10);
    assert.notEqual(result.tracks[i].id, p.animationTracks[i].id);
    assert.ok(
      result.tracks[i].keys.every((k) => !p.animationTracks[i].keys.some((old) => old.id === k.id)),
    );
  }
});

test('a dense triangular path retains its bend without keeping the approach samples', () => {
  const { p, sceneId, entityId } = base();
  p.animationTracks = [
    curve(
      entityId,
      'position',
      Array.from({ length: 121 }, (_, frame) => [frame, [frame <= 60 ? frame : 120 - frame, 0, 0]]),
    ),
  ];
  const result = reduceAction(p, sceneId, options);
  assert.deepEqual(
    result.tracks[0].keys.map((k) => k.frame),
    [0, 60, 120],
  );
  compare(p.animationTracks[0], result.tracks[0], 0, 120, 1e-10);
});

test('time-warped Bezier and cubic interior extrema cannot disappear just because source keys agree', () => {
  const { p, sceneId, entityId } = base();
  const bezier = curve(
    entityId,
    'position',
    [
      [0, [0, 0, 0]],
      [10, [0, 0, 0]],
      [20, [0, 0, 0]],
    ],
    'bezier',
  );
  for (const k of bezier.keys)
    k.handles = [0, 1, 2].map((axis) => ({
      mode: 'free',
      left: [-2 - axis * 0.3, axis ? 0 : 5],
      right: [1 + axis, axis ? 0 : 5],
    })) as NonNullable<typeof k.handles>;
  const cubic = structuredClone(bezier);
  cubic.id = id();
  cubic.property = 'scale';
  for (const k of cubic.keys) {
    k.value = [1, 1, 1];
    k.interpolation = 'cubic';
    delete k.handles;
    k.inTangent = [-2, 0, 0];
    k.outTangent = [2, 0, 0];
  }
  p.animationTracks = [bezier, cubic];
  const result = reduceAction(p, sceneId, options);
  assert.equal(result.stats.removed, 0);
  result.tracks.forEach((t, i) => compare(p.animationTracks[i], t, 0, 20, 0));
  assert.ok(sampleCurve(bezier, 4)![0] > 1);
  assert.ok(sampleCurve(cubic, 5)![0] > 1);
});

test('range reduction freezes effective automatic handles so retained Bezier intervals outside the range do not change', () => {
  const { p, sceneId, entityId } = base(),
    values = [0, 2, 3, 3.2, 4, 5, 8];
  const source = curve(
    entityId,
    'position',
    values.map((v, frame) => [frame, [v, 0, 0]]),
    'bezier',
  );
  p.animationTracks = [source];
  const result = reduceAction(p, sceneId, { ...options, start: 2, end: 5, position: 1 }),
    reduced = result.tracks[0];
  assert.deepEqual(
    reduced.keys.map((k) => k.frame),
    [0, 1, 2, 5, 6],
  );
  assert.ok(reduced.keys[2].handles?.every((h) => h.mode === 'free'));
  assert.equal(source.keys[2].handles, undefined);
  compare(source, reduced, -1, 2, 1e-11);
  compare(source, reduced, 5, 8, 1e-11);
  compare(source, reduced, 2, 5, 1);
});

test('STEP discontinuities and Float32 guard neighborhoods survive generous tolerances', () => {
  const { p, sceneId, entityId } = base();
  const step = curve(
    entityId,
    'position',
    [
      [0, [0, 0, 0]],
      [2, [0, 0, 0]],
      [4, [0, 0, 0]],
      [5, [1, 0, 0]],
      [7, [1, 0, 0]],
      [9, [1, 0, 0]],
    ],
    'constant',
  );
  const guarded = curve(entityId, 'scale', [
    [0, [1, 1, 1]],
    [4, [1, 1, 1]],
    [4.000001, [2, 1, 1]],
    [8, [2, 1, 1]],
    [9, [2, 1, 1]],
  ]);
  p.animationTracks = [step, guarded];
  const result = reduceAction(p, sceneId, { ...options, position: 10, scale: 10 });
  assert.ok(result.stats.removed > 0);
  for (const frame of [4, 5]) assert.ok(result.tracks[0].keys.some((k) => k.frame === frame));
  for (const frame of [4, 4.000001])
    assert.ok(result.tracks[1].keys.some((k) => k.frame === frame));
  compare(step, result.tracks[0], 0, 9, 0);
  compare(guarded, result.tracks[1], 3.999999, 4.000002, 1e-9);
});

test('Euler winding and quaternion loops retain their paths, while redundant slerp samples reduce', () => {
  const { p, sceneId, entityId } = base(),
    axis = new Vector3(0, 1, 0);
  const euler = curve(entityId, 'rotation', [
    [0, [0, 0, 0]],
    [30, [0, Math.PI * 2, 0]],
    [60, [0, 0, 0]],
  ]);
  p.animationTracks = [euler];
  assert.equal(reduceAction(p, sceneId, options).tracks[0].keys.length, 3);
  const q = curve(
    entityId,
    'quaternion',
    Array.from({ length: 61 }, (_, frame) => [
      frame,
      new Quaternion().setFromAxisAngle(axis, (frame * Math.PI) / 90).toArray(),
    ]),
  );
  p.animationTracks = [q];
  const result = reduceAction(p, sceneId, options);
  assert.equal(result.tracks[0].keys.length, 2);
  compare(q, result.tracks[0], 0, 60, result.stats.details[0].bound + 0.00001);
  assert.ok(result.stats.details[0].bound <= options.rotationDegrees);
  const loop = curve(
    entityId,
    'quaternion',
    [0, 1, 2, 3, 4].map((frame) => [
      frame,
      new Quaternion().setFromAxisAngle(axis, (frame * Math.PI) / 2).toArray(),
    ]),
  );
  p.animationTracks = [loop];
  const retained = reduceAction(p, sceneId, options);
  assert.ok(retained.tracks[0].keys.length > 2);
  compare(loop, retained.tracks[0], 0, 4, options.rotationDegrees);
});

test('normalized quaternion Hermite interiors are bounded and reducible, with hidden rotation bumps preserved', () => {
  const { p, sceneId, entityId } = base(),
    rate = Math.PI / 180;
  const q = curve(
    entityId,
    'quaternion',
    [0, 10, 20, 30].map((frame) => [
      frame,
      [0, Math.sin((frame * rate) / 2), 0, Math.cos((frame * rate) / 2)],
    ]),
  );
  for (const k of q.keys) {
    k.interpolation = 'cubic';
    k.inTangent = k.outTangent = [
      0,
      (rate / 2) * Math.cos((k.frame * rate) / 2),
      0,
      (-rate / 2) * Math.sin((k.frame * rate) / 2),
    ];
  }
  p.animationTracks = [q];
  const result = reduceAction(p, sceneId, options);
  assert.equal(result.tracks[0].keys.length, 2);
  compare(q, result.tracks[0], 0, 30, options.rotationDegrees);
  const bump = curve(
    entityId,
    'quaternion',
    [0, 1, 2].map((frame) => [frame, [0, 0, 0, 1]]),
  );
  for (const k of bump.keys) {
    k.interpolation = 'cubic';
    k.outTangent = [12, 0, 0, 0];
    k.inTangent = [-12, 0, 0, 0];
  }
  p.animationTracks = [bump];
  const kept = reduceAction(p, sceneId, options);
  assert.equal(kept.stats.removed, 0);
  compare(bump, kept.tracks[0], 0, 2, 0.00001);
});

test('single-component IK curves retain clamp crossings and unwrapped pole motion; scale zero crossings stay exact', () => {
  const f = ikFixture(),
    p = f.p,
    chain = p.ikChains![0];
  const values = [0, 0, 0, 0.5, 1, 1, 1, 0.5, 0, 0, 0];
  p.ikTracks = [
    {
      id: id(),
      entityId: chain.joints[0],
      chainId: chain.id,
      property: 'influence',
      keys: values.map((value, frame) => ({
        id: id(),
        frame,
        value: [value],
        interpolation: 'linear',
      })),
    },
    {
      id: id(),
      entityId: chain.joints[0],
      chainId: chain.id,
      property: 'poleAngle',
      keys: Array.from({ length: 11 }, (_, frame) => ({
        id: id(),
        frame,
        value: [frame * 0.1],
        interpolation: 'linear',
      })),
    },
  ];
  const scale = curve(f.meshId, 'scale', [
    [0, [1, 1, 1]],
    [5, [1, 1, 1]],
    [10, [1, 1, 1]],
  ]);
  for (const k of scale.keys) {
    k.interpolation = 'cubic';
    k.inTangent = [2, 0, 0];
    k.outTangent = [-2, 0, 0];
  }
  p.animationTracks.push(scale);
  const result = reduceAction(p, f.sceneId, options);
  assert.ok(result.ikTracks[0].keys.length < values.length);
  assert.equal(result.ikTracks[1].keys.length, 2);
  assert.ok(result.ikTracks.every((t) => t.keys.every((k) => k.value.length === 1)));
  for (const frame of [2, 3, 4, 6, 7, 8])
    assert.ok(result.ikTracks[0].keys.some((k) => k.frame === frame));
  compare(p.ikTracks[0], result.ikTracks[0], 0, 10, 0);
  const scaleOut = result.tracks.find((t) => t.entityId === f.meshId && t.property === 'scale')!;
  assert.equal(scaleOut.keys.length, 3);
  compare(scale, scaleOut, 0, 10, 0);
});

test('reduction is an atomic new action with source metadata intact; invalid ranges and IDs reject', () => {
  const { p, sceneId, entityId } = base();
  p.animationTracks = [
    curve(
      entityId,
      'position',
      Array.from({ length: 9 }, (_, frame) => [frame, [frame, 0, 0]]),
    ),
  ];
  const snapshot = structuredClone(p),
    action = { id: id(), name: 'reduced', sceneId };
  const next = applyCommands(p, [
    { type: 'action.reduce', action, options, activate: true },
  ]).project;
  assert.deepEqual(p, snapshot);
  assert.deepEqual(next.entities, p.entities);
  assert.deepEqual(
    next.animationTracks.filter((t) => !t.actionId),
    p.animationTracks,
  );
  assert.equal(next.scenes[0].activeActionId, action.id);
  assert.equal(next.animationTracks.filter((t) => t.actionId === action.id)[0].keys.length, 2);
  const off = reduceAction(p, sceneId, { ...options, position: 0 });
  assert.equal(off.stats.removed, 0);
  assert.throws(
    () =>
      applyCommands(p, [
        { type: 'action.reduce', action, options: { ...options, end: 0 }, activate: true },
      ]),
    /终点/,
  );
  assert.throws(() => reduceAction(p, sceneId, { ...options, actionId: id() }), /源动作/);
  assert.throws(() => reduceAction(p, sceneId, { ...options, scale: -1 }));
  assert.throws(
    () => applyCommands(next, [{ type: 'action.reduce', action, options, activate: true }]),
    /重复/,
  );
  assert.deepEqual(p, snapshot);
});

test('uncertain quaternion intervals stop at the work budget and preserve unresolved source segments', () => {
  const { p, sceneId, entityId } = base(),
    axis = new Vector3(0, 1, 0);
  p.animationTracks = [
    curve(
      entityId,
      'quaternion',
      Array.from({ length: 11 }, (_, frame) => [
        frame / 16,
        new Quaternion().setFromAxisAngle(axis, (frame * Math.PI) / 45).toArray(),
      ]),
    ),
  ];
  const result = reduceAction(p, sceneId, { ...options, rotationDegrees: 0.001 });
  assert.equal(result.stats.exhausted, true);
  assert.equal(result.stats.checks, 1000000);
  assert.equal(result.tracks[0].keys.length, 11);
  compare(p.animationTracks[0], result.tracks[0], 0, 0.625, 0.00001);
  assert.ok(result.notes.some((n) => n.includes('未确认')));
});

test('reduced action, source channels and all rig metadata survive a durable undo/redo and process restart', () => {
  const parent = resolve(tmpdir()),
    directory = mkdtempSync(join(parent, 'frameforge-reduce-'));
  let store = new Store(directory);
  try {
    const f = reduceFixture(),
      p = store.create(f.p).project,
      action = { id: id(), sceneId: f.sceneId, name: 'Durable reduction' };
    const saved = store.change(
      p.id,
      p.revision,
      [{ type: 'action.reduce', action, options: f.options, activate: true }],
      'agent',
      'reduce',
    ).project;
    assert.deepEqual(saved.entities, p.entities);
    assert.deepEqual(saved.ikChains, p.ikChains);
    assert.deepEqual(saved.animationLayers, p.animationLayers);
    assert.deepEqual(saved.retargetProfiles, p.retargetProfiles);
    store.close();
    store = new Store(directory);
    assert.deepEqual(store.get(p.id).project, saved);
    const undo = store.change(p.id, saved.revision, undefined, 'user', 'undo', 'undo').project;
    assert.deepEqual(undo.animationTracks, p.animationTracks);
    assert.deepEqual(undo.scenes, p.scenes);
    const redo = store.change(p.id, undo.revision, undefined, 'user', 'redo', 'redo').project;
    assert.deepEqual(redo.animationTracks, saved.animationTracks);
    assert.deepEqual(redo.scenes, saved.scenes);
  } finally {
    store.close();
    assert.ok(resolve(directory).startsWith(parent + sep));
    rmSync(directory, { recursive: true });
  }
});

globalThis.ProgressEvent ||= class extends Event {
  lengthComputable = false;
  loaded = 0;
  total = 0;
} as typeof ProgressEvent;
test('native reduced GLB retains the smaller action and independent playback matches every skinned vertex and camera', async () => {
  const f = reduceFixture(),
    action = { id: id(), sceneId: f.sceneId, name: 'Reduced performance' },
    p = applyCommands(f.p, [
      { type: 'action.reduce', action, options: f.options, activate: true },
    ]).project;
  const before = f.p.animationTracks
      .filter((t) => t.actionId === f.sourceActionId)
      .reduce((n, t) => n + t.keys.length, 0),
    after = p.animationTracks
      .filter((t) => t.actionId === action.id)
      .reduce((n, t) => n + t.keys.length, 0);
  assert.ok(before > 2000);
  assert.ok(after < before / 10);
  const output = exportGLB(p, f.sceneId, 0, new Map(), true),
    report = await validateBytes(output.bytes);
  assert.equal(report.issues.numErrors, 0);
  assert.equal(report.issues.numWarnings, 0);
  const loaded = await new GLTFLoader().parseAsync(Uint8Array.from(output.bytes).buffer, ''),
    clip = loaded.animations.find((a) => a.name === action.name)!;
  assert.ok(clip);
  assert.equal(
    clip.tracks.reduce((n, t) => n + t.times.length, 0),
    after,
  );
  const mixer = new AnimationMixer(loaded.scene),
    play = mixer.clipAction(clip);
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
  const near = (a: number[], b: number[], epsilon = 2e-5) =>
    a.forEach((v, i) => assert.ok(Math.abs(v - b[i]) <= epsilon, `${v} != ${b[i]}`));
  let sourceDifference = 0;
  for (const frame of [0, 6.25, 12, 17.125, 24, 36, 36.5, 47]) {
    mixer.setTime(frame / 24);
    loaded.scene.updateMatrixWorld(true);
    skin.skeleton.update();
    const pose = sceneEvaluator(p, f.sceneId)(frame),
      expected = deformGeometry(g, mesh.skin!, pose.world),
      original = deformGeometry(g, mesh.skin!, sceneEvaluator(f.p, f.sceneId)(frame).world);
    g.triangles.flat().forEach((index, i) => {
      near(
        skin!.getVertexPosition(i, new Vector3()).applyMatrix4(skin!.matrixWorld).toArray(),
        expected.positions[index],
      );
      sourceDifference = Math.max(
        sourceDifference,
        Math.hypot(
          ...expected.positions[index].map((v, axis) => v - original.positions[index][axis]),
        ),
      );
    });
    near(loaded.cameras[0].matrixWorld.elements, pose.world.get(f.cameraId)!.elements);
  }
  // This is a measured bound for this fixture, not a world-space promise for
  // arbitrary hierarchy lengths, constraints, layers or contact-sensitive rigs.
  assert.ok(sourceDifference < 0.02, String(sourceDifference));
});
