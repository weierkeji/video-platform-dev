import { chromium } from 'playwright-core';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import assert from 'node:assert/strict';
import { browserPath } from '../server/runtime';
import { type Project, type GenerationJob } from '../src/core/model';

const origin = process.env.STUDIO_URL || 'http://127.0.0.1:4173',
  output = resolve('.local/checks');
await mkdir(output, { recursive: true });
async function api<T>(path: string, body?: unknown): Promise<T> {
  const r = await fetch(origin + '/api' + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Studio-Client': 'frameforge' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const result = await r.json();
  if (!r.ok) throw new Error(JSON.stringify(result));
  return result as T;
}
const browser = await chromium.launch({
  executablePath: browserPath(),
  headless: true,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const errors: string[] = [];
try {
  const page = await browser.newPage({ viewport: { width: 1500, height: 1050 } });
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(origin, { waitUntil: 'networkidle' });
  await page.locator('.brand').waitFor();
  await page.getByRole('button', { name: '新建', exact: true }).click();
  const name = `集成检查 ${new Date().toISOString().slice(0, 19)}`;
  await page.getByLabel('新项目名称').fill(name);
  await page.getByRole('button', { name: '创建项目', exact: true }).click();
  await page.waitForFunction(
    (name) =>
      (document.querySelector('[aria-label="项目名称"]') as HTMLInputElement)?.value === name,
    name,
  );
  await page.getByLabel('添加对象').selectOption('sphere');
  await page.getByRole('button', { name: '◇ 球体', exact: true }).click();
  const position = page.getByRole('spinbutton', { name: '位置 X', exact: true });
  await position.fill('2');
  await position.press('Enter');
  await page.waitForTimeout(300);
  await page.getByRole('button', { name: '◇ 记录当前变换关键帧', exact: true }).click();
  await page.waitForTimeout(300);
  await page.getByRole('spinbutton', { name: '当前帧', exact: true }).fill('23');
  await page.getByRole('spinbutton', { name: '当前帧', exact: true }).press('Enter');
  await position.fill('-2');
  await position.press('Enter');
  await page.waitForTimeout(300);
  const projectId = await page.getByLabel('切换项目').inputValue();
  let { project: p } = await api<{ project: Project }>(`/projects/${projectId}`);
  const sphere = p.entities.find((e) => e.name === '球体')!;
  assert.ok(sphere);
  assert.equal(
    p.animationTracks.find((t) => t.entityId === sphere.id && t.property === 'position')?.keys
      .length,
    2,
  );
  const before = p.revision;
  await page.getByRole('button', { name: '↶', exact: true }).click();
  await page.waitForTimeout(200);
  p = (await api<{ project: Project }>(`/projects/${projectId}`)).project;
  assert.equal(p.revision, before + 1);
  await page.getByRole('button', { name: '↷', exact: true }).click();
  await page.waitForTimeout(200);
  p = (await api<{ project: Project }>(`/projects/${projectId}`)).project;
  p = (
    await api<{ project: Project }>(`/projects/${projectId}/commands`, {
      baseRevision: p.revision,
      label: '短片运行检查',
      actor: 'user',
      commands: [
        { type: 'clip.update', id: p.timeline.clips[0].id, patch: { duration: 24 } },
        { type: 'timeline.update', patch: { duration: 24, width: 320, height: 180 } },
      ],
    })
  ).project;
  // Exercise binary upload, audio mixing and project-package embedding with a real PCM WAV.
  const samples = 24000,
    pcm = Buffer.alloc(44 + samples * 2);
  pcm.write('RIFF');
  pcm.writeUInt32LE(pcm.length - 8, 4);
  pcm.write('WAVEfmt ', 8);
  pcm.writeUInt32LE(16, 16);
  pcm.writeUInt16LE(1, 20);
  pcm.writeUInt16LE(1, 22);
  pcm.writeUInt32LE(24000, 24);
  pcm.writeUInt32LE(48000, 28);
  pcm.writeUInt16LE(2, 32);
  pcm.writeUInt16LE(16, 34);
  pcm.write('data', 36);
  pcm.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++)
    pcm.writeInt16LE(Math.round(Math.sin((i / 24000) * Math.PI * 440 * 2) * 1200), 44 + i * 2);
  const uploaded = await fetch(origin + '/api/blobs', {
    method: 'POST',
    headers: {
      'X-Studio-Client': 'frameforge',
      'X-File-Name': 'tone.wav',
      'Content-Type': 'audio/wav',
    },
    body: pcm,
  });
  const asset = await uploaded.json();
  assert.equal(uploaded.status, 201, JSON.stringify(asset));
  p = (
    await api<{ project: Project }>(`/projects/${projectId}/commands`, {
      baseRevision: p.revision,
      label: '音频加入时间轴',
      commands: [
        { type: 'asset.add', asset },
        {
          type: 'clip.add',
          clip: {
            id: crypto.randomUUID(),
            name: 'tone.wav',
            kind: 'audio',
            sourceId: asset.id,
            start: 0,
            duration: 24,
            sourceIn: 0,
            channel: 2,
            muted: false,
            volume: 0.5,
          },
        },
      ],
    })
  ).project;
  await page.getByRole('button', { name: '刷新', exact: true }).click();
  await page.waitForTimeout(300);
  await page.getByRole('button', { name: '成片预览', exact: true }).click();
  await page.waitForTimeout(1000);
  await page.screenshot({ path: join(output, 'studio.png') });
  const requestKey = crypto.randomUUID();
  const job = await api<GenerationJob>(`/projects/${projectId}/jobs`, {
    baseRevision: p.revision,
    kind: 'workflow',
    workflowId: p.workflows[0].id,
    requestKey,
  });
  const duplicate = await api<GenerationJob>(`/projects/${projectId}/jobs`, {
    baseRevision: p.revision,
    kind: 'workflow',
    workflowId: p.workflows[0].id,
    requestKey,
  });
  assert.equal(duplicate.id, job.id);
  let result = job;
  const deadline = Date.now() + 120000;
  while (['queued', 'running'].includes(result.status) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 500));
    result = await api<GenerationJob>(`/jobs/${job.id}`);
  }
  assert.equal(result.status, 'succeeded', result.message);
  assert.ok(result.artifact && result.artifact.bytes > 1000);
  const repeated = await api<GenerationJob>(`/projects/${projectId}/jobs`, {
    baseRevision: p.revision,
    kind: 'workflow',
    workflowId: p.workflows[0].id,
    requestKey,
  });
  assert.equal(repeated.id, job.id);
  const file = join(output, 'render.mp4');
  await writeFile(
    file,
    Buffer.from(await (await fetch(`${origin}/api/jobs/${job.id}/artifact`)).arrayBuffer()),
  );
  const { stdout } = await promisify(execFile)(
    'ffprobe',
    ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file],
    { windowsHide: true },
  );
  const probe = JSON.parse(stdout),
    video = probe.streams.find((s: { codec_type: string }) => s.codec_type === 'video');
  assert.equal(video.width, 320);
  assert.equal(video.height, 180);
  assert.equal(Number(video.nb_frames), 24);
  assert.ok(probe.streams.some((s: { codec_type: string }) => s.codec_type === 'audio'));
  const bundle = await api<{ project: Project; blobs: unknown[] }>(`/projects/${projectId}/export`);
  assert.equal(bundle.project.artifacts.length, 1);
  assert.ok(bundle.blobs.length >= 2);
  await writeFile(join(output, 'project.ffstudio'), JSON.stringify(bundle));
  const imported = await api<{ project: Project }>('/projects/import', bundle);
  assert.notEqual(imported.project.id, projectId);
  assert.equal(imported.project.assets.length, bundle.project.assets.length);
  // The worker must stop on cancellation, and retry must use the original snapshot.
  const cancelled = await api<GenerationJob>(`/projects/${projectId}/jobs`, {
    baseRevision: bundle.project.revision,
    kind: 'render',
    requestKey: crypto.randomUUID(),
  });
  assert.equal((await api<GenerationJob>(`/jobs/${cancelled.id}/cancel`, {})).status, 'cancelled');
  const retried = await api<GenerationJob>(`/jobs/${cancelled.id}/retry`, {
    requestKey: crypto.randomUUID(),
  });
  assert.equal(retried.projectRevision, bundle.project.revision);
  let retryResult = retried;
  while (['queued', 'running'].includes(retryResult.status) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 500));
    retryResult = await api<GenerationJob>(`/jobs/${retried.id}`);
  }
  assert.equal(retryResult.status, 'succeeded', retryResult.message);
  await page.reload({ waitUntil: 'networkidle' });
  await page.locator('.brand').waitFor();
  assert.equal(await page.getByLabel('切换项目').inputValue(), projectId);
  assert.deepEqual(errors, []);
  const summary = {
    checkedAt: new Date().toISOString(),
    projectId,
    importedProjectId: imported.project.id,
    jobId: job.id,
    browser: browser.version(),
    ui: [
      'new project',
      'add sphere',
      'transform',
      'keyframes',
      'undo',
      'redo',
      'sequence preview',
      'reload',
    ],
    api: [
      'audio upload',
      'audio timeline',
      'idempotent workflow job including after completion',
      'MP4 with audio',
      'portable project reimport',
      'result registered as asset',
      'cancel running job',
      'retry original snapshot',
    ],
    video: {
      width: video.width,
      height: video.height,
      frames: video.nb_frames,
      duration: probe.format.duration,
    },
    consoleErrors: errors,
  };
  await writeFile(join(output, 'result.json'), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
} finally {
  await browser.close();
}
