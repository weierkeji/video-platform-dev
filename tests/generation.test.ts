import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { newProject } from '../src/core/factory';
import { id, migrateProject, PROJECT_VERSION, type GenerationJob } from '../src/core/model';
import { applyCommands } from '../src/core/commands';
import { validateGeneration } from '../src/core/generation';
import {
  Seedance,
  ProviderError,
  providerStatus,
  requestBody,
  resultUrl,
  type VideoProvider,
} from '../server/seedance';
import { GenerationJobs, downloadVideo } from '../server/generation-jobs';
import { Store } from '../server/store';
import { Jobs } from '../server/jobs';

const request = validateGeneration({
  model: 'contract-test-model',
  prompt: 'A moving sphere',
  profile: '2.0',
});
function directory() {
  return mkdtempSync(join(tmpdir(), 'frameforge-generation-'));
}
function cleanup(path: string) {
  assert.ok(resolve(path).startsWith(resolve(tmpdir()) + sep));
  rmSync(path, { recursive: true, force: true });
}
function job(projectId: string): GenerationJob {
  const now = new Date().toISOString();
  return {
    id: id(),
    projectId,
    projectRevision: 0,
    kind: 'workflow',
    requestKey: id(),
    status: 'running',
    message: 'protocol fixture',
    progress: 0,
    createdAt: now,
    updatedAt: now,
    provider: { id: 'seedance', request, phase: 'polling', taskId: 'contract-task' },
  };
}
async function until(predicate: () => boolean, attempts = 100) {
  for (let i = 0; i < attempts; i++) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.ok(predicate(), 'state transition did not finish');
}

test('generation model constraints and reference dependencies protect saved projects', () => {
  assert.throws(
    () => validateGeneration({ ...request, profile: '2.0-fast', resolution: '1080p' }),
    /720p/,
  );
  assert.throws(
    () => validateGeneration({ ...request, profile: '2.5', firstFrameId: id() }),
    /自适应/,
  );
  assert.throws(() => validateGeneration({ ...request, lastFrameId: id() }), /首帧/);
  assert.throws(() => validateGeneration({ ...request, duration: 2 }), /4–15/);
  const p = newProject();
  const imageId = id();
  const w = {
    ...p.workflows[0],
    edges: [],
    nodes: [
      {
        id: id(),
        name: '生成',
        kind: 'seedance' as const,
        x: 0,
        y: 0,
        generation: { ...request, prompt: undefined, firstFrameId: imageId },
      },
    ],
  };
  delete (w.nodes[0].generation as { prompt?: string }).prompt;
  assert.throws(() => applyCommands(p, [{ type: 'workflow.put', workflow: w }]), /图片不存在/);
  const image = {
    id: imageId,
    name: 'reference',
    kind: 'image',
    mime: 'image/png',
    bytes: 10,
    blobId: 'a'.repeat(64),
  };
  const edited = applyCommands(p, [
    { type: 'asset.add', asset: image },
    { type: 'workflow.put', workflow: w },
  ]).project;
  assert.throws(() => applyCommands(edited, [{ type: 'asset.delete', id: imageId }]), /图片不存在/);
  const legacy = { ...newProject(), schemaVersion: 2 };
  const before = JSON.stringify(legacy);
  assert.equal(migrateProject(legacy).schemaVersion, PROJECT_VERSION);
  assert.equal(migrateProject(legacy).timeline.clips[0].fit, 'contain');
  assert.equal(JSON.stringify(legacy), before);
});

