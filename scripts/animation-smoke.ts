import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright-core';
import { browserPath, ffmpegPath, ffprobePath } from '../server/runtime';
import { id, PROJECT_VERSION, type Project, type GenerationJob } from '../src/core/model';
import { sampleTrack } from '../src/core/animation';

const origin = process.env.STUDIO_URL || 'http://127.0.0.1:4173';
const output = resolve('.local/checks/animation');
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
  await api<{ project: Project }>('/projects', {
    name: `动画曲线检查 ${new Date().toISOString().slice(0, 19)}`,
  })
).project;
const mesh = p.entities.find((e) => e.kind === 'mesh')!,
  camera = p.entities.find((e) => e.kind === 'camera')!;
p = (
  await api<{ project: Project }>(`/projects/${p.id}/commands`, {
    baseRevision: p.revision,
    label: '动画镜头设置',
    commands: [
      { type: 'clip.update', id: p.timeline.clips[0].id, patch: { duration: 36 } },
      { type: 'timeline.update', patch: { duration: 36, width: 320, height: 180 } },
      {
        type: 'entity.update',
        id: mesh.id,
        patch: {
          transform: { position: [-2, 0, 0], rotation: [0, 0, 0], scale: [0.65, 0.65, 0.65] },
        },
      },
      {
        type: 'entity.update',
        id: camera.id,
        patch: { transform: { position: [0, 0, 10], rotation: [0, 0, 0], scale: [1, 1, 1] } },
      },
      {
        type: 'material.update',
        id: mesh.materialId,
        patch: { color: '#ff2020', roughness: 1, metalness: 0 },
      },
      { type: 'scene.update', id: p.scenes[0].id, patch: { background: '#000000', ambient: 1 } },
    ],
  })
).project;
const browser = await chromium.launch({
  executablePath: browserPath(),
  headless: true,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const errors: string[] = [];
try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1100 } });
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(origin, { waitUntil: 'networkidle' });
  await page.getByLabel('切换项目').selectOption(p.id);
  await page.locator('.entity').filter({ hasText: '立方体' }).click();
  await page.getByRole('button', { name: '动画曲线', exact: true }).click();
  async function saved(previous = p.revision) {
    for (let n = 0; n < 80; n++) {
      p = (await api<{ project: Project }>(`/projects/${p.id}`)).project;
      if (p.revision > previous) {
        await page.waitForFunction(
          (revision) =>
            document.querySelector('.save-status')?.textContent?.includes(`r${revision}`),
          p.revision,
        );
        return;
      }
      await page.waitForTimeout(50);
    }
    throw new Error(
      'Edit did not save: ' +
        (await page
          .locator('.error-banner')
          .textContent()
          .catch(() => 'no error banner')),
    );
  }
  async function number(label: string, value: number, persists = true) {
    await page.getByLabel(label, { exact: true }).fill(String(value));
    await page.getByLabel(label, { exact: true }).press('Enter');
    if (persists) await saved();
  }
  await page.getByRole('button', { name: '记录当前帧', exact: true }).click();
  await saved();
  await number('当前帧', 24, false);
  await number('位置 X', 2);
  const trackId = p.animationTracks[0].id,
    firstId = p.animationTracks[0].keys[0].id,
    lastId = p.animationTracks[0].keys[1].id;
  const first = () => page.locator(`[data-key-id="${firstId}"]`),
    last = () => page.locator(`[data-key-id="${lastId}"]`);
  await first().click();
  await page.getByLabel('曲线插值').selectOption('bezier');
  await saved();
  await number('右手柄 Δ帧', 2);
  await number('右手柄 Δ值', 4);
  await last().click();
  await number('左手柄 Δ帧', -10);
  await number('左手柄 Δ值', 0);
  await number('关键帧时间', 30);
  await page.getByRole('button', { name: '适配曲线', exact: true }).click();
  assert.equal(p.animationTracks[0].keys[1].id, lastId);
  const beforeKeyDrag = p.revision;
  const lastBox = (await last().boundingBox())!;
  await page.mouse.move(lastBox.x + lastBox.width / 2, lastBox.y + lastBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(lastBox.x + lastBox.width / 2 - 32, lastBox.y + lastBox.height / 2 - 8, {
    steps: 6,
  });
  await page.mouse.up();
  await saved();
  assert.equal(p.revision, beforeKeyDrag + 1, 'one pointer drag = one persisted transaction');
  assert.notEqual(p.animationTracks[0].keys[1].frame, 30);
  const movedKey = structuredClone(p.animationTracks[0].keys[1]);
  await page.getByTitle('Ctrl+Z', { exact: true }).click();
  await saved();
  assert.equal(p.animationTracks[0].keys[1].frame, 30);
  await page.getByTitle('Ctrl+Shift+Z', { exact: true }).click();
  await saved();
  assert.deepEqual(p.animationTracks[0].keys[1], movedKey);
  await first().click();
  const beforeHandle = structuredClone(p.animationTracks[0].keys[0].handles),
    revision = p.revision;
  const handle = page.locator('[data-handle="right"]'),
    box = (await handle.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 24, box.y + box.height / 2 - 9, { steps: 8 });
  await page.mouse.up();
  await saved();
  assert.equal(p.revision, revision + 1);
  assert.notDeepEqual(p.animationTracks[0].keys[0].handles, beforeHandle);
  const beforeCancel = structuredClone(p.animationTracks[0]),
    cancelRevision = p.revision;
  const cancelBox = (await handle.boundingBox())!;
  await page.mouse.move(cancelBox.x + cancelBox.width / 2, cancelBox.y + cancelBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(cancelBox.x + 50, cancelBox.y + 20, { steps: 4 });
  await page.keyboard.press('Escape');
  await page.mouse.up();
  await page.waitForTimeout(150);
  p = (await api<{ project: Project }>(`/projects/${p.id}`)).project;
  assert.equal(p.revision, cancelRevision);
  assert.deepEqual(p.animationTracks[0], beforeCancel);
  await page.getByRole('button', { name: '适配曲线', exact: true }).click();
  await page.screenshot({ path: join(output, 'curves.png') });
  await page.reload({ waitUntil: 'networkidle' });
  await page.locator('.entity').filter({ hasText: '立方体' }).click();
  await page.getByRole('button', { name: '动画曲线', exact: true }).click();
  await first().click();
  assert.equal(await page.getByLabel('曲线插值').inputValue(), 'bezier');
  await number('当前帧', 8, false);
  assert.ok(
    Math.abs(
      Number(await page.getByLabel('位置 X', { exact: true }).inputValue()) -
        sampleTrack(p.animationTracks[0], 8)![0],
    ) < 1e-4,
  );
  // Real preview pixels through the product compositor, evaluated at fractional and integer frames.
  await page.getByLabel('动画属性').selectOption('rotation');
  await page.getByRole('button', { name: '记录当前帧', exact: true }).click();
  await saved();
  const rotationKey = p.animationTracks.find((t) => t.property === 'rotation')!.keys[0].id;
  await page.locator(`[data-key-id="${rotationKey}"]`).click();
  await number('关键帧 X（°）', 90);
  assert.equal(
    p.animationTracks.find((t) => t.property === 'rotation')!.keys[0].value[0],
    Math.PI / 2,
  );
  await page.locator('.curve-canvas').focus();
  await page.keyboard.press('Delete');
  await saved();
  assert.ok(
    p.entities.some((e) => e.id === mesh.id),
    'Delete in curves preserves the selected object',
  );
  assert.equal(
    p.animationTracks.some((t) => t.property === 'rotation'),
    false,
  );
  await page.getByTitle('Ctrl+Z', { exact: true }).click();
  await saved();
  assert.equal(p.animationTracks.find((t) => t.property === 'rotation')!.keys[0].id, rotationKey);
  await page.getByTitle('Ctrl+Shift+Z', { exact: true }).click();
  await saved();
  await page.getByLabel('动画属性').selectOption('position');
  await first().click();
  const frames = [0, 6, 12, 24, 35];
  const preview = await page.evaluate(
    async ({ project, frames }) => {
      const modulePath = '/src/render/timeline.ts';
      const { TimelineRenderer } = await import(/* @vite-ignore */ modulePath);
      const canvas = document.createElement('canvas'),
        renderer = new TimelineRenderer(canvas, project);
      const result = [];
      try {
        for (const frame of frames) {
          await renderer.render(frame);
          const rgba = canvas
            .getContext('2d')!
            .getImageData(0, 0, canvas.width, canvas.height).data;
          let sum = 0,
            count = 0;
          for (let n = 0; n < rgba.length; n += 4)
            if (rgba[n] > 90 && rgba[n] > rgba[n + 1] * 1.7 && rgba[n] > rgba[n + 2] * 1.7) {
              sum += (n / 4) % canvas.width;
              count++;
            }
          result.push({
            frame,
            center: sum / count,
            pixels: count,
            png: canvas.toDataURL('image/png').split(',')[1],
          });
        }
        return result;
      } finally {
        renderer.dispose();
      }
    },
    { project: p, frames },
  );
  const job = await api<GenerationJob>(`/projects/${p.id}/jobs`, {
    baseRevision: p.revision,
    kind: 'render',
    requestKey: id(),
  });
  let result = job;
  const deadline = Date.now() + 120000;
  while (['queued', 'running'].includes(result.status) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 500));
    result = await api<GenerationJob>(`/jobs/${job.id}`);
  }
  assert.equal(result.status, 'succeeded', result.message);
  const file = join(output, 'curves.mp4');
  await writeFile(
    file,
    Buffer.from(await (await fetch(`${origin}/api/jobs/${job.id}/artifact`)).arrayBuffer()),
  );
  const run = promisify(execFile);
  const { stdout: probeText } = await run(
    ffprobePath(),
    ['-v', 'error', '-show_streams', '-of', 'json', file],
    { windowsHide: true },
  );
  assert.equal(JSON.parse(probeText).streams[0].nb_frames, '36');
  const measurements = [];
  for (const item of preview) {
    await writeFile(join(output, `preview-${item.frame}.png`), Buffer.from(item.png, 'base64'));
    const { stdout: rgb } = await run(
      ffmpegPath(),
      [
        '-v',
        'error',
        '-i',
        file,
        '-ss',
        String(item.frame / 24),
        '-frames:v',
        '1',
        '-pix_fmt',
        'rgb24',
        '-f',
        'rawvideo',
        'pipe:1',
      ],
      { encoding: 'buffer', windowsHide: true, maxBuffer: 1024 * 1024 },
    );
    let sum = 0,
      count = 0;
    for (let n = 0; n < rgb.length; n += 3)
      if (rgb[n] > 90 && rgb[n] > rgb[n + 1] * 1.7 && rgb[n] > rgb[n + 2] * 1.7) {
        sum += (n / 3) % 320;
        count++;
      }
    assert.ok(count > 100 && item.pixels > 100);
    const x = sampleTrack(p.animationTracks[0], item.frame)![0];
    // Perspective center from the known camera, independent of the product scene evaluator.
    const expected = 160 + (x * 90) / (10 * Math.tan(Math.PI / 8)) - 0.5;
    assert.ok(
      Math.abs(item.center - expected) < 2,
      JSON.stringify({ item: { frame: item.frame, center: item.center }, expected }),
    );
    assert.ok(
      Math.abs(sum / count - item.center) < 1.5,
      'encoded motion matches actual preview pixels',
    );
    measurements.push({
      frame: item.frame,
      worldX: x,
      expectedPixelX: expected,
      previewPixelX: item.center,
      exportedPixelX: sum / count,
    });
  }
  const bundle = await api<{ project: Project; blobs: unknown[] }>(`/projects/${p.id}/export`);
  assert.equal(bundle.project.schemaVersion, PROJECT_VERSION);
  await writeFile(join(output, 'curves.ffstudio'), JSON.stringify(bundle));
  const imported = await api<{ project: Project }>('/projects/import', bundle);
  assert.deepEqual(imported.project.animationTracks, p.animationTracks);
  assert.deepEqual(errors, []);
  const report = {
    checkedAt: new Date().toISOString(),
    browser: browser.version(),
    projectId: p.id,
    importedProjectId: imported.project.id,
    jobId: job.id,
    trackId,
    format: PROJECT_VERSION,
    frames: 36,
    checks: [
      'UI records keys and edits interpolation/handles/time',
      'key and handle drags each persist one transaction',
      'key drag undo/redo',
      'Escape discards pending handle drag',
      'reload preserves curve selection targets and controls',
      'inspector uses shared evaluator',
      'rotation degrees persist as radians; Delete removes only the selected key and is undoable',
      'real preview and encoded object positions match curve',
      'portable project reimport preserves all curves',
    ],
    measurements,
    pageErrors: errors,
  };
  await writeFile(join(output, 'result.json'), JSON.stringify(report, null, 2));
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
