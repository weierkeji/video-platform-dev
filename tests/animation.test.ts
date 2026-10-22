import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { newProject } from '../src/core/factory';
import { applyCommands } from '../src/core/commands';
import {
  id,
  migrateProject,
  PROJECT_VERSION,
  type AnimationTrack,
  type KeyHandles,
} from '../src/core/model';
import { cubic, editTrack, keyHandles, sampleTrack, segmentControls } from '../src/core/animation';
import { Store } from '../server/store';

function track(): AnimationTrack {
  return {
    id: id(),
    entityId: id(),
    property: 'position',
    keys: [
      { id: id(), frame: 0, value: [0, 0, 0], interpolation: 'bezier' },
      { id: id(), frame: 20, value: [10, 20, 30], interpolation: 'bezier' },
      { id: id(), frame: 50, value: [15, -5, 30], interpolation: 'bezier' },
    ],
  };
}
test('Bézier solves cubic time independently on each axis, including shortened crossing handles', () => {
  const t = track();
  editTrack(t, {
    type: 'key.handle',
    trackId: t.id,
    keyId: t.keys[0].id,
    axis: 0,
    side: 'right',
    offset: [1, 9],
  });
  editTrack(t, {
    type: 'key.handle',
    trackId: t.id,
    keyId: t.keys[1].id,
    axis: 0,
    side: 'left',
    offset: [-4, -2],
  });
  // At Bézier parameter 0.5, the time is 8.875 (not the segment midpoint 10).
  const f = cubic(0, 1, 16, 20, 0.5),
    expected = cubic(0, 9, 8, 10, 0.5);
  assert.ok(Math.abs(sampleTrack(t, f)![0] - expected) < 1e-10);
  assert.ok(Math.abs(sampleTrack(t, 10)![0] - expected) > 0.1);
  assert.notEqual(sampleTrack(t, f)![1], sampleTrack(t, f)![0] * 2);
  assert.deepEqual(sampleTrack(t, 20), t.keys[1].value, 'exact key times retain exact values');
  editTrack(t, {
    type: 'key.handle',
    trackId: t.id,
    keyId: t.keys[0].id,
    axis: 0,
    side: 'right',
    offset: [40, 12],
  });
  editTrack(t, {
    type: 'key.handle',
    trackId: t.id,
    keyId: t.keys[1].id,
    axis: 0,
    side: 'left',
    offset: [-40, -8],
  });
  const points = segmentControls(t, 0, 0);
  assert.deepEqual(points, [
    [0, 0],
    [10, 3],
    [10, 8],
    [20, 10],
  ]);
  assert.ok(Math.abs(sampleTrack(t, 10)![0] - 5.375) < 1e-10);
  assert.equal(t.keys[0].handles![0].right[0], 40, 'evaluation does not mutate stored controls');
});

test('automatic handles retain extrema and stay within each segment range on uneven time spacing', () => {
  const t = track();
  t.keys[1].frame = 2;
  assert.equal(keyHandles(t, 1, 1).right[1], 0, 'turning point is horizontal');
  for (let segment = 0; segment < t.keys.length - 1; segment++) {
    const a = t.keys[segment],
      b = t.keys[segment + 1];
    for (let step = 0; step <= 100; step++) {
      const sample = sampleTrack(t, a.frame + ((b.frame - a.frame) * step) / 100)!;
      for (let axis = 0; axis < 3; axis++)
        assert.ok(
          sample[axis] >= Math.min(a.value[axis], b.value[axis]) - 1e-9 &&
            sample[axis] <= Math.max(a.value[axis], b.value[axis]) + 1e-9,
        );
    }
  }
  for (const k of t.keys)
    for (let axis = 0; axis < 3; axis++)
      editTrack(t, { type: 'key.handles', trackId: t.id, keyId: k.id, axis, mode: 'vector' });
  const midpoint = sampleTrack(t, 1)!;
  midpoint.forEach((v, i) => assert.ok(Math.abs(v - t.keys[1].value[i] / 2) < 1e-10));
});

test('aligned handles preserve the opposite length and free handles move independently', () => {
  const t = track(),
    key = t.keys[1];
  editTrack(t, { type: 'key.handles', trackId: t.id, keyId: key.id, axis: 0, mode: 'aligned' });
  const previous = keyHandles(t, 1, 0),
    length = Math.hypot(...previous.left);
  editTrack(t, {
    type: 'key.handle',
    trackId: t.id,
    keyId: key.id,
    axis: 0,
    side: 'right',
    offset: [6, 9],
  });
  const h = key.handles![0];
  assert.ok(Math.abs(Math.hypot(...h.left) - length) < 1e-10);
  assert.ok(Math.abs(h.left[0] * h.right[1] - h.left[1] * h.right[0]) < 1e-10);
  editTrack(t, { type: 'key.handles', trackId: t.id, keyId: key.id, axis: 0, mode: 'free' });
  const left = [...key.handles![0].left];
  editTrack(t, {
    type: 'key.handle',
    trackId: t.id,
    keyId: key.id,
    axis: 0,
    side: 'right',
    offset: [2, -4],
  });
  assert.deepEqual(key.handles![0].left, left);
});

