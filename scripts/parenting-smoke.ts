import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { PerspectiveCamera, Vector3 } from 'three';
import { chromium } from 'playwright-core';
import { validateBytes } from 'gltf-validator';
import { parentingFixture } from './parenting-fixture';
import { browserPath, ffmpegPath, ffprobePath } from '../server/runtime';
import { id, type Project, type GenerationJob } from '../src/core/model';
import { sceneEvaluator } from '../src/core/constraints';

const origin = process.env.STUDIO_URL || 'http://127.0.0.1:4173';
const output = resolve('.local/checks/parenting');
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
const f = parentingFixture();
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
  const field = async (label: string, n: number) => {
    const input = page.getByLabel(label, { exact: true });
    await input.fill(String(n));
    await input.press('Tab');
  };
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
  const select = async (entityId: string) => {
    await page
      .locator('.entity-list')
      .getByRole('button', { name: p.entities.find((e) => e.id === entityId)!.name, exact: false })
      .click();
  };
  const parent = async (entityId: string, parentId: string | null) => {
    await select(entityId);
    await page.getByLabel('父对象', { exact: true }).selectOption(parentId || '');
    await saved();
  };
  const pose = (project: Project, frame: number) => sceneEvaluator(project, f.sceneId)(frame).world;
  const samePose = (frame: number) => {
    const before = pose(original, frame),
      after = pose(p, frame);
    for (const [key, m] of before)
      m.elements.forEach((v, i) => assert.ok(Math.abs(v - after.get(key)!.elements[i]) < 1e-7));
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
  const images = new Map<number, Buffer>();
  for (const frame of frames) images.set(frame, await png('original', frame));
  assert.ok(difference(images.get(0)!, images.get(24)!) > 0.1);
  await page.getByRole('button', { name: '三维编辑', exact: true }).click();
  await field('当前帧', 12);
  for (const key of f.selected) {
    await parent(key, f.newParent);
    samePose(12);
  }
  assert.deepEqual(p.animationTracks, original.animationTracks);
  assert.deepEqual(
    p.entities.find((e) => e.id === f.meshId)!.skin,
    original.entities.find((e) => e.id === f.meshId)!.skin,
  );
  const attached = structuredClone(p);
  await undo();
  await page.getByTitle('Ctrl+Shift+Z', { exact: true }).click();
  await saved();
  assert.deepEqual(p.entities, attached.entities);
  await page.reload({ waitUntil: 'networkidle' });
  await page.getByLabel('切换项目').selectOption(p.id);
  await page.getByRole('button', { name: '三维编辑', exact: true }).click();
  await field('当前帧', 12);
  await select(f.cubeId);
  assert.equal(await page.getByLabel('父对象', { exact: true }).inputValue(), f.newParent);
  assert.ok(await page.getByLabel('启用层级补偿').isChecked());
  // Actual world-axis pointer editing must invert the affine attachment basis.
  const view = page.getByLabel('三维编辑视图', { exact: true }),
    camera = new PerspectiveCamera(45, 1, 0.1, 2000);
  camera.position.set(8, 6, 10);
  camera.lookAt(0, 1, 0);
  camera.updateMatrixWorld(true);
  const screen = async (v: Vector3) => {
    const r = (await view.boundingBox())!;
    camera.aspect = r.width / r.height;
    camera.updateProjectionMatrix();
    const q = v.clone().project(camera);
    return { x: r.x + ((q.x + 1) * r.width) / 2, y: r.y + ((1 - q.y) * r.height) / 2 };
  };
  const center = new Vector3().setFromMatrixPosition(pose(p, 12).get(f.cubeId)!);
  const factor = (center.distanceTo(camera.position) * 1.9 * Math.tan(Math.PI / 8)) / 4;
  const from = await screen(center.clone().add(new Vector3(factor * 0.5, 0, 0))),
    to = await screen(center.clone().add(new Vector3(factor * 0.5 + 0.4, 0, 0)));
  const drag = async (cancel: boolean) => {
    await page.mouse.move(from.x, from.y);
    await page.waitForTimeout(100);
    await page.mouse.down();
    await page.mouse.move(to.x, to.y, { steps: 8 });
    if (cancel) await page.keyboard.press('Escape');
    await page.mouse.up();
  };
  await drag(true);
  assert.equal((await api<{ project: Project }>(`/projects/${p.id}`)).project.revision, p.revision);
  await drag(false);
  await saved();
  const delta = new Vector3().setFromMatrixPosition(pose(p, 12).get(f.cubeId)!).sub(center);
  assert.ok(delta.x > 0.2);
  assert.ok(Math.abs(delta.y) < 1e-6 && Math.abs(delta.z) < 1e-6);
  assert.deepEqual(p.entities, attached.entities);
  const changedTrack = p.animationTracks.find((t) => t.entityId === f.cubeId)!;
  assert.ok(changedTrack.keys.some((k) => k.frame === 12));
  assert.equal(p.animationTracks.length, original.animationTracks.length);
  await undo();
  samePose(12);
  await page.getByLabel('重设父级保持世界姿态').uncheck();
  await parent(f.cubeId, null);
  assert.deepEqual(
    p.entities.find((e) => e.id === f.cubeId)!.parentOffset,
    attached.entities.find((e) => e.id === f.cubeId)!.parentOffset,
  );
  assert.ok(
    new Vector3().setFromMatrixPosition(pose(p, 12).get(f.cubeId)!).distanceTo(center) > 0.1,
  );
  await undo();
  await page.getByLabel('重设父级保持世界姿态').check();
  await page.getByLabel('启用层级补偿').click();
  await saved();
  assert.ok(
    new Vector3().setFromMatrixPosition(pose(p, 12).get(f.cubeId)!).distanceTo(center) > 0.1,
  );
  await undo();
  await assert.rejects(
    api(`/projects/${p.id}/commands`, {
      baseRevision: p.revision,
      label: 'Reject cycle',
      commands: [
        {
          type: 'entity.reparent',
          entityIds: [f.newParent],
          parentId: f.cubeId,
          frame: 12,
          keepWorld: true,
        },
      ],
    }),
    /循环|cycle|环/,
  );
  assert.equal((await api<{ project: Project }>(`/projects/${p.id}`)).project.revision, p.revision);
  await page.getByRole('button', { name: '成片预览', exact: true }).click();
  const measurements: { frame: number; difference: number }[] = [];
  for (const frame of frames) {
    samePose(frame);
    const d = difference(images.get(frame)!, await png('attached', frame));
    assert.ok(d < 0.01, String(d));
    measurements.push({ frame, difference: d });
  }
  const bundle = await api<{ project: Project; blobs: unknown[] }>(`/projects/${p.id}/export`);
  const restored = await api<{ project: Project }>('/projects/import', bundle);
  assert.deepEqual(restored.project.entities, p.entities);
  assert.deepEqual(restored.project.animationTracks, original.animationTracks);
  await writeFile(join(output, 'parented-animation.ffstudio'), JSON.stringify(bundle, null, 2));
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
  const mp4Path = join(output, 'parented-animation.mp4');
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
    const d = difference(images.get(frame)!, pixels);
    assert.ok(d < 4, String(d));
    videoMeasurements.push({ frame, difference: d });
  }
  p = (await api<{ project: Project }>(`/projects/${p.id}`)).project;
  await page.getByRole('button', { name: '刷新', exact: true }).click();
  await visibleRevision();
  await page.getByRole('button', { name: 'glTF', exact: true }).click();
  await page.getByRole('button', { name: '导出动画 GLB', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: '层级补偿' }).waitFor();
  await page.getByRole('button', { name: '导出当前帧 GLB', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: '剪切' }).waitFor();
  await page.getByRole('button', { name: '分析烘焙', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: '剪切' }).waitFor();
  await page.getByRole('button', { name: '关闭', exact: true }).click();
  await page.getByRole('button', { name: '三维编辑', exact: true }).click();
  await field('当前帧', 12);
  for (const key of f.selected) await parent(key, f.oldParent);
  samePose(12);
  await page.getByRole('button', { name: 'glTF', exact: true }).click();
  await field('烘焙终点', 48);
  await field('烘焙步长', 0.25);
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: '烘焙动画 GLB', exact: true }).click(),
  ]);
  const glbPath = join(output, 'parented-animation.glb');
  await download.saveAs(glbPath);
  const validator = await validateBytes(new Uint8Array(await readFile(glbPath)));
  assert.equal(validator.issues.numErrors, 0);
  assert.equal(validator.issues.numWarnings, 0);
  await page.getByLabel('烘焙动作名称').fill('层级整理后的动作');
  await page.getByLabel('启用烘焙动作').check();
  await page.getByRole('button', { name: '保存为新动作', exact: true }).click();
  await saved();
  assert.ok(
    f.selected.every((key) => !p.entities.find((e) => e.id === key)!.parentOffset!.enabled),
  );
  samePose(12);
  assert.deepEqual(
    p.animationTracks.slice(0, original.animationTracks.length),
    original.animationTracks,
  );
  const oldScenes = new Set(p.scenes.map((s) => s.id));
  await page.getByLabel('选择 glTF 文件', { exact: true }).setInputFiles(glbPath);
  await page.getByRole('button', { name: '导入这些场景', exact: true }).click();
  await saved();
  const importedScene = p.scenes.find((s) => !oldScenes.has(s.id))!,
    importedCamera = p.entities.find((e) => e.sceneId === importedScene.id && e.kind === 'camera')!;
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
          id: p.timeline.clips[0].sourceId,
          patch: { sceneId: importedScene.id, cameraId: importedCamera.id },
        },
      ],
    })
  ).project;
  await page.getByRole('button', { name: '刷新', exact: true }).click();
  await visibleRevision();
  await page.getByRole('button', { name: '成片预览', exact: true }).click();
  const importedMeasurements: { frame: number; difference: number }[] = [];
  for (const frame of frames) {
    const d = difference(images.get(frame)!, await png('imported', frame));
    assert.ok(d < 0.1, String(d));
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
    measurements,
    importedMeasurements,
    videoMeasurements,
    gizmoWorldDelta: delta.toArray(),
    validator: validator.issues,
    video: probe.streams[0],
    pageErrors: errors,
    checks: [
      'UI keep-world reparent of ordinary and skinned nodes with nonuniform parents',
      'original channels and skin unchanged',
      'undo redo reload and project export import',
      'actual gizmo Escape and world translation authored as one position key',
      'local mode and offset disable retain recoverable matrix',
      'cycle rejection leaves revision unchanged',
      'affine PNG and actual H264 retain appearance',
      'raw animated and sheared static/baked GLB reject explicitly',
      'bake after TRS-compatible reparent disables retained offsets',
      'independent GLB validation and UI reimport match source images',
    ],
  };
  await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} catch (e) {
  await page.screenshot({ path: join(output, 'failure.png'), fullPage: true });
  await writeFile(join(output, 'failure.txt'), await page.locator('body').innerText());
  console.error(await page.locator('.error-banner, .viewport-error').allTextContents());
  throw e;
} finally {
  await browser.close();
}
