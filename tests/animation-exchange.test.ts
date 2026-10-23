import test from 'node:test';
import assert from 'node:assert/strict';
import { AnimationMixer, LoopOnce, Quaternion } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { validateBytes } from 'gltf-validator';
import { animationExchangeFixture } from '../scripts/animation-exchange-fixture';
import { importGLTF, exportGLB } from '../src/core/gltf';
import { animationSampler } from '../src/core/animation-exchange';
import {
  activeTracks,
  sampleTrack,
  quaternionFromEuler,
  slerp,
  editTrack,
  validateTrack,
} from '../src/core/animation';
import { evaluatedTransform } from '../src/core/evaluate';
import { applyCommands } from '../src/core/commands';
import { newProject } from '../src/core/factory';
import { id, migrateProject, type Vec3, type Vec4, type AnimationTrack } from '../src/core/model';
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
// The independent loader's FileLoader emits browser progress events, which Node does not define.
globalThis.ProgressEvent ||= class extends Event {
  lengthComputable = false;
  loaded = 0;
  total = 0;
  constructor(type: string, init: ProgressEventInit = {}) {
    super(type);
    Object.assign(this, init);
  }
} as typeof ProgressEvent;
const near = (a: number[], b: number[], tolerance = 1e-5) =>
  assert.ok(
    a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) < tolerance),
    JSON.stringify({ a, b }),
  );
const sameRotation = (a: number[], b: number[]) =>
  assert.ok(
    Math.abs(new Quaternion(...(a as Vec4)).dot(new Quaternion(...(b as Vec4)))) > 1 - 1e-6,
    JSON.stringify({ a, b }),
  );
async function sample() {
  const result = await importGLTF(bytes(animationExchangeFixture()), [], 24);
  return { ...result, project: applyCommands(newProject(), [result.command]).project };
}

test('fractional keys and action-specific quaternion/Hermite evaluation match the independent glTF loader', async () => {
  const { project, defaultSceneId } = await sample(),
    fixture = animationExchangeFixture();
  // Compare one scene in the independent loader; the shared-source scene mapping is asserted separately.
  fixture.scenes = fixture.scenes.slice(0, 1);
  const reference = await new GLTFLoader().parseAsync(JSON.stringify(fixture), '');
  const actions = project.animationActions!.filter((a) => a.sceneId === defaultSceneId);
  assert.equal(project.animationActions!.length, 4);
  assert.equal(project.animationTracks.length, 10);
  assert.ok(project.animationTracks.some((t) => t.keys.some((k) => !Number.isInteger(k.frame))));
  for (let i = 0; i < actions.length; i++) {
    project.scenes.find((s) => s.id === defaultSceneId)!.activeActionId = actions[i].id;
    const mixer = new AnimationMixer(reference.scene),
      action = mixer.clipAction(reference.animations[i]);
    action.setLoop(LoopOnce, 1);
    action.clampWhenFinished = true;
    action.play();
    for (const seconds of [0, 0.12, 0.34, 0.35, 0.7, 1.099]) {
      mixer.setTime(seconds);
      for (const [localName, importedName] of [
        ['Motion root', 'Motion_root'],
        ['Animated bar', 'Animated_bar'],
      ]) {
        const e = project.entities.find(
            (e) => e.sceneId === defaultSceneId && e.name === localName,
          )!,
          t = evaluatedTransform(project, e, seconds * 24),
          object = reference.scene.getObjectByName(importedName)!;
        near(t.position, object.position.toArray());
        near(t.scale, object.scale.toArray());
        sameRotation(t.quaternion || quaternionFromEuler(t.rotation), object.quaternion.toArray());
      }
    }
    mixer.stopAllAction();
    mixer.uncacheRoot(reference.scene);
  }
});

