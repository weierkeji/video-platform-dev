import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { newProject } from '../src/core/factory';
import { applyCommands } from '../src/core/commands';
import { parseProject, id, type AnimationTrack } from '../src/core/model';
import { sampleTrack, sourceFrame, activeClips } from '../src/core/evaluate';
import { exportOBJ, importOBJ, primitive, extrudeFace } from '../src/core/geometry';
import { Store, Conflict } from '../server/store';
import { Jobs } from '../server/jobs';

test('transaction rejects invalid references without changing the original project', () => {
  const p = newProject(),
    before = JSON.stringify(p),
    entity = p.entities[0];
  assert.throws(
    () =>
      applyCommands(p, [
        { type: 'project.rename', name: 'must roll back' },
        { type: 'entity.update', id: entity.id, patch: { parentId: 'missing' } },
      ]),
    /父对象/,
  );
  assert.equal(JSON.stringify(p), before);
  assert.throws(
    () =>
      applyCommands(p, [{ type: 'entity.update', id: entity.id, patch: { parentId: entity.id } }]),
    /循环/,
  );
  assert.throws(
    () =>
      applyCommands(p, [
        {
          type: 'entity.update',
          id: entity.id,
          patch: { transform: { ...entity.transform, scale: [0, 1, 1] } },
        },
      ]),
    /缩放/,
  );
});
test('deleting a parent removes descendant animation dependencies and remains undoable', () => {
  let p = newProject();
  p = applyCommands(p, [{ type: 'entity.create', kind: 'group', sceneId: p.scenes[0].id }]).project;
  const group = p.entities.at(-1)!,
    mesh = p.entities[0];
  p = applyCommands(p, [
    { type: 'entity.update', id: mesh.id, patch: { parentId: group.id } },
    {
      type: 'key.set',
      entityId: mesh.id,
      property: 'position',
      key: { frame: 0, value: [0, 0, 0], interpolation: 'linear' },
    },
  ]).project;
  const next = applyCommands(p, [{ type: 'entity.delete', id: group.id }]).project;
  assert.equal(
    next.entities.some((e) => e.id === mesh.id),
    false,
  );
  assert.equal(next.animationTracks.length, 0);
  assert.equal(next.geometries.length, 0);
  assert.throws(
    () => applyCommands(p, [{ type: 'entity.delete', id: p.shots[0].cameraId }]),
    /镜头引用/,
  );
});
test('keyframe replacement, interpolation and held endpoints follow frame semantics', () => {
  const track: AnimationTrack = {
    id: id(),
    entityId: id(),
    property: 'position',
    keys: [
      { frame: 0, value: [0, 0, 0], interpolation: 'linear' },
      { frame: 10, value: [10, 20, 30], interpolation: 'constant' },
    ],
  };
  assert.deepEqual(sampleTrack(track, 5), [5, 10, 15]);
  assert.deepEqual(sampleTrack(track, 20), [10, 20, 30]);
  assert.deepEqual(sampleTrack(track, -1), [0, 0, 0]);
  track.keys[0].interpolation = 'constant';
  assert.deepEqual(sampleTrack(track, 9), [0, 0, 0]);
  assert.deepEqual(sampleTrack(track, 10), [10, 20, 30]);
  track.keys[0].interpolation = 'smooth';
  assert.deepEqual(sampleTrack(track, 5), [5, 10, 15]);
  const p = newProject(),
    command = {
      type: 'key.set' as const,
      entityId: p.entities[0].id,
      property: 'position' as const,
      key: { frame: 4, value: [1, 2, 3], interpolation: 'linear' },
    };
  const next = applyCommands(p, [
    command,
    { ...command, key: { ...command.key, value: [4, 5, 6] } },
  ]).project;
  assert.equal(next.animationTracks[0].keys.length, 1);
  assert.deepEqual(next.animationTracks[0].keys[0].value, [4, 5, 6]);
});
test('split preserves source timing and uses half-open boundaries', () => {
  const p = newProject(),
    original = p.timeline.clips[0];
  original.sourceIn = 20;
  const next = applyCommands(p, [{ type: 'clip.split', id: original.id, frame: 40 }]).project,
    [a, b] = next.timeline.clips;
  assert.equal(a.duration, 40);
  assert.equal(b.duration, 80);
  assert.equal(b.sourceIn, 60);
  assert.equal(sourceFrame(b, 75), 95);
  assert.deepEqual(
    activeClips(next, 40).map((c) => c.id),
    [b.id],
  );
  assert.equal(activeClips(next, 120).length, 0);
  assert.throws(
    () => applyCommands(next, [{ type: 'clip.update', id: b.id, patch: { start: 39 } }]),
    /重叠/,
  );
});
test('mesh editing changes actual geometry and OBJ round-trip preserves it', () => {
  const g = primitive('box');
  extrudeFace(g, 0, 0.5);
  assert.equal(g.positions.length, 11);
  assert.equal(g.triangles.length, 18);
  const roundtrip = importOBJ(exportOBJ(g));
  assert.deepEqual(roundtrip.positions, g.positions);
  assert.deepEqual(roundtrip.triangles, g.triangles);
  assert.throws(() => importOBJ('v 0 0 0\nf 1 2 3'), /索引/);
  const p = newProject();
  p.geometries[0].triangles[0][0] = 999;
  assert.throws(() => parseProject(p), /三角面/);
});
test('SQLite restart retains undo, redo, audit and concurrency checks', () => {
  const directory = mkdtempSync(join(tmpdir(), 'frameforge-store-'));
  let store = new Store(directory);
  try {
    const p = store.create(newProject()).project;
    const edited = store.change(
      p.id,
      0,
      [{ type: 'project.rename', name: 'Saved' }],
      'agent',
      'rename',
    );
    assert.equal(edited.project.revision, 1);
    assert.throws(
      () => store.change(p.id, 0, [{ type: 'project.rename', name: 'stale' }], 'user', 'stale'),
      Conflict,
    );
    store.close();
    store = new Store(directory);
    assert.equal(store.get(p.id).project.name, 'Saved');
    assert.equal(store.get(p.id).canUndo, true);
    const undo = store.change(p.id, 1, undefined, 'user', 'undo', 'undo');
    assert.equal(undo.project.name, p.name);
    assert.equal(undo.project.revision, 2);
    const redo = store.change(p.id, 2, undefined, 'user', 'redo', 'redo');
    assert.equal(redo.project.name, 'Saved');
    assert.equal(store.revisions(p.id).length, 3);
    store.change(p.id, 3, undefined, 'user', 'undo', 'undo');
    store.change(p.id, 4, [{ type: 'project.rename', name: 'branch' }], 'user', 'branch');
    assert.equal(store.get(p.id).canRedo, false);
    const revisions = store.revisions(p.id);
    assert.equal(revisions.at(-1)?.actor, 'agent');
    const first = revisions.at(-1)!;
    const restored = store.change(p.id, 5, first.id, 'user', 'restore', 'restore');
    assert.equal(restored.project.name, 'Saved');
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
test('workflow edges and portable project versions reject invalid data', () => {
  const p = newProject(),
    w = p.workflows[0];
  assert.throws(
    () =>
      applyCommands(p, [
        {
          type: 'workflow.put',
          workflow: { ...w, edges: [{ from: 'missing', to: w.nodes[0].id }] },
        },
      ]),
    /不存在/,
  );
  assert.throws(
    () =>
      applyCommands(p, [
        {
          type: 'workflow.put',
          workflow: { ...w, edges: [{ from: w.nodes[0].id, to: w.nodes[0].id }] },
        },
      ]),
    /不兼容/,
  );
  const next = applyCommands(p, [
    { type: 'workflow.put', workflow: { ...w, nodes: w.nodes.slice(0, 1), edges: [] } },
  ]).project;
  assert.equal(next.workflows[0].nodes.length, 1);
});
test('interrupted worker states are preserved for explicit recovery after restart', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'frameforge-recovery-')),
    store = new Store(directory);
  const p = store.create(newProject()).project,
    now = new Date().toISOString(),
    jobId = id();
  store.createJob(
    {
      id: jobId,
      projectId: p.id,
      projectRevision: 0,
      kind: 'render',
      requestKey: id(),
      status: 'running',
      progress: 0.3,
      message: 'rendering',
      createdAt: now,
      updatedAt: now,
    },
    p,
  );
  const jobs = new Jobs(store, 'http://127.0.0.1:1');
  try {
    assert.equal(store.job(jobId).job.status, 'interrupted');
    assert.deepEqual(store.job(jobId).snapshot, p);
  } finally {
    await jobs.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
