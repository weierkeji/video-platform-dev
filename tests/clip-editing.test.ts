import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { newProject } from '../src/core/factory';
import { id, parseProject, type Asset, type Project } from '../src/core/model';
import { planClipEdit, previewClipEdit, type ClipEdit } from '../src/core/clip-editing';
import { applyCommands } from '../src/core/commands';
import { sourceFrame } from '../src/core/playback';
import { audioSegment } from '../src/core/media';
import { Store } from '../server/store';

function fixture() {
  const p = newProject(),
    c = p.timeline.clips[0];
  p.timeline.duration = 120;
  Object.assign(c, {
    start: 20,
    duration: 40,
    sourceIn: 8.375,
    action: { actionId: null },
    playback: { rate: -0.75, rangeStart: 1.25, rangeEnd: 12.5, mode: 'pingpong' },
    volume: 0.7,
    fit: 'cover',
  });
  return parseProject(p);
}
function apply(p: Project, edit: ClipEdit) {
  const c = p.timeline.clips[0],
    plan = planClipEdit(p, c.id, edit);
  assert.equal(plan.error, '');
  return applyCommands(p, [{ type: 'clip.update', id: c.id, patch: plan.patch }]).project;
}
const near = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-8, `${a} != ${b}`);
function media(kind: 'video' | 'audio' | 'image') {
  const p = fixture(),
    c = p.timeline.clips[0];
  const asset: Asset = {
    id: id(),
    name: kind,
    kind,
    mime: kind === 'image' ? 'image/png' : kind === 'audio' ? 'audio/wav' : 'video/mp4',
    blobId: 'a'.repeat(64),
    bytes: 100,
    ...(kind === 'image' ? {} : { duration: 3 }),
  };
  p.assets.push(asset);
  Object.assign(c, { kind, sourceId: asset.id, sourceIn: 12, duration: 24 });
  delete c.action;
  delete c.playback;
  return parseProject(p);
}

test('moving changes placement/channel while preserving source phase, every clip option and source data', () => {
  const p = fixture(),
    before = structuredClone(p),
    c = p.timeline.clips[0],
    next = apply(p, { mode: 'move', delta: 19, channel: 3 });
  const moved = next.timeline.clips[0];
  assert.deepEqual(moved, { ...c, start: 39, channel: 3 });
  for (const t of [0, 0.125, 11.5, 25.75, 39.9])
    near(sourceFrame(c, c.start + t), sourceFrame(moved, moved.start + t));
  assert.deepEqual(p, before);
  assert.deepEqual(next.animationTracks, p.animationTracks);
  assert.deepEqual(next.shots, p.shots);
  assert.deepEqual(next.entities, p.entities);
});

test('left trimming preserves unwrapped source time across positive, negative, frozen and looping shot playback', () => {
  for (const mode of ['hold', 'repeat', 'pingpong'] as const)
    for (const rate of [-2.25, -0.75, 0, 0.125, 1, 2.5]) {
      const p = fixture(),
        c = p.timeline.clips[0];
      c.playback = { ...c.playback!, mode, rate };
      for (const delta of [-5, 7, 39]) {
        const trimmed = apply(p, { mode: 'trimStart', delta }).timeline.clips[0];
        near(trimmed.sourceIn, c.sourceIn + delta * rate);
        assert.equal(trimmed.start + trimmed.duration, c.start + c.duration);
        for (let t = Math.max(c.start, trimmed.start); t < c.start + c.duration; t += 0.375)
          near(sourceFrame(c, t), sourceFrame(trimmed, t));
      }
    }
});

test('right trimming and inverse left trimming retain original phase and never retime the kept content', () => {
  const p = fixture(),
    c = p.timeline.clips[0];
  for (const delta of [-39, 12]) {
    const right = apply(p, { mode: 'trimEnd', delta }).timeline.clips[0];
    assert.equal(right.start, c.start);
    assert.equal(right.sourceIn, c.sourceIn);
    assert.deepEqual(right.playback, c.playback);
  }
  const restored = apply(apply(p, { mode: 'trimStart', delta: 9 }), {
    mode: 'trimStart',
    delta: -9,
  });
  assert.deepEqual(restored.timeline.clips, p.timeline.clips);
  assert.equal(planClipEdit(p, c.id, { mode: 'move', delta: 0 }).changed, false);
});

test('media trims follow integer source samples and audio timing while images can extend without a media duration', () => {
  for (const kind of ['video', 'audio'] as const) {
    const p = media(kind),
      c = p.timeline.clips[0],
      next = apply(p, { mode: 'trimStart', delta: 6 }),
      trimmed = next.timeline.clips[0];
    assert.equal(trimmed.sourceIn, 18);
    assert.equal(trimmed.duration, 18);
    assert.equal(trimmed.fit, 'cover');
    const before = audioSegment(c, p.timeline.fps),
      after = audioSegment(trimmed, next.timeline.fps);
    assert.ok(before && after);
    near(after.trimStart - before.trimStart, (6 * 48000) / p.timeline.fps);
    near(after.delay - before.delay, (6 * 48000) / p.timeline.fps);
    assert.equal(
      planClipEdit(p, c.id, { mode: 'trimStart', delta: -13 }).error,
      '媒体源入点必须为范围内的非负整帧',
    );
    assert.equal(planClipEdit(p, c.id, { mode: 'trimEnd', delta: 37 }).error, '');
    assert.equal(planClipEdit(p, c.id, { mode: 'trimEnd', delta: 38 }).error, '片段超出素材时长');
  }
  const p = media('image');
  assert.equal(apply(p, { mode: 'trimEnd', delta: 70 }).timeline.clips[0].duration, 94);
});

