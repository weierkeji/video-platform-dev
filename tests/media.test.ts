import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { resolve, join, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { newProject } from '../src/core/factory';
import { migrateProject, id, PROJECT_VERSION, type Project } from '../src/core/model';
import { fitRect, audioSegment } from '../src/core/media';
import { Store } from '../server/store';

test('contain, cover and stretch preserve explicit source/output rectangle semantics', () => {
  assert.deepEqual(fitRect(100, 200, 320, 180, 'contain'), {
    sx: 0,
    sy: 0,
    sw: 100,
    sh: 200,
    dx: 115,
    dy: 0,
    dw: 90,
    dh: 180,
  });
  assert.deepEqual(fitRect(100, 200, 320, 180, 'cover'), {
    sx: 0,
    sy: 71.875,
    sw: 100,
    sh: 56.25,
    dx: 0,
    dy: 0,
    dw: 320,
    dh: 180,
  });
  assert.deepEqual(fitRect(100, 200, 320, 180, 'stretch'), {
    sx: 0,
    sy: 0,
    sw: 100,
    sh: 200,
    dx: 0,
    dy: 0,
    dw: 320,
    dh: 180,
  });
  assert.throws(() => fitRect(0, 200, 320, 180, 'contain'), /尺寸/);
});
test('audio trims, delayed stream starts and adjacent clips retain sample boundaries', () => {
  const c = {
    ...newProject().timeline.clips[0],
    start: 12,
    duration: 24,
    sourceIn: 6,
    volume: 1.5,
  };
  assert.deepEqual(audioSegment(c, 24), {
    trimStart: 12000,
    samples: 48000,
    delay: 24000,
    gain: 1.5,
  });
  assert.deepEqual(audioSegment(c, 24, 0.5), {
    trimStart: 0,
    samples: 36000,
    delay: 36000,
    gain: 1.5,
  });
  assert.equal(audioSegment(c, 24, 2), null);
  const a = audioSegment({ ...c, start: 1, duration: 1, sourceIn: 0 }, 29)!,
    b = audioSegment({ ...c, start: 2, duration: 1, sourceIn: 1 }, 29)!;
  assert.equal(a.delay + a.samples, b.delay);
});
test('v1 migration preserves appearance, video silence and original input bytes', () => {
  const p = newProject(),
    legacy = JSON.parse(JSON.stringify(p));
  legacy.schemaVersion = 1;
  for (const c of legacy.timeline.clips) {
    delete c.fit;
    c.volume = 0;
  }
  const before = JSON.stringify(legacy),
    next = migrateProject(legacy);
  assert.equal(next.schemaVersion, PROJECT_VERSION);
  assert.equal(next.timeline.clips[0].fit, 'stretch');
  assert.equal(next.timeline.clips[0].volume, 0);
  assert.equal(JSON.stringify(legacy), before);
  assert.throws(() => migrateProject({ ...legacy, schemaVersion: PROJECT_VERSION + 1 }), /不支持/);
  assert.throws(() => migrateProject({ ...legacy, schemaVersion: '1' }), /不支持/);
});
test('database migration backs up and upgrades project, undo history, revisions and job snapshots atomically', () => {
  const root = resolve(tmpdir()),
    directory = mkdtempSync(join(root, 'frameforge-migration-'));
  let store = new Store(directory);
  try {
    const p = store.create(newProject()).project,
      legacy = JSON.parse(JSON.stringify(p));
    legacy.schemaVersion = 1;
    legacy.timeline.clips.forEach((c: { fit?: string }) => delete c.fit);
    const revisionId = id(),
      jobId = id(),
      now = new Date().toISOString();
    store.db
      .prepare('UPDATE projects SET json=?,history=? WHERE id=?')
      .run(JSON.stringify(legacy), JSON.stringify([legacy]), p.id);
    store.db.prepare('INSERT INTO revisions VALUES (?,?,?,?,?)').run(
      revisionId,
      p.id,
      1,
      JSON.stringify({
        id: revisionId,
        projectId: p.id,
        number: 1,
        actor: 'user',
        label: 'old',
        command: [],
        createdAt: now,
      }),
      JSON.stringify(legacy),
    );
    store.createJob(
      {
        id: jobId,
        projectId: p.id,
        projectRevision: 0,
        kind: 'render',
        requestKey: id(),
        status: 'cancelled',
        progress: 0,
        message: 'old',
        createdAt: now,
        updatedAt: now,
      },
      legacy as Project,
    );
    store.close();
    store = new Store(directory);
    assert.equal(store.get(p.id).project.schemaVersion, PROJECT_VERSION);
    assert.equal(store.job(jobId).snapshot.timeline.clips[0].fit, 'stretch');
    const row = store.db.prepare('SELECT history FROM projects WHERE id=?').get(p.id) as {
      history: string;
    };
    assert.equal(JSON.parse(row.history)[0].schemaVersion, PROJECT_VERSION);
    assert.equal(
      store.change(p.id, 0, revisionId, 'user', 'restore', 'restore').project.timeline.clips[0].fit,
      'stretch',
    );
    const backups = readdirSync(join(directory, 'backups'));
    assert.equal(backups.length, 1);
    const migration = store.db.prepare('SELECT * FROM schema_migrations').get() as {
      from_version: number;
      to_version: number;
      backup_name: string;
    };
    assert.equal(migration.from_version, 1);
    assert.equal(migration.to_version, PROJECT_VERSION);
    assert.equal(migration.backup_name, backups[0]);
    const backup = new DatabaseSync(join(directory, 'backups', backups[0]), { readOnly: true });
    try {
      const r = backup.prepare('SELECT json FROM projects WHERE id=?').get(p.id) as {
        json: string;
      };
      assert.equal(JSON.parse(r.json).schemaVersion, 1);
    } finally {
      backup.close();
    }
  } finally {
    store.close();
    assert.ok(resolve(directory).startsWith(root + sep));
    rmSync(directory, { recursive: true, force: true });
  }
});
