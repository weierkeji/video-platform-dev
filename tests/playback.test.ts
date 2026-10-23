import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { newProject } from '../src/core/factory';
import {
  id,
  migrateProject,
  parseProject,
  type AnimationTrack,
  type Clip,
} from '../src/core/model';
import { sourceFrame, shotAction, actionRange } from '../src/core/playback';
import { evaluatedTransform, activeClips } from '../src/core/evaluate';
import { applyCommands } from '../src/core/commands';
import { Store } from '../server/store';

const near = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-8, `${a} != ${b}`);
function project() {
  const p = newProject(),
    sceneId = p.scenes[0].id;
  p.animationActions = [
    { id: id(), name: 'A', sceneId },
    { id: id(), name: 'B', sceneId },
  ];
  p.scenes[0].activeActionId = p.animationActions[0].id;
  p.animationTracks = [undefined, ...p.animationActions.map((a) => a.id)].flatMap((actionId, i) =>
    [p.entities[0].id, p.shots[0].cameraId].map(
      (entityId): AnimationTrack => ({
        id: id(),
        entityId,
        actionId,
        property: 'position',
        keys: [
          { id: id(), frame: 0, value: [i * 10, 0, 0], interpolation: 'linear' },
          { id: id(), frame: 10, value: [i * 10 + 10, 0, 0], interpolation: 'linear' },
        ],
      }),
    ),
  );
  return parseProject(p);
}

test('shot time mapping has explicit hold, repeat, reverse, freeze and ping-pong boundaries', () => {
  const clip = newProject().timeline.clips[0];
  clip.start = 20;
  clip.sourceIn = 2.5;
  clip.playback = { rate: 1, rangeStart: 2.5, rangeEnd: 12.5, mode: 'hold' };
  assert.deepEqual(
    [19, 20, 25, 30, 40].map((f) => sourceFrame(clip, f)),
    [2.5, 2.5, 7.5, 12.5, 12.5],
  );
  clip.playback.mode = 'repeat';
  assert.deepEqual(
    [20, 25, 30, 35, 40].map((f) => sourceFrame(clip, f)),
    [2.5, 7.5, 2.5, 7.5, 2.5],
  );
  clip.sourceIn = 12.5;
  clip.playback.rate = -1;
  assert.deepEqual(
    [20, 25, 30, 35, 40].map((f) => sourceFrame(clip, f)),
    [12.5, 7.5, 12.5, 7.5, 12.5],
  );
  clip.sourceIn = 2.5;
  clip.playback.rate = 1;
  clip.playback.mode = 'pingpong';
  assert.deepEqual(
    [20, 25, 30, 35, 40].map((f) => sourceFrame(clip, f)),
    [2.5, 7.5, 12.5, 7.5, 2.5],
  );
  clip.playback.rate = 0;
  clip.sourceIn = 6.25;
  near(sourceFrame(clip, 119), 6.25);
  clip.playback = { rate: -0.1, rangeStart: 0.1, rangeEnd: 0.3, mode: 'repeat' };
  clip.sourceIn = 0.3;
  near(sourceFrame(clip, 22), 0.3);
});

test('splitting retimed shots preserves unwrapped fractional phase in every playback mode', () => {
  for (const mode of ['hold', 'repeat', 'pingpong'] as const)
    for (const rate of [1.25, -0.75, 0]) {
      const p = project(),
        c = p.timeline.clips[0];
      c.action = { actionId: p.animationActions![1].id };
      c.sourceIn = 18.375;
      c.playback = { rate, rangeStart: 1.25, rangeEnd: 10.75, mode };
      const before = JSON.stringify(p),
        result = applyCommands(p, [{ type: 'clip.split', id: c.id, frame: 23 }]).project;
      const right = result.timeline.clips[1];
      near(right.sourceIn, c.sourceIn + 23 * rate);
      assert.deepEqual(right.action, c.action);
      assert.deepEqual(right.playback, c.playback);
      for (let f = 0; f < 120; f += 0.25) {
        const active = activeClips(result, f);
        assert.equal(active.length, 1);
        near(sourceFrame(active[0], f), sourceFrame(c, f));
      }
      assert.equal(JSON.stringify(p), before);
    }
});

