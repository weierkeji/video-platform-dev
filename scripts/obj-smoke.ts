import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chromium } from 'playwright-core';
import { browserPath, ffmpegPath, ffprobePath } from '../server/runtime';
import { objFixture } from './obj-fixture';
import { importOBJ, parseOBJ } from '../src/core/obj';
import { id, textureBinding, type Project, type GenerationJob } from '../src/core/model';
import type { Command } from '../src/core/commands';

const origin = process.env.STUDIO_URL || 'http://127.0.0.1:4173',
  output = resolve('.local/checks/obj');
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
const f = objFixture(),
  expected = parseOBJ(f.obj);
assert.equal(expected.geometry.positions.length, 48);
assert.equal(expected.geometry.triangles.length, 28);
let p = (await api<{ project: Project }>('/projects/import', { project: f.p, blobs: f.blobs }))
  .project;
const browser = await chromium.launch({
  executablePath: browserPath(),
  headless: true,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 1100 } }),
  errors: string[] = [];
try {
  await page.addInitScript('globalThis.__name = (fn) => fn');
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(origin, { waitUntil: 'networkidle' });
  await page.getByLabel('切换项目').selectOption(p.id);
  const visible = () =>
    page.waitForFunction(
      (r) => document.querySelector('.save-status')?.textContent?.includes(`r${r}`),
      p.revision,
    );
  const saved = async () => {
    const before = p.revision;
    for (let i = 0; i < 120; i++) {
      p = (await api<{ project: Project }>(`/projects/${p.id}`)).project;
      if (p.revision > before) {
        assert.equal(p.revision, before + 1);
        await visible();
        return;
      }
      await page.waitForTimeout(50);
    }
    throw new Error('OBJ edit not saved');
  };
  const change = async (commands: Command[]) => {
    p = (
      await api<{ project: Project }>(`/projects/${p.id}/commands`, {
        baseRevision: p.revision,
        commands,
        label: '凹面雕塑制作',
      })
    ).project;
    await page.getByRole('button', { name: '刷新', exact: true }).click();
    await visible();
  };
  const input = page.locator('input[accept=".obj"]');
  const dialog = page.getByRole('dialog', { name: '导入 OBJ 网格' });
  const upload = async (text: string, name = 'concave-sculpture.obj') =>
    input.setInputFiles({ name, mimeType: 'text/plain', buffer: Buffer.from(text) });
  await upload(f.obj);
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  await page.waitForTimeout(300);
  assert.equal((await api<{ project: Project }>(`/projects/${p.id}`)).project.revision, p.revision);
  await upload('v 0 0 0\nv 1 0 0\nv 0 1 0\nf 0 2 3', 'invalid.obj');
  await dialog.getByRole('alert').waitFor();
  assert.match(await dialog.getByRole('alert').innerText(), /第 4 行.*索引/);
  assert.equal(await dialog.getByRole('button', { name: '导入到当前场景' }).isDisabled(), true);
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  await upload(f.obj);
  const commit = dialog.getByRole('button', { name: '导入到当前场景' });
  await page.waitForFunction(
    () => !document.querySelector<HTMLButtonElement>('[role=dialog] button.primary')?.disabled,
  );
  assert.match(await dialog.innerText(), /48 个顶点 \/ 28 个三角面/);
  assert.match(await dialog.innerText(), /MTL/);
  await page.screenshot({ path: join(output, 'import-review.png') });
  await commit.click();
  await saved();
  const mesh = p.entities.find((e) => e.name === 'concave-sculpture.obj')!,
    geometryId = mesh.geometryId!;
  const geometry = () => p.geometries.find((g) => g.id === geometryId)!;
  for (const key of ['positions', 'triangles', 'uv', 'normals'] as const)
    assert.deepEqual(geometry()[key], expected.geometry[key]);
  const imported = structuredClone(geometry());
  assert.equal(p.materials.find((m) => m.id === mesh.materialId)!.flatShading, false);
  await page.getByTitle('Ctrl+Z', { exact: true }).click();
  await saved();
  assert.ok(!p.geometries.some((g) => g.id === geometryId));
  await page.getByTitle('Ctrl+Shift+Z', { exact: true }).click();
  await saved();
  assert.deepEqual(geometry(), imported);
  await page.locator('.entity').filter({ hasText: 'concave-sculpture.obj' }).click();
  await page.getByRole('button', { name: '编辑网格', exact: true }).click();
  await page.locator('.mesh-panel').getByRole('button', { name: '全选', exact: true }).click();
  const center = page.getByLabel('选中中心 X', { exact: true }),
    current = Number(await center.inputValue());
  await center.fill(String(current + 0.2));
  await center.press('Enter');
  await saved();
  assert.equal(geometry().normals, undefined);
  assert.deepEqual(geometry().uv, imported.uv);
  geometry().positions.forEach((v, i) =>
    assert.ok(Math.abs(v[0] - imported.positions[i][0] - 0.2) < 1e-8),
  );
  await page.getByTitle('Ctrl+Z', { exact: true }).click();
  await saved();
  assert.deepEqual(geometry(), imported);
  await page.getByRole('button', { name: '完成编辑', exact: true }).click();
  const [objDownload] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: '导出局部网格 OBJ' }).click(),
  ]);
  const objPath = join(output, 'concave-sculpture.obj');
  await objDownload.saveAs(objPath);
  const roundtrip = importOBJ(await readFile(objPath, 'utf8'));
  for (const key of ['positions', 'triangles', 'uv'] as const)
    assert.deepEqual(roundtrip[key], imported[key]);
  roundtrip.normals!.forEach((n, i) =>
    n.forEach((v, j) => assert.ok(Math.abs(v - imported.normals![i][j]) < 1e-10)),
  );
  await change([
    {
      type: 'material.update',
      id: mesh.materialId!,
      patch: {
        color: '#ffffff',
        roughness: 0.35,
        textures: { baseColor: textureBinding(f.assetId) },
      },
    },
    {
      type: 'key.set',
      entityId: mesh.id,
      property: 'rotation',
      key: { frame: 0, value: [0, 0, 0] },
    },
    {
      type: 'key.set',
      entityId: mesh.id,
      property: 'rotation',
      key: { frame: 23, value: [0, 0.35, 0] },
    },
  ]);
  await page.reload({ waitUntil: 'networkidle' });
  await visible();
  assert.deepEqual(geometry(), imported);
  await page.getByRole('button', { name: '成片预览', exact: true }).click();
  const pngs: string[] = [];
  for (const frame of [0, 12, 23]) {
    const field = page.getByLabel('当前帧', { exact: true });
    await field.fill(String(frame));
    await field.press('Enter');
    await page.waitForTimeout(350);
    const [png] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: '导出当前帧 PNG', exact: true }).click(),
    ]);
    const path = join(output, `frame-${frame}.png`);
    await png.saveAs(path);
    pngs.push(path);
  }
  await page.screenshot({ path: join(output, 'sculpture.png') });
  const job = await api<GenerationJob>(`/projects/${p.id}/jobs`, {
    kind: 'render',
    baseRevision: p.revision,
    requestKey: id(),
  });
  let result = job;
  const deadline = Date.now() + 180000;
  while (['queued', 'running'].includes(result.status) && Date.now() < deadline) {
    await page.waitForTimeout(300);
    result = await api<GenerationJob>(`/jobs/${job.id}`);
  }
  assert.equal(result.status, 'succeeded', result.message);
  const mp4 = join(output, 'concave-sculpture.mp4');
  await writeFile(
    mp4,
    Buffer.from(await (await fetch(origin + `/api/jobs/${job.id}/artifact`)).arrayBuffer()),
  );
  const run = promisify(execFile),
    { stdout } = await run(ffprobePath(), ['-v', 'error', '-show_streams', '-of', 'json', mp4], {
      windowsHide: true,
    });
  const video = JSON.parse(stdout).streams[0];
  assert.equal(video.nb_frames, '24');
  assert.equal(video.width, 480);
  assert.equal(video.height, 270);
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
  const differences = [];
  for (const [i, frame] of [0, 12, 23].entries()) {
    const a = await decode(pngs[i]),
      b = await decode(mp4, frame);
    assert.equal(a.length, 480 * 270 * 3);
    assert.equal(a.length, b.length);
    const mean = a.reduce((sum, v, i) => sum + Math.abs(v - b[i]), 0) / a.length;
    assert.ok(mean < 5);
    differences.push({ frame, mean });
    if (frame === 0) {
      // Frontal camera: notch around world (.5,1.6,0) must expose background;
      // left spine at (-1,1.6,0) must be textured, not a filled fan across the notch.
      const sample = (x: number, y: number) => [
        ...a.subarray((y * 480 + x) * 3, (y * 480 + x) * 3 + 3),
      ];
      const background = sample(10, 135),
        notch = sample(260, 135),
        spine = sample(200, 135);
      assert.deepEqual(notch, background);
      assert.ok(spine.some((v, i) => Math.abs(v - background[i]) > 30));
    }
  }
  p = (await api<{ project: Project }>(`/projects/${p.id}`)).project;
  const bundle = await api<{ project: Project; blobs: unknown[] }>(`/projects/${p.id}/export`);
  await writeFile(join(output, 'concave-sculpture.ffstudio'), JSON.stringify(bundle, null, 2));
  const restored = (await api<{ project: Project }>('/projects/import', bundle)).project;
  assert.deepEqual(restored.geometries, p.geometries);
  assert.deepEqual(restored.materials, p.materials);
  assert.deepEqual(restored.animationTracks, p.animationTracks);
  await writeFile(join(output, 'source-polygons.obj'), f.obj);
  assert.deepEqual(errors, []);
  const report = {
    checkedAt: new Date().toISOString(),
    browser: browser.version(),
    projectId: p.id,
    restoredProjectId: restored.id,
    jobId: job.id,
    revision: p.revision,
    sourcePolygons: 10,
    sourceVertices: 16,
    vertices: 48,
    triangles: 28,
    video,
    differences,
    pageErrors: errors,
    checks: [
      'worker cancel and invalid index reject without revisions',
      'import warnings, UV seams and explicit normals',
      'one import revision; undo and redo',
      'component move preserves UV; undo restores custom normals',
      'OBJ download and exact geometry/UV reimport',
      'reload and native package restore',
      'textured animated concave sculpture rendered to 24 H264 frames',
      'frontal notch remains empty; PNG matches actual encoded frames',
    ],
  };
  await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} catch (e) {
  await page.screenshot({ path: join(output, 'failure.png') });
  await writeFile(join(output, 'failure.txt'), await page.locator('body').innerText());
  throw e;
} finally {
  await browser.close();
}
