import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { chromium } from 'playwright-core';
import { validateBytes } from 'gltf-validator';
import { hierarchyCopyFixture } from './hierarchy-copy-fixture';
import { browserPath, ffmpegPath, ffprobePath } from '../server/runtime';
import { id, type Project, type GenerationJob } from '../src/core/model';
import { sceneEvaluator } from '../src/core/constraints';
import { deformGeometry } from '../src/core/skin';
import type { Command } from '../src/core/commands';

const origin = process.env.STUDIO_URL || 'http://127.0.0.1:4173',
  output = resolve('.local/checks/hierarchy-copy');
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
const f = hierarchyCopyFixture();
f.p.name += ' ' + new Date().toISOString();
let p = (await api<{ project: Project }>('/projects/import', { project: f.p, blobs: [] })).project;
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
  const dialog = page.getByRole('dialog', { name: '复制对象层级', exact: true });
  const openCopy = async () => {
    await page.getByRole('button', { name: '复制所选层级', exact: true }).click();
    await dialog.waitFor();
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
  await field('当前帧', 12);
  await row(f.elbowId).click();
  await openCopy();
  await dialog.getByRole('alert').filter({ hasText: '部分 IK' }).waitFor();
  assert.ok(await dialog.getByRole('button', { name: '创建层级副本' }).isDisabled());
  await dialog.getByLabel('复制外部依赖').selectOption('include');
  assert.ok(await dialog.getByRole('button', { name: '创建层级副本' }).isEnabled());
  const expandedCount = Number(
    await dialog.locator('[data-copy-count]').getAttribute('data-copy-count'),
  );
  await dialog.getByRole('button', { name: '创建层级副本' }).click();
  await saved();
  assert.equal(p.entities.length, original.entities.length + expandedCount);
  assert.equal(p.ikChains!.length, 2);
  const expandedIds = p.entities
    .filter((e) => !original.entities.some((old) => old.id === e.id))
    .map((e) => e.id);
  assert.ok(p.ikChains![1].joints.every((key) => expandedIds.includes(key)));
  assert.ok(expandedIds.includes(p.ikChains![1].targetId));
  await undo();
  assert.deepEqual(p.entities, original.entities);
  await redo();
  assert.ok(expandedIds.every((key) => p.entities.some((e) => e.id === key)));
  await undo();
  await row(f.root).click();
  await openCopy();
  await dialog.getByLabel('复制外部依赖').selectOption('reject');
  await dialog.getByRole('alert').filter({ hasText: '外部' }).waitFor();
  assert.ok(await dialog.getByRole('button', { name: '创建层级副本' }).isDisabled());
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  await row(f.assemblyId).click();
  await row(f.meshId).click({ modifiers: ['Shift'] });
  await openCopy();
  const copyCount = Number(
    await dialog.locator('[data-copy-count]').getAttribute('data-copy-count'),
  );
  await page.screenshot({ path: join(output, 'copy-preview.png') });
  const cancelledRevision = p.revision;
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'hidden' });
  assert.equal(
    (await api<{ project: Project }>(`/projects/${p.id}`)).project.revision,
    cancelledRevision,
  );
  await openCopy();
  await dialog.getByRole('button', { name: '创建层级副本' }).click();
  await saved();
  const copies = p.entities.filter((e) => !original.entities.some((old) => old.id === e.id));
  assert.equal(copies.length, copyCount);
  const map = new Map(
    original.entities.flatMap((e) => {
      const copy = copies.find((c) => c.name === e.name + ' 副本');
      return copy ? [[e.id, copy.id] as const] : [];
    }),
  );
  const rootId = map.get(f.assemblyId)!,
    meshId = map.get(f.meshId)!,
    targetId = map.get(f.targetId)!;
  assert.equal(await row(rootId).getAttribute('aria-pressed'), 'true');
  assert.equal(await page.locator('.entity-list button[aria-pressed="true"]').count(), 1);
  assert.deepEqual(p.animationActions, original.animationActions);
  for (const frame of frames) {
    const before = sceneEvaluator(original, f.sceneId)(frame),
      after = sceneEvaluator(p, f.sceneId)(frame);
    for (const [from, to] of map)
      before.world
        .get(from)!
        .elements.forEach((n, i) =>
          assert.ok(Math.abs(n - after.world.get(to)!.elements[i]) < 1e-7),
        );
    const source = original.entities.find((e) => e.id === f.meshId)!,
      copy = p.entities.find((e) => e.id === meshId)!;
    const a = deformGeometry(
      original.geometries.find((g) => g.id === source.geometryId)!,
      source.skin!,
      before.world,
    );
    const b = deformGeometry(
      p.geometries.find((g) => g.id === copy.geometryId)!,
      copy.skin!,
      after.world,
    );
    a.positions.forEach((v, i) =>
      v.forEach((n, axis) => assert.ok(Math.abs(n - b.positions[i][axis]) < 1e-7)),
    );
  }
  // Display only the copied assembly to compare against the original rendered motion.
  await change(
    [{ type: 'entities.visibility', entityIds: [f.assemblyId], visible: false }],
    '比较原地副本',
  );
  await page.getByRole('button', { name: '成片预览', exact: true }).click();
  const copyMeasurements: { frame: number; difference: number }[] = [];
  for (const frame of frames) {
    const d = difference(originals.get(frame)!, await png('copied', frame));
    assert.ok(d < 0.01, String(d));
    copyMeasurements.push({ frame, difference: d });
  }
  await undo();
  await page.getByRole('button', { name: '三维编辑', exact: true }).click();
  await field('当前帧', 12);
  await row(rootId).click();
  await field('位置 X', 2.5);
  await saved();
  await row(targetId).click();
  await field('位置 X', 0.7);
  await saved();
  assert.deepEqual(
    p.animationTracks.filter((t) => original.entities.some((e) => e.id === t.entityId)),
    original.animationTracks,
  );
  await row(meshId).click();
  await page.getByLabel('基础色', { exact: true }).fill('#57b8d7');
  await saved();
  const originalMaterial = original.entities.find((e) => e.id === f.meshId)!.materialId!;
  assert.deepEqual(
    p.materials.find((m) => m.id === originalMaterial),
    original.materials.find((m) => m.id === originalMaterial),
  );
  // Linked geometry/material selection really uses source IDs, then undo it as one unit.
  await row(f.wristId).click();
  await openCopy();
  await dialog.getByLabel('复制几何数据').selectOption('linked');
  await dialog.getByLabel('复制材质数据').selectOption('linked');
  const priorIds = new Set(p.entities.map((e) => e.id));
  await dialog.getByRole('button', { name: '创建层级副本' }).click();
  await saved();
  const linked = p.entities.find((e) => !priorIds.has(e.id))!,
    source = original.entities.find((e) => e.id === f.wristId)!;
  assert.equal(linked.geometryId, source.geometryId);
  assert.equal(linked.materialId, source.materialId);
  await undo();
  const editedProject = structuredClone(p);
  await page.reload({ waitUntil: 'networkidle' });
  await page.getByLabel('切换项目').selectOption(p.id);
  p = (await api<{ project: Project }>(`/projects/${p.id}`)).project;
  assert.deepEqual(p.entities, editedProject.entities);
  assert.deepEqual(p.ikChains, editedProject.ikChains);
  await row(rootId).click();
  await page.screenshot({ path: join(output, 'copied-assembly.png') });
  await page.getByRole('button', { name: '成片预览', exact: true }).click();
  const edited = new Map<number, Buffer>();
  for (const frame of frames) edited.set(frame, await png('edited', frame));
  assert.ok(difference(originals.get(12)!, edited.get(12)!) > 0.1);
  await page.getByRole('button', { name: 'glTF', exact: true }).click();
  await field('烘焙终点', 48);
  await field('烘焙步长', 0.25);
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: '烘焙动画 GLB', exact: true }).click(),
  ]);
  const glbPath = join(output, 'copied-assembly.glb');
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
  const mp4Path = join(output, 'copied-assembly.mp4');
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
  await page.getByRole('button', { name: 'glTF', exact: true }).click();
  await page.getByLabel('选择 glTF 文件', { exact: true }).setInputFiles(glbPath);
  const oldScenes = new Set(p.scenes.map((s) => s.id));
  await page.getByRole('button', { name: '导入这些场景', exact: true }).click();
  await saved();
  const scene = p.scenes.find((s) => !oldScenes.has(s.id))!,
    camera = p.entities.find((e) => e.sceneId === scene.id && e.kind === 'camera')!;
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
        patch: { sceneId: scene.id, cameraId: camera.id },
      },
    ],
    '预览重导入装配副本',
  );
  await page.getByRole('button', { name: '成片预览', exact: true }).click();
  const importedMeasurements: { frame: number; difference: number }[] = [];
  for (const frame of frames) {
    const d = difference(edited.get(frame)!, await png('imported', frame));
    assert.ok(d < 0.15, String(d));
    importedMeasurements.push({ frame, difference: d });
  }
  const bundle = await api<{ project: Project; blobs: unknown[] }>(`/projects/${p.id}/export`),
    restored = await api<{ project: Project }>('/projects/import', bundle);
  assert.deepEqual(restored.project.entities, p.entities);
  assert.deepEqual(restored.project.animationTracks, p.animationTracks);
  assert.deepEqual(restored.project.ikChains, p.ikChains);
  assert.deepEqual(restored.project.ikTracks, p.ikTracks);
  assert.deepEqual(restored.project.animationLayers, p.animationLayers);
  await writeFile(join(output, 'copied-assembly.ffstudio'), JSON.stringify(bundle, null, 2));
  assert.deepEqual(errors, []);
  const report = {
    checkedAt: new Date().toISOString(),
    browser: browser.version(),
    projectId: p.id,
    restoredProjectId: restored.project.id,
    jobId: job.id,
    revision: p.revision,
    copiedObjects: copyCount,
    expandedObjects: expandedCount,
    copyMeasurements,
    importedMeasurements,
    videoMeasurements,
    validator: validator.issues,
    video: probe.streams[0],
    pageErrors: errors,
    checks: [
      'partial IK rejection and dependency-inclusive copy',
      'overlapping ancestor/child selection copies one subtree union',
      'preview cancellation, external reference rejection and single revision undo/redo',
      'copied worlds and weighted skin match across six sample times',
      'only copied assembly renders identically to original at six times',
      'independent copied root, animated controller and material edits leave originals unchanged',
      'linked data uses original geometry/material IDs',
      'reload and project recovery retain both independent rigs and control tracks',
      'baked animated GLB validates and reimports',
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
