import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chromium } from 'playwright-core';
import { Euler, Matrix3, Matrix4, PerspectiveCamera, Quaternion, Vector3 } from 'three';
import { browserPath, ffmpegPath, ffprobePath } from '../server/runtime';
import { importOBJ } from '../src/core/geometry';
import {
  id,
  PROJECT_VERSION,
  type Project,
  type GenerationJob,
  type Vec3,
} from '../src/core/model';
import { selectedVertices, vertexCenter } from '../src/core/mesh';

const origin = process.env.STUDIO_URL || 'http://127.0.0.1:4173',
  output = resolve('.local/checks/mesh');
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
    name: `网格编辑检查 ${new Date().toISOString().slice(0, 19)}`,
  })
).project;
const meshId = p.entities[0].id,
  geometryId = p.entities[0].geometryId!;
const geometry = () => p.geometries.find((g) => g.id === geometryId)!;
const camera = new PerspectiveCamera(45, 1, 0.1, 2000);
camera.position.set(8, 6, 10);
camera.lookAt(0, 1, 0);
camera.updateMatrixWorld(true);
function worldMatrix(entityId: string): Matrix4 {
  const e = p.entities.find((e) => e.id === entityId)!,
    t = e.transform;
  const m = new Matrix4().compose(
    new Vector3(...t.position),
    new Quaternion().setFromEuler(new Euler(...t.rotation, 'XYZ')),
    new Vector3(...t.scale),
  );
  return e.parentId ? worldMatrix(e.parentId).multiply(m) : m;
}
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
  await page.getByRole('button', { name: '编辑网格', exact: true }).click();
  const canvas = page.getByLabel('三维编辑视图', { exact: true });
  async function saved(previous = p.revision) {
    for (let i = 0; i < 80; i++) {
      p = (await api<{ project: Project }>(`/projects/${p.id}`)).project;
      if (p.revision > previous) {
        await page.waitForFunction(
          (r) => document.querySelector('.save-status')?.textContent?.includes(`r${r}`),
          p.revision,
        );
        await page.waitForTimeout(100);
        return;
      }
      await page.waitForTimeout(50);
    }
    throw new Error(
      'Expected mesh edit was not saved: ' + (await page.locator('body').innerText()),
    );
  }
  async function count(n: number) {
    await page.waitForFunction(
      (n) =>
        document.querySelector('.mesh-selection-status')?.textContent?.startsWith(`已选 ${n} /`),
      n,
    );
  }
  async function point(local: Vec3, isWorld = false) {
    const r = (await canvas.boundingBox())!;
    camera.aspect = r.width / r.height;
    camera.updateProjectionMatrix();
    const p3 = new Vector3(...local);
    if (!isWorld) p3.applyMatrix4(worldMatrix(meshId));
    p3.project(camera);
    return { x: r.x + ((p3.x + 1) / 2) * r.width, y: r.y + ((1 - p3.y) / 2) * r.height };
  }
  async function click(local: Vec3, shift = false) {
    const pt = await point(local);
    if (shift) await page.keyboard.down('Shift');
    await page.mouse.click(pt.x, pt.y);
    if (shift) await page.keyboard.up('Shift');
    await page.waitForTimeout(120);
  }
  async function number(label: string, value: number, persist = true) {
    await page.getByLabel(label, { exact: true }).fill(String(value));
    await page.getByLabel(label, { exact: true }).press('Enter');
    if (persist) await saved();
  }
  await page.waitForTimeout(300);
  await click(geometry().positions[6]);
  await count(1);
  assert.equal(await page.getByLabel('选中中心 X', { exact: true }).inputValue(), '1');
  await click(geometry().positions[7], true);
  await count(2);
  assert.equal(await page.getByLabel('选中中心 X', { exact: true }).inputValue(), '0');
  await page.getByRole('button', { name: '清空选择', exact: true }).click();
  await click(geometry().positions[0]);
  await count(0);
  await page.getByLabel('穿透选择').check();
  await click(geometry().positions[0]);
  await count(1);
  await page.getByLabel('穿透选择').uncheck();
  await page.getByRole('button', { name: '框选 · B', exact: true }).click();
  const corners = await Promise.all(geometry().positions.map((p) => point(p)));
  const left = Math.min(...corners.map((p) => p.x)) - 12,
    top = Math.min(...corners.map((p) => p.y)) - 12,
    right = Math.max(...corners.map((p) => p.x)) + 12,
    bottom = Math.max(...corners.map((p) => p.y)) + 12;
  async function box() {
    await page.mouse.move(left, top);
    await page.mouse.down();
    await page.mouse.move(right, bottom, { steps: 6 });
    await page.mouse.up();
  }
  await box();
  await count(7);
  await page.getByLabel('穿透选择').check();
  await box();
  await count(8);
  await page.getByRole('button', { name: '框选 · B', exact: true }).click();
  await page.getByLabel('穿透选择').uncheck();
  await page.getByRole('button', { name: '选择边模式', exact: true }).click();
  await count(18);
  await page.getByRole('button', { name: '清空选择', exact: true }).click();
  await click([1, 0, 1]);
  await count(1);
  const beforeEdge = structuredClone(geometry());
  await number('选中中心 X', 1.25);
  assert.equal(geometry().positions[5][0], 1.25);
  assert.equal(geometry().positions[6][0], 1.25);
  assert.deepEqual(geometry().positions[4], beforeEdge.positions[4]);
  await page.getByTitle('Ctrl+Z', { exact: true }).click();
  await saved();
  assert.deepEqual(geometry(), beforeEdge);
  await page.getByRole('button', { name: '选择面模式', exact: true }).click();
  await count(0);
  await click([1 / 3, -1 / 3, 1]);
  await count(1);
  await click([-1 / 3, 1 / 3, 1], true);
  await count(2);
  await number('区域挤出位移 Y', 0, false);
  await number('区域挤出位移 Z', 0.75, false);
  await page.getByRole('button', { name: '挤出选中区域', exact: true }).click();
  await saved();
  await count(2);
  assert.equal(geometry().positions.length, 12);
  assert.equal(geometry().triangles.length, 20);
  const topVertices = selectedVertices(geometry(), 'face', [2, 3]);
  topVertices.forEach((i) => assert.equal(geometry().positions[i][2], 1.75));
  // Parent affine transform exercises world/local conversion in the actual viewport gizmo.
  p = (
    await api<{ project: Project }>(`/projects/${p.id}/commands`, {
      baseRevision: p.revision,
      label: '变换父级',
      commands: [{ type: 'entity.create', sceneId: p.scenes[0].id, kind: 'group' }],
    })
  ).project;
  const parent = p.entities.at(-1)!;
  p = (
    await api<{ project: Project }>(`/projects/${p.id}/commands`, {
      baseRevision: p.revision,
      label: '带非均匀缩放的层级',
      commands: [
        {
          type: 'entity.update',
          id: parent.id,
          patch: {
            transform: { position: [0, 0, 0], rotation: [0, 0.3, 0], scale: [1.5, 0.7, 1.2] },
          },
        },
        { type: 'entity.update', id: meshId, patch: { parentId: parent.id } },
      ],
    })
  ).project;
  await page.getByRole('button', { name: '刷新', exact: true }).click();
  await page.waitForTimeout(250);
  async function dragX(cancel = false) {
    const center = new Vector3(...vertexCenter(geometry(), topVertices)).applyMatrix4(
      worldMatrix(meshId),
    );
    const factor = (center.distanceTo(camera.position) * 1.9 * Math.tan(Math.PI / 8)) / 4;
    const start = await point(
        center
          .clone()
          .add(new Vector3(factor * 0.5, 0, 0))
          .toArray(),
        true,
      ),
      end = await point(
        center
          .clone()
          .add(new Vector3(factor * 0.5 + 0.6, 0, 0))
          .toArray(),
        true,
      );
    await page.mouse.move(start.x, start.y);
    await page.waitForTimeout(100);
    await page.mouse.down();
    await page.mouse.move(end.x, end.y, { steps: 8 });
    if (cancel) await page.keyboard.press('Escape');
    await page.mouse.up();
  }
  const beforeDrag = structuredClone(geometry()),
    dragRevision = p.revision,
    matrix = worldMatrix(meshId);
  await dragX();
  await saved();
  assert.equal(p.revision, dragRevision + 1);
  const displacement = topVertices.map((i) =>
    new Vector3(...geometry().positions[i])
      .sub(new Vector3(...beforeDrag.positions[i]))
      .applyMatrix3(new Matrix3().setFromMatrix4(matrix))
      .toArray(),
  );
  displacement.forEach(([x, y, z]) =>
    assert.ok(x > 0.2 && Math.abs(y) < 1e-5 && Math.abs(z) < 1e-5, JSON.stringify(displacement)),
  );
  const afterDrag = structuredClone(geometry()),
    cancelRevision = p.revision;
  await dragX(true);
  await page.waitForTimeout(200);
  p = (await api<{ project: Project }>(`/projects/${p.id}`)).project;
  assert.equal(p.revision, cancelRevision);
  assert.deepEqual(geometry(), afterDrag);
  await page.getByTitle('Ctrl+Z', { exact: true }).click();
  await saved();
  assert.deepEqual(geometry(), beforeDrag);
  await page.getByTitle('Ctrl+Shift+Z', { exact: true }).click();
  await saved();
  assert.deepEqual(geometry(), afterDrag);
  await number('组件旋转 ° Z', 20, false);
  await number('组件缩放 X', 1.2, false);
  await page.getByRole('button', { name: '应用旋转缩放', exact: true }).click();
  await saved();
  assert.notDeepEqual(geometry().positions, afterDrag.positions);
  const edited = structuredClone(geometry());
  await page.screenshot({ path: join(output, 'mesh-editor.png') });
  // Delete all vertices via the product keyboard, then restore the geometry rather than deleting the entity.
  await page.getByRole('button', { name: '选择顶点模式', exact: true }).click();
  await page.getByRole('button', { name: '全选', exact: true }).click();
  await count(12);
  await canvas.focus();
  await page.keyboard.press('Delete');
  await saved();
  assert.deepEqual(geometry().positions, []);
  assert.ok(p.entities.some((e) => e.id === meshId));
  await page.reload({ waitUntil: 'networkidle' });
  p = (await api<{ project: Project }>(`/projects/${p.id}`)).project;
  assert.deepEqual(geometry().triangles, []);
  await page.getByTitle('Ctrl+Z', { exact: true }).click();
  await saved();
  assert.deepEqual(geometry(), edited);
  await page.locator('.entity').filter({ hasText: '立方体' }).click();
  await page.getByRole('button', { name: '编辑网格', exact: true }).click();
  await page.getByRole('button', { name: '选择面模式', exact: true }).click();
  await page.screenshot({ path: join(output, 'restored.png') });
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: '导出局部网格 OBJ', exact: true }).click(),
  ]);
  await download.saveAs(join(output, 'edited.obj'));
  const obj = importOBJ(await readFile(join(output, 'edited.obj'), 'utf8'));
  assert.deepEqual(obj.positions, geometry().positions);
  assert.deepEqual(obj.triangles, geometry().triangles);
  p = (
    await api<{ project: Project }>(`/projects/${p.id}/commands`, {
      baseRevision: p.revision,
      label: '短片导出设置',
      commands: [
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
    await new Promise((r) => setTimeout(r, 500));
    result = await api<GenerationJob>(`/jobs/${job.id}`);
  }
  assert.equal(result.status, 'succeeded', result.message);
  const file = join(output, 'mesh.mp4');
  await writeFile(
    file,
    Buffer.from(await (await fetch(`${origin}/api/jobs/${job.id}/artifact`)).arrayBuffer()),
  );
  const { stdout } = await promisify(execFile)(
    ffprobePath(),
    ['-v', 'error', '-show_streams', '-of', 'json', file],
    { windowsHide: true },
  );
  const video = JSON.parse(stdout).streams[0];
  assert.equal(video.nb_frames, '12');
  assert.equal(video.width, 480);
  await page.getByRole('button', { name: '刷新', exact: true }).click();
  await page.getByRole('button', { name: '成片预览', exact: true }).click();
  await page.waitForTimeout(300);
  const [png] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: '导出当前帧 PNG', exact: true }).click(),
  ]);
  const previewFile = join(output, 'preview.png');
  await png.saveAs(previewFile);
  const run = promisify(execFile);
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
  const preview = await decode(previewFile),
    encoded = await decode(file);
  assert.equal(preview.length, 480 * 270 * 3);
  assert.equal(preview.length, encoded.length);
  let difference = 0,
    orangePixels = 0;
  for (let i = 0; i < preview.length; i++) difference += Math.abs(preview[i] - encoded[i]);
  for (let i = 0; i < preview.length; i += 3)
    if (preview[i] > 70 && preview[i] > preview[i + 1] * 1.15 && preview[i] > preview[i + 2] * 1.5)
      orangePixels++;
  const pixelDifference = difference / preview.length;
  assert.ok(
    orangePixels > 500 && pixelDifference < 4,
    JSON.stringify({ orangePixels, pixelDifference }),
  );
  const bundle = await api<{ project: Project; blobs: unknown[] }>(`/projects/${p.id}/export`);
  await writeFile(join(output, 'mesh.ffstudio'), JSON.stringify(bundle));
  const imported = await api<{ project: Project }>('/projects/import', bundle);
  assert.deepEqual(imported.project.geometries, p.geometries);
  assert.equal(imported.project.schemaVersion, PROJECT_VERSION);
  assert.deepEqual(errors, []);
  const report = {
    checkedAt: new Date().toISOString(),
    projectId: p.id,
    importedProjectId: imported.project.id,
    jobId: job.id,
    browser: browser.version(),
    format: PROJECT_VERSION,
    visibleBoxVertices: 7,
    xrayBoxVertices: 8,
    worldDisplacement: displacement,
    vertices: geometry().positions.length,
    triangles: geometry().triangles.length,
    frames: 12,
    orangePixels,
    previewExportMeanAbsoluteDifference: pixelDifference,
    checks: [
      'vertex pick and shift toggle',
      'occlusion vs xray',
      'box selection and mode conversion',
      'edge transform and undo',
      'connected face region extrusion',
      'world gizmo with rotated nonuniform parent',
      'one drag one transaction; Escape cancels',
      'numeric rotation and scale',
      'empty mesh save/reload/undo keeps entity',
      'OBJ download',
      'MP4 render and portable project reimport',
      'OBJ retains exact geometry; actual PNG/MP4 pixels match and include the edited mesh',
    ],
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
