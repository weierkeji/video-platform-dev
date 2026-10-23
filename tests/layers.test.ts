import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { Quaternion } from 'three';
import { newProject } from '../src/core/factory';
import {
  id,
  identity,
  parseProject,
  migrateProject,
  type AnimationLayer,
  type AnimationValue,
  type Project,
} from '../src/core/model';
import { evaluatedTransform, evaluatedBaseTransform } from '../src/core/evaluate';
import { layerWeight, layerSourceFrame } from '../src/core/layers';
import { quaternionFromEuler } from '../src/core/animation';
import { sourceFrame } from '../src/core/playback';
import { applyCommands, type Command } from '../src/core/commands';
import { exportGLB, importGLTF } from '../src/core/gltf';
import { Store } from '../server/store';

const near = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-8, `${a} != ${b}`);
function setup() {
  const p = newProject(),
    e = p.entities[0];
  p.animationTracks = [];
  e.transform = identity();
  p.animationActions = ['A', 'B'].map((name) => ({ id: id(), name, sceneId: e.sceneId }));
  p.scenes[0].activeActionId = null;
  const layer = (actionId = p.animationActions![0].id): AnimationLayer => ({
    id: id(),
    name: 'Layer',
    entityId: e.id,
    actionId,
    enabled: true,
    blend: 'replace',
    weight: 1,
    channels: ['position', 'rotation', 'scale'],
    start: 0,
    duration: 40,
    sourceIn: 0,
    playback: { rate: 1, rangeStart: 0, rangeEnd: 20, mode: 'hold' },
    fadeIn: 0,
    fadeOut: 0,
  });
  const track = (
    actionId: string | undefined,
    property: Project['animationTracks'][number]['property'],
    value: AnimationValue,
  ) =>
    p.animationTracks.push({
      id: id(),
      entityId: e.id,
      actionId,
      property,
      keys: [{ id: id(), frame: 0, value, interpolation: 'linear' }],
    });
  return { p, e, layer, track, a: p.animationActions[0].id, b: p.animationActions[1].id };
}
test('layer envelopes have half-open windows and fractional fades with retimed source boundaries', () => {
  const { layer } = setup(),
    l = layer();
  Object.assign(l, { start: 2.5, duration: 20, fadeIn: 4, fadeOut: 4, weight: 0.8 });
  [
    [2, 0],
    [2.5, 0],
    [4.5, 0.4],
    [6.5, 0.8],
    [18.5, 0.8],
    [20.5, 0.4],
    [22.5, 0],
  ].forEach(([f, w]) => near(layerWeight(l, f), w));
  l.sourceIn = 20;
  l.playback.rate = -2;
  l.playback.mode = 'pingpong';
  near(layerSourceFrame(l, 2.5), 20);
  near(layerSourceFrame(l, 12.5), 0);
  near(layerSourceFrame(l, 17.5), 10);
  l.enabled = false;
  near(layerWeight(l, 10), 0);
});
test('ordered replacement crossfades authored channels and preserves rest for missing paths', () => {
  const { p, e, a, b, layer, track } = setup();
  track(a, 'position', [10, 0, 0]);
  track(b, 'position', [20, 0, 0]);
  const first = layer(a),
    second = { ...layer(b), weight: 0.5, fadeIn: 10 };
  p.animationLayers = [first, second];
  near(evaluatedTransform(p, e, 5).position[0], 12.5);
  near(evaluatedTransform(p, e, 10).position[0], 15);
  assert.deepEqual(evaluatedTransform(p, e, 10).scale, [1, 1, 1]);
  second.channels = ['scale'];
  near(evaluatedTransform(p, e, 10).position[0], 10);
  second.channels = ['position'];
  p.animationLayers.reverse();
  near(evaluatedTransform(p, e, 10).position[0], 10);
  near(evaluatedTransform(p, e, 40).position[0], 0);
  near(evaluatedBaseTransform(p, e, 10).position[0], 0);
});
test('additive deltas use rest position and linear scale and compose noncommuting local quaternion deltas', () => {
  const { p, e, a, layer, track } = setup();
  e.transform.position = [2, 1, 0];
  e.transform.scale = [-2, 2, 1];
  const rest = quaternionFromEuler([Math.PI / 2, 0, 0]),
    base = quaternionFromEuler([0, 0, Math.PI / 2]);
  e.transform.quaternion = rest;
  track(undefined, 'quaternion', base);
  track(undefined, 'position', [10, 1, 0]);
  track(a, 'position', [6, 3, 0]);
  track(a, 'scale', [-4, 6, 1]);
  const delta = new Quaternion().setFromAxisAngle({ x: 0, y: 1, z: 0 } as never, Math.PI / 2);
  track(a, 'quaternion', new Quaternion(...rest).multiply(delta).toArray());
  p.animationLayers = [{ ...layer(), blend: 'additive', weight: 0.5 }];
  const t = evaluatedTransform(parseProject(p), e, 1);
  assert.deepEqual(t.position, [12, 2, 0]);
  assert.deepEqual(t.scale, [-3, 4, 1]);
  const expected = new Quaternion(...base).multiply(
    new Quaternion().setFromAxisAngle({ x: 0, y: 1, z: 0 } as never, Math.PI / 4),
  );
  near(Math.abs(new Quaternion(...t.quaternion!).dot(expected)), 1);
  p.animationTracks.find((t) => t.actionId === a && t.property === 'quaternion')!.keys[0].value =
    p.animationTracks
      .find((t) => t.actionId === a && t.property === 'quaternion')!
      .keys[0].value.map((x) => -x) as AnimationValue;
  near(Math.abs(new Quaternion(...evaluatedTransform(p, e, 1).quaternion!).dot(expected)), 1);
});
test('layer evaluation is isolated across explicit actions, cameras and shot source mapping without mutations', () => {
  const { p, e, a, b, layer, track } = setup();
  track(undefined, 'position', [2, 0, 0]);
  track(a, 'position', [10, 0, 0]);
  track(b, 'position', [20, 0, 0]);
  p.animationLayers = [{ ...layer(a), weight: 0.5, start: 5, duration: 10 }];
  const camera = p.entities.find((x) => x.id === p.shots[0].cameraId)!;
  p.animationLayers.push({ ...layer(a), id: id(), entityId: camera.id }); // action has no camera channels
  const before = structuredClone(p),
    c = p.timeline.clips[0];
  const cameraRest = evaluatedBaseTransform(p, camera, 7);
  near(evaluatedTransform(p, e, 7, b).position[0], 15);
  near(evaluatedTransform(p, e, 7, null).position[0], 6);
  assert.deepEqual(evaluatedTransform(p, camera, 7), cameraRest);
  assert.deepEqual(p, before);
  c.sourceIn = 8;
  c.playback = { rate: -1, rangeStart: 0, rangeEnd: 20, mode: 'hold' };
  near(evaluatedTransform(p, e, sourceFrame(c, 1), b).position[0], 15);
  near(evaluatedTransform(p, e, sourceFrame(c, 5), b).position[0], 20);
});
test('layer commands validate references atomically, protect actions, reorder, duplicate and cascade', () => {
  const { p, e, a, layer } = setup();
  const one = layer(),
    two = { ...layer(), name: 'Second' };
  const added = applyCommands(p, [
    { type: 'layer.add', layer: one },
    { type: 'layer.add', layer: two },
  ]).project;
  const moved = applyCommands(added, [{ type: 'layer.move', id: two.id, direction: -1 }]).project;
  assert.deepEqual(
    moved.animationLayers!.map((l) => l.id),
    [two.id, one.id],
  );
  assert.throws(() => applyCommands(added, [{ type: 'action.delete', id: a }]), /动作层引用/);
  for (const patch of [
    { fadeIn: 41 },
    { weight: 2 },
    { channels: ['position', 'position'] },
    { actionId: 'missing' },
    { playback: { rate: 1, rangeStart: 2, rangeEnd: 1, mode: 'hold' } },
  ])
    assert.throws(() =>
      applyCommands(added, [{ type: 'layer.update', id: one.id, patch } as Command]),
    );
  assert.deepEqual(added.animationLayers, [one, two]);
  const duplicated = applyCommands(added, [{ type: 'entity.duplicate', id: e.id }]).project;
  const copy = duplicated.entities.at(-1)!;
  assert.equal(duplicated.animationLayers!.filter((l) => l.entityId === copy.id).length, 2);
  assert.equal(new Set(duplicated.animationLayers!.map((l) => l.id)).size, 4);
  const removed = applyCommands(duplicated, [{ type: 'entity.delete', id: e.id }]).project;
  assert.ok(removed.animationLayers!.every((l) => l.entityId === copy.id));
  assert.deepEqual(migrateProject({ ...p, schemaVersion: 9 }), p);
});
test('static GLB preserves the mixed pose and animated GLB refuses to silently omit active layers', async () => {
  const { p, e, a, track, layer } = setup();
  track(a, 'position', [10, 0, 0]);
  p.animationLayers = [{ ...layer(), weight: 0.25 }];
  const imported = await importGLTF(exportGLB(p, e.sceneId, 5).bytes);
  near(imported.command.entities.find((x) => x.name === e.name)!.transform.position[0], 2.5);
  assert.throws(() => exportGLB(p, e.sceneId, 5, new Map(), true), /动作层烘焙/);
  p.animationLayers[0].enabled = false;
  assert.ok(exportGLB(p, e.sceneId, 5, new Map(), true).bytes.length);
});
test('layers survive persisted restart, undo and redo', () => {
  const root = resolve(tmpdir()),
    directory = mkdtempSync(join(root, 'frameforge-layers-'));
  let store = new Store(directory);
  try {
    const { p: input, layer } = setup(),
      p = store.create(input).project;
    const changed = store.change(
      p.id,
      p.revision,
      [{ type: 'layer.add', layer: layer() }],
      'user',
      'layer',
    ).project;
    store.close();
    store = new Store(directory);
    assert.deepEqual(store.get(p.id).project.animationLayers, changed.animationLayers);
    const undone = store.change(p.id, changed.revision, undefined, 'user', 'undo', 'undo').project;
    assert.equal(undone.animationLayers, undefined);
    const redone = store.change(p.id, undone.revision, undefined, 'user', 'redo', 'redo').project;
    assert.deepEqual(redone.animationLayers, changed.animationLayers);
  } finally {
    store.close();
    assert.ok(resolve(directory).startsWith(root + sep));
    rmSync(directory, { recursive: true, force: true });
  }
});
