import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { chromium } from 'playwright-core';
import { validateBytes } from 'gltf-validator';
import { dataUsersFixture } from './data-users-fixture';
import { browserPath, ffmpegPath, ffprobePath } from '../server/runtime';
import { id, type Project, type GenerationJob } from '../src/core/model';
import { dataUsers } from '../src/core/data-users';
import type { Command } from '../src/core/commands';

const origin = process.env.STUDIO_URL || 'http://127.0.0.1:4173',
  output = resolve('.local/checks/data-users');
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
const f = dataUsersFixture();
f.p.name += ' ' + new Date().toISOString();
let p = (await api<{ project: Project }>('/projects/import', { project: f.p, blobs: f.blobs }))
  .project;
const original = structuredClone(p),
  frames = [0, 7.5, 12, 24, 36, 47];
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
  const visibleRevision = async () =>
    page.waitForFunction(
      (r) => document.querySelector('.save-status')?.textContent?.includes(`r${r}`),
      p.revision,
    );
  const saved = async (previous = p.revision) => {
    for (let i = 0; i < 120; i++) {
      p = (await api<{ project: Project }>(`/projects/${p.id}`)).project;
      if (p.revision > previous) {
        assert.equal(p.revision, previous + 1);
        await visibleRevision();
        return;
      }
      await page.waitForTimeout(50);
    }
    throw new Error('No saved revision');
  };
  const undo = async () => {
    await page.getByTitle('Ctrl+Z', { exact: true }).click();
    await saved();
  };
  const redo = async () => {
    await page.getByTitle('Ctrl+Shift+Z', { exact: true }).click();
    await saved();
  };
  const field = async (label: string, value: number) => {
    const input = page.getByLabel(label, { exact: true });
    await input.fill(String(value));
    await input.press('Tab');
  };
  const row = (key: string) => page.locator(`.entity-list [data-entity-id="${key}"]`);
  const panel = page.getByRole('region', { name: '共享数据管理' });
  const options = async () => {
    const details = panel.locator('.data-isolation-options');
    if (!(await details.evaluate((e) => (e as HTMLDetailsElement).open)))
      await details.locator('summary').click();
  };
  const isolate = async () => {
    await panel.getByRole('button', { name: '解除所选数据共享' }).click();
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
    await visibleRevision();
  };
  const decode = async (path: string) =>
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
  const difference = (a: Buffer, b: Buffer) => {
    assert.equal(a.length, b.length);
    return a.reduce((sum, n, i) => sum + Math.abs(n - b[i]), 0) / a.length;
  };
  const png = async (name: string, frame: number) => {
    await field('当前帧', frame);
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: '导出当前帧 PNG', exact: true }).click(),
    ]);
    const path = join(output, `${name}-${frame}.png`);
    await download.saveAs(path);
    const data = await decode(path);
    assert.equal(data.length, 480 * 270 * 3);
    return data;
  };
  await page.getByRole('button', { name: '成片预览', exact: true }).click();
  const originals = new Map<number, Buffer>();
  for (const frame of frames) originals.set(frame, await png('original', frame));
  await page.getByRole('button', { name: '三维编辑', exact: true }).click();
  await row(f.meshId).click();
  const source = panel.locator(`details[data-resource-id="${f.geometryId}"]`);
  assert.match(await source.locator('summary').innerText(), /3 个对象/);
  await source.locator('summary').click();
  await source.getByRole('button', { name: /隐藏共享用户/ }).click();
  assert.equal(await page.getByLabel('场景', { exact: true }).inputValue(), f.foreignSceneId);
  await page.getByLabel('场景', { exact: true }).selectOption(f.sceneId);
  await row(f.meshId).click();
  await source.locator('summary').click();
  await source.getByRole('button', { name: '选择本场景使用者' }).click();
  assert.match(await panel.locator('h3').innerText(), /2 个网格/);
  await options();
  assert.equal(await panel.getByLabel('数据独立方式').inputValue(), 'selection');
  assert.equal(
    await panel.locator('[data-isolation-copies]').getAttribute('data-isolation-copies'),
    '2',
  );
  await panel.getByLabel('独立材质').uncheck();
  assert.match(await panel.locator('[role="status"]').innerText(), /1 份几何、0 份材质/);
  await panel.getByLabel('独立几何').uncheck();
  assert.equal(await panel.getByRole('button', { name: '解除所选数据共享' }).isEnabled(), false);
  await panel.getByLabel('独立几何').check();
  await panel.getByLabel('独立材质').check();
  await page.screenshot({ path: join(output, 'shared-users.png') });
  await isolate();
  const grouped = structuredClone(p),
    left = () => p.entities.find((e) => e.id === f.meshId)!,
    right = () => p.entities.find((e) => e.id === f.rightId)!;
  assert.equal(left().geometryId, right().geometryId);
  assert.notEqual(left().geometryId, f.geometryId);
  assert.equal(left().materialId, right().materialId);
  assert.notEqual(left().materialId, f.materialId);
  assert.equal(dataUsers(p, 'geometry', left().geometryId!).length, 2);
  assert.equal(p.entities.find((e) => e.id === f.foreignId)!.geometryId, f.geometryId);
  assert.equal(await panel.getByRole('button', { name: '解除所选数据共享' }).isEnabled(), false);
  await undo();
  assert.deepEqual(p.entities, original.entities);
  assert.deepEqual(p.geometries, original.geometries);
  await redo();
  assert.deepEqual(p.entities, grouped.entities);
  assert.deepEqual(p.geometries, grouped.geometries);
  await row(f.rightId).click();
  await page.getByRole('button', { name: '编辑网格', exact: true }).click();
  await page.locator('.mesh-panel').getByRole('button', { name: '全选', exact: true }).click();
  assert.match(await page.locator('.mesh-selection-status').innerText(), /已选 36/);
  await options();
  await isolate();
  assert.equal(await page.locator('.mesh-panel').count(), 0);
  assert.notEqual(right().geometryId, left().geometryId);
  assert.notEqual(right().materialId, left().materialId);
  assert.deepEqual(
    p.entities.find((e) => e.id === f.foreignId),
    original.entities.find((e) => e.id === f.foreignId),
  );
  assert.deepEqual(right().skin, original.entities.find((e) => e.id === f.rightId)!.skin);
  assert.deepEqual(p.animationTracks, original.animationTracks);
  assert.deepEqual(p.assets, original.assets);
  await page.getByRole('button', { name: '成片预览', exact: true }).click();
  const isolationMeasurements: { frame: number; difference: number }[] = [];
  for (const frame of frames) {
    const d = difference(originals.get(frame)!, await png('isolated', frame));
    assert.equal(d, 0);
    isolationMeasurements.push({ frame, difference: d });
  }
  await page.getByRole('button', { name: '三维编辑', exact: true }).click();
  await row(f.rightId).click();
  await field('顶点位置 X', -0.85);
  await saved();
  await page.getByLabel('基础色', { exact: true }).fill('#55b8cf');
  await saved();
  assert.deepEqual(
    p.geometries.find((g) => g.id === f.geometryId),
    original.geometries.find((g) => g.id === f.geometryId),
  );
  assert.deepEqual(
    p.geometries.find((g) => g.id === left().geometryId),
    grouped.geometries.find((g) => g.id === left().geometryId),
  );
  assert.deepEqual(
    p.materials.find((m) => m.id === left().materialId),
    grouped.materials.find((m) => m.id === left().materialId),
  );
  assert.deepEqual(
    p.materials.find((m) => m.id === f.materialId),
    original.materials.find((m) => m.id === f.materialId),
  );
  assert.equal(
    p.materials.find((m) => m.id === right().materialId)!.textures!.baseColor!.assetId,
    f.assetId,
  );
  const editedProject = structuredClone(p);
  await page.reload({ waitUntil: 'networkidle' });
  await page.getByLabel('切换项目').selectOption(p.id);
  p = (await api<{ project: Project }>(`/projects/${p.id}`)).project;
  assert.deepEqual(p.entities, editedProject.entities);
  assert.deepEqual(p.geometries, editedProject.geometries);
  await row(f.rightId).click();
  await page.screenshot({ path: join(output, 'independent-sculptures.png') });
  await page.getByRole('button', { name: '成片预览', exact: true }).click();
  const edited = new Map<number, Buffer>();
  for (const frame of frames) edited.set(frame, await png('edited', frame));
  assert.ok(difference(originals.get(12)!, edited.get(12)!) > 0.1);
  await page.getByRole('button', { name: 'glTF', exact: true }).click();
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: '导出动画 GLB', exact: true }).click(),
  ]);
  const glbPath = join(output, 'independent-sculptures.glb');
  await download.saveAs(glbPath);
  const validator = await validateBytes(new Uint8Array(await readFile(glbPath)));
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
  const mp4Path = join(output, 'independent-sculptures.mp4');
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
  assert.equal(probe.streams[0].nb_frames, '48');
  assert.equal(probe.streams[0].width, 480);
  assert.equal(probe.streams[0].codec_name, 'h264');
  const videoMeasurements: { frame: number; difference: number }[] = [];
  for (const frame of [0, 12, 24, 36, 47]) {
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
    const d = difference(edited.get(frame)!, pixels);
    assert.ok(d < 4);
    videoMeasurements.push({ frame, difference: d });
  }
  p = (await api<{ project: Project }>(`/projects/${p.id}`)).project;
  await page.getByRole('button', { name: '刷新', exact: true }).click();
  await visibleRevision();
  const bundle = await api<{ project: Project; blobs: unknown[] }>(`/projects/${p.id}/export`),
    restored = await api<{ project: Project }>('/projects/import', bundle);
  assert.deepEqual(restored.project.entities, p.entities);
  assert.deepEqual(restored.project.geometries, p.geometries);
  assert.deepEqual(restored.project.materials, p.materials);
  assert.deepEqual(restored.project.animationTracks, p.animationTracks);
  await writeFile(join(output, 'independent-sculptures.ffstudio'), JSON.stringify(bundle, null, 2));
  // Native project artifact retains its editable rigs; import GLB into this runtime project separately.
  await page.getByRole('button', { name: 'glTF', exact: true }).click();
  await page.getByLabel('选择 glTF 文件', { exact: true }).setInputFiles(glbPath);
  const oldScenes = new Set(p.scenes.map((s) => s.id));
  await page.getByRole('button', { name: '导入这些场景', exact: true }).click();
  await saved();
  const scene = p.scenes.find((s) => !oldScenes.has(s.id))!,
    camera = p.entities.find((e) => e.sceneId === scene.id && e.kind === 'camera')!;
  assert.equal(p.entities.filter((e) => e.sceneId === scene.id && e.skin).length, 2);
  await change(
    [
      {
        type: 'scene.update',
        id: scene.id,
        patch: { background: original.scenes[0].background, ambient: original.scenes[0].ambient },
      },
      {
        type: 'shot.update',
        id: p.timeline.clips[0].sourceId,
        patch: {
          sceneId: scene.id,
          cameraId: camera.id,
          action: { actionId: p.animationActions?.find((a) => a.sceneId === scene.id)?.id ?? null },
        },
      },
    ],
    '预览重导入独立造型',
  );
  await page.getByRole('button', { name: '成片预览', exact: true }).click();
  const importedMeasurements: { frame: number; difference: number }[] = [];
  for (const frame of frames) {
    const d = difference(edited.get(frame)!, await png('imported', frame));
    assert.ok(d < 0.15, String(d));
    importedMeasurements.push({ frame, difference: d });
  }
  assert.deepEqual(errors, []);
  const report = {
    checkedAt: new Date().toISOString(),
    browser: browser.version(),
    projectId: p.id,
    restoredProjectId: restored.project.id,
    jobId: job.id,
    revision: p.revision,
    isolationMeasurements,
    importedMeasurements,
    videoMeasurements,
    validator: validator.issues,
    video: probe.streams[0],
    pageErrors: errors,
    checks: [
      'hidden cross-scene users and navigation',
      'select all local users and independent resource choices',
      'grouped isolation preserves internal sharing and single revision undo/redo',
      'individual isolation clears previous geometry components',
      'UV, weights, skin binding, image assets and animation retained',
      'six before/after isolation PNGs are identical',
      'independent UI vertex and material edits leave both previous data groups unchanged',
      'reload and native project package retain editable rigs and all image bytes',
      'animated GLB validates and reimports two skins',
      'real H264 matches edited scenes',
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