test('animated GLB retains native actions, fractional time and cubic derivatives through validation and reimport', async () => {
  const { project, defaultSceneId } = await sample();
  const out = exportGLB(project, defaultSceneId, 0, new Map(), true),
    validation = await validateBytes(out.bytes);
  assert.equal(validation.issues.numErrors, 0, JSON.stringify(validation.issues));
  assert.equal(validation.issues.numWarnings, 0, JSON.stringify(validation.issues));
  const restored = await importGLTF(out.bytes, [], 24),
    next = applyCommands(newProject(), [restored.command]).project;
  assert.equal(restored.command.animationActions!.length, 2);
  const previous = project.animationActions!.filter((a) => a.sceneId === defaultSceneId);
  for (let i = 0; i < 2; i++) {
    const before = project.animationTracks.filter((t) => t.actionId === previous[i].id),
      after = next.animationTracks.filter(
        (t) => t.actionId === restored.command.animationActions![i].id,
      );
    assert.equal(before.length, after.length);
    before.forEach((track, j) => {
      for (let f = 0; f <= 30; f += 0.25) {
        const a = sampleTrack(track, f)!,
          b = sampleTrack(after[j], f)!;
        if (track.property === 'quaternion') sameRotation(a, b);
        else near(a, b);
      }
    });
  }
});

test('action edits isolate tracks and fractional key operations preserve identities and original snapshots', async () => {
  const { project, defaultSceneId } = await sample(),
    scene = project.scenes.find((s) => s.id === defaultSceneId)!,
    original = structuredClone(project);
  const copyId = id();
  let next = applyCommands(project, [
    {
      type: 'action.add',
      action: { id: copyId, name: 'Motion copy', sceneId: defaultSceneId },
      copyFrom: scene.activeActionId!,
    },
  ]).project;
  const track = next.animationTracks.find(
      (t) => t.actionId === copyId && t.property === 'quaternion',
    )!,
    key = track.keys[1];
  next = applyCommands(next, [
    {
      type: 'key.update',
      trackId: track.id,
      keyId: key.id,
      patch: { frame: 8.75, value: [0, 0, 0.4, 0.8] },
    },
  ]).project;
  assert.equal(next.animationTracks.find((t) => t.id === track.id)!.keys[1].id, key.id);
  assert.ok(
    Math.abs(
      Math.hypot(...next.animationTracks.find((t) => t.id === track.id)!.keys[1].value) - 1,
    ) < 1e-10,
  );
  assert.deepEqual(project, original);
  assert.deepEqual(
    next.animationTracks.filter((t) => t.actionId !== copyId),
    project.animationTracks,
  );
  next = applyCommands(next, [{ type: 'action.delete', id: copyId }]).project;
  assert.ok(!next.animationTracks.some((t) => t.actionId === copyId));
  assert.equal(next.scenes.find((s) => s.id === defaultSceneId)!.activeActionId, null);
  const old = newProject();
  assert.deepEqual(migrateProject({ ...old, schemaVersion: 7 }), old);
});

test('quaternion shortest path, zero rejection and Hermite time scaling are explicit', () => {
  sameRotation(slerp([0, 0, 0, 1], [0, 0, 0, -1], 0.5), [0, 0, 0, 1]);
  const track: AnimationTrack = {
    id: id(),
    entityId: id(),
    property: 'quaternion',
    keys: [
      { id: id(), frame: 0, value: [0, 0, 0, 1], interpolation: 'linear' },
      { id: id(), frame: 2.5, value: [0, 0, 1, 0], interpolation: 'linear' },
    ],
  };
  sameRotation(sampleTrack(track, 1.25)!, [0, 0, Math.SQRT1_2, Math.SQRT1_2]);
  assert.throws(
    () =>
      editTrack(track, {
        type: 'key.update',
        trackId: track.id,
        keyId: track.keys[0].id,
        patch: { value: [0, 0, 0, 0] },
      }),
    /四元数/,
  );
  const position: AnimationTrack = {
    id: id(),
    entityId: id(),
    property: 'position',
    keys: [
      {
        id: id(),
        frame: 0,
        value: [0, 0, 0],
        interpolation: 'cubic',
        outTangent: [2, 0, 0],
        inTangent: [0, 0, 0],
      },
      {
        id: id(),
        frame: 2,
        value: [1, 0, 0],
        interpolation: 'cubic',
        inTangent: [0, 0, 0],
        outTangent: [0, 0, 0],
      },
    ],
  };
  near(sampleTrack(position, 1)!, [1, 0, 0]);
  assert.equal(animationSampler(position, 24).values[2][0], 48);
});

