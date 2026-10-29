import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { chromium } from 'playwright-core';
import { clipEditingFixture } from './clip-editing-fixture';
import { browserPath, ffmpegPath, ffprobePath } from '../server/runtime';
import { id, type Asset, type Clip, type Project, type GenerationJob } from '../src/core/model';
import { sourceFrame } from '../src/core/playback';
import type { Command } from '../src/core/commands';

const origin = process.env.STUDIO_URL || 'http://127.0.0.1:4173',
  output = resolve('.local/checks/clip-editing'),
  run = promisify(execFile);
await mkdir(output, { recursive: true });
const duplicateDirectory = join(output, `unused-duplicate-${id()}`);
let duplicateRejected = false;
try {
  await run(
    process.execPath,
    ['node_modules/tsx/dist/cli.mjs', 'server/index.ts', '--production'],
    {
      windowsHide: true,
      timeout: 15000,
      env: { ...process.env, PORT: new URL(origin).port, STUDIO_DATA_DIR: duplicateDirectory },
    },
  );
} catch (error) {
  duplicateRejected =
    (error as { code?: number }).code === 1 &&
    String((error as { stderr?: string }).stderr).includes('端口已被使用');
}
assert.ok(
  duplicateRejected,
  'Duplicate launch must fail clearly before storage/job initialization',
);
assert.equal(existsSync(duplicateDirectory), false);
const sourcePath = join(output, 'moving-colors.mp4');
await run(
  ffmpegPath(),
  [
    '-y',
    '-v',
    'error',
    '-f',
    'lavfi',
    '-i',
    'testsrc2=size=160x240:rate=24:duration=3',
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
    sourcePath,
  ],
  { windowsHide: true },
);
async function api<T>(path: string, body?: unknown): Promise<T> {
  const r = await fetch(origin + '/api' + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Studio-Client': 'frameforge' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const result = await r.json();
  if (!r.ok) throw new Error(JSON.stringify(result));
  return result;
}
const upload = await fetch(origin + '/api/blobs', {
  method: 'POST',
  headers: {
    'Content-Type': 'video/mp4',
    'X-Studio-Client': 'frameforge',
    'X-File-Name': encodeURIComponent('原创运动色块与音调.mp4'),
  },
  body: new Uint8Array(await readFile(sourcePath)),
});
const video = (await upload.json()) as Asset;
assert.equal(upload.status, 201);
assert.equal(video.hasAudio, true);
const f = clipEditingFixture(video);
f.p.name += ' ' + new Date().toISOString();
let p = (await api<{ project: Project }>('/projects/import', { project: f.p, blobs: [] })).project;
const original = structuredClone(p),
  browser = await chromium.launch({
    executablePath: browserPath(),
    headless: true,
    args: [
      '--use-angle=swiftshader',
      '--enable-unsafe-swiftshader',
      '--autoplay-policy=no-user-gesture-required',
    ],
  });
const page = await browser.newPage({ viewport: { width: 1500, height: 1100 } }),
  errors: string[] = [];
try {
  await page.addInitScript('globalThis.__name=(fn)=>fn');
  page.on('pageerror', (e) => errors.push(e.stack || e.message));
  await page.goto(origin, { waitUntil: 'networkidle' });
  await page.getByLabel('切换项目').selectOption(p.id);
  const current = (key: string) => p.timeline.clips.find((c) => c.id === key)!;
  const refresh = async () => {
    p = (await api<{ project: Project }>(`/projects/${p.id}`)).project;
  };
  const visible = async () =>
    page.waitForFunction(
      (r) => document.querySelector('.save-status')?.textContent?.includes(`r${r}`),
      p.revision,
    );
  const saved = async (previous = p.revision) => {
    for (let i = 0; i < 120; i++) {
      await refresh();
      if (p.revision > previous) {
        assert.equal(p.revision, previous + 1);
        await visible();
        return;
      }
      await page.waitForTimeout(50);
    }
    throw new Error('No saved clip revision');
  };
  const unchanged = async () => {
    const revision = p.revision;
    await page.waitForTimeout(200);
    await refresh();
    assert.equal(p.revision, revision);
  };
  const undo = async () => {
    await page.getByTitle('Ctrl+Z', { exact: true }).click();
    await saved();
  };
  const redo = async () => {
    await page.getByTitle('Ctrl+Shift+Z', { exact: true }).click();
    await saved();
  };
  const change = async (commands: Command[], label: string) => {
    p = (
      await api<{ project: Project }>(`/projects/${p.id}/commands`, {
        baseRevision: p.revision,
        commands,
        label,
      })
    ).project;
    await page.getByRole('button', { name: '刷新', exact: true }).click();
    await visible();
  };
  const body = (key: string) => page.locator(`.clip[data-clip-id="${key}"]`);
  const handle = (key: string, mode: string) =>
    mode === 'move' ? body(key) : page.locator(`[data-clip="${key}"][data-clip-handle="${mode}"]`);
  const drag = async (key: string, mode: string, delta: number, channel?: number) => {
    const button = handle(key, mode);
    await button.scrollIntoViewIfNeeded();
    const box = (await button.boundingBox())!,
      track = (await page.locator(`[data-channel="${current(key).channel}"]`).boundingBox())!;
    const px = track.width / p.timeline.duration,
      x = box.x + box.width / 2,
      y = box.y + box.height / 2;
    const target =
      channel === undefined
        ? y
        : (await page.locator(`[data-channel="${channel}"]`).boundingBox())!.y + 16;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + delta * px, target, { steps: 8 });
    await page.locator('.clip-draft').waitFor();
  };
  const finish = async () => {
    await page.mouse.up();
    await saved();
  };
  const field = async (label: string, value: number) => {
    const input = page.getByLabel(label, { exact: true });
    await input.fill(String(value));
    await input.press('Tab');
  };
  const decode = async (path: string) =>
    Buffer.from(
      await page.evaluate(
        async (bytes) => {
          const image = await createImageBitmap(
            new Blob([new Uint8Array(bytes)], { type: 'image/png' }),
          );
          const canvas = new OffscreenCanvas(image.width, image.height),
            ctx = canvas.getContext('2d')!;
          ctx.drawImage(image, 0, 0);
          image.close();
          const rgba = ctx.getImageData(0, 0, canvas.width, canvas.height).data,
            rgb: number[] = [];
          for (let i = 0; i < rgba.length; i += 4) rgb.push(rgba[i], rgba[i + 1], rgba[i + 2]);
          return rgb;
        },
        Array.from(await readFile(path)),
      ),
    );
  const png = async (name: string, frame: number) => {
    await field('当前帧', frame);
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: '导出当前帧 PNG', exact: true }).click(),
    ]);
    const path = join(output, `${name}-${frame}.png`);
    await download.saveAs(path);
    return decode(path);
  };
  const difference = (a: Buffer, b: Buffer) => {
    assert.equal(a.length, b.length);
    return a.reduce((sum, v, i) => sum + Math.abs(v - b[i]), 0) / a.length;
  };

  await page.getByRole('button', { name: '成片预览', exact: true }).click();
  const keptFrames = [12, 17.5, 24, 27],
    kept = new Map<number, Buffer>();
  for (const frame of keptFrames) kept.set(frame, await png('original-reverse', frame));
  await field('当前帧', 0);
  // A one-frame gap falls within eight CSS pixels at fit zoom: the end snaps to B's start.
  await drag(f.aId, 'move', 23);
  assert.equal(await page.locator('.clip-draft').getAttribute('data-preview-start'), '48');
  assert.match(await page.locator('.timeline-edit-status').innerText(), /吸附 72/);
  await unchanged();
  await page.screenshot({ path: join(output, 'snapped-draft.png') });
  await finish();
  assert.equal(current(f.aId).start, 48);
  assert.equal(current(f.aId).sourceIn, 12);
  assert.equal(current(f.aId).fit, 'cover');
  assert.equal(await page.getByLabel('轨道', { exact: true }).inputValue(), '2');
  await undo();
  assert.equal(current(f.aId).start, 24);
  await redo();
  assert.equal(current(f.aId).start, 48);
  // Ctrl reverses the enabled snapping setting for this gesture.
  await undo();
  await page.keyboard.down('Control');
  await drag(f.aId, 'move', 23);
  assert.equal(await page.locator('.clip-draft').getAttribute('data-preview-start'), '47');
  await page.mouse.up();
  await page.keyboard.up('Control');
  await saved();
  assert.equal(current(f.aId).start, 47);
  await undo();
  await drag(f.aId, 'move', 24);
  await finish();
  // Neither Esc nor a forbidden drop creates a history entry.
  await drag(f.aId, 'move', -10);
  await page.keyboard.press('Escape');
  await page.mouse.up();
  await unchanged();
  assert.equal(await page.locator('.clip-draft').count(), 0);
  await drag(f.aId, 'move', -10);
  await page.setViewportSize({ width: 1400, height: 1100 });
  await page.mouse.up();
  await unchanged();
  assert.equal(await page.locator('.clip-draft').count(), 0);
  await page.setViewportSize({ width: 1500, height: 1100 });
  await page.getByLabel('片段吸附').uncheck();
  await drag(f.aId, 'move', 12);
  assert.match(await page.locator('.timeline-edit-status').innerText(), /不能重叠/);
  await page.mouse.up();
  await unchanged();
  assert.equal(current(f.aId).start, 48);
  await drag(f.aId, 'trimStart', -20);
  assert.match(await page.locator('.timeline-edit-status').innerText(), /非负整帧/);
  await page.mouse.up();
  await unchanged();
  // Move to a clear channel and back, retaining source media and gain.
  await drag(f.aId, 'move', 0, 2);
  await finish();
  assert.equal(current(f.aId).channel, 2);
  assert.equal(await page.getByLabel('轨道', { exact: true }).inputValue(), '3');
  await undo();
  assert.equal(current(f.aId).channel, 1);
  await drag(f.aId, 'trimStart', 4);
  await finish();
  assert.equal(current(f.aId).start, 52);
  assert.equal(current(f.aId).sourceIn, 16);
  assert.equal(current(f.aId).duration, 20);
  await drag(f.aId, 'trimEnd', -4);
  await finish();
  assert.equal(current(f.aId).duration, 16);
  assert.equal(current(f.aId).sourceIn, 16);
  // Every retained reverse shot frame must show the original pose, including fractional time.
  await drag(f.reverseId, 'trimStart', 4);
  await finish();
  assert.equal(current(f.reverseId).sourceIn, 25.375);
  await drag(f.reverseId, 'trimEnd', 2);
  await finish();
  assert.equal(current(f.reverseId).duration, 18);
  const trimMeasurements: { frame: number; difference: number }[] = [];
  for (const frame of keptFrames) {
    const d = difference(kept.get(frame)!, await png('trimmed-reverse', frame));
    assert.equal(d, 0);
    trimMeasurements.push({ frame, difference: d });
  }
  await field('当前帧', 0);
  // Focused handles provide single-frame keyboard precision after zooming.
  await page.getByLabel('时间轴缩放').selectOption('2');
  await handle(f.aId, 'trimEnd').focus();
  await page.keyboard.press('ArrowRight');
  await saved();
  assert.equal(current(f.aId).duration, 17);
  await undo();
  await page.getByLabel('时间轴缩放').selectOption('1');
  await page.getByRole('button', { name: '增加轨道', exact: true }).click();
  await drag(f.reverseId, 'move', 32, 3);
  await finish();
  assert.equal(current(f.reverseId).channel, 3);
  assert.equal(current(f.reverseId).start, 44);
  for (const t of [0, 0.5, 9.25, 17.5])
    assert.ok(
      Math.abs(
        sourceFrame(current(f.reverseId), 44 + t) -
          sourceFrame(original.timeline.clips.find((c) => c.id === f.reverseId)!, 12 + t),
      ) < 1e-9,
    );
  await page.screenshot({ path: join(output, 'edited-timeline.png') });
  // Keep an export-length 96-frame sequence after exercising the wider editing view.
  await change([{ type: 'timeline.update', patch: { duration: 96 } }], '设置成片终点');
  const edited = structuredClone(p);
  await page.reload({ waitUntil: 'networkidle' });
  await page.getByLabel('切换项目').selectOption(p.id);
  await refresh();
  assert.deepEqual(p.timeline, edited.timeline);
  await page.getByRole('button', { name: '成片预览', exact: true }).click();
  const frames = [0, 12, 44, 60, 64, 68, 72, 84, 95],
    previews = new Map<number, Buffer>();
  for (const frame of frames) previews.set(frame, await png('final', frame));
  const job = await api<GenerationJob>(`/projects/${p.id}/jobs`, {
    kind: 'render',
    baseRevision: p.revision,
    requestKey: id(),
  });
  let result = job;
  const deadline = Date.now() + 180000;
  while (['queued', 'running'].includes(result.status) && Date.now() < deadline) {
    await page.waitForTimeout(500);
    result = await api<GenerationJob>(`/jobs/${job.id}`);
  }
  assert.equal(result.status, 'succeeded', result.message);
  const mp4 = join(output, 'edited-sequence.mp4');
  await writeFile(
    mp4,
    Buffer.from(await (await fetch(`${origin}/api/jobs/${job.id}/artifact`)).arrayBuffer()),
  );
  const probe = JSON.parse(
    (
      await run(ffprobePath(), ['-v', 'error', '-show_streams', '-of', 'json', mp4], {
        windowsHide: true,
      })
    ).stdout,
  );
  const stream = probe.streams.find((s: { codec_type: string }) => s.codec_type === 'video');
  assert.equal(stream.nb_frames, '96');
  assert.equal(stream.width, 480);
  assert.equal(stream.codec_name, 'h264');
  assert.ok(probe.streams.some((s: { codec_type: string }) => s.codec_type === 'audio'));
  const videoMeasurements: { frame: number; difference: number }[] = [];
  for (const frame of frames) {
    const pixels = (
      await run(
        ffmpegPath(),
        [
          '-v',
          'error',
          '-i',
          mp4,
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
        { encoding: 'buffer', maxBuffer: 1024 * 1024, windowsHide: true },
      )
    ).stdout;
    const d = difference(previews.get(frame)!, pixels);
    assert.ok(d < 5, `${frame}: ${d}`);
    videoMeasurements.push({ frame, difference: d });
  }
  const signal = async (path: string, start: number, duration = 0.15) => {
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
      const v = stdout.readFloatLE(i);
      sum += v * v;
      if (i && v > 0 && stdout.readFloatLE(i - 4) <= 0) crossings++;
    }
    return {
      rms: Math.sqrt(sum / (stdout.length / 4)),
      frequency: crossings / (stdout.length / 4 / 48000),
    };
  };
  const audio = {
    source660: await signal(sourcePath, 0.75),
    source440: await signal(sourcePath, 0.1),
    first: await signal(mp4, 2.25),
    second: await signal(mp4, 2.55),
    third: await signal(mp4, 3.1),
    before: await signal(mp4, 2),
    gap: await signal(mp4, 2.86, 0.1),
  };
  assert.ok(Math.abs(audio.first.frequency - 660) < 20);
  assert.ok(Math.abs(audio.second.frequency - 880) < 20);
  assert.ok(Math.abs(audio.third.frequency - 440) < 20);
  assert.ok(
    audio.first.rms / audio.source660.rms > 0.65 && audio.first.rms / audio.source660.rms < 0.85,
  );
  assert.ok(
    audio.third.rms / audio.source440.rms > 0.4 && audio.third.rms / audio.source440.rms < 0.6,
  );
  assert.ok(audio.before.rms < 0.001 && audio.gap.rms < 0.001);
  await refresh();
  await page.getByRole('button', { name: '刷新', exact: true }).click();
  await visible();
  const bundle = await api<{ project: Project; blobs: unknown[] }>(`/projects/${p.id}/export`),
    restored = await api<{ project: Project }>('/projects/import', bundle);
  assert.deepEqual(restored.project.timeline, p.timeline);
  assert.deepEqual(restored.project.entities, p.entities);
  assert.deepEqual(restored.project.animationTracks, p.animationTracks);
  await writeFile(join(output, 'edited-sequence.ffstudio'), JSON.stringify(bundle, null, 2));
  assert.deepEqual(errors, []);
  const report = {
    checkedAt: new Date().toISOString(),
    browser: browser.version(),
    projectId: p.id,
    restoredProjectId: restored.project.id,
    jobId: job.id,
    revision: p.revision,
    duplicateLaunch: {
      rejected: duplicateRejected,
      createdDataDirectory: existsSync(duplicateDirectory),
    },
    clips: p.timeline.clips,
    trimMeasurements,
    videoMeasurements,
    audio,
    video: stream,
    pageErrors: errors,
    checks: [
      'real mouse preview and release save exactly one revision',
      'end-edge snap and Ctrl inversion',
      'undo/redo and Esc/overlap/negative media-source rejection',
      'cross-track move and both trim handles',
      'fractional reverse pingpong phase and exact retained PNGs',
      'zoom and keyboard handle precision',
      'new channel and source-preserving shot move',
      'partial updates preserve cover fit',
      'reload and project package recover exact editable timeline',
      'real H264 frames and AAC source frequencies, gain and silent gap',
    ],
  };
  await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  await page.screenshot({ path: join(output, 'failure.png'), fullPage: true });
  await writeFile(join(output, 'failure.txt'), await page.locator('body').innerText());
  console.error(await page.locator('.error-banner,.viewport-error').allTextContents());
  throw error;
} finally {
  await browser.close();
}
