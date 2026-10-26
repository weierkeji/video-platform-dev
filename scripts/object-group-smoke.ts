import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { Matrix4, PerspectiveCamera, Vector3 } from 'three';
import { chromium } from 'playwright-core';
import { validateBytes } from 'gltf-validator';
import { objectGroupFixture } from './object-group-fixture';
import { browserPath, ffmpegPath, ffprobePath } from '../server/runtime';
import { id, type Project, type GenerationJob } from '../src/core/model';
import { sceneEvaluator, transformMatrix } from '../src/core/constraints';

const origin = process.env.STUDIO_URL || 'http://127.0.0.1:4173',
  output = resolve('.local/checks/object-group');
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
const f = objectGroupFixture();
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
  const field = async (label: string, n: number) => {
    const input = page.getByLabel(label, { exact: true });
    await input.fill(String(n));
    await input.press('Tab');
  };
  const row = (key: string) => page.locator(`.entity-list [data-entity-id="${key}"]`);
  const select = async (ids: string[]) => {
    await row(ids[0]).click();
    for (const key of ids.slice(1)) await row(key).click({ modifiers: ['Shift'] });
    await page.locator(`[data-object-selection-count="${ids.length}"]`).waitFor();
  };
  const world = (project = p, frame = 12) => sceneEvaluator(project, f.sceneId)(frame).world;
  const near = (a: number[], b: number[]) =>
    a.forEach((v, i) => assert.ok(Math.abs(v - b[i]) < 1e-6, `${v} != ${b[i]}`));
  const decode = async (path: string) =>
    Buffer.from(
      await page.evaluate(
        async (bytes) => {
          const bitmap = await createImageBitmap(
              new Blob([new Uint8Array(bytes)], { type: 'image/png' }),
            ),
            canvas = new OffscreenCanvas(bitmap.width, bitmap.height),
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
    const [d] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: '导出当前帧 PNG', exact: true }).click(),
    ]);
    const path = join(output, `${name}-${frame}.png`);
    await d.saveAs(path);
    const data = await decode(path);
    assert.equal(data.length, 480 * 270 * 3);
    return data;
  };
  await page.getByRole('button', { name: '成片预览', exact: true }).click();
  const originals = new Map<number, Buffer>();
  for (const frame of frames) originals.set(frame, await png('original', frame));
  await page.getByRole('button', { name: '三维编辑', exact: true }).click();
  await field('当前帧', 12);
  await select(f.ids);
  assert.equal(await page.getByLabel('活动对象', { exact: true }).inputValue(), f.b);
  await page.getByLabel('活动对象', { exact: true }).selectOption(f.a);
  assert.equal(await row(f.a).getAttribute('data-active-object'), 'true');
  await row(f.a).click({ modifiers: ['Shift'] });
  await page.locator('[data-object-selection-count="2"]').waitFor();
  await row(f.a).click({ modifiers: ['Shift'] });
  await page.locator('[data-object-selection-count="3"]').waitFor();
  // Single-object editors must stay single even when list clicks use modifiers.
  await page.getByRole('button', { name: '动画曲线', exact: true }).click();
  await row(f.b).click({ modifiers: ['Shift'] });
  assert.equal(await page.locator('.entity-list button[aria-pressed="true"]').count(), 1);
  assert.equal(await row(f.b).getAttribute('data-active-object'), 'true');
  await page.getByRole('button', { name: '制作', exact: true }).click();
  await page.getByRole('button', { name: '成片预览', exact: true }).click();
  await row(f.a).click({ modifiers: ['Shift'] });
  assert.equal(await page.locator('.entity-list button[aria-pressed="true"]').count(), 1);
  await page.getByRole('button', { name: '三维编辑', exact: true }).click();
  await select(f.ids);
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
  const centerOf = (key: string) => new Vector3().setFromMatrixPosition(world().get(key)!);
  await page.getByRole('button', { name: '清空对象选择', exact: true }).click();
  const pointA = await screen(centerOf(f.a)),
    pointB = await screen(centerOf(f.b));
  await page.mouse.click(pointA.x, pointA.y);
  assert.equal(await row(f.a).getAttribute('aria-pressed'), 'true');
  await page.keyboard.down('Shift');
  await page.mouse.click(pointB.x, pointB.y);
  await page.keyboard.up('Shift');
  await page.locator('[data-object-selection-count="2"]').waitFor();
  await row(f.child).click({ modifiers: ['Shift'] });
  // Origin box selection includes the nested child but excludes low parent origins.
  await page.getByRole('button', { name: '清空对象选择', exact: true }).click();
  await page.getByRole('button', { name: '框选原点 · B', exact: true }).click();
  const points = await Promise.all(f.ids.map((key) => screen(centerOf(key))));
  await page.mouse.move(
    Math.min(...points.map((v) => v.x)) - 6,
    Math.min(...points.map((v) => v.y)) - 6,
  );
  await page.mouse.down();
  await page.mouse.move(
    Math.max(...points.map((v) => v.x)) + 6,
    Math.max(...points.map((v) => v.y)) + 6,
    { steps: 8 },
  );
  await page.mouse.up();
  await page.locator('[data-object-selection-count="3"]').waitFor();
  for (const key of f.ids) assert.equal(await row(key).getAttribute('aria-pressed'), 'true');
  await page.getByRole('button', { name: '框选原点 · B', exact: true }).click();
  await view.focus();
  await page.keyboard.press('a');
  assert.equal(
    await page.locator('.entity-list button[aria-pressed="true"]').count(),
    p.entities.length,
  );
  await page.keyboard.press('Alt+a');
  assert.equal(await page.locator('.entity-list button[aria-pressed="true"]').count(), 0);
  await select(f.ids);
  const center = f.ids
    .reduce((sum, key) => sum.add(centerOf(key)), new Vector3())
    .multiplyScalar(1 / f.ids.length);
  const factor = (center.distanceTo(camera.position) * 1.9 * Math.tan(Math.PI / 8)) / 4;
  const from = await screen(center.clone().add(new Vector3(factor * 0.5, 0, 0))),
    to = await screen(center.clone().add(new Vector3(factor * 0.5 + 0.5, 0, 0)));
  const drag = async (cancel: boolean) => {
    await page.mouse.move(from.x, from.y);
    await page.waitForTimeout(100);
    await page.mouse.down();
    await page.mouse.move(to.x, to.y, { steps: 8 });
    await page.waitForTimeout(100);
    if (cancel) await page.keyboard.press('Escape');
    else await view.screenshot({ path: join(output, 'drag-preview.png') });
    await page.mouse.up();
  };
  await drag(true);
  assert.equal((await api<{ project: Project }>(`/projects/${p.id}`)).project.revision, p.revision);
  await view.screenshot({ path: join(output, 'before-drag.png') });
  await drag(false);
  await saved();
  await view.screenshot({ path: join(output, 'after-drag.png') });
  const beforeWorld = world(original),
    afterWorld = world(),
    delta = new Vector3()
      .setFromMatrixPosition(afterWorld.get(f.a)!)
      .sub(new Vector3().setFromMatrixPosition(beforeWorld.get(f.a)!));
  assert.ok(Math.abs(delta.x - 0.5) < 1e-5 && Math.abs(delta.y) < 1e-6 && Math.abs(delta.z) < 1e-6);
  for (const key of f.ids)
    near(
      new Matrix4().makeTranslation(delta.x, delta.y, delta.z).multiply(beforeWorld.get(key)!)
        .elements,
      afterWorld.get(key)!.elements,
    );
  assert.deepEqual(
    p.entities.find((e) => e.id === f.child),
    original.entities.find((e) => e.id === f.child),
  );
  assert.equal(p.animationTracks[0].keys.length, 4);
  assert.deepEqual(p.animationTracks[1], original.animationTracks[1]);
  const beforePixels = await decode(join(output, 'before-drag.png')),
    previewPixels = await decode(join(output, 'drag-preview.png')),
    afterPixels = await decode(join(output, 'after-drag.png'));
  const previewChange = difference(beforePixels, previewPixels),
    previewCommitDifference = difference(previewPixels, afterPixels);
  assert.ok(previewChange > 0.1);
  assert.ok(previewCommitDifference < previewChange);
  const dragged = structuredClone(p);
  await undo();
  assert.deepEqual(p.entities, original.entities);
  assert.deepEqual(p.animationTracks, original.animationTracks);
  await redo();
  assert.deepEqual(p.entities, dragged.entities);
  // A common active pivot rotates/scales the selected ancestor and child once.
  await field('成组位移 m X', 0.1);
  await page.getByLabel('活动对象', { exact: true }).selectOption(f.a);
  assert.equal(await page.getByLabel('成组位移 m X', { exact: true }).inputValue(), '0.1');
  await page.getByLabel('对象变换枢轴').selectOption('active');
  await field('成组位移 m Y', 0.2);
  await field('成组旋转 ° Z', 30);
  for (const axis of 'XYZ') await field(`成组缩放倍率 ${axis}`, 1.2);
  const previousWorld = world(),
    pivot = new Vector3().setFromMatrixPosition(previousWorld.get(f.a)!);
  await page.getByRole('button', { name: '应用成组变换', exact: true }).click();
  await saved();
  const transform = new Matrix4()
    .makeTranslation(0.1, 0.2, 0)
    .multiply(new Matrix4().makeTranslation(pivot.x, pivot.y, pivot.z))
    .multiply(
      transformMatrix({
        position: [0, 0, 0],
        rotation: [0, 0, Math.PI / 6],
        scale: [1.2, 1.2, 1.2],
      }),
    )
    .multiply(new Matrix4().makeTranslation(-pivot.x, -pivot.y, -pivot.z));
  for (const key of f.ids)
    near(transform.clone().multiply(previousWorld.get(key)!).elements, world().get(key)!.elements);
  assert.deepEqual(
    p.entities.find((e) => e.id === f.child)!.transform,
    original.entities.find((e) => e.id === f.child)!.transform,
  );
  const finalSource = structuredClone(p),
    finalWorld = world();
  await page.getByLabel('对象变换枢轴').selectOption('individual');
  await field('成组旋转 ° Y', 20);
  await page.getByRole('button', { name: '应用成组变换', exact: true }).click();
  await saved();
  for (const key of f.ids)
    near(world().get(key)!.elements.slice(12, 15), finalWorld.get(key)!.elements.slice(12, 15));
  await undo();
  await field('成组缩放倍率 X', 2);
  await page.getByRole('button', { name: '应用成组变换', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: '剪切' }).waitFor();
  assert.equal((await api<{ project: Project }>(`/projects/${p.id}`)).project.revision, p.revision);
  await page.getByRole('button', { name: '重置变换输入', exact: true }).click();
  await page.getByLabel('统一父对象').selectOption(f.destination);
  await page.getByRole('button', { name: '重设所选父级', exact: true }).click();
  await saved();
  for (const key of f.ids) {
    assert.equal(p.entities.find((e) => e.id === key)!.parentId, f.destination);
    near(world().get(key)!.elements, finalWorld.get(key)!.elements);
  }
  await undo();
  await redo();
  await undo();
  await page.getByRole('button', { name: '隐藏所选', exact: true }).click();
  await saved();
  assert.ok(f.ids.every((key) => !p.entities.find((e) => e.id === key)!.visible));
  await undo();
  await view.focus();
  await page.keyboard.press('Delete');
  await saved();
  assert.ok(f.ids.every((key) => !p.entities.some((e) => e.id === key)));
  await undo();
  assert.deepEqual(p.entities, finalSource.entities);
  assert.deepEqual(p.animationTracks, finalSource.animationTracks);
  await assert.rejects(
    api(`/projects/${p.id}/commands`, {
      baseRevision: p.revision,
      label: 'Reject invalid group',
      commands: [
        {
          type: 'entities.transform',
          entityIds: [f.a, f.a],
          activeId: f.a,
          frame: 12,
          layers: true,
          pivot: 'median',
          delta: { position: [0.5, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
        },
      ],
    }),
    /重复/,
  );
  assert.equal((await api<{ project: Project }>(`/projects/${p.id}`)).project.revision, p.revision);
  await page.reload({ waitUntil: 'networkidle' });
  await page.getByLabel('切换项目').selectOption(p.id);
  assert.equal(await page.locator('.entity-list button[aria-pressed="true"]').count(), 0);
  await select(f.ids);
  await page.screenshot({ path: join(output, 'edited-scene.png') });
  await page.getByRole('button', { name: '成片预览', exact: true }).click();
  const edited = new Map<number, Buffer>(),
    editMeasurements: { frame: number; difference: number }[] = [];
  for (const frame of frames) {
    const pixels = await png('edited', frame);
    edited.set(frame, pixels);
    const d = difference(originals.get(frame)!, pixels);
    assert.ok(d > 0.1);
    editMeasurements.push({ frame, difference: d });
  }
  await page.getByRole('button', { name: 'glTF', exact: true }).click();
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: '导出动画 GLB', exact: true }).click(),
  ]);
  const glbPath = join(output, 'grouped-motion.glb');
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
  const mp4Path = join(output, 'grouped-motion.mp4');
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
    cameraEntity = p.entities.find((e) => e.sceneId === scene.id && e.kind === 'camera')!;
  p = (
    await api<{ project: Project }>(`/projects/${p.id}/commands`, {
      baseRevision: p.revision,
      label: '预览重导入成组动作',
      commands: [
        {
          type: 'scene.update',
          id: scene.id,
          patch: { background: original.scenes[0].background, ambient: original.scenes[0].ambient },
        },
        {
          type: 'shot.update',
          id: p.timeline.clips[0].sourceId,
          patch: { sceneId: scene.id, cameraId: cameraEntity.id },
        },
      ],
    })
  ).project;
  await page.getByRole('button', { name: '刷新', exact: true }).click();
  await visibleRevision();
  await page.getByRole('button', { name: '成片预览', exact: true }).click();
  const importedMeasurements: { frame: number; difference: number }[] = [];
  for (const frame of frames) {
    const d = difference(edited.get(frame)!, await png('imported', frame));
    assert.ok(d < 0.1, String(d));
    importedMeasurements.push({ frame, difference: d });
  }
  const bundle = await api<{ project: Project; blobs: unknown[] }>(`/projects/${p.id}/export`),
    restored = await api<{ project: Project }>('/projects/import', bundle);
  assert.deepEqual(restored.project.entities, p.entities);
  assert.deepEqual(restored.project.animationTracks, p.animationTracks);
  await writeFile(join(output, 'grouped-motion.ffstudio'), JSON.stringify(bundle, null, 2));
  // Imported copies share entity IDs, but project switches must clear temporary selection.
  await page.reload({ waitUntil: 'networkidle' });
  await page.getByLabel('切换项目').selectOption(p.id);
  await page.getByLabel('场景', { exact: true }).selectOption(f.sceneId);
  await page.getByRole('button', { name: '三维编辑', exact: true }).click();
  await select(f.ids);
  await page.getByLabel('切换项目').selectOption(restored.project.id);
  await page.waitForFunction(
    () => document.querySelectorAll('.entity-list button[aria-pressed="true"]').length === 0,
  );
  assert.deepEqual(errors, []);
  const report = {
    checkedAt: new Date().toISOString(),
    browser: browser.version(),
    projectId: p.id,
    restoredProjectId: restored.project.id,
    jobId: job.id,
    revision: p.revision,
    gizmoWorldDelta: delta.toArray(),
    previewChange,
    previewCommitDifference,
    editMeasurements,
    importedMeasurements,
    videoMeasurements,
    validator: validator.issues,
    video: probe.streams[0],
    pageErrors: errors,
    checks: [
      'hierarchical list Shift toggles, active object and single-object editing contexts',
      'viewport click/Shift, origin rectangle and A/Alt-A selection',
      'real group gizmo preview, Escape and one saved revision',
      'selected ancestor/child receive exactly one world delta',
      'active and individual pivots with numeric rotation/scale',
      'shear and duplicate selections reject atomically',
      'batch keep-world reparent, visibility, delete and undo/redo',
      'reload clears temporary selection but retains every edit',
      'switching to a project copy clears selection even when entity IDs match',
      'native animated GLB reimport and complete project recovery',
      'real H264 matches edited previews',
    ],
  };
  await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} catch (e) {
  await page.screenshot({ path: join(output, 'failure.png'), fullPage: true });
  await writeFile(join(output, 'failure.txt'), await page.locator('body').innerText());
  console.error(await page.locator('.error-banner,.viewport-error').allTextContents());
  throw e;
} finally {
  await browser.close();
}