test('official adapter uses POST/GET/DELETE without leaking credentials or fabricating task IDs', async () => {
  const oldKey = process.env.ARK_API_KEY,
    oldEnabled = process.env.STUDIO_ENABLE_PAID_GENERATION;
  process.env.ARK_API_KEY = 'local-contract-secret';
  process.env.STUDIO_ENABLE_PAID_GENERATION = 'true';
  const calls: { method: string; path: string; body: any }[] = [];
  const adapter = new Seedance((async (url: string | URL | Request, init?: RequestInit) => {
    assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer local-contract-secret');
    calls.push({
      method: init!.method!,
      path: String(url),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    return Response.json(
      init!.method === 'POST'
        ? { id: 'contract-task' }
        : init!.method === 'GET'
          ? { id: 'contract-task', status: 'queued' }
          : {},
    );
  }) as typeof fetch);
  const signal = new AbortController().signal;
  try {
    assert.equal(providerStatus().status, 'configured');
    assert.ok(!JSON.stringify(providerStatus()).includes('local-contract-secret'));
    const created = await adapter.create(request, newProject(), '.', signal);
    assert.equal(created.id, 'contract-task');
    await adapter.get(created.id, signal);
    await adapter.cancel(created.id, signal);
    assert.deepEqual(
      calls.map((c) => c.method),
      ['POST', 'GET', 'DELETE'],
    );
    assert.equal(
      calls[0].path,
      'https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks',
    );
    assert.equal(calls[1].path, calls[0].path + '/contract-task');
    assert.deepEqual(calls[0].body.content, [{ type: 'text', text: request.prompt }]);
    assert.equal(calls[0].body.generate_audio, true);
    assert.equal(calls[0].body.profile, undefined);
    assert.equal(
      (await requestBody({ ...request, profile: '1.0-pro' }, newProject(), '.')).generate_audio,
      undefined,
    );
    const failing = new Seedance(
      (async () => new Response('local-contract-secret', { status: 503 })) as typeof fetch,
    );
    await assert.rejects(
      () => failing.create(request, newProject(), '.', signal),
      (e: any) =>
        e instanceof ProviderError && e.uncertain && !e.message.includes('local-contract-secret'),
    );
    process.env.STUDIO_ENABLE_PAID_GENERATION = 'false';
    await assert.rejects(() => adapter.create(request, newProject(), '.', signal), /未启用/);
    assert.equal(calls.length, 3);
  } finally {
    if (oldKey === undefined) delete process.env.ARK_API_KEY;
    else process.env.ARK_API_KEY = oldKey;
    if (oldEnabled === undefined) delete process.env.STUDIO_ENABLE_PAID_GENERATION;
    else process.env.STUDIO_ENABLE_PAID_GENERATION = oldEnabled;
  }
});

test('result downloads accept only official HTTPS hosts and reject credential-bearing URLs', () => {
  assert.equal(
    resultUrl('https://ark-content-generation-cn-beijing.tos-cn-beijing.volces.com/video.mp4')
      .protocol,
    'https:',
  );
  for (const url of [
    'http://a.volces.com/file',
    'https://a.volces.com.evil.test/file',
    'https://127.0.0.1/file',
    'https://key@a.volces.com/file',
  ])
    assert.throws(() => resultUrl(url));
});

test('implicit and explicit workflow outputs keep the original submission identity', async () => {
  const folder = directory(),
    store = new Store(folder),
    p = newProject();
  const promptId = id(),
    generatorId = id();
  const { prompt, ...options } = request;
  p.workflows[0].nodes = [
    { id: promptId, name: 'Prompt', kind: 'prompt', text: prompt, x: 0, y: 0 },
    { id: generatorId, name: 'Seedance', kind: 'seedance', generation: options, x: 250, y: 0 },
  ];
  p.workflows[0].edges = [{ from: promptId, to: generatorId }];
  store.create(p);
  const jobs = new Jobs(store, 'http://127.0.0.1:1');
  // Stop execution before testing persisted submission envelopes; no external request is made.
  await jobs.close();
  const oldKey = process.env.ARK_API_KEY,
    oldEnabled = process.env.STUDIO_ENABLE_PAID_GENERATION;
  process.env.ARK_API_KEY = 'local-contract-secret';
  process.env.STUDIO_ENABLE_PAID_GENERATION = 'true';
  try {
    const requestKey = id();
    const implicit = jobs.submit(p, requestKey, 'workflow', p.workflows[0].id);
    assert.equal(implicit.outputNodeId, undefined);
    assert.equal(jobs.submit(p, requestKey, 'workflow', p.workflows[0].id).id, implicit.id);
    const explicit = jobs.submit(p, id(), 'workflow', p.workflows[0].id, generatorId);
    assert.equal(explicit.outputNodeId, generatorId);
    assert.equal(store.jobs(p.id).length, 2);
  } finally {
    if (oldKey === undefined) delete process.env.ARK_API_KEY;
    else process.env.ARK_API_KEY = oldKey;
    if (oldEnabled === undefined) delete process.env.STUDIO_ENABLE_PAID_GENERATION;
    else process.env.STUDIO_ENABLE_PAID_GENERATION = oldEnabled;
    store.close();
    cleanup(folder);
  }
});

test('restart resumes known remote IDs and does not resend uncertain submissions', async () => {
  const folder = directory(),
    store = new Store(folder);
  const p = store.create(newProject()).project;
  const known = job(p.id),
    unknown = job(p.id);
  unknown.provider = { id: 'seedance', request, phase: 'submitting' };
  store.createJob(known, p);
  store.createJob(unknown, p);
  let creates = 0,
    queries = 0;
  const provider: VideoProvider = {
    async create() {
      creates++;
      throw new Error('must not create');
    },
    async get(taskId) {
      queries++;
      assert.equal(taskId, 'contract-task');
      return { id: taskId, status: 'failed' };
    },
    async cancel() {
      throw new Error('must not cancel');
    },
  };
  const jobs = new GenerationJobs(store, provider);
  try {
    assert.equal(store.job(unknown.id).job.status, 'interrupted');
    assert.equal(store.job(unknown.id).job.provider!.phase, 'uncertain');
    await until(() => store.job(known.id).job.status === 'failed');
    assert.equal(creates, 0);
    assert.equal(queries, 1);
    assert.throws(() => jobs.retry(unknown.id, id()), /不能重发/);
  } finally {
    await jobs.close();
    store.close();
    cleanup(folder);
  }
});

test('asset, artifact and job completion commit together and repeated registration stays idempotent', () => {
  const folder = directory(),
    store = new Store(folder);
  try {
    const p = store.create(newProject()).project,
      j = job(p.id);
    store.createJob(j, p);
    const source = resolve('examples/motion-study.mp4'),
      bytes = readFileSync(source);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const artifact = {
      id: id(),
      jobId: j.id,
      name: 'actual-video.mp4',
      bytes: bytes.length,
      sha256,
      mime: 'video/mp4',
      createdAt: new Date().toISOString(),
    };
    const asset = {
      id: id(),
      name: artifact.name,
      kind: 'video' as const,
      mime: 'video/mp4' as const,
      bytes: bytes.length,
      blobId: sha256,
    };
    assert.throws(
      () => store.registerResult(j.id, artifact, { ...asset, id: p.entities[0].id }, source),
      /重复/,
    );
    assert.equal(store.get(p.id).project.revision, 0);
    assert.equal(store.job(j.id).job.status, 'running');
    assert.equal(store.blob(sha256), undefined);
    store.registerResult(j.id, artifact, asset, source);
    store.registerResult(j.id, artifact, asset, source);
    assert.equal(store.get(p.id).project.artifacts.length, 1);
    assert.equal(store.get(p.id).project.revision, 1);
    assert.equal(store.job(j.id).job.status, 'succeeded');
    assert.equal(store.revisions(p.id)[0].actor, 'system');
  } finally {
    store.close();
    cleanup(folder);
  }
});

test('completed remote fixture streams actual MP4 bytes through download, probe and project registration', async () => {
  const folder = directory(),
    store = new Store(folder),
    p = store.create(newProject()).project;
  const j = job(p.id);
  store.createJob(j, p);
  const bytes = readFileSync(resolve('examples/motion-study.mp4'));
  const provider: VideoProvider = {
    async create() {
      throw new Error('must not submit');
    },
    async get(taskId) {
      return {
        id: taskId,
        status: 'succeeded',
        content: { video_url: 'https://fixture.tos-cn-beijing.volces.com/video.mp4' },
      };
    },
    async cancel() {
      throw new Error('must not cancel');
    },
  };
  // Explicit local protocol fixture: no request to any provider and no AI-generated claim.
  const transport = (async (_url: unknown, init: RequestInit) => {
    assert.equal(init.headers, undefined);
    return new Response(bytes, { headers: { 'Content-Type': 'video/mp4' } });
  }) as typeof fetch;
  const jobs = new GenerationJobs(store, provider, (url, path, signal) =>
    downloadVideo(url, path, signal, transport),
  );
  try {
    await until(() => store.job(j.id).job.status === 'succeeded');
    const result = store.get(p.id).project;
    assert.equal(result.assets[0].width, 320);
    assert.equal(result.assets[0].height, 180);
    assert.equal(result.assets[0].duration, 1);
    assert.equal(result.assets[0].hasAudio, true);
    assert.equal(store.job(j.id).job.provider!.phase, 'done');
    assert.equal(result.artifacts[0].sha256, createHash('sha256').update(bytes).digest('hex'));
    await assert.rejects(
      () =>
        downloadVideo(
          'https://fixture.volces.com/file',
          join(folder, 'bad.mp4'),
          new AbortController().signal,
          (async () =>
            new Response(null, {
              status: 302,
              headers: { location: 'http://127.0.0.1/private' },
            })) as typeof fetch,
        ),
      /HTTPS/,
    );
  } finally {
    await jobs.close();
    store.close();
    cleanup(folder);
  }
});

test('cancellation arriving during a query survives until remote cancellation is confirmed', async () => {
  const folder = directory(),
    store = new Store(folder),
    p = store.create(newProject()).project;
  const j = job(p.id);
  j.provider!.remoteStatus = 'queued';
  store.createJob(j, p);
  let queries = 0,
    cancellations = 0,
    release: (() => void) | undefined;
  const provider: VideoProvider = {
    async create() {
      throw new Error('must not create');
    },
    async get(taskId) {
      queries++;
      if (queries === 1)
        await new Promise<void>((r) => {
          release = r;
        });
      return { id: taskId, status: cancellations ? 'cancelled' : 'queued' };
    },
    async cancel() {
      cancellations++;
    },
  };
  const jobs = new GenerationJobs(store, provider);
  try {
    await until(() => !!release);
    jobs.cancel(j.id);
    release!();
    await until(() => cancellations === 1);
    assert.notEqual(store.job(j.id).job.status, 'cancelled');
    await until(() => store.job(j.id).job.status === 'cancelled', 700);
    assert.equal(cancellations, 1);
  } finally {
    release?.();
    await jobs.close();
    store.close();
    cleanup(folder);
  }
});