test('scene, shot and clip action choices stay isolated and explicit project tracks override inheritance', () => {
  const p = project(),
    shot = p.shots[0],
    c = p.timeline.clips[0],
    [a, b] = p.animationActions!;
  assert.equal(shotAction(p, shot, c), a.id);
  shot.action = { actionId: b.id };
  assert.equal(shotAction(p, shot, c), b.id);
  c.action = { actionId: null };
  const before = JSON.stringify(p);
  for (const entity of [p.entities[0], p.entities.find((e) => e.id === shot.cameraId)!]) {
    near(evaluatedTransform(p, entity, 2.5, shotAction(p, shot, c)).position[0], 2.5);
    near(evaluatedTransform(p, entity, 2.5, b.id).position[0], 22.5);
    near(evaluatedTransform(p, entity, 2.5).position[0], 12.5);
  }
  assert.equal(JSON.stringify(p), before);
  c.action = null;
  assert.equal(shotAction(p, shot, c), b.id);
  shot.action = null;
  assert.equal(shotAction(p, shot, c), a.id);
});

test('action references, timing limits and media-only integer timing reject invalid transactions', () => {
  const p = project(),
    shot = p.shots[0],
    clip = p.timeline.clips[0],
    actionId = p.animationActions![0].id;
  shot.action = { actionId };
  const before = JSON.stringify(p);
  assert.throws(
    () => applyCommands(p, [{ type: 'action.delete', id: actionId }]),
    /仍被镜头或片段引用/,
  );
  assert.throws(
    () =>
      applyCommands(p, [
        { type: 'clip.update', id: clip.id, patch: { action: { actionId: 'missing' } } },
      ]),
    /动作必须属于同一场景/,
  );
  assert.throws(
    () =>
      applyCommands(p, [
        {
          type: 'clip.update',
          id: clip.id,
          patch: { playback: { rate: 1, rangeStart: 2, rangeEnd: 2, mode: 'repeat' } },
        },
      ]),
    /播放范围/,
  );
  assert.throws(
    () => applyCommands(p, [{ type: 'clip.update', id: clip.id, patch: { sourceIn: 1e9 } }]),
    /源时间超出/,
  );
  assert.equal(JSON.stringify(p), before);
  const media = structuredClone(p);
  media.timeline.clips[0].kind = 'video';
  media.timeline.clips[0].sourceIn = 0.5;
  assert.throws(() => parseProject(media), /媒体源入点/);
  media.timeline.clips[0].sourceIn = 0;
  media.timeline.clips[0].action = { actionId };
  assert.throws(() => parseProject(media), /只能用于镜头片段/);
  const removed = applyCommands(p, [
    { type: 'shot.update', id: shot.id, patch: { action: null } },
    { type: 'action.delete', id: actionId },
  ]).project;
  assert.ok(!removed.animationActions!.some((a) => a.id === actionId));
});

test('retimed shots survive save, restart, undo and redo while old v8 snapshots keep original timing', () => {
  const root = resolve(tmpdir()),
    directory = mkdtempSync(join(root, 'frameforge-playback-'));
  let store = new Store(directory);
  try {
    const p = store.create(project()).project,
      clip = p.timeline.clips[0];
    const patch: Partial<Clip> = {
      sourceIn: -17.5,
      action: { actionId: null },
      playback: { rate: -0.75, rangeStart: 1.25, rangeEnd: 8.5, mode: 'pingpong' },
    };
    const changed = store.change(
      p.id,
      p.revision,
      [{ type: 'clip.update', id: clip.id, patch }],
      'user',
      'retime',
    ).project;
    store.close();
    store = new Store(directory);
    assert.deepEqual(store.get(p.id).project.timeline.clips, changed.timeline.clips);
    const undone = store.change(p.id, changed.revision, undefined, 'user', 'undo', 'undo').project;
    assert.deepEqual(undone.timeline.clips, p.timeline.clips);
    const redone = store.change(p.id, undone.revision, undefined, 'user', 'redo', 'redo').project;
    assert.deepEqual(redone.timeline.clips, changed.timeline.clips);
    const old = { ...p, schemaVersion: 8 };
    assert.deepEqual(migrateProject(old), p);
    near(sourceFrame(migrateProject(old).timeline.clips[0], 42.5), 42.5);
  } finally {
    store.close();
    assert.ok(resolve(directory).startsWith(root + sep));
    rmSync(directory, { recursive: true, force: true });
  }
});

test('action range resolves only the chosen scene/action and supplies a safe interval for single keys', () => {
  const p = project(),
    sceneId = p.scenes[0].id;
  assert.deepEqual(actionRange(p, sceneId, p.animationActions![0].id), { start: 0, end: 10 });
  p.animationTracks = p.animationTracks.filter((t) => !t.actionId);
  for (const t of p.animationTracks) t.keys = [{ ...t.keys[0], frame: 1e6 }];
  assert.deepEqual(actionRange(p, sceneId, null), { start: 999999, end: 1000000 });
  assert.deepEqual(actionRange(p, sceneId, p.animationActions![0].id), { start: 0, end: 1 });
});
