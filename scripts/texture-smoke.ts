import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chromium } from 'playwright-core';
import { validateBytes } from 'gltf-validator';
import { browserPath, ffmpegPath, ffprobePath } from '../server/runtime';
import { textureFixture } from './texture-fixture';
import { importGLTF } from '../src/core/gltf';
import { textureRenderCheck } from './texture-render-check';
import { id, PROJECT_VERSION, type Project, type GenerationJob } from '../src/core/model';

const origin = process.env.STUDIO_URL || 'http://127.0.0.1:4173',
  output = resolve('.local/checks/textures');
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
  await api<{ project: Project }>('/projects', { name: `PBR 贴图检查 ${new Date().toISOString()}` })
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
  const fixture = textureFixture();
  const directory = join(output, 'import');
  await mkdir(join(directory, 'images'), { recursive: true });
  await mkdir(join(directory, 'geometry'), { recursive: true });
  fixture.document.buffers[0].uri = 'geometry/panel.bin';
  fixture.document.images.forEach((i) => {
    i.uri = 'images/' + i.uri;
  });
  await writeFile(join(directory, 'textures.gltf'), JSON.stringify(fixture.document));
  for (const file of fixture.files)
    await writeFile(
      join(directory, file.name.endsWith('.png') ? 'images' : 'geometry', file.name),
      file.bytes,
    );
  await page.getByRole('button', { name: 'glTF', exact: true }).click();
  await page.getByLabel('选择 glTF 文件夹', { exact: true }).setInputFiles(directory);
  await page.getByRole('button', { name: '导入这些场景', exact: true }).click();
  await saved();
  assert.equal(p.revision, 1);
  assert.equal(p.assets.length, 2);
  const sceneId = p.scenes.find((s) => s.name === 'Texture study')!.id;
  const panel = p.entities.find((e) => e.name === 'Textured panel')!,
    materialId = panel.materialId!;
  const original = structuredClone(p.materials.find((m) => m.id === materialId)!);
  await page.getByTitle('Ctrl+Z', { exact: true }).click();
  await saved();
  assert.equal(p.assets.length, 0);
  assert.equal(p.scenes.length, 1);
  await page.getByTitle('Ctrl+Shift+Z', { exact: true }).click();
  await saved();
  assert.equal(p.assets.length, 2);
  await page.getByLabel('场景', { exact: true }).selectOption(sceneId);
  await page.locator('.entity').filter({ hasText: 'Textured panel' }).click();
  await page.getByLabel('基础色贴图 wrapS', { exact: true }).selectOption('clamp');
  await saved();
  await page.getByLabel('基础色贴图 旋转 °', { exact: true }).fill('30');
  await page.getByLabel('基础色贴图 旋转 °', { exact: true }).press('Tab');
  await saved();
  assert.ok(
    Math.abs(
      p.materials.find((m) => m.id === materialId)!.textures!.baseColor!.rotation - Math.PI / 6,
    ) < 1e-9,
  );
  await page.getByTitle('Ctrl+Z', { exact: true }).click();
  await saved();
  await page.getByTitle('Ctrl+Z', { exact: true }).click();
  await saved();
  assert.deepEqual(
    p.materials.find((m) => m.id === materialId),
    original,
  );
  // Real UV command through the inspector, then restore the original imported attributes.
  const geometry = structuredClone(p.geometries.find((g) => g.id === panel.geometryId)!);
  await page.getByRole('button', { name: '生成/覆盖 UV1', exact: true }).click();
  await saved();
  assert.equal(p.geometries.find((g) => g.id === panel.geometryId)!.tangents, undefined);
  await page.getByTitle('Ctrl+Z', { exact: true }).click();
  await saved();
  assert.deepEqual(
    p.geometries.find((g) => g.id === panel.geometryId),
    geometry,
  );
  await assert.rejects(
    () =>
      api(`/projects/${p.id}/commands`, {
        baseRevision: p.revision,
        label: '检查纹理引用保护',
        commands: [{ type: 'asset.delete', id: p.assets[0].id }],
      }),
    /纹理|贴图/,
  );
  assert.equal((await api<{ project: Project }>(`/projects/${p.id}`)).project.revision, p.revision);
  await page.reload({ waitUntil: 'networkidle' });
  await page.getByLabel('切换项目').selectOption(p.id);
  await page.getByLabel('场景', { exact: true }).selectOption(sceneId);
  await page.locator('.entity').filter({ hasText: 'Textured panel' }).click();
  assert.equal(
    await page.getByLabel('基础色贴图', { exact: true }).inputValue(),
    original.textures!.baseColor!.assetId,
  );
  await page.getByLabel('基础色贴图', { exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(output, 'materials.png') });
  await page.getByRole('button', { name: 'glTF', exact: true }).click();
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: '导出当前帧 GLB', exact: true }).click(),
  ]);
  const glbPath = join(output, 'pbr-textures.glb');
  await download.saveAs(glbPath);
  const glb = await readFile(glbPath),
    validation = await validateBytes(glb);
  await writeFile(join(output, 'validator.json'), JSON.stringify(validation, null, 2));
  assert.equal(validation.issues.numErrors, 0, JSON.stringify(validation.issues));
  assert.equal(validation.issues.numWarnings, 0, JSON.stringify(validation.issues));
  const next = await importGLTF(glb);
  assert.deepEqual(
    next.images.map((i) => i.asset.blobId),
    p.assets.map((a) => a.blobId),
  );
  await page.getByLabel('选择 glTF 文件', { exact: true }).setInputFiles(glbPath);
  await page.getByRole('button', { name: '导入这些场景', exact: true }).click();
  await saved();
  assert.equal(p.scenes.length, 3);
  assert.equal(p.assets.length, 4);
  const cameraId = p.entities.find((e) => e.sceneId === sceneId && e.kind === 'camera')!.id;
  p = (
    await api<{ project: Project }>(`/projects/${p.id}/commands`, {
      baseRevision: p.revision,
      label: '贴图场景接入镜头',
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
  const mp4Path = join(output, 'pbr-textures.mp4');
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
  assert.equal(probe.streams[0].nb_frames, '12');
  await page.getByRole('button', { name: '刷新', exact: true }).click();
  await page.getByRole('button', { name: '成片预览', exact: true }).click();
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
  const at = (x: number, y: number) =>
    Array.from(preview.subarray((y * 480 + x) * 3, (y * 480 + x) * 3 + 3));
  const pixels = {
    topLeft: at(215, 110),
    topRight: at(265, 110),
    bottomLeft: at(215, 160),
    bottomRight: at(265, 160),
    background: at(100, 100),
  };
  assert.ok(pixels.topLeft[0] > pixels.topLeft[1] * 2, JSON.stringify(pixels));
  assert.ok(pixels.topRight[2] > pixels.topRight[0] * 2, JSON.stringify(pixels));
  assert.ok(pixels.bottomLeft[1] > pixels.bottomLeft[0] * 2, JSON.stringify(pixels));
  assert.deepEqual(pixels.bottomRight, pixels.background); // Alpha MASK removes the yellow quadrant.
  const difference =
    preview.reduce((sum, v, i) => sum + Math.abs(v - encoded[i]), 0) / preview.length;
  assert.ok(difference < 4, String(difference));
  const bundle = await api<{ project: Project; blobs: unknown[] }>(`/projects/${p.id}/export`);
  await writeFile(join(output, 'pbr-textures.ffstudio'), JSON.stringify(bundle));
  const restored = await api<{ project: Project }>('/projects/import', bundle);
  assert.deepEqual(restored.project.materials, bundle.project.materials);
  assert.deepEqual(restored.project.geometries, bundle.project.geometries);
  assert.deepEqual(restored.project.assets, bundle.project.assets);
  await page.screenshot({ path: join(output, 'product.png') });
  assert.deepEqual(errors, []);
  const rendererChecks = process.argv.includes('--renderer')
    ? await textureRenderCheck(browser, origin, p, sceneId, panel.id, cameraId)
    : undefined;
  const report = {
    checkedAt: new Date().toISOString(),
    projectId: p.id,
    importedProjectId: restored.project.id,
    jobId: job.id,
    browser: browser.version(),
    format: PROJECT_VERSION,
    rendererChecks,
    validator: { version: validation.validatorVersion, issues: validation.issues },
    frames: 12,
    pixels,
    previewExportMeanAbsoluteDifference: difference,
    pageErrors: errors,
    checks: [
      'nested folder five-map image import in one undo transaction',
      'sampler and rotation UI edits with undo',
      'UV1 projection and tangent undo restoration',
      'referenced texture deletion rejected atomically',
      'reload and texture inspector',
      'GLB download with original embedded image hashes',
      'GLB reimport',
      'PNG and MP4 use imported camera with image orientation and alpha MASK',
      'portable project preserves textures, geometry and assets',
    ],
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
