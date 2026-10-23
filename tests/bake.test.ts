import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { AnimationMixer, LoopOnce, Quaternion } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { validateBytes } from 'gltf-validator';
import { newProject } from '../src/core/factory';
import {
  id,
  identity,
  parseProject,
  type AnimationTrack,
  type AnimationValue,
} from '../src/core/model';
import { bakeAnimation, bakedProject, type BakeOptions } from '../src/core/bake';
import { evaluatedTransform } from '../src/core/evaluate';
import { quaternionFromEuler } from '../src/core/animation';
import { applyCommands } from '../src/core/commands';
import { exportGLB, importGLTF } from '../src/core/gltf';
import { Store } from '../server/store';

globalThis.ProgressEvent ||= class extends Event {
  lengthComputable = false;
  loaded = 0;
  total = 0;
  constructor(type: string, init: ProgressEventInit = {}) {
    super(type);
    Object.assign(this, init);
  }
} as typeof ProgressEvent;
const near = (a: number, b: number, tolerance = 1e-5) =>
  assert.ok(Math.abs(a - b) < tolerance, `${a} != ${b}`);
function fixture() {
  const p = newProject(),
    e = p.entities[0],
    sceneId = e.sceneId,
    base = id(),
    layerAction = id();
  e.name = 'Bake object';
  e.transform = identity();
  p.animationActions = [
    { id: base, name: 'Base', sceneId },
    { id: layerAction, name: 'Layer', sceneId },
  ];
  p.scenes[0].activeActionId = base;
  const track = (
    actionId: string,
    property: AnimationTrack['property'],
    first: AnimationValue,
    last: AnimationValue,
  ): AnimationTrack => ({
    id: id(),
    entityId: e.id,
    actionId,
    property,
    keys: [
      { id: id(), frame: 0, value: first, interpolation: 'linear' },
      { id: id(), frame: 24, value: last, interpolation: 'linear' },
    ],
  });
  p.animationTracks = [
    track(base, 'position', [0, 0, 0], [4, 0, 0]),
    track(base, 'rotation', [0, 0, 0], [0, 0, Math.PI / 2]),
    track(layerAction, 'position', [2, 1, 0], [2, 1, 0]),
    track(
      layerAction,
      'quaternion',
      quaternionFromEuler([0, Math.PI / 3, 0]),
      quaternionFromEuler([0, Math.PI / 3, 0]),
    ),
  ];
  p.animationLayers = [
    {
      id: id(),
      name: 'Fade',
      entityId: e.id,
      actionId: layerAction,
      enabled: true,
      blend: 'replace',
      weight: 0.5,
      channels: ['position', 'rotation'],
      start: 0,
      duration: 24,
      sourceIn: 0,
      playback: { rate: 1, rangeStart: 0, rangeEnd: 24, mode: 'hold' },
      fadeIn: 6,
      fadeOut: 6,
    },
  ];
  const options: BakeOptions = {
    start: 0,
    end: 24,
    step: 0.5,
    interpolation: 'linear',
    rebase: false,
    actionId: base,
  };
  return { p: parseProject(p), e, sceneId, base, layerAction, options };
}
test('bake samples composed local transforms, retains source state and measures fractional interpolation errors', () => {
  const { p, e, sceneId, options } = fixture(),
    before = structuredClone(p),
    result = bakedProject(p, sceneId, options);
  assert.equal(result.stats.tracks, 2);
  assert.ok(result.stats.samples >= 49);
  assert.ok(result.stats.probes > 0);
  assert.ok(result.stats.errors.position < 0.002);
  assert.ok(result.stats.errors.rotationDegrees < 0.03);
  for (let f = 0; f <= 24; f += 0.5) {
    const original = evaluatedTransform(p, e, f),
      baked = evaluatedTransform(result.project, e, f);
    original.position.forEach((v, i) => near(v, baked.position[i]));
    near(
      Math.abs(
        new Quaternion(...(original.quaternion || quaternionFromEuler(original.rotation))).dot(
          new Quaternion(...baked.quaternion!),
        ),
      ),
      1,
    );
  }
  assert.deepEqual(p, before);
  const coarse = bakeAnimation(p, sceneId, { ...options, step: 3 });
  assert.ok(coarse.stats.errors.position > result.stats.errors.position * 10);
});
test('STEP keys, finite layer windows and forward/reverse repeated boundaries get guarded samples', () => {
  const { p, e, sceneId, base, layerAction, options } = fixture();
  p.animationTracks = p.animationTracks.filter((t) => t.property === 'position');
  const source = p.animationTracks.find((t) => t.actionId === layerAction)!;
  source.keys = [
    { id: id(), frame: 0, value: [0, 1, 0], interpolation: 'constant' },
    { id: id(), frame: 2, value: [6, 1, 0], interpolation: 'constant' },
    { id: id(), frame: 4, value: [3, 1, 0], interpolation: 'linear' },
  ];
  const layer = p.animationLayers![0];
  Object.assign(layer, {
    start: 1.25,
    duration: 16,
    sourceIn: 0,
    fadeIn: 0,
    fadeOut: 0,
    weight: 1,
  });
  for (const mode of ['hold', 'repeat', 'pingpong'] as const)
    for (const rate of [-1, 1]) {
      layer.sourceIn = rate < 0 ? 4 : 0;
      layer.playback = { rate, rangeStart: 0, rangeEnd: 4, mode };
      const result = bakedProject(p, sceneId, { ...options, actionId: base, step: 3 });
      assert.ok(result.stats.guardedBoundaries >= 2);
      for (const f of [1.249, 1.251, 3.249, 3.251, 5.249, 5.251, 7.249, 7.251, 17.249, 17.251]) {
        const x = evaluatedTransform(p, e, f).position,
          y = evaluatedTransform(result.project, e, f).position;
        x.forEach((v, i) => near(v, y[i], 0.002));
      }
    }
});
test('rebase keeps source interval while shifted output begins at zero, STEP output remains explicit', () => {
  const { p, e, sceneId, options } = fixture();
  const result = bakedProject(p, sceneId, {
    ...options,
    start: 6.25,
    end: 12.75,
    step: 0.5,
    rebase: true,
    interpolation: 'constant',
  });
  assert.equal(result.tracks[0].keys[0].frame, 0);
  near(result.tracks[0].keys.at(-1)!.frame, 6.5, 1e-6);
  assert.ok(result.tracks.every((t) => t.keys.every((k) => k.interpolation === 'constant')));
  for (const f of [0, 0.5, 1, 3, 6]) {
    const expected = evaluatedTransform(p, e, f + 6.25),
      sample = evaluatedTransform(result.project, e, f + 1e-5);
    expected.position.forEach((v, i) => near(v, sample.position[i]));
  }
});

