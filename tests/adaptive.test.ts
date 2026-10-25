import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { Quaternion, Vector3, AnimationMixer, LoopOnce, SkinnedMesh } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { validateBytes } from 'gltf-validator';
import { newProject } from '../src/core/factory';
import { id, identity, type AnimationTrack, type Vec3 } from '../src/core/model';
import {
  bakeAnimation,
  bakedProject,
  requireBakeTolerance,
  type BakeOptions,
} from '../src/core/bake';
import { sampleAnimationGrid, type GridPoint } from '../src/core/adaptive-sampling';
import { quaternionFromEuler, sampleTrack } from '../src/core/animation';
import { evaluatedTransform } from '../src/core/evaluate';
import { sceneEvaluator } from '../src/core/constraints';
import { deformGeometry } from '../src/core/skin';
import { applyCommands, CommandSchema } from '../src/core/commands';
import { exportGLB } from '../src/core/gltf';
import { adaptiveFixture } from '../scripts/adaptive-fixture';
import { Store } from '../server/store';

const options: BakeOptions = {
  start: 0,
  end: 24,
  step: 24,
  actionId: null,
  rebase: false,
  interpolation: 'linear',
  adaptive: { position: 0.001, rotationDegrees: 0.1, scale: 0.001, minStep: 0.001 },
};
function fixture(property: AnimationTrack['property'] = 'position') {
  const p = newProject(),
    e = p.entities[0],
    sceneId = e.sceneId;
  e.transform = identity();
  p.animationTracks = [
    {
      id: id(),
      entityId: e.id,
      property,
      keys: [
        {
          id: id(),
          frame: 0,
          value: [0, 0, 0],
          interpolation: 'cubic',
          inTangent: [0, 0, 0],
          outTangent: [1, 0.5, 0],
        },
        {
          id: id(),
          frame: 24,
          value: [0, 0, 0],
          interpolation: 'cubic',
          inTangent: [1, -0.5, 0],
          outTangent: [0, 0, 0],
        },
      ],
    },
  ];
  return { p, e, sceneId };
}
const angle = (a: number[], b: number[]) =>
  (new Quaternion().fromArray(a).normalize().angleTo(new Quaternion().fromArray(b).normalize()) *
    180) /
  Math.PI;

test('adaptive bake refines Hermite interiors, retains actual endpoint poses and reports only final leaf errors', () => {
  const { p, e, sceneId } = fixture(),
    original = structuredClone(p);
  const fixed = bakeAnimation(p, sceneId, { ...options, adaptive: undefined });
  const result = bakeAnimation(p, sceneId, options);
  assert.equal(result.stats.adaptive!.satisfied, true);
  assert.ok(result.stats.samples > fixed.stats.samples);
  assert.ok(result.stats.smoothErrors.position <= options.adaptive!.position);
  assert.ok(result.stats.adaptive!.initialSmoothErrors.position > 1);
  for (let frame = 0; frame <= 24; frame += 0.013) {
    const actual = evaluatedTransform(p, e, frame).position,
      output = sampleTrack(result.tracks[0], frame)!;
    assert.ok(Math.max(...actual.map((v, i) => Math.abs(v - output[i]))) < 0.0011);
  }
  for (const key of result.tracks[0].keys)
    assert.deepEqual(key.value, evaluatedTransform(p, e, key.frame).position);
  assert.deepEqual(p, original);
});

test('supplementary probes expose multi-turn motion that exactly aliases all quarter probes', () => {
  const { p, e, sceneId } = fixture('rotation');
  p.animationTracks[0].keys = [
    { id: id(), frame: 0, value: [0, 0, 0], interpolation: 'linear' },
    { id: id(), frame: 24, value: [0, 0, 16 * Math.PI], interpolation: 'linear' },
  ];
  const fixed = bakeAnimation(p, sceneId, { ...options, adaptive: undefined });
  assert.ok(fixed.stats.errors.rotationDegrees < 1e-8);
  const result = bakeAnimation(p, sceneId, options);
  assert.ok(result.stats.adaptive!.initialSmoothErrors.rotationDegrees > 60);
  assert.equal(result.stats.adaptive!.satisfied, true);
  assert.ok(result.stats.samples > 16);
  for (let frame = 0; frame < 24; frame += 0.017)
    assert.ok(
      angle(
        quaternionFromEuler(evaluatedTransform(p, e, frame).rotation),
        sampleTrack(result.tracks[0], frame)!,
      ) < 0.101,
    );
});