test('time edits preserve identity, reject collisions atomically and property edits retain curves', () => {
  const p = newProject(),
    t = track();
  t.entityId = p.entities[0].id;
  p.animationTracks.push(t);
  const key = t.keys[0];
  let next = applyCommands(p, [
    { type: 'key.handle', trackId: t.id, keyId: key.id, axis: 0, side: 'right', offset: [4, 8] },
  ]).project;
  const handles = structuredClone(next.animationTracks[0].keys[0].handles);
  next = applyCommands(next, [
    {
      type: 'key.set',
      entityId: t.entityId,
      property: t.property,
      key: { frame: 0, value: [1, 2, 3] },
    },
  ]).project;
  assert.deepEqual(next.animationTracks[0].keys[0], { ...key, value: [1, 2, 3], handles });
  next = applyCommands(next, [
    { type: 'key.update', trackId: t.id, keyId: key.id, patch: { frame: 40 } },
  ]).project;
  assert.equal(next.animationTracks[0].keys[1].id, key.id);
  const before = JSON.stringify(next);
  assert.throws(
    () =>
      applyCommands(next, [
        { type: 'project.rename', name: 'must roll back' },
        { type: 'key.update', trackId: t.id, keyId: key.id, patch: { frame: 20 } },
      ]),
    /已有关键帧/,
  );
  assert.throws(
    () =>
      applyCommands(next, [
        { type: 'key.handle', trackId: t.id, keyId: key.id, axis: 0, side: 'left', offset: [1, 2] },
      ]),
    /朝过去/,
  );
  assert.equal(JSON.stringify(next), before);
  const duplicate = applyCommands(next, [{ type: 'entity.duplicate', id: t.entityId }]).project;
  const copied = duplicate.animationTracks.at(-1)!;
  assert.notEqual(copied.id, t.id);
  assert.deepEqual(copied.keys, next.animationTracks[0].keys, 'key identity is scoped by track');
});

test('v3 key migration is deterministic across persisted histories, revisions and task snapshots', () => {
  const root = resolve(tmpdir()),
    directory = mkdtempSync(join(root, 'frameforge-curves-'));
  let store = new Store(directory);
  try {
    const p = newProject(),
      t = track();
    t.entityId = p.entities[0].id;
    t.keys.forEach((k) => {
      k.interpolation = 'smooth';
    });
    p.animationTracks.push(t);
    store.create(p);
    store.change(p.id, 0, [{ type: 'project.rename', name: 'saved curves' }], 'user', 'rename');
    const jobId = id(),
      now = new Date().toISOString();
    store.createJob(
      {
        id: jobId,
        projectId: p.id,
        projectRevision: 0,
        kind: 'render',
        requestKey: id(),
        status: 'queued',
        progress: 0,
        message: 'queued',
        createdAt: now,
        updatedAt: now,
      },
      p,
    );
    const legacy = (json: string) => {
      const p = JSON.parse(json);
      p.schemaVersion = 3;
      p.animationTracks.forEach((t: AnimationTrack) =>
        t.keys.forEach((k) => {
          delete (k as { id?: string }).id;
        }),
      );
      return p;
    };
    const row = store.db.prepare('SELECT json,history FROM projects WHERE id=?').get(p.id) as {
      json: string;
      history: string;
    };
    store.db
      .prepare('UPDATE projects SET json=?,history=? WHERE id=?')
      .run(
        JSON.stringify(legacy(row.json)),
        JSON.stringify(JSON.parse(row.history).map((h: unknown) => legacy(JSON.stringify(h)))),
        p.id,
      );
    for (const table of ['revisions', 'jobs']) {
      const rows = store.db.prepare(`SELECT id,snapshot FROM ${table}`).all() as {
        id: string;
        snapshot: string;
      }[];
      for (const r of rows)
        store.db
          .prepare(`UPDATE ${table} SET snapshot=? WHERE id=?`)
          .run(JSON.stringify(legacy(r.snapshot)), r.id);
    }
    const source = legacy(JSON.stringify(p));
    assert.deepEqual(migrateProject(source), migrateProject(source));
    assert.equal(source.animationTracks[0].keys[0].id, undefined);
    store.close();
    store = new Store(directory);
    const upgraded = store.get(p.id).project;
    assert.equal(upgraded.schemaVersion, PROJECT_VERSION);
    const keys = upgraded.animationTracks[0].keys;
    assert.equal(store.job(jobId).snapshot.animationTracks[0].keys[1].id, keys[1].id);
    assert.deepEqual(sampleTrack(upgraded.animationTracks[0], 7), sampleTrack(t, 7));
    const edited = store.change(
      p.id,
      1,
      [
        {
          type: 'key.update',
          trackId: t.id,
          keyId: keys[1].id,
          patch: { frame: 23, interpolation: 'bezier' },
        },
      ],
      'agent',
      'time edit',
    );
    assert.equal(edited.project.animationTracks[0].keys[1].frame, 23);
    store.close();
    store = new Store(directory);
    assert.equal(store.get(p.id).project.animationTracks[0].keys[1].id, keys[1].id);
    assert.equal(
      store.change(p.id, 2, undefined, 'user', 'undo', 'undo').project.animationTracks[0].keys[1]
        .frame,
      20,
    );
    assert.equal(
      store.change(p.id, 3, undefined, 'user', 'redo', 'redo').project.animationTracks[0].keys[1]
        .frame,
      23,
    );
    const backup = new DatabaseSync(
      join(directory, 'backups', readdirSync(join(directory, 'backups'))[0]),
      { readOnly: true },
    );
    try {
      const r = backup.prepare('SELECT json FROM projects WHERE id=?').get(p.id) as {
        json: string;
      };
      assert.equal(JSON.parse(r.json).schemaVersion, 3);
    } finally {
      backup.close();
    }
    assert.equal(
      (store.db.prepare('SELECT to_version FROM schema_migrations').get() as { to_version: number })
        .to_version,
      PROJECT_VERSION,
    );
  } finally {
    store.close();
    assert.ok(resolve(directory).startsWith(root + sep));
    rmSync(directory, { recursive: true, force: true });
  }
});
