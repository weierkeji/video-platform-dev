import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { chromium } from 'playwright-core';
import { browserPath, ffmpegPath, ffprobePath } from '../server/runtime';
import { PROJECT_VERSION, type Asset, type Project, type GenerationJob } from '../src/core/model';

const origin = process.env.STUDIO_URL || 'http://127.0.0.1:4173',
  output = resolve('.local/checks/media');
await mkdir(output, { recursive: true });
const run = promisify(execFile);
const fixture = join(output, 'portrait-with-audio.mp4'),
  silent = join(output, 'silent.mp4');
// Locally synthesized input: portrait video plus a known-amplitude tone. No third-party media.
await run(
  ffmpegPath(),
  [
    '-y',
    '-v',
    'error',
    '-f',
    'lavfi',
    '-i',
    'color=c=red:s=100x200:r=24:d=3,drawbox=x=0:y=0:w=100:h=40:color=blue:t=fill,drawbox=x=0:y=160:w=100:h=40:color=blue:t=fill',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440:sample_rate=48000:duration=0.5[a];sine=frequency=660:sample_rate=48000:duration=0.5[b];sine=frequency=880:sample_rate=48000:duration=2[c];[a][b][c]concat=n=3:v=0:a=1',
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    '-b:a',
    '192k',
    '-shortest',
    fixture,
  ],
  { windowsHide: true },
);
await run(ffmpegPath(), ['-y', '-v', 'error', '-i', fixture, '-an', '-c:v', 'copy', silent], {
  windowsHide: true,
});
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
async function upload(path: string) {
  const response = await fetch(origin + '/api/blobs', {
    method: 'POST',
    headers: {
      'Content-Type': 'video/mp4',
      'X-Studio-Client': 'frameforge',
      'X-File-Name': encodeURIComponent(path === fixture ? '带原声竖屏.mp4' : '无声竖屏.mp4'),
    },
    body: new Uint8Array(await readFile(path)),
  });
  const result = await response.json();
  assert.equal(response.status, 201, JSON.stringify(result));
  return result as Asset;
}
const video = await upload(fixture),
  noAudio = await upload(silent);
assert.equal(video.hasAudio, true);
assert.equal(noAudio.hasAudio, false);
let p = (
  await api<{ project: Project }>('/projects', {
    name: `媒体剪辑检查 ${new Date().toISOString().slice(0, 19)}`,
  })
).project;
const videoClipId = crypto.randomUUID();
async function command(commands: unknown[], label: string) {
  p = (
    await api<{ project: Project }>(`/projects/${p.id}/commands`, {
      baseRevision: p.revision,
      commands,
      label,
    })
  ).project;
}
await command(
  [
    { type: 'clip.delete', id: p.timeline.clips[0].id },
    { type: 'timeline.update', patch: { duration: 48, width: 320, height: 180 } },
    { type: 'asset.add', asset: video },
    { type: 'asset.add', asset: noAudio },
    {
      type: 'clip.add',
      clip: {
        id: videoClipId,
        name: '带原声竖屏',
        kind: 'video',
        sourceId: video.id,
        start: 12,
        duration: 24,
        sourceIn: 12,
        channel: 1,
        muted: false,
        volume: 1.5,
        fit: 'contain',
      },
    },
    {
      type: 'clip.add',
      clip: {
        id: crypto.randomUUID(),
        name: '无声视频也可导出',
        kind: 'video',
        sourceId: noAudio.id,
        start: 36,
        duration: 12,
        sourceIn: 0,
        channel: 1,
        muted: false,
        volume: 1,
        fit: 'contain',
      },
    },
  ],
  '准备真实视频剪辑',
);

