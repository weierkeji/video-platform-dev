import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chromium } from 'playwright-core';
import { browserPath, ffmpegPath, ffprobePath } from '../server/runtime';
import { animationExchangeFixture } from './animation-exchange-fixture';
import { importGLTF } from '../src/core/gltf';
import {
  id,
  PROJECT_VERSION,
  type Clip,
  type Project,
  type GenerationJob,
} from '../src/core/model';
import type { Command } from '../src/core/commands';

const origin = process.env.STUDIO_URL || 'http://127.0.0.1:4173';
const output = resolve('.local/checks/playback');
const referenceRenderer = process.argv.includes('--renderer');
await mkdir(output, { recursive: true });
async function api<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(origin + '/api' + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Studio-Client': 'frameforge' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(JSON.stringify(result));
  return result;
}
let p = (
  await api<{ project: Project }>('/projects', { name: `动作调度检查 ${new Date().toISOString()}` })
).project;
async function commands(commands: Command[], label: string) {
  p = (
    await api<{ project: Project }>(`/projects/${p.id}/commands`, {
      baseRevision: p.revision,
      commands,
      label,
    })
  ).project;
}
const imported = await importGLTF(
  new TextEncoder().encode(JSON.stringify(animationExchangeFixture())),
  [],
  24,
);
const scene = imported.command.scenes.find((s) => s.name === 'Animation exchange')!;
const cameraId = imported.command.entities.find(
  (e) => e.sceneId === scene.id && e.kind === 'camera',
)!.id;
const [arc, hold] = ['Arc and turn', 'Hold and tilt'].map(
  (name) =>
    imported.command.animationActions!.find((a) => a.sceneId === scene.id && a.name === name)!,
);
const firstShot = p.shots[0].id,
  secondShot = id();
const clip = (name: string, start: number, sourceId: string): Clip => ({
  id: id(),
  name,
  kind: 'shot',
  sourceId,
  start,
  duration: 24,
  sourceIn: 0,
  channel: 1,
  muted: false,
  volume: 1,
  fit: 'contain',
});
const reverse = clip('倒放片段', 24, secondShot),
  loop = clip('循环片段', 48, secondShot),
  ping = clip('往返片段', 72, firstShot);
