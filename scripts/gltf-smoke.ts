import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chromium } from 'playwright-core';
import { validateBytes } from 'gltf-validator';
import { browserPath, ffmpegPath, ffprobePath } from '../server/runtime';
import { gltfFixture } from './gltf-fixture';
import { importGLTF } from '../src/core/gltf';
import { id, PROJECT_VERSION, type Project, type GenerationJob } from '../src/core/model';

const origin = process.env.STUDIO_URL || 'http://127.0.0.1:4173',
  output = resolve('.local/checks/gltf');
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
    name: `glTF 交换检查 ${new Date().toISOString()}`,
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
  await page.getByRole('button', { name: 'glTF', exact: true }).click();
  await page
    .getByLabel('选择 glTF 文件')
    .setInputFiles({
      name: 'animated.gltf',
      mimeType: 'model/gltf+json',
      buffer: Buffer.from(JSON.stringify({ ...gltfFixture(), animations: [{}] })),
    });
  await page.getByRole('alert').filter({ hasText: '动画导入' }).waitFor();
  assert.equal((await api<{ project: Project }>(`/projects/${p.id}`)).project.revision, 0);
  // Companion-file resolution exercises real file chooser handling rather than the exporter itself.
  const fixture = gltfFixture(),
    binary = Buffer.from(fixture.buffers[0].uri.split(',')[1], 'base64');
  fixture.buffers[0].uri = 'octahedron.bin';
  await page.getByLabel('选择 glTF 文件').setInputFiles([
    {
      name: 'scene.gltf',
      mimeType: 'model/gltf+json',
      buffer: Buffer.from(JSON.stringify(fixture)),
    },
    { name: 'octahedron.bin', mimeType: 'application/octet-stream', buffer: binary },
  ]);
  await page.getByRole('button', { name: '导入这些场景', exact: true }).waitFor();
  await page.screenshot({ path: join(output, 'import-review.png') });
  await page.getByRole('button', { name: '导入这些场景', exact: true }).click();
  await saved();
  assert.equal(p.revision, 1);
  assert.equal(p.scenes.length, 3);
  const sceneId = p.scenes.find((s) => s.name === 'Exchange study')!.id;
  assert.equal(await page.getByLabel('场景', { exact: true }).inputValue(), sceneId);
  const importedGeometry = p.geometries.find((g) => g.name === 'Smooth octahedron')!;
  const originalGeometry = structuredClone(importedGeometry);
  await page.getByTitle('Ctrl+Z', { exact: true }).click();
  await saved();
  assert.equal(p.scenes.length, 1);
  await page.getByTitle('Ctrl+Shift+Z', { exact: true }).click();
  await saved();
  assert.equal(p.scenes.length, 3);
  await page.getByLabel('场景', { exact: true }).selectOption(sceneId);
  await page.locator('.entity').filter({ hasText: 'First instance' }).click();
  await page.getByLabel('不透明度', { exact: true }).fill('0.85');
  await page.getByLabel('不透明度', { exact: true }).press('Tab');
  await saved();
  await page.getByLabel('基础色', { exact: true }).fill('#42b68d');
  await saved();
  const materialId = p.entities.find(
    (e) => e.sceneId === sceneId && e.name === 'First instance',
  )!.materialId!;
  assert.equal(p.materials.find((m) => m.id === materialId)!.linearColor, undefined);
  await page.getByLabel('顶点位置 X', { exact: true }).fill('1.35');
  await page.getByLabel('顶点位置 X', { exact: true }).press('Tab');
  await saved();
  assert.equal(p.geometries.find((g) => g.id === importedGeometry.id)!.normals, undefined);
  assert.deepEqual(p.geometries.find((g) => g.id === importedGeometry.id)!.uv, originalGeometry.uv);
  await page.getByTitle('Ctrl+Z', { exact: true }).click();
  await saved();
  assert.deepEqual(
    p.geometries.find((g) => g.id === importedGeometry.id),
    originalGeometry,
  );
  await page.getByTitle('Ctrl+Shift+Z', { exact: true }).click();
  await saved();
  await page.reload({ waitUntil: 'networkidle' });
  await page.getByLabel('切换项目').selectOption(p.id);
  await page.getByLabel('场景', { exact: true }).selectOption(sceneId);
  await page.getByRole('button', { name: 'glTF', exact: true }).click();
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: '导出当前帧 GLB', exact: true }).click(),
  ]);
  const glbPath = join(output, 'scene-exchange.glb');
  await download.saveAs(glbPath);
  const glb = await readFile(glbPath),
    validation = await validateBytes(glb);
  await writeFile(join(output, 'validator.json'), JSON.stringify(validation, null, 2));
  assert.equal(validation.issues.numErrors, 0, JSON.stringify(validation.issues));
  assert.equal(validation.issues.numWarnings, 0, JSON.stringify(validation.issues));
  const roundtrip = importGLTF(glb);
  assert.equal(roundtrip.command.geometries.length, 1);
  assert.deepEqual(
    roundtrip.command.geometries[0].positions,
    p.geometries
      .find((g) => g.id === importedGeometry.id)!
      .positions.map((v) => v.map(Math.fround)),
  );
  await page.getByLabel('选择 glTF 文件').setInputFiles(glbPath);
  await page.getByRole('button', { name: '导入这些场景', exact: true }).click();
  await saved();
  assert.equal(p.scenes.length, 4);
  // The imported camera is used by the existing shot and the normal media/render pipeline.
  const cameraId = p.entities.find((e) => e.sceneId === sceneId && e.kind === 'camera')!.id;
  p = (
    await api<{ project: Project }>(`/projects/${p.id}/commands`, {
      baseRevision: p.revision,
      label: '导入场景接入镜头输出',
      commands: [
        { type: 'shot.update', id: p.shots[0].id, patch: { sceneId, cameraId } },
        { type: 'clip.update', id: p.timeline.clips[0].id, patch: { duration: 12 } },
        { type: 'timeline.update', patch: { duration: 12, width: 480, height: 270 } },
      ],
    })
  ).project;
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
  const mp4Path = join(output, 'scene-exchange.mp4');
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
  assert.equal(probe.streams[0].nb_frames, '12');
  await page.getByRole('button', { name: '刷新', exact: true }).click();
  await page.getByRole('button', { name: '成片预览', exact: true }).click();
  await page.waitForTimeout(500);
  const [png] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: '导出当前帧 PNG', exact: true }).click(),
  ]);
  const pngPath = join(output, 'preview.png');
  await png.saveAs(pngPath);
  const decode = async (path: string) =>
    (
      await run(
        ffmpegPath(),
        [
          '-v',
          'error',
          '-i',
          path,
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
  const preview = await decode(pngPath),
    encoded = await decode(mp4Path);
  assert.equal(preview.length, 480 * 270 * 3);
  assert.equal(preview.length, encoded.length);
  let greenPixels = 0,
    difference = 0;
  for (let i = 0; i < preview.length; i++) difference += Math.abs(preview[i] - encoded[i]);
  for (let i = 0; i < preview.length; i += 3)
    if (preview[i + 1] > 55 && preview[i + 1] > preview[i] * 1.3) greenPixels++;
  const pixelDifference = difference / preview.length;
  assert.ok(
    greenPixels > 300 && pixelDifference < 4,
    JSON.stringify({ greenPixels, pixelDifference }),
  );
  await page.screenshot({ path: join(output, 'product.png') });
  const bundle = await api<{ project: Project; blobs: unknown[] }>(`/projects/${p.id}/export`);
  await writeFile(join(output, 'scene-exchange.ffstudio'), JSON.stringify(bundle));
  const restored = await api<{ project: Project }>('/projects/import', bundle);
  assert.deepEqual(restored.project.geometries, bundle.project.geometries);
  assert.deepEqual(restored.project.materials, bundle.project.materials);
  assert.deepEqual(restored.project.scenes, bundle.project.scenes);
  assert.deepEqual(errors, []);
  const report = {
    checkedAt: new Date().toISOString(),
    projectId: p.id,
    importedProjectId: restored.project.id,
    jobId: job.id,
    browser: browser.version(),
    format: PROJECT_VERSION,
    validator: { version: validation.validatorVersion, issues: validation.issues },
    checks: [
      'unsupported animation rejected without saving',
      'external binary file import',
      'hierarchy and shared geometry',
      'single undo/redo import transaction',
      'material color/opacity and mesh editing',
      'normal invalidation and undo restoration',
      'reload and GLB UI download',
      'GLB reimport',
      'imported camera/scene feeds ordinary render job',
      'actual MP4/PNG visual output',
      'portable project preserves geometry/materials/source metadata',
    ],
    frames: 12,
    greenPixels,
    previewExportMeanAbsoluteDifference: pixelDifference,
    pageErrors: errors,
  };
  await writeFile(join(output, 'result.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} catch (e) {
  const page = browser.contexts()[0]?.pages()[0];
  if (page) {
    await page.screenshot({ path: join(output, 'failure.png') });
    await writeFile(join(output, 'failure.txt'), await page.locator('body').innerText());
  }
  throw e;
} finally {
  await browser.close();
}