const browser = await chromium.launch({
  executablePath: browserPath(),
  headless: true,
  args: [
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--autoplay-policy=no-user-gesture-required',
  ],
});
const errors: string[] = [];
try {
  const page = await browser.newPage({ viewport: { width: 1500, height: 1050 } });
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(origin, { waitUntil: 'networkidle' });
  await page.getByLabel('切换项目').selectOption(p.id);
  await page.getByRole('button', { name: '成片预览', exact: true }).click();
  await page.getByRole('spinbutton', { name: '当前帧', exact: true }).fill('18');
  await page.getByRole('spinbutton', { name: '当前帧', exact: true }).press('Enter');
  await page.locator('.clip.video').filter({ hasText: '带原声竖屏' }).click();
  const pixels = async () =>
    page.getByLabel('成片预览', { exact: true }).evaluate((canvas: HTMLCanvasElement) => {
      const ctx = canvas.getContext('2d')!;
      return {
        width: canvas.width,
        center: Array.from(ctx.getImageData(160, 90, 1, 1).data),
        edge: Array.from(ctx.getImageData(10, 90, 1, 1).data),
        top: Array.from(ctx.getImageData(160, 10, 1, 1).data),
      };
    });
  await page.waitForFunction(() => {
    const c = document.querySelector('canvas[aria-label="成片预览"]') as HTMLCanvasElement;
    return c?.width === 320 && c.getContext('2d')!.getImageData(160, 90, 1, 1).data[0] > 180;
  });
  const contained = await pixels();
  assert.ok(contained.edge[0] < 15 && contained.center[0] > 180);
  assert.ok(contained.top[2] > 180);
  await page.getByLabel('画幅适配').selectOption('cover');
  await page.waitForTimeout(400);
  const covered = await pixels();
  assert.ok(covered.edge[0] > 180);
  assert.ok(covered.top[0] > 180 && covered.top[2] < 15);
  await page.getByLabel('画幅适配').selectOption('stretch');
  await page.waitForTimeout(400);
  const stretched = await pixels();
  assert.ok(stretched.edge[0] > 180 && stretched.top[2] > 180);
  await page.getByLabel('画幅适配').selectOption('contain');
  await page.waitForTimeout(400);
  await page.getByRole('spinbutton', { name: '当前帧', exact: true }).fill('24');
  await page.getByRole('spinbutton', { name: '当前帧', exact: true }).press('Enter');
  await page.getByRole('button', { name: '在帧 24 切分', exact: true }).click();
  await page.waitForTimeout(300);
  p = (await api<{ project: Project }>(`/projects/${p.id}`)).project;
  const right = p.timeline.clips.find((c) => c.name === '带原声竖屏 · 后段')!;
  assert.equal(right.sourceIn, 24);
  assert.equal(right.fit, 'contain');
  assert.equal(right.volume, 1.5);
  // Capture an actual decoded/playing audio signal after the product's gain node.
  const audioLevels = await page.evaluate(
    async ({ project, clipId }) => {
      const modulePath = '/src/render/timeline.ts';
      const { TimelineAudio } = await import(/* @vite-ignore */ modulePath);
      const mixer = new TimelineAudio();
      const only = structuredClone(project);
      only.timeline.clips = only.timeline.clips.filter((c: { id: string }) => c.id === clipId);
      const analyzer = mixer.context.createAnalyser();
      analyzer.fftSize = 2048;
      mixer.output.connect(analyzer);
      await mixer.context.resume();
      try {
        const levels = [];
        for (const gain of [0.5, 1.5]) {
          only.timeline.clips[0].volume = gain;
          mixer.sync(only, 16, true);
          await new Promise((r) => setTimeout(r, 180));
          const data = new Float32Array(2048);
          analyzer.getFloatTimeDomainData(data);
          levels.push(Math.sqrt(data.reduce((sum, v) => sum + v * v, 0) / data.length));
        }
        return {
          low: levels[0],
          high: levels[1],
          ratio: levels[1] / levels[0],
          error: mixer.error,
          state: mixer.context.state,
        };
      } finally {
        analyzer.disconnect();
        mixer.dispose();
      }
    },
    { project: p, clipId: videoClipId },
  );
  assert.equal(audioLevels.error, '');
  assert.ok(audioLevels.low > 0.01, JSON.stringify(audioLevels));
  assert.ok(audioLevels.ratio > 2.8 && audioLevels.ratio < 3.2, JSON.stringify(audioLevels));
  await page.screenshot({ path: join(output, 'editor.png') });
  const job = await api<GenerationJob>(`/projects/${p.id}/jobs`, {
    baseRevision: p.revision,
    kind: 'render',
    requestKey: crypto.randomUUID(),
  });
  let result = job;
  const deadline = Date.now() + 120000;
  while (['queued', 'running'].includes(result.status) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 500));
    result = await api<GenerationJob>(`/jobs/${job.id}`);
  }
  assert.equal(result.status, 'succeeded', result.message);
  const rendered = join(output, 'edited.mp4');
  await writeFile(
    rendered,
    Buffer.from(await (await fetch(`${origin}/api/jobs/${job.id}/artifact`)).arrayBuffer()),
  );
  const { stdout: probeText } = await run(
    ffprobePath(),
    ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', rendered],
    { windowsHide: true },
  );
  const probe = JSON.parse(probeText);
  assert.ok(probe.streams.some((s: { codec_type: string }) => s.codec_type === 'audio'));
  assert.equal(
    probe.streams.find((s: { codec_type: string }) => s.codec_type === 'video').nb_frames,
    '48',
  );
  async function signal(path: string, start: number, duration: number) {
    const { stdout } = await run(
      ffmpegPath(),
      [
        '-v',
        'error',
        '-i',
        path,
        '-ss',
        String(start),
        '-t',
        String(duration),
        '-vn',
        '-af',
        'pan=mono|c0=c0',
        '-ar',
        '48000',
        '-f',
        'f32le',
        'pipe:1',
      ],
      { encoding: 'buffer', maxBuffer: 1024 * 1024, windowsHide: true },
    );
    let sum = 0,
      crossings = 0;
    for (let i = 0; i < stdout.length; i += 4) {
      const value = stdout.readFloatLE(i);
      sum += value ** 2;
      if (i > 0 && value > 0 && stdout.readFloatLE(i - 4) <= 0) crossings++;
    }
    return {
      rms: Math.sqrt(sum / (stdout.length / 4)),
      frequency: crossings / (stdout.length / 4 / 48000),
    };
  }
  const source = await signal(fixture, 0.7, 0.2),
    first = await signal(rendered, 0.7, 0.2),
    second = await signal(rendered, 1.2, 0.2);
  const sourceRms = source.rms,
    outputRms = first.rms,
    before = (await signal(rendered, 0.1, 0.2)).rms,
    after = (await signal(rendered, 1.7, 0.2)).rms,
    cutRms = (await signal(rendered, 0.98, 0.04)).rms;
  assert.ok(
    Math.abs(first.frequency - 660) < 15 && Math.abs(second.frequency - 880) < 15,
    JSON.stringify({ first, second }),
  );
  assert.ok(
    outputRms / sourceRms > 1.4 && outputRms / sourceRms < 1.6,
    JSON.stringify({ sourceRms, outputRms }),
  );
  assert.ok(before < 0.001 && after < 0.001, JSON.stringify({ before, after }));
  assert.ok(cutRms > 0.08);
  const { stdout: rgb } = await run(
    ffmpegPath(),
    [
      '-v',
      'error',
      '-i',
      rendered,
      '-ss',
      '0.75',
      '-frames:v',
      '1',
      '-pix_fmt',
      'rgb24',
      '-f',
      'rawvideo',
      'pipe:1',
    ],
    { encoding: 'buffer', maxBuffer: 1024 * 1024, windowsHide: true },
  );
  const exportPixels = {
    center: Array.from(rgb.subarray((90 * 320 + 160) * 3, (90 * 320 + 160) * 3 + 3)),
    edge: Array.from(rgb.subarray((90 * 320 + 10) * 3, (90 * 320 + 10) * 3 + 3)),
    top: Array.from(rgb.subarray((10 * 320 + 160) * 3, (10 * 320 + 160) * 3 + 3)),
  };
  assert.ok(exportPixels.center[0] > 180 && exportPixels.edge[0] < 15 && exportPixels.top[2] > 180);
  const bundle = await api<{ project: Project; blobs: unknown[] }>(`/projects/${p.id}/export`);
  assert.equal(bundle.project.schemaVersion, PROJECT_VERSION);
  await writeFile(join(output, 'edited.ffstudio'), JSON.stringify(bundle));
  const reopened = await api<{ project: Project }>('/projects/import', bundle);
  assert.equal(reopened.project.timeline.clips.find((c) => c.id === right.id)?.sourceIn, 24);
  assert.equal(reopened.project.timeline.clips.find((c) => c.id === right.id)?.volume, 1.5);
  assert.deepEqual(errors, []);
  const report = {
    checkedAt: new Date().toISOString(),
    projectId: p.id,
    jobId: job.id,
    browser: browser.version(),
    videoHasAudio: video.hasAudio,
    silentVideoHasAudio: noAudio.hasAudio,
    contained,
    covered,
    stretched,
    exportPixels,
    previewAudio: audioLevels,
    exportAudio: {
      sourceRms,
      outputRms,
      gain: outputRms / sourceRms,
      before,
      after,
      cutRms,
      firstFrequency: first.frequency,
      secondFrequency: second.frequency,
    },
    frames: 48,
    format: bundle.project.schemaVersion,
    checks: [
      'UI contain/cover/stretch and encoded frame pixels',
      'video source in',
      'split linked audio',
      'real preview gain',
      'video original audio export',
      'silent video export',
      'pre/post clip silence',
      'portable project reimport',
    ],
    pageErrors: errors,
  };
  await writeFile(join(output, 'result.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser.close();
}