const background = {
  ...clip('底层动作', 0, secondShot),
  channel: 0,
  duration: 96,
  sourceIn: 24,
  action: { actionId: hold.id },
  playback: { rate: 0, rangeStart: 0, rangeEnd: 24, mode: 'hold' as const },
};
await commands(
  [
    imported.command,
    { type: 'shot.update', id: firstShot, patch: { name: '镜头 A', sceneId: scene.id, cameraId } },
    { type: 'shot.add', shot: { id: secondShot, name: '镜头 B', sceneId: scene.id, cameraId } },
    {
      type: 'clip.update',
      id: p.timeline.clips[0].id,
      patch: { name: '原速片段', channel: 1, duration: 24 },
    },
    ...[reverse, loop, ping, background].map((clip): Command => ({ type: 'clip.add', clip })),
    { type: 'timeline.update', patch: { duration: 96, width: 480, height: 270 } },
  ],
  '组织同场景多动作影片',
);
const browser = await chromium.launch({
  executablePath: browserPath(),
  headless: true,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const errors: string[] = [];
try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1100 } });
  await page.addInitScript('globalThis.__name = (fn) => fn');
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(origin, { waitUntil: 'networkidle' });
  await page.getByLabel('切换项目').selectOption(p.id);
  async function saved(previous = p.revision) {
    for (let i = 0; i < 100; i++) {
      p = (await api<{ project: Project }>(`/projects/${p.id}`)).project;
      if (p.revision > previous) {
        await page.waitForFunction(
          (r) => document.querySelector('.save-status')?.textContent?.includes(`r${r}`),
          p.revision,
        );
        return;
      }
      await page.waitForTimeout(50);
    }
    throw new Error('操作未保存：' + (await page.locator('body').innerText()));
  }
  const selectClip = async (name: string) =>
    page.locator('.clip.shot').filter({ hasText: name }).click();
  const field = async (label: string, value: number) => {
    await page.getByLabel(label, { exact: true }).fill(String(value));
    await page.getByLabel(label, { exact: true }).press('Tab');
    await saved();
  };
  const cursor = async (frame: number) => {
    await page.getByLabel('当前帧', { exact: true }).fill(String(frame));
    await page.getByLabel('当前帧', { exact: true }).press('Tab');
  };
  await page.getByLabel('场景', { exact: true }).selectOption(scene.id);
  await page.getByLabel('镜头 A 默认动作', { exact: true }).selectOption(arc.id);
  await saved();
  await page.getByLabel('镜头 B 默认动作', { exact: true }).selectOption(hold.id);
  await saved();
  assert.equal(p.shots.find((s) => s.id === secondShot)!.action?.actionId, hold.id);
  await selectClip(reverse.name);
  await page.getByLabel('自定义动画播放', { exact: true }).click();
  await saved();
  await field('动作范围终点', 24);
  await page.getByRole('button', { name: '从末尾倒放', exact: true }).click();
  await saved();
  assert.equal(p.timeline.clips.find((c) => c.id === reverse.id)!.sourceIn, 24);
  await selectClip(loop.name);
  await page.getByLabel('片段动作', { exact: true }).selectOption(arc.id);
  await saved();
  await page.getByLabel('自定义动画播放', { exact: true }).click();
  await saved();
  await field('动作范围终点', 24);
  await field('动画速度', 2);
  await page.getByLabel('范围外处理', { exact: true }).selectOption('repeat');
  await saved();
  await selectClip(ping.name);
  await page.getByLabel('自定义动画播放', { exact: true }).click();
  await saved();
  await field('动作范围终点', 10);
  await field('源入点', 3.5);
  await field('动画速度', 1.25);
  await page.getByLabel('范围外处理', { exact: true }).selectOption('pingpong');
  await saved();
  await cursor(81);
  await page.getByRole('button', { name: '在帧 81 切分', exact: true }).click();
  await saved();
  const right = p.timeline.clips.find((c) => c.name === '往返片段 · 后段')!;
  assert.equal(right.sourceIn, 14.75);
  await page.getByTitle('Ctrl+Z', { exact: true }).click();
  await saved();
  assert.ok(!p.timeline.clips.some((c) => c.id === right.id));
  await page.getByTitle('Ctrl+Shift+Z', { exact: true }).click();
  await saved();
  assert.equal(p.timeline.clips.find((c) => c.id === right.id)!.sourceIn, 14.75);
  // Referenced actions cannot be silently deleted underneath either a shot or a clip.
  const beforeDelete = p.revision;
  await page.getByRole('button', { name: '删除动作', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: '动作仍被镜头或片段引用' }).waitFor();
  assert.equal(
    (await api<{ project: Project }>(`/projects/${p.id}`)).project.revision,
    beforeDelete,
  );
  await page.getByRole('alert').getByRole('button', { name: '关闭', exact: true }).click();
  await page.reload({ waitUntil: 'networkidle' });
  await page.getByLabel('切换项目').selectOption(p.id);
  await selectClip('往返片段 · 后段');
  assert.equal(Number(await page.getByLabel('源入点', { exact: true }).inputValue()), 14.75);
  assert.equal(await page.getByLabel('范围外处理', { exact: true }).inputValue(), 'pingpong');
  await page.getByLabel('片段动作', { exact: true }).selectOption('@base');
  await saved();
  assert.equal(p.timeline.clips.find((c) => c.id === right.id)!.action?.actionId, null);
  await page.getByTitle('Ctrl+Z', { exact: true }).click();
  await saved();
  assert.equal(p.timeline.clips.find((c) => c.id === right.id)!.action, undefined);
  const job = await api<GenerationJob>(`/projects/${p.id}/jobs`, {
    kind: 'render',
    baseRevision: p.revision,
    requestKey: id(),
  });
  const loopTiming = structuredClone(p.timeline.clips.find((c) => c.id === loop.id)!.playback!);
  await commands(
    [
      { type: 'shot.update', id: firstShot, patch: { action: { actionId: hold.id } } },
      { type: 'scene.update', id: scene.id, patch: { activeActionId: hold.id } },
      { type: 'clip.update', id: loop.id, patch: { playback: { ...loopTiming, rate: 3 } } },
    ],
    '提交后修改动作与速度',
  );
  let result = job;
  const deadline = Date.now() + 120000;
  while (['queued', 'running'].includes(result.status) && Date.now() < deadline) {
    await page.waitForTimeout(500);
    result = await api<GenerationJob>(`/jobs/${job.id}`);
  }
  assert.equal(result.status, 'succeeded', result.message);
  const mp4Path = join(output, 'action-montage.mp4');
  await writeFile(
    mp4Path,
    Buffer.from(await (await fetch(`${origin}/api/jobs/${job.id}/artifact`)).arrayBuffer()),
  );
  const run = promisify(execFile);
  const probe = JSON.parse(
    (
      await run(ffprobePath(), ['-v', 'error', '-show_streams', '-of', 'json', mp4Path], {
        windowsHide: true,
      })
    ).stdout,
  );
  assert.equal(probe.streams[0].nb_frames, '96');
  p = (await api<{ project: Project }>(`/projects/${p.id}`)).project;
  await commands(
    [
      { type: 'shot.update', id: firstShot, patch: { action: { actionId: arc.id } } },
      { type: 'scene.update', id: scene.id, patch: { activeActionId: arc.id } },
      { type: 'clip.update', id: loop.id, patch: { playback: loopTiming } },
    ],
    '恢复影片的动作和速度',
  );
  await page.getByRole('button', { name: '刷新', exact: true }).click();
  await page.waitForFunction(
    (r) => document.querySelector('.save-status')?.textContent?.includes(`r${r}`),
    p.revision,
  );
  await page.getByRole('button', { name: '成片预览', exact: true }).click();
  // Expected source times are manually specified, independent of the product's time-mapping function.
  const samples = [
    [0, 0, arc.id],
    [8, 8, arc.id],
    [23, 23, arc.id],
    [24, 24, hold.id],
    [32, 16, hold.id],
    [47, 1, hold.id],
    [48, 0, arc.id],
    [52, 8, arc.id],
    [60, 0, arc.id],
    [72, 3.5, arc.id],
    [80, 6.5, arc.id],
    [81, 5.25, arc.id],
    [82, 4, arc.id],
    [95, 7.75, arc.id],
  ].map(([frame, source, actionId]) => ({
    frame: frame as number,
    source: source as number,
    actionId: actionId as string,
  }));
  const references = referenceRenderer
    ? await page.evaluate(
        async ({ project, sceneId, cameraId, samples }) => {
          const modulePath = '/src/render/scene.ts';
          const { SceneRenderer } = await import(/* @vite-ignore */ modulePath);
          const renderer = new SceneRenderer(),
            copy = structuredClone(project),
            results: string[] = [];
          try {
            renderer.setProject(copy, sceneId);
            await renderer.ready();
            for (const sample of samples) {
              copy.scenes.find((s) => s.id === sceneId)!.activeActionId = sample.actionId;
              renderer.evaluate(sample.source); // Existing scene-default path, without shot/clip overrides.
              renderer.render(renderer.objects.get(cameraId), 480, 270);
              results.push(renderer.renderer.domElement.toDataURL('image/png').split(',')[1]);
            }
            return results;
          } finally {
            renderer.dispose();
          }
        },
        { project: p, sceneId: scene.id, cameraId, samples },
      )
    : [];
  const decode = async (path: string, frame = 0) =>
    (
      await run(
        ffmpegPath(),
        [
          '-v',
          'error',
          '-i',
          path,
          '-vf',
          `select=eq(n\\,${frame})`,
          '-frames:v',
          '1',
          '-pix_fmt',
          'rgb24',
          '-f',
          'rawvideo',
          'pipe:1',
        ],
        { encoding: 'buffer', windowsHide: true, maxBuffer: 1024 * 1024 },
      )
    ).stdout;
  const difference = (a: Buffer, b: Buffer) => {
    assert.equal(a.length, 480 * 270 * 3);
    assert.equal(a.length, b.length);
    return a.reduce((sum, value, i) => sum + Math.abs(value - b[i]), 0) / a.length;
  };
  const frames = new Map<number, Buffer>(),
    measurements = [];
  for (const [i, sample] of samples.entries()) {
    await cursor(sample.frame);
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: '导出当前帧 PNG', exact: true }).click(),
    ]);
    const path = join(output, `frame-${sample.frame}.png`);
    await download.saveAs(path);
    const pixels = await decode(path),
      exported = await decode(mp4Path, sample.frame);
    frames.set(sample.frame, pixels);
    const videoDifference = difference(pixels, exported);
    assert.ok(videoDifference < 4, JSON.stringify({ sample, videoDifference }));
    let referenceDifference: number | undefined;
    if (referenceRenderer) {
      const refPath = join(output, `reference-${sample.frame}.png`);
      await writeFile(refPath, Buffer.from(references[i], 'base64'));
      referenceDifference = difference(pixels, await decode(refPath));
      assert.ok(referenceDifference < 0.02, JSON.stringify({ sample, referenceDifference }));
    }
    const redPixels = pixels.reduce(
      (n, v, i) =>
        n + Number(i % 3 === 0 && v > 90 && v > pixels[i + 1] * 1.7 && v > pixels[i + 2] * 1.7),
      0,
    );
    assert.ok(redPixels > 100);
    measurements.push({ ...sample, videoDifference, referenceDifference, redPixels });
  }
  for (const [a, b] of [
    [0, 48],
    [0, 60],
    [8, 52],
  ])
    assert.equal(difference(frames.get(a)!, frames.get(b)!), 0);
  assert.ok(difference(frames.get(23)!, frames.get(24)!) > 0.5);
  const bundle = await api<{ project: Project; blobs: unknown[] }>(`/projects/${p.id}/export`);
  await writeFile(join(output, 'action-montage.ffstudio'), JSON.stringify(bundle));
  const restored = await api<{ project: Project }>('/projects/import', bundle);
  assert.deepEqual(restored.project.shots, bundle.project.shots);
  assert.deepEqual(restored.project.timeline, bundle.project.timeline);
  assert.deepEqual(restored.project.animationActions, bundle.project.animationActions);
  await selectClip('往返片段 · 后段');
  await cursor(81);
  await page.screenshot({ path: join(output, 'product.png') });
  assert.deepEqual(errors, []);
  const report = {
    checkedAt: new Date().toISOString(),
    projectId: p.id,
    importedProjectId: restored.project.id,
    jobId: job.id,
    browser: browser.version(),
    format: PROJECT_VERSION,
    frames: 96,
    referenceRenderer,
    measurements,
    pageErrors: errors,
    checks: [
      'shot defaults and clip overrides share scene objects',
      'speed reverse repeat and ping-pong edited through UI',
      'fractional phase preserved through split undo redo reload',
      'referenced action deletion rejected without saving',
      'explicit project tracks override is undoable',
      'submitted action and speed snapshot remains fixed',
      'same-scene overlapping layers do not leak action or scale',
      'cycle frames are pixel-identical',
      'actual preview and MP4 agree across cuts and split',
      'portable project retains shot choices and timing',
    ],
  };
  await writeFile(
    join(output, referenceRenderer ? 'renderer-result.json' : 'result.json'),
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  const page = browser.contexts()[0]?.pages()[0];
  if (page) {
    await page.screenshot({ path: join(output, 'failure.png') });
    await writeFile(join(output, 'failure.txt'), await page.locator('body').innerText());
  }
  throw error;
} finally {
  await browser.close();
}
