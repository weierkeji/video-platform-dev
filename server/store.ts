import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { applyCommands } from '../src/core/commands';
import {
  id,
  migrateProject,
  type GenerationJob,
  type Project,
  type Revision,
} from '../src/core/model';

export class Conflict extends Error {}
type Row = { json: string; history: string; cursor: number };
export class Store {
  db: DatabaseSync;
  constructor(public directory: string) {
    mkdirSync(directory, { recursive: true });
    this.db = new DatabaseSync(join(directory, 'studio.sqlite'));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS projects(id TEXT PRIMARY KEY,json TEXT NOT NULL,history TEXT NOT NULL,cursor INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS revisions(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,number INTEGER NOT NULL,json TEXT NOT NULL,snapshot TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,request_key TEXT NOT NULL,json TEXT NOT NULL,snapshot TEXT NOT NULL, UNIQUE(project_id,request_key));
      CREATE TABLE IF NOT EXISTS blobs(id TEXT PRIMARY KEY,mime TEXT NOT NULL,bytes INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS revisions_project ON revisions(project_id,number);
    `);
  }
  list() {
    return (this.db.prepare('SELECT json FROM projects').all() as { json: string }[])
      .map((r) => {
        const p = JSON.parse(r.json) as Project;
        return { id: p.id, name: p.name, revision: p.revision, updatedAt: p.updatedAt };
      })
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
  get(projectId: string) {
    const r = this.db.prepare('SELECT * FROM projects WHERE id=?').get(projectId) as
      | Row
      | undefined;
    if (!r) throw new Error('项目不存在');
    return {
      project: JSON.parse(r.json) as Project,
      canUndo: r.cursor > 0,
      canRedo: r.cursor < JSON.parse(r.history).length - 1,
    };
  }
  create(input: unknown) {
    const p = migrateProject(input);
    if (this.db.prepare('SELECT id FROM projects WHERE id=?').get(p.id)) {
      p.id = id();
      p.name += '（导入副本）';
    }
    p.revision = 0;
    p.createdAt = p.updatedAt = new Date().toISOString();
    this.db
      .prepare('INSERT INTO projects VALUES (?,?,?,0)')
      .run(p.id, JSON.stringify(p), JSON.stringify([p]));
    return this.get(p.id);
  }
  change(
    projectId: string,
    baseRevision: number,
    input: unknown,
    actor: 'user' | 'agent' | 'system',
    label: string,
    mode: 'commands' | 'undo' | 'redo' | 'restore' = 'commands',
  ) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const r = this.db.prepare('SELECT * FROM projects WHERE id=?').get(projectId) as
        | Row
        | undefined;
      if (!r) throw new Error('项目不存在');
      const current = JSON.parse(r.json) as Project;
      if (current.revision !== baseRevision)
        throw new Conflict('项目已由其他窗口修改；请刷新后重试，当前更改未覆盖服务器数据');
      let history = JSON.parse(r.history) as Project[],
        cursor = r.cursor,
        next: Project,
        command: unknown = input;
      if (mode === 'undo' || mode === 'redo') {
        cursor += mode === 'undo' ? -1 : 1;
        if (cursor < 0 || cursor >= history.length) throw new Error('没有可撤销或重做的操作');
        next = structuredClone(history[cursor]);
        command = { type: mode };
      } else {
        if (mode === 'restore') {
          const revision = this.db
            .prepare('SELECT snapshot FROM revisions WHERE id=? AND project_id=?')
            .get(String(input), projectId) as { snapshot: string } | undefined;
          if (!revision) throw new Error('版本不存在');
          next = migrateProject(JSON.parse(revision.snapshot));
          command = { type: 'revision.restore', revisionId: input };
        } else {
          const applied = applyCommands(current, input);
          next = applied.project;
          command = applied.commands;
        }
        history = history.slice(0, cursor + 1);
        history.push(next);
        if (history.length > 101) history.shift();
        cursor = history.length - 1;
      }
      next.revision = current.revision + 1;
      next.updatedAt = new Date().toISOString();
      const revision: Revision = {
        id: id(),
        projectId,
        number: next.revision,
        actor,
        label,
        command,
        createdAt: next.updatedAt,
      };
      this.db
        .prepare('UPDATE projects SET json=?,history=?,cursor=? WHERE id=?')
        .run(JSON.stringify(next), JSON.stringify(history), cursor, projectId);
      this.db
        .prepare('INSERT INTO revisions VALUES (?,?,?,?,?)')
        .run(
          revision.id,
          projectId,
          revision.number,
          JSON.stringify(revision),
          JSON.stringify(next),
        );
      this.db.exec('COMMIT');
      return this.get(projectId);
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  revisions(projectId: string) {
    return (
      this.db
        .prepare('SELECT json FROM revisions WHERE project_id=? ORDER BY number DESC LIMIT 100')
        .all(projectId) as { json: string }[]
    ).map((r) => JSON.parse(r.json) as Revision);
  }
  jobs(projectId?: string) {
    const rows = projectId
      ? this.db
          .prepare('SELECT json FROM jobs WHERE project_id=? ORDER BY rowid DESC')
          .all(projectId)
      : this.db.prepare('SELECT json FROM jobs ORDER BY rowid').all();
    return (rows as { json: string }[]).map((r) => JSON.parse(r.json) as GenerationJob);
  }
  job(jobId: string) {
    const r = this.db.prepare('SELECT json,snapshot FROM jobs WHERE id=?').get(jobId) as
      | { json: string; snapshot: string }
      | undefined;
    if (!r) throw new Error('任务不存在');
    return {
      job: JSON.parse(r.json) as GenerationJob,
      snapshot: JSON.parse(r.snapshot) as Project,
    };
  }
  createJob(job: GenerationJob, snapshot: Project) {
    const exists = this.db
      .prepare('SELECT json FROM jobs WHERE project_id=? AND request_key=?')
      .get(job.projectId, job.requestKey) as { json: string } | undefined;
    if (exists) return JSON.parse(exists.json) as GenerationJob;
    this.db
      .prepare('INSERT INTO jobs VALUES (?,?,?,?,?)')
      .run(job.id, job.projectId, job.requestKey, JSON.stringify(job), JSON.stringify(snapshot));
    return job;
  }
  saveJob(job: GenerationJob) {
    job.updatedAt = new Date().toISOString();
    this.db.prepare('UPDATE jobs SET json=? WHERE id=?').run(JSON.stringify(job), job.id);
  }
  addBlob(id: string, mime: string, bytes: number) {
    this.db.prepare('INSERT OR IGNORE INTO blobs VALUES (?,?,?)').run(id, mime, bytes);
  }
  blob(id: string) {
    return this.db.prepare('SELECT * FROM blobs WHERE id=?').get(id) as
      | { id: string; mime: string; bytes: number }
      | undefined;
  }
  close() {
    this.db.close();
  }
}