test('Euler and incompatible curves disclose baking while exact vector Hermite segments stay native', () => {
  const track: AnimationTrack = {
    id: id(),
    entityId: id(),
    property: 'rotation',
    keys: [
      { id: id(), frame: 0, value: [0, 0, 0], interpolation: 'smooth' },
      { id: id(), frame: 12.5, value: [0, 0, 5], interpolation: 'linear' },
    ],
  };
  const out = animationSampler(track, 24);
  assert.ok(out.baked);
  assert.equal(out.interpolation, 'LINEAR');
  assert.equal(out.times.at(-1), 12.5 / 24);
  out.times.forEach((t, i) =>
    sameRotation(out.values[i], quaternionFromEuler(sampleTrack(track, t * 24) as Vec3)),
  );
  const vector = { ...track, property: 'position' as const };
  assert.equal(animationSampler(vector, 24).interpolation, 'CUBICSPLINE');
  assert.equal(animationSampler(vector, 24).baked, false);
});

test('quaternion Hermite rejects interior common zeros, including a double root', () => {
  const track: AnimationTrack = {
    id: id(),
    entityId: id(),
    property: 'quaternion',
    keys: [
      {
        id: id(),
        frame: 0,
        value: [0, 0, 0, 1],
        interpolation: 'cubic',
        outTangent: [0, 0, 0, -4],
      },
      { id: id(), frame: 1, value: [0, 0, 0, 1], interpolation: 'linear', inTangent: [0, 0, 0, 4] },
    ],
  };
  assert.throws(() => validateTrack(track), /零长度/);
  track.keys[1].value = [0, 0, 0, -1];
  track.keys[0].outTangent = [0, 0, 0, 2];
  track.keys[1].inTangent = [0, 0, 0, -3];
  assert.throws(() => validateTrack(track), /零长度/);
  track.keys[0].value = [0, 0, 1e-4, Math.sqrt(1 - 1e-8)];
  track.keys[1].value = [0, 0, 1e-4, -Math.sqrt(1 - 1e-8)];
  assert.doesNotThrow(() => validateTrack(track));
});

test('malformed animation times, duplicate channels, weights and zero quaternions fail before scene mutation', async () => {
  const f = animationExchangeFixture();
  f.animations[0].channels.push(f.animations[0].channels[0]);
  await assert.rejects(() => importGLTF(bytes(f)), /重复/);
  const weights = animationExchangeFixture();
  weights.animations[0].channels[0].target.path = 'weights';
  await assert.rejects(() => importGLTF(bytes(weights)), /形态键/);
  const bounds = animationExchangeFixture();
  bounds.accessors[bounds.animations[0].samplers[0].input].max = [5];
  await assert.rejects(() => importGLTF(bytes(bounds)), /范围/);
  const zero = animationExchangeFixture(),
    data = Buffer.from(zero.buffers[0].uri.split(',')[1], 'base64'),
    accessor = zero.accessors[zero.animations[0].samplers[1].output];
  data.fill(
    0,
    zero.bufferViews[accessor.bufferView].byteOffset,
    zero.bufferViews[accessor.bufferView].byteOffset + 16,
  );
  zero.buffers[0].uri = 'data:application/octet-stream;base64,' + data.toString('base64');
  await assert.rejects(() => importGLTF(bytes(zero)), /四元数/);
});