test('reverse STEP at frame zero clears source arithmetic rounding before the next ordinary sample', () => {
  const { p, e, sceneId, layerAction, options } = fixture();
  p.animationTracks = p.animationTracks.filter((t) => t.property === 'position');
  const track = p.animationTracks.find((t) => t.actionId === layerAction)!;
  track.keys = [
    { id: id(), frame: 0, value: [1, 1, 0], interpolation: 'constant' },
    { id: id(), frame: 12, value: [5, 1, 0], interpolation: 'constant' },
    { id: id(), frame: 24, value: [1, 1, 0], interpolation: 'constant' },
  ];
  Object.assign(p.animationLayers![0], {
    fadeIn: 0,
    fadeOut: 0,
    weight: 1,
    sourceIn: 24,
    playback: { rate: -0.75, rangeStart: 0, rangeEnd: 24, mode: 'pingpong' },
  });
  const result = bakedProject(p, sceneId, options);
  for (const frame of [0, 0.000001, 0.125, 0.25, 0.375, 15.999, 16.001])
    near(
      evaluatedTransform(p, e, frame).position[0],
      evaluatedTransform(result.project, e, frame).position[0],
    );
  assert.ok(result.stats.smoothErrors.position < 1e-5);
});
test('Float32 event collisions, invalid ranges and excessive cycles fail explicitly before mutation', () => {
  const { p, sceneId, options } = fixture(),
    before = structuredClone(p);
  for (const patch of [{ end: 0 }, { step: 0 }, { end: 100000 }, { actionId: 'missing' }])
    assert.throws(() => bakeAnimation(p, sceneId, { ...options, ...patch }));
  assert.deepEqual(p, before);
  p.animationLayers = [];
  p.animationTracks = [p.animationTracks[0]];
  const t = p.animationTracks[0];
  t.keys[0].frame = 999994;
  t.keys[1].frame = 999994.0001;
  assert.throws(
    () => bakeAnimation(p, sceneId, { ...options, start: 999990, end: 999999, step: 1 }),
    /Float32/,
  );
  assert.ok(
    bakeAnimation(p, sceneId, { ...options, start: 999990, end: 999999, step: 1, rebase: true })
      .tracks.length,
  );
  t.keys[1].frame = t.keys[0].frame + 1e-10;
  assert.throws(
    () => bakeAnimation(p, sceneId, { ...options, start: 999990, end: 999999, step: 1 }),
    /Float32/,
  );
  const loop = fixture();
  loop.p.animationLayers![0].playback = {
    rate: 16,
    rangeStart: 0,
    rangeEnd: 0.000001,
    mode: 'repeat',
  };
  assert.throws(() => bakeAnimation(loop.p, loop.sceneId, loop.options), /循环边界/);
});
test('baked GLB validates and matches independent loader animation poses without exporting layer metadata', async () => {
  const { p, e, sceneId, options } = fixture(),
    before = structuredClone(p);
  const out = exportGLB(p, sceneId, 0, new Map(), true, options);
  const report = await validateBytes(out.bytes, { uri: 'baked.glb' });
  assert.equal(report.issues.numErrors, 0, JSON.stringify(report.issues));
  assert.equal(report.issues.numWarnings, 0);
  const loaded = await new GLTFLoader().parseAsync(Uint8Array.from(out.bytes).buffer, '');
  assert.equal(loaded.animations.length, 1);
  const mixer = new AnimationMixer(loaded.scene),
    action = mixer.clipAction(loaded.animations[0]);
  action.setLoop(LoopOnce, 1);
  action.clampWhenFinished = true;
  action.play();
  for (const frame of [0, 1.5, 6, 9.5, 18, 23.5]) {
    mixer.setTime(frame / 24);
    const object = loaded.scene.getObjectByName('Bake_object')!,
      expected = evaluatedTransform(p, e, frame);
    expected.position.forEach((v, i) => near(v, object.position.toArray()[i]));
    near(
      Math.abs(
        new Quaternion(...(expected.quaternion || quaternionFromEuler(expected.rotation))).dot(
          object.quaternion,
        ),
      ),
      1,
    );
  }
  const imported = await importGLTF(out.bytes);
  assert.equal(imported.command.animationActions!.length, 1);
  assert.equal(imported.command.animationTracks!.length, 2);
  assert.ok(out.notes.some((n) => n.includes('不是全区间误差上界')));
  assert.deepEqual(p, before);
});
test('bake command retains original actions/layers and activation is an explicit atomic option', () => {
  const { p, e, sceneId, options } = fixture(),
    action = { id: id(), name: 'Baked', sceneId };
  const copy = applyCommands(p, [
    { type: 'action.bake', action, options, activate: false },
  ]).project;
  assert.equal(copy.scenes[0].activeActionId, p.scenes[0].activeActionId);
  assert.deepEqual(copy.animationLayers, p.animationLayers);
  const activated = applyCommands(p, [
    { type: 'action.bake', action, options, activate: true },
  ]).project;
  assert.ok(activated.animationLayers!.every((l) => !l.enabled));
  assert.equal(activated.scenes[0].activeActionId, action.id);
  assert.deepEqual(activated.animationTracks.slice(0, p.animationTracks.length), p.animationTracks);
  near(evaluatedTransform(activated, e, 9).position[0], evaluatedTransform(p, e, 9).position[0]);
  assert.throws(() =>
    applyCommands(p, [
      { type: 'action.bake', action: { ...action, id: p.scenes[0].id }, options, activate: true },
    ]),
  );
  assert.ok(p.animationLayers![0].enabled);
});
test('saved baked action and layer activation survive restart, undo and redo', () => {
  const root = resolve(tmpdir()),
    directory = mkdtempSync(join(root, 'frameforge-bake-'));
  let store = new Store(directory);
  try {
    const input = fixture(),
      p = store.create(input.p).project;
    const changed = store.change(
      p.id,
      p.revision,
      [
        {
          type: 'action.bake',
          action: { id: id(), name: 'Baked', sceneId: input.sceneId },
          options: input.options,
          activate: true,
        },
      ],
      'user',
      'bake',
    ).project;
    store.close();
    store = new Store(directory);
    assert.deepEqual(store.get(p.id).project.animationTracks, changed.animationTracks);
    const undo = store.change(p.id, changed.revision, undefined, 'user', 'undo', 'undo').project;
    assert.deepEqual(undo.animationLayers, p.animationLayers);
    assert.deepEqual(undo.animationTracks, p.animationTracks);
    const redo = store.change(p.id, undo.revision, undefined, 'user', 'redo', 'redo').project;
    assert.deepEqual(redo.animationTracks, changed.animationTracks);
  } finally {
    store.close();
    assert.ok(resolve(directory).startsWith(root + sep));
    rmSync(directory, { recursive: true, force: true });
  }
});