test('IK, retimed parameter layers, follower constraints and the camera share one adaptive pose grid', () => {
  const f = adaptiveFixture(),
    before = structuredClone(f.p),
    result = bakedProject(f.p, f.sceneId, f.options);
  assert.equal(result.stats.adaptive!.satisfied, true);
  assert.ok(result.stats.adaptive!.added > 0);
  assert.ok(result.stats.smoothErrors.position <= 0.001);
  assert.ok(result.stats.smoothErrors.rotationDegrees <= 0.1);
  const fine = bakeAnimation(f.p, f.sceneId, { ...f.options, step: 0.05, adaptive: undefined });
  assert.ok(result.stats.keys < fine.stats.keys / 4);
  const source = sceneEvaluator(f.p, f.sceneId),
    baked = sceneEvaluator(result.project, f.sceneId);
  let maximum = 0;
  for (let frame = 0.137; frame < 48; frame += 0.317) {
    const a = source(frame),
      b = baked(frame);
    for (const entityId of [f.rootJointId, f.elbowId, f.tipId, f.cameraId]) {
      const pa = new Vector3().setFromMatrixPosition(a.world.get(entityId)!);
      const pb = new Vector3().setFromMatrixPosition(b.world.get(entityId)!);
      maximum = Math.max(maximum, pa.distanceTo(pb));
    }
  }
  assert.ok(maximum < 0.01, String(maximum)); // Fixture observation, not a general world-space contract.
  assert.deepEqual(f.p, before);
});

test('STEP boundaries and reverse repeat or ping-pong layers keep their original Float32 guard keys', () => {
  const { p, e, sceneId } = fixture();
  const action = { id: id(), sceneId, name: 'Jump layer' };
  p.animationActions = [action];
  p.animationTracks[0].actionId = action.id;
  p.animationTracks[0].keys = [
    { id: id(), frame: 0, value: [0, 0, 0], interpolation: 'constant' },
    { id: id(), frame: 2, value: [3, 0, 0], interpolation: 'constant' },
    { id: id(), frame: 4, value: [1, 0, 0], interpolation: 'linear' },
  ];
  p.animationLayers = [
    {
      id: id(),
      entityId: e.id,
      actionId: action.id,
      name: 'Reverse',
      enabled: true,
      blend: 'replace',
      weight: 1,
      channels: ['position'],
      start: 1,
      duration: 20,
      sourceIn: 4,
      playback: { rate: -1, rangeStart: 0, rangeEnd: 4, mode: 'repeat' },
      fadeIn: 0,
      fadeOut: 0,
    },
  ];
  for (const mode of ['repeat', 'pingpong'] as const) {
    p.animationLayers[0].playback.mode = mode;
    const input = { ...options, step: 6 },
      fixed = bakeAnimation(p, sceneId, { ...input, adaptive: undefined }),
      adaptive = bakeAnimation(p, sceneId, input);
    assert.equal(adaptive.stats.adaptive!.satisfied, true);
    assert.equal(adaptive.stats.guardedBoundaries, fixed.stats.guardedBoundaries);
    assert.ok(adaptive.stats.guardedBoundaries > 2);
    for (const key of fixed.tracks[0].keys)
      assert.deepEqual(
        adaptive.tracks[0].keys.find((k) => k.frame === key.frame)!.value,
        key.value,
      );
    assert.ok(adaptive.stats.maxBoundarySpanFrames < 0.00001);
  }
});

