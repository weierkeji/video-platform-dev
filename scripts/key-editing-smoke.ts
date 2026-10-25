import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chromium } from 'playwright-core';
import { validateBytes } from 'gltf-validator';
import { keyEditingFixture } from './key-editing-fixture';
import { browserPath, ffmpegPath, ffprobePath } from '../server/runtime';
import { id, type Project, type GenerationJob } from '../src/core/model';

const origin = process.env.STUDIO_URL || 'http://127.0.0.1:4173';
const output = resolve('.local/checks/key-editing');
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
const fixture = keyEditingFixture();
fixture.p.name += ' ' + new Date().toISOString();
let p = (await api<{ project: Project }>('/projects/import', { project: fixture.p, blobs: [] }))
  .project;
const original = structuredClone(p),
  sourceTrack = p.animationTracks[0];
const browser = await chromium.launch({
  executablePath: browserPath(),
  headless: true,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 1700, height: 1200 } }),
  errors: string[] = [];
try {
  await page.addInitScript('globalThis.__name = (fn) => fn');
  page.on('pageerror', (e) => errors.push(e.stack || e.message));
  await page.goto(origin, { waitUntil: 'networkidle' });
  await page.getByLabel('切换项目').selectOption(p.id);
  const field = async (label: string, n: number) => {
    const input = page.getByLabel(label, { exact: true });
    await input.fill(String(n));
    await input.press('Tab');
  };
  const saved = async (previous = p.revision) => {
    for (let i = 0; i < 120; i++) {
      p = (await api<{ project: Project }>(`/projects/${p.id}`)).project;
      if (p.revision > previous) {
        assert.equal(p.revision, previous + 1, 'one gesture must be one revision');
        await page.waitForFunction(
          (r) => document.querySelector('.save-status')?.textContent?.includes(`r${r}`),
          p.revision,
        );
        return;
      }
      await page.waitForTimeout(50);
    }
    throw new Error('No saved revision: ' + (await page.locator('body').innerText()));
  };
  const selection = async (n: number) => {
    await page.locator(`[data-key-selection-count="${n}"]`).waitFor();
  };
  const point = async (keyId: string) => {
    const box = await page.locator(`.curve-canvas [data-key-id="${keyId}"]`).boundingBox();
    assert.ok(box);
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  };
  const decodePNG = async (path: string) =>
    Buffer.from(
      await page.evaluate(
        async (bytes) => {
          const bitmap = await createImageBitmap(
            new Blob([new Uint8Array(bytes)], { type: 'image/png' }),
          );
          const canvas = new OffscreenCanvas(bitmap.width, bitmap.height),
            ctx = canvas.getContext('2d')!;
          ctx.drawImage(bitmap, 0, 0);
          bitmap.close();
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
    return decodePNG(path);
  };
  const difference = (a: Buffer, b: Buffer) => {
    assert.equal(a.length, 480 * 270 * 3);
    assert.equal(a.length, b.length);
    return a.reduce((sum, n, i) => sum + Math.abs(n - b[i]), 0) / a.length;
  };
  await page.getByRole('button', { name: '成片预览', exact: true }).click();
  const sourceImages = new Map<number, Buffer>();
  for (const frame of [0, 3, 6, 9, 12, 15, 18])
    sourceImages.set(frame, await png('original', frame));
  assert.ok(difference(sourceImages.get(0)!, sourceImages.get(12)!) > 1);
  await page.getByRole('button', { name: '三维编辑', exact: true }).click();
  await page
    .locator('.entity-list')
    .getByRole('button', { name: '节奏方块', exact: false })
    .click();
  await page.getByRole('button', { name: '动画曲线', exact: true }).click();
  await page.getByRole('button', { name: '适配曲线', exact: true }).click();
  // Box-select the two middle keys using actual pointer events.
  const a = await point(sourceTrack.keys[1].id),
    b = await point(sourceTrack.keys[2].id);
  await page.mouse.move(Math.min(a.x, b.x) - 12, Math.min(a.y, b.y) - 12);
  await page.mouse.down();
  await page.mouse.move(Math.max(a.x, b.x) + 12, Math.max(a.y, b.y) + 12, { steps: 8 });
  await page.mouse.up();
  await selection(2);
  assert.equal(p.revision, original.revision);
  await page.keyboard.down('Shift');
  await page.locator(`.curve-canvas [data-key-id="${sourceTrack.keys[0].id}"]`).click();
  await page.keyboard.up('Shift');
  await selection(3);
  await page.keyboard.down('Shift');
  await page.locator(`.curve-canvas [data-key-id="${sourceTrack.keys[0].id}"]`).click();
  await page.keyboard.up('Shift');
  await selection(2);
  // A collision against the unselected last key is rejected before any revision.
  // An external action change must discard now-hidden selected keys on refresh.
  const temporaryAction = id();
  await api(`/projects/${p.id}/commands`, {
    baseRevision: p.revision,
    label: '外部切换动作',
    commands: [
      {
        type: 'action.add',
        action: { id: temporaryAction, name: '临时空动作', sceneId: fixture.sceneId },
      },
      { type: 'scene.update', id: fixture.sceneId, patch: { activeActionId: temporaryAction } },
    ],
  });
  await page.getByRole('button', { name: '刷新', exact: true }).click();
  await saved();
  await selection(0);
  await page.getByTitle('Ctrl+Z', { exact: true }).click();
  await saved();
  assert.deepEqual(p.animationTracks, original.animationTracks);
  await page.locator(`.curve-canvas [data-key-id="${sourceTrack.keys[1].id}"]`).click();
  await page.keyboard.down('Shift');
  await page.locator(`.curve-canvas [data-key-id="${sourceTrack.keys[2].id}"]`).click();
  await page.keyboard.up('Shift');
  await selection(2);
  await field('批量时间偏移 帧', 6);
  await page.getByRole('button', { name: '应用时间变换', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: '目标帧已有关键帧' }).waitFor();
  assert.equal((await api<{ project: Project }>(`/projects/${p.id}`)).project.revision, p.revision);
  await assert.rejects(
    api(`/projects/${p.id}/commands`, {
      baseRevision: p.revision,
      label: 'API collision',
      commands: [
        {
          type: 'keys.transform',
          keys: sourceTrack.keys.slice(1, 3).map((k) => ({ trackId: sourceTrack.id, keyId: k.id })),
          pivot: 0,
          scale: 1,
          offset: 6,
        },
      ],
    }),
    /目标帧/,
  );
  // Shared Timeline/Curve selection spans TRS channels.
  const rotation = p.animationTracks[1];
  await page.keyboard.down('Shift');
  await page.locator(`.timeline [data-timeline-key-id="${rotation.keys[0].id}"]`).click();
  await page.keyboard.up('Shift');
  await selection(3);
  assert.equal(await page.getByLabel('动画属性').inputValue(), 'quaternion');
  await page.getByRole('button', { name: '选择对象全部键', exact: true }).click();
  await selection(12);
  await page.getByRole('button', { name: '适配曲线', exact: true }).click();
  const visibleTrack = p.animationTracks[2];
  const start = await point(visibleTrack.keys[1].id),
    end = await point(visibleTrack.keys[2].id);
  const dx = (end.x - start.x) / 3; // exactly two frames with rounding.
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x + dx, start.y + 20, { steps: 5 });
  await page.keyboard.press('Escape');
  await page.mouse.up();
  assert.equal((await api<{ project: Project }>(`/projects/${p.id}`)).project.revision, p.revision);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x + dx, start.y + 20, { steps: 5 });
  await page.mouse.up();
  await saved();
  assert.deepEqual(
    p.animationTracks.map((t) => t.keys.map((k) => k.frame)),
    Array.from({ length: 3 }, () => [2, 8, 14, 20]),
  );
  p.animationTracks.forEach((t, i) =>
    assert.deepEqual(
      t.keys.map((k) => k.value),
      original.animationTracks[i].keys.map((k) => k.value),
    ),
  );
  await page.getByTitle('Ctrl+Z', { exact: true }).click();
  await saved();
  assert.deepEqual(p.animationTracks, original.animationTracks);
  await page.getByTitle('Ctrl+Shift+Z', { exact: true }).click();
  await saved();
  await field('批量时间偏移 帧', 1);
  await field('批量时间倍率', 1.5);
  await page.getByRole('button', { name: '应用时间变换', exact: true }).click();
  await saved();
  assert.deepEqual(
    p.animationTracks[0].keys.map((k) => k.frame),
    [3, 12, 21, 30],
  );
  assert.deepEqual(
    p.animationTracks[0].keys[0].outTangent,
    original.animationTracks[0].keys[0].outTangent!.map((n) => n / 1.5),
  );
  await field('批量时间偏移 帧', 36);
  await field('批量时间倍率', 1);
  await page.getByRole('button', { name: '复制所选键', exact: true }).click();
  await saved();
  await selection(12);
  const copied = structuredClone(p.animationTracks);
  assert.ok(p.animationTracks.every((t) => t.keys.length === 8));
  assert.deepEqual(
    p.animationTracks[0].keys.map((k) => k.frame),
    [3, 12, 21, 30, 39, 48, 57, 66],
  );
  await page.getByRole('button', { name: '删除所选键', exact: true }).click();
  await saved();
  await selection(0);
  assert.ok(p.animationTracks.every((t) => t.keys.length === 4));
  await page.getByTitle('Ctrl+Z', { exact: true }).click();
  await saved();
  assert.deepEqual(p.animationTracks, copied);
  // Keyboard selection and delete use the same grouped command.
  await page.locator('.curve-canvas').focus();
  await page.keyboard.press('a');
  await selection(8);
  await page.keyboard.press('Delete');
  await saved();
  assert.equal(p.animationTracks.length, 2);
  await page.getByTitle('Ctrl+Z', { exact: true }).click();
  await saved();
  assert.deepEqual(p.animationTracks, copied);
  await page.getByRole('button', { name: '选择对象全部键', exact: true }).click();
  await selection(24);
  await page.getByRole('button', { name: '适配曲线', exact: true }).click();
  await page.screenshot({ path: join(output, 'multi-key-editor.png') });
  await page.reload({ waitUntil: 'networkidle' });
  await page.getByLabel('切换项目').selectOption(p.id);
  p = (await api<{ project: Project }>(`/projects/${p.id}`)).project;
  assert.deepEqual(p.animationTracks, copied);
  await page.getByRole('button', { name: '成片预览', exact: true }).click();
  const measurements: {
    source: number;
    target: number;
    difference: number;
    duplicateDifference: number;
  }[] = [];
  const referenceImages = new Map<number, Buffer>();
  for (const [source, image] of sourceImages) {
    const target = 3 + 1.5 * source,
      pixels = await png('retimed', target),
      duplicate = await png('duplicate', target + 36);
    const delta = difference(image, pixels),
      duplicateDelta = difference(pixels, duplicate);
    assert.ok(delta < 0.05, String(delta));
    assert.ok(duplicateDelta < 0.05, String(duplicateDelta));
    referenceImages.set(target, pixels);
    referenceImages.set(target + 36, duplicate);
    measurements.push({ source, target, difference: delta, duplicateDifference: duplicateDelta });
  }
  await page.screenshot({ path: join(output, 'product.png') });
  await page.getByRole('button', { name: '三维编辑', exact: true }).click();
  await page.getByRole('button', { name: 'glTF', exact: true }).click();
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: '导出动画 GLB', exact: true }).click(),
  ]);
  const glbPath = join(output, 'key-editing.glb');
  await download.saveAs(glbPath);
  const validator = await validateBytes(new Uint8Array(await readFile(glbPath)), {
    uri: 'key-editing.glb',
  });
  assert.equal(validator.issues.numErrors, 0);
  assert.equal(validator.issues.numWarnings, 0);
  await page.getByRole('button', { name: '关闭', exact: true }).click();
  const job = await api<GenerationJob>(`/projects/${p.id}/jobs`, {
    kind: 'render',
    baseRevision: p.revision,
    requestKey: id(),
  });
  let result = job;
  const deadline = Date.now() + 120000;
  while (['queued', 'running'].includes(result.status) && Date.now() < deadline) {
    await page.waitForTimeout(500);
    result = await api<GenerationJob>(`/jobs/${job.id}`);
  }
  assert.equal(result.status, 'succeeded', result.message);
  const mp4Path = join(output, 'key-editing.mp4');
  await writeFile(
    mp4Path,
    Buffer.from(await (await fetch(`${origin}/api/jobs/${job.id}/artifact`)).arrayBuffer()),
  );
  const run = promisify(execFile),
    probe = JSON.parse(
      (
        await run(ffprobePath(), ['-v', 'error', '-show_streams', '-of', 'json', mp4Path], {
          windowsHide: true,
        })
      ).stdout,
    );
  assert.equal(probe.streams[0].nb_frames, '72');
  assert.equal(probe.streams[0].width, 480);
  assert.equal(probe.streams[0].codec_name, 'h264');
  const videoMeasurements: { frame: number; difference: number }[] = [];
  for (const frame of [3, 12, 21, 30, 39, 48, 57, 66]) {
    const pixels = (
      await run(
        ffmpegPath(),
        [
          '-v',
          'error',
          '-i',
          mp4Path,
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
        { windowsHide: true, encoding: 'buffer', maxBuffer: 1024 * 1024 },
      )
    ).stdout;
    const delta = difference(referenceImages.get(frame)!, pixels);
    assert.ok(delta < 4, String(delta));
    videoMeasurements.push({ frame, difference: delta });
  }
  // Import the native animated output through the real UI and compare poses.
  // A completed render adds an artifact revision. Refresh before the next edit.
  p = (await api<{ project: Project }>(`/projects/${p.id}`)).project;
  await page.getByRole('button', { name: '刷新', exact: true }).click();
  await page.waitForFunction(
    (r) => document.querySelector('.save-status')?.textContent?.includes(`r${r}`),
    p.revision,
  );
  await page.getByRole('button', { name: 'glTF', exact: true }).click();
  await page.getByLabel('选择 glTF 文件', { exact: true }).setInputFiles(glbPath);
  const oldScenes = new Set(p.scenes.map((s) => s.id));
  await page.getByRole('button', { name: '导入这些场景', exact: true }).click();
  await saved();
  const importedScene = p.scenes.find((s) => !oldScenes.has(s.id))!;
  assert.ok(importedScene);
  const importedEntities = new Set(
    p.entities.filter((e) => e.sceneId === importedScene.id).map((e) => e.id),
  );
  assert.equal(
    p.animationTracks
      .filter((t) => importedEntities.has(t.entityId))
      .reduce((sum, t) => sum + t.keys.length, 0),
    24,
  );
  const shotId = p.timeline.clips[0].sourceId;
  const importedCamera = p.entities.find(
    (e) => e.sceneId === importedScene.id && e.kind === 'camera',
  )!;
  p = (
    await api<{ project: Project }>(`/projects/${p.id}/commands`, {
      baseRevision: p.revision,
      label: '预览重导入动画',
      commands: [
        {
          type: 'scene.update',
          id: importedScene.id,
          patch: { background: original.scenes[0].background, ambient: original.scenes[0].ambient },
        },
        {
          type: 'shot.update',
          id: shotId,
          patch: { sceneId: importedScene.id, cameraId: importedCamera.id },
        },
      ],
    })
  ).project;
  await page.getByRole('button', { name: '刷新', exact: true }).click();
  await page.getByRole('button', { name: '成片预览', exact: true }).click();
  const importedMeasurements: { frame: number; difference: number }[] = [];
  for (const frame of [3, 7.5, 12, 21, 30, 48, 66]) {
    const delta = difference(referenceImages.get(frame)!, await png('imported', frame));
    assert.ok(delta < 0.1, String(delta));
    importedMeasurements.push({ frame, difference: delta });
  }
  const bundle = await api<{ project: Project; blobs: unknown[] }>(`/projects/${p.id}/export`);
  const restored = await api<{ project: Project }>('/projects/import', bundle);
  assert.deepEqual(restored.project.animationTracks, p.animationTracks);
  assert.deepEqual(restored.project.geometries, p.geometries);
  await writeFile(join(output, 'key-editing.ffstudio'), JSON.stringify(bundle, null, 2));
  const report = {
    checkedAt: new Date().toISOString(),
    browser: browser.version(),
    projectId: p.id,
    restoredProjectId: restored.project.id,
    jobId: job.id,
    revision: p.revision,
    sourceKeys: 12,
    finalSourceKeys: 24,
    frames: p.animationTracks
      .filter((t) => !importedEntities.has(t.entityId))
      .map((t) => t.keys.map((k) => k.frame)),
    measurements,
    importedMeasurements,
    videoMeasurements,
    validator: validator.issues,
    video: probe.streams[0],
    pageErrors: errors,
    checks: [
      'box selection and Shift toggles',
      'external action change clears hidden selected keys',
      'Timeline and curve multi-track selection',
      'group drag cancels and commits one revision',
      'collision rejects in UI and API',
      'time scale updates Hermite tangent units',
      'duplicate selects fresh IDs; delete and keyboard delete are atomic',
      'undo/redo/reload retain all keys',
      'retimed and duplicate PNG match source poses',
      'native GLB reimport and saved project restore',
      'actual H264 output matches edited preview',
    ],
  };
  assert.deepEqual(errors, []);
  await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} catch (e) {
  await page.screenshot({ path: join(output, 'failure.png'), fullPage: true });
  await writeFile(join(output, 'failure.txt'), await page.locator('body').innerText());
  console.error(await page.locator('.error-banner, .curve-error').allTextContents());
  throw e;
} finally {
  await browser.close();
}