test('partial clip updates retain existing cover/stretch fit until fit is explicitly edited', () => {
  for (const fit of ['cover', 'stretch'] as const) {
    const p = media('video'),
      c = p.timeline.clips[0];
    c.fit = fit;
    const next = applyCommands(p, [
      { type: 'clip.update', id: c.id, patch: { name: '重新命名', volume: 0.25 } },
    ]).project;
    assert.equal(next.timeline.clips[0].fit, fit);
    const explicit = applyCommands(next, [
      { type: 'clip.update', id: c.id, patch: { fit: 'contain' } },
    ]).project;
    assert.equal(explicit.timeline.clips[0].fit, 'contain');
    assert.equal(explicit.timeline.clips[0].volume, 0.25);
  }
});

test('bounds, minimum duration, all-channel collisions and strict inputs reject drafts without partial mutation', () => {
  const p = fixture(),
    c = p.timeline.clips[0];
  p.timeline.clips.push({ ...c, id: id(), start: 60, duration: 20, muted: true });
  const before = structuredClone(p);
  for (const edit of [
    { mode: 'move', delta: -21 },
    { mode: 'move', delta: 61 },
    { mode: 'trimStart', delta: 40 },
    { mode: 'trimEnd', delta: -40 },
    { mode: 'move', delta: 1 },
    { mode: 'trimEnd', delta: 1 },
  ] as ClipEdit[])
    assert.ok(planClipEdit(p, c.id, edit).error);
  assert.equal(planClipEdit(p, c.id, { mode: 'move', delta: 40, channel: 1 }).error, '');
  assert.throws(() => planClipEdit(p, c.id, { mode: 'move', delta: 0.5 }));
  assert.throws(() => planClipEdit(p, c.id, { mode: 'move', delta: 0, channel: 32 }));
  assert.throws(() => planClipEdit(p, c.id, { mode: 'trimStart', delta: 1, channel: 1 }), /裁剪/);
  assert.throws(() => planClipEdit(p, id(), { mode: 'move', delta: 1 }), /不存在/);
  assert.deepEqual(p, before);
  const rejected = planClipEdit(p, c.id, { mode: 'move', delta: 1 });
  assert.throws(
    () => applyCommands(p, [{ type: 'clip.update', id: c.id, patch: rejected.patch }]),
    /重叠/,
  );
});

test('snapping considers both moving edges, timeline bounds and integer playheads with deterministic ties', () => {
  const p = fixture(),
    c = p.timeline.clips[0];
  p.timeline.clips.push({ ...c, id: id(), start: 80, duration: 20, channel: 1 });
  const snap = (delta: number, frame = 117, threshold = 2) =>
    previewClipEdit(p, c.id, { mode: 'move', delta }, { frame, threshold });
  assert.equal(snap(19).clip.start, 40);
  assert.equal(snap(19).snapFrame, 80);
  assert.equal(snap(-19).clip.start, 0);
  assert.equal(snap(-19).snapFrame, 0);
  assert.equal(snap(59).clip.start, 80);
  assert.equal(snap(59).snapFrame, 80); // Both edges align; the earlier target wins the tie.
  assert.equal(
    previewClipEdit(p, c.id, { mode: 'trimStart', delta: 8 }, { frame: 29, threshold: 2 }).clip
      .start,
    29,
  );
  assert.equal(
    previewClipEdit(p, c.id, { mode: 'trimStart', delta: 8 }, { frame: 29.25, threshold: 2 })
      .snapFrame,
    undefined,
  );
  assert.equal(previewClipEdit(p, c.id, { mode: 'move', delta: 19 }).clip.start, 39);
  assert.equal(snap(10, 30, 0).clip.start, 30);
});

test('snapping skips an illegal overlap candidate and does not silently move or overwrite its neighbor', () => {
  const p = fixture(),
    c = p.timeline.clips[0];
  Object.assign(c, { start: 10, duration: 10 });
  p.timeline.clips.push({ ...c, id: id(), start: 25, duration: 10 });
  const before = structuredClone(p),
    preview = previewClipEdit(p, c.id, { mode: 'move', delta: 14 }, { frame: 100, threshold: 10 });
  assert.equal(preview.error, '');
  assert.equal(preview.clip.start, 15);
  assert.equal(preview.snapFrame, 25);
  assert.deepEqual(p, before);
  const invalid = previewClipEdit(
    p,
    c.id,
    { mode: 'move', delta: 14 },
    { frame: 100, threshold: 1 },
  );
  assert.match(invalid.error, /重叠/);
  assert.equal(invalid.snapFrame, undefined);
});

test('one clip edit and its exact unwrapped phase survive SQLite close/reopen and atomic undo/redo', () => {
  const root = resolve(tmpdir()),
    directory = mkdtempSync(join(root, 'ff-clip-edit-'));
  let store = new Store(directory);
  try {
    const before = store.create(fixture()).project,
      c = before.timeline.clips[0],
      plan = planClipEdit(before, c.id, { mode: 'trimStart', delta: 11 });
    const after = store.change(
      before.id,
      before.revision,
      [{ type: 'clip.update', id: c.id, patch: plan.patch }],
      'user',
      'trim',
    ).project;
    store.close();
    store = new Store(directory);
    assert.deepEqual(store.get(before.id).project, after);
    const undo = store.change(before.id, after.revision, undefined, 'user', 'undo', 'undo').project;
    assert.deepEqual(undo.timeline, before.timeline);
    const redo = store.change(before.id, undo.revision, undefined, 'user', 'redo', 'redo').project;
    assert.deepEqual(redo.timeline, after.timeline);
  } finally {
    store.close();
    assert.ok(resolve(directory).startsWith(root + sep));
    rmSync(directory, { recursive: true, force: true });
  }
});