test('minimum spacing failures are inspectable but reject authoritative save atomically', () => {
  const { p, sceneId } = fixture(),
    before = structuredClone(p),
    input = { ...options, adaptive: { ...options.adaptive!, minStep: 8 } };
  const result = bakeAnimation(p, sceneId, input);
  assert.equal(result.stats.adaptive!.satisfied, false);
  assert.ok(result.stats.adaptive!.reasons.includes('最小采样间隔'));
  assert.throws(() => requireBakeTolerance(result), /未达到目标/);
  assert.throws(
    () =>
      applyCommands(p, [
        {
          type: 'action.bake',
          action: { id: id(), sceneId, name: 'Fail' },
          options: input,
          activate: true,
        },
      ]),
    /未达到目标/,
  );
  assert.deepEqual(p, before);
  assert.throws(() => bakeAnimation(p, sceneId, { ...input, step: 2 }), /最小采样间隔/);
  assert.throws(() =>
    bakeAnimation(p, sceneId, { ...options, adaptive: { ...options.adaptive!, position: 0 } }),
  );
  assert.throws(() =>
    CommandSchema.parse({
      type: 'retarget.bake',
      profileId: id(),
      action: { id: id(), sceneId, name: 'Retarget' },
      options,
      activate: false,
    }),
  );
});

test('sample, node, Float32 and depth limits never label an incomplete analysis as satisfied', () => {
  const grid: GridPoint[] = [
    { time: 0, frame: 0, source: 0, boundaryAfter: false },
    { time: 5, frame: 120, source: 120, boundaryAfter: false },
  ];
  const config = {
    fps: 24,
    offset: 0,
    interpolation: 'linear' as const,
    nodeCost: 1,
    entities: 1,
    maxSamples: 10000,
    adaptive: { position: 1e-8, rotationDegrees: 0.1, scale: 0.001, minStep: 1e-6 },
  };
  const sample = (f: number): Vec3[] => [[Math.sin(f / 5), 0, 0]];
  const keys = sampleAnimationGrid(grid, ['position'], sample, { ...config, maxSamples: 3 });
  assert.equal(keys.adaptive!.satisfied, false);
  assert.ok(keys.adaptive!.reasons.includes('输出键数上限'));
  const budget = sampleAnimationGrid(grid, ['position'], sample, { ...config, nodeCost: 2000 });
  assert.equal(budget.adaptive!.satisfied, false);
  assert.ok(budget.adaptive!.unchecked > 0);
  assert.ok(budget.nodeEvaluations <= 2000000);
  assert.ok(budget.adaptive!.reasons.includes('节点采样预算'));
  const start = 10000,
    end = 10000.0009765625;
  const precision = sampleAnimationGrid(
    [start, end].map((time) => ({
      time,
      frame: time * 24,
      source: time * 24,
      boundaryAfter: false,
    })),
    ['position'],
    (frame) => [[((frame / 24 - start) / (end - start)) ** 2, 0, 0]],
    config,
  );
  assert.ok(precision.adaptive!.reasons.includes('Float32 时间精度'));
  const lateLinear = sampleAnimationGrid(
    [40000, 40000.00390625].map((time) => ({
      time,
      frame: time * 24,
      source: time * 24,
      boundaryAfter: false,
    })),
    ['position'],
    (frame) => [[(frame - 960000) * 1e6, 0, 0]],
    config,
  );
  assert.equal(lateLinear.adaptive!.satisfied, true);
  assert.equal(lateLinear.adaptive!.added, 0);
  const depth = sampleAnimationGrid(grid, ['position'], (frame) => [[frame, 0, 0]], {
    ...config,
    interpolation: 'constant',
    maxSamples: 30,
  });
  assert.ok(depth.adaptive!.reasons.includes('细分深度'));
  for (const result of [keys, budget, precision, depth])
    assert.ok(result.points.every((p) => p.values.every((v) => v.every(Number.isFinite))));
});

test('rebased adaptive output samples source time and constant interpolation remains explicit', () => {
  const { p, e, sceneId } = fixture();
  const input = { ...options, start: 6, end: 18, rebase: true };
  const result = bakeAnimation(p, sceneId, input);
  assert.equal(result.stats.adaptive!.satisfied, true);
  assert.equal(result.tracks[0].keys[0].frame, 0);
  assert.equal(result.tracks[0].keys.at(-1)!.frame, 12);
  for (const key of result.tracks[0].keys)
    assert.deepEqual(key.value, evaluatedTransform(p, e, key.frame + 6).position);
  const held = bakeAnimation(p, sceneId, {
    ...input,
    interpolation: 'constant',
    adaptive: { ...options.adaptive!, position: 0.1 },
  });
  assert.equal(held.stats.adaptive!.satisfied, true);
  assert.ok(held.tracks[0].keys.every((k) => k.interpolation === 'constant'));
});

test('adaptive action and source drivers survive durable undo, redo and process restart', () => {
  const parent = resolve(tmpdir()),
    directory = mkdtempSync(join(parent, 'frameforge-adaptive-'));
  let store = new Store(directory);
  try {
    const f = adaptiveFixture();
    f.p = store.create(f.p).project;
    const action = { id: id(), sceneId: f.sceneId, name: 'Adaptive saved' };
    const saved = store.change(
      f.p.id,
      f.p.revision,
      [{ type: 'action.bake', action, options: f.options, activate: true }],
      'user',
      'Adaptive',
    ).project;
    assert.ok(saved.animationTracks.length > f.p.animationTracks.length);
    assert.deepEqual(
      saved.animationTracks.filter((t) => t.actionId !== action.id),
      f.p.animationTracks,
    );
    assert.deepEqual(saved.geometries, f.p.geometries);
    assert.ok(saved.ikChains!.every((c) => !c.enabled));
    assert.ok(saved.animationLayers!.every((l) => !l.enabled));
    store.close();
    store = new Store(directory);
    assert.deepEqual(store.get(f.p.id)!.project.animationTracks, saved.animationTracks);
    const undone = store.change(f.p.id, saved.revision, undefined, 'user', 'undo', 'undo').project;
    assert.deepEqual(undone.ikChains, f.p.ikChains);
    assert.deepEqual(undone.animationLayers, f.p.animationLayers);
    assert.deepEqual(
      store.change(f.p.id, undone.revision, undefined, 'user', 'redo', 'redo').project
        .animationTracks,
      saved.animationTracks,
    );
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
test('adaptive GLB has nonuniform key times and independent playback matches skinned vertices and camera', async () => {
  const f = adaptiveFixture(),
    result = bakedProject(f.p, f.sceneId, f.options);
  requireBakeTolerance(result);
  const output = exportGLB(result.project, f.sceneId, 0, new Map(), true),
    report = await validateBytes(output.bytes);
  assert.equal(report.issues.numErrors, 0);
  assert.equal(report.issues.numWarnings, 0);
  const loaded = await new GLTFLoader().parseAsync(Uint8Array.from(output.bytes).buffer, ''),
    mixer = new AnimationMixer(loaded.scene);
  const clip = loaded.animations[0],
    play = mixer.clipAction(clip);
  play.setLoop(LoopOnce, 1);
  play.clampWhenFinished = true;
  play.play();
  assert.equal(
    clip.tracks.reduce((sum, t) => sum + t.times.length, 0),
    result.stats.keys,
  );
  const intervals = clip.tracks[0].times.slice(1).map((v, i) => v - clip.tracks[0].times[i]);
  assert.ok(new Set(intervals).size > 4);
  let skin: SkinnedMesh | undefined;
  loaded.scene.traverse((o) => {
    if (o instanceof SkinnedMesh) skin = o;
  });
  assert.ok(skin);
  const mesh = f.p.entities.find((e) => e.skin)!,
    g = f.p.geometries.find((g) => g.id === mesh.geometryId)!;
  const near = (a: number[], b: number[], epsilon = 2e-5) =>
    a.forEach((v, i) => assert.ok(Math.abs(v - b[i]) < epsilon, `${v} != ${b[i]}`));
  for (const frame of [0, 6.25, 12, 17.125, 24, 36, 36.5, 47]) {
    mixer.setTime(frame / 24);
    loaded.scene.updateMatrixWorld(true);
    skin.skeleton.update();
    const pose = sceneEvaluator(result.project, f.sceneId)(frame),
      expected = deformGeometry(g, mesh.skin!, pose.world);
    g.triangles
      .flat()
      .forEach((index, i) =>
        near(
          skin!.getVertexPosition(i, new Vector3()).applyMatrix4(skin!.matrixWorld).toArray(),
          expected.positions[index],
        ),
      );
    near(loaded.cameras[0].matrixWorld.elements, pose.world.get(f.cameraId)!.elements);
  }
});
