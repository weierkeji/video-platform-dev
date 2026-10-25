import { restWorld } from '../src/core/rest-pose';
import { deformGeometry } from '../src/core/skin';
import { PerspectiveCamera, Vector3 } from 'three';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chromium } from 'playwright-core';
import { validateBytes } from 'gltf-validator';
import { restPoseFixture } from './rest-pose-fixture';
import { browserPath, ffmpegPath, ffprobePath } from '../server/runtime';
import { id, type Project, type GenerationJob } from '../src/core/model';
import type { Command } from '../src/core/commands';

const origin = process.env.STUDIO_URL || 'http://127.0.0.1:4173',
  output = resolve('.local/checks/rest-pose');
const media = !process.argv.includes('--no-media');
await mkdir(output, { recursive: true });
async function api<T>(path: string, body?: unknown): Promise<T> {
  const r = await fetch(origin + '/api' + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Studio-Client': 'frameforge' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const value = await r.json();
  if (!r.ok) throw new Error(JSON.stringify(value));
  return value;
}
const fixture = restPoseFixture();
fixture.p.name += ' ' + new Date().toISOString();
let p = (await api<{ project: Project }>('/projects/import', { project: fixture.p, blobs: [] }))
  .project;
const original = structuredClone(p),
  sourceScene = p.scenes[0].id;
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
  const saved = async (previous = p.revision) => {
    for (let i = 0; i < 120; i++) {
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
    throw new Error('未保存：' + (await page.locator('body').innerText()));
  };
  const commands = async (commands: Command[], label: string) => {
    p = (
      await api<{ project: Project }>(`/projects/${p.id}/commands`, {
        baseRevision: p.revision,
        commands,
        label,
      })
    ).project;
    await page.getByRole('button', { name: '刷新', exact: true }).click();
    await page.waitForFunction(
      (r) => document.querySelector('.save-status')?.textContent?.includes(`r${r}`),
      p.revision,
    );
  };
  const field = async (label: string, value: number) => {
    const input = page.getByLabel(label, { exact: true });
    await input.fill(String(value));
    await input.press('Tab');
  };
  const select = async (name: string) =>
    page.locator('.entity-list').getByRole('button', { name, exact: false }).click();
  const run = promisify(execFile);
  const decode = async (path: string, frame = 0) => {
    if (path.endsWith('.png'))
      return Buffer.from(
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
    return (
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
  };
  const difference = (a: Buffer, b: Buffer) => {
    assert.equal(a.length, 480 * 270 * 3);
    assert.equal(a.length, b.length);
    return a.reduce((s, v, i) => s + Math.abs(v - b[i]), 0) / a.length;
  };
  const png = async (prefix: string, frame: number) => {
    await field('当前帧', frame);
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: '导出当前帧 PNG', exact: true }).click(),
    ]);
    const path = join(output, `${prefix}-${frame}.png`);
    await download.saveAs(path);
    return decode(path);
  };
  const frames = [0, 6.25, 12, 24, 36.5, 47],
    references = new Map<number, Buffer>();
  await page.getByRole('button', { name: '成片预览', exact: true }).click();
  for (const frame of frames) references.set(frame, await png('source', frame));
  assert.ok(
    difference(references.get(0)!, references.get(24)!) > 0.1,
    '蒙皮动画必须产生真实画面变化',
  );
  await page.getByRole('button', { name: '三维编辑', exact: true }).click();
  await field('当前帧', 0);
  await select('Tip joint');
  await page.getByRole('button', { name: '基础姿态', exact: true }).click();
  await page.locator('canvas[data-rest-pose="true"]').waitFor();
  const undo = async () => {
    await page.getByTitle('Ctrl+Z', { exact: true }).click();
    await saved();
  };
  const shape = (project: Project) => {
    const mesh = project.entities.find((e) => e.id === fixture.meshId)!;
    return deformGeometry(
      project.geometries.find((g) => g.id === mesh.geometryId)!,
      mesh.skin!,
      restWorld(project, sourceScene),
    ).positions;
  };
  const distance = (a: number[][], b: number[][]) =>
    Math.max(...a.flatMap((v, i) => v.map((n, j) => Math.abs(n - b[i][j]))));
  const sourceShape = shape(p);
  await field('基础位置 X', 0.4);
  await saved();
  assert.ok(distance(shape(p), sourceShape) < 1e-9);
  assert.deepEqual(p.geometries, original.geometries);
  assert.deepEqual(p.animationTracks, original.animationTracks);
  await undo();
  await page.getByTitle('Ctrl+Shift+Z', { exact: true }).click();
  await saved();
  await undo();
  const view = page.locator('canvas[aria-label="三维编辑视图"]');
  const editCamera = new PerspectiveCamera(45, 1, 0.1, 2000);
  editCamera.position.set(8, 6, 10);
  editCamera.lookAt(0, 1, 0);
  editCamera.updateMatrixWorld(true);
  const screen = async (v: Vector3) => {
    const r = (await view.boundingBox())!;
    editCamera.aspect = r.width / r.height;
    editCamera.updateProjectionMatrix();
    const q = v.clone().project(editCamera);
    return { x: r.x + ((q.x + 1) * r.width) / 2, y: r.y + ((1 - q.y) * r.height) / 2 };
  };
  const drag = async (cancel = false) => {
    const center = new Vector3().setFromMatrixPosition(
      restWorld(p, sourceScene).get(fixture.joint1)!,
    );
    const factor = (center.distanceTo(editCamera.position) * 1.9 * Math.tan(Math.PI / 8)) / 4;
    const start = await screen(center.clone().add(new Vector3(factor * 0.5, 0, 0)));
    const end = await screen(center.clone().add(new Vector3(factor * 0.5 + 0.5, 0, 0)));
    await page.mouse.move(start.x, start.y);
    await page.waitForTimeout(100);
    await page.mouse.down();
    await page.mouse.move(end.x, end.y, { steps: 8 });
    if (cancel) await page.keyboard.press('Escape');
    await page.mouse.up();
  };
  const revision = p.revision;
  await drag();
  await saved();
  assert.equal(p.revision, revision + 1);
  assert.ok(distance(shape(p), sourceShape) < 1e-8);
  await undo();
  const cancelled = p.revision;
  await drag(true);
  await page.waitForTimeout(250);
  assert.equal((await api<{ project: Project }>(`/projects/${p.id}`)).project.revision, cancelled);
  await page.getByLabel('保持蒙皮基础外形', { exact: true }).click();
  await field('基础旋转 ° Z', 50);
  await saved();
  assert.ok(distance(shape(p), sourceShape) > 0.1);
  await undo();
  await page.getByLabel('保持蒙皮基础外形', { exact: true }).click();
  await page.getByRole('button', { name: '重置基础姿态偏移', exact: true }).click();
  await saved();
  assert.equal(p.entities.find((e) => e.id === fixture.joint1)!.restPose, undefined);
  assert.ok(distance(shape(p), sourceShape) < 1e-8);
  await undo();
  await field('当前帧', 24);
  await page.getByRole('button', { name: '复制当前帧局部姿态到基础', exact: true }).click();
  await saved();
  assert.ok(distance(shape(p), sourceShape) < 1e-8);
  assert.deepEqual(p.animationTracks, original.animationTracks);
  await undo();
  await field('基础缩放 X', 0);
  await page.getByRole('alert').filter({ hasText: '不可逆' }).waitFor();
  assert.equal((await api<{ project: Project }>(`/projects/${p.id}`)).project.revision, p.revision);
  await page.reload({ waitUntil: 'networkidle' });
  await page.getByLabel('切换项目').selectOption(p.id);
  await select('Tip joint');
  await field('当前帧', 24);
  assert.deepEqual(p.entities, original.entities);
  assert.deepEqual(p.animationTracks, original.animationTracks);
  await page.getByRole('button', { name: '基础姿态', exact: true }).click();
  await page.screenshot({ path: join(output, 'product.png') });
  await page.getByRole('button', { name: '基础姿态', exact: true }).click();
  await page.getByRole('button', { name: 'glTF', exact: true }).click();
  await page.getByRole('button', { name: '导出动画 GLB', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: '无法保存约束' }).waitFor();
  await field('烘焙终点', 48);
  await field('烘焙步长', 0.25);
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: '烘焙动画 GLB', exact: true }).click(),
  ]);
  const glbPath = join(output, 'rest-sculpture.glb');
  await download.saveAs(glbPath);
  const validator = await validateBytes(new Uint8Array(await readFile(glbPath)), {
    uri: 'rest-sculpture.glb',
  });
  assert.equal(validator.issues.numErrors, 0, JSON.stringify(validator.issues));
  assert.equal(validator.issues.numWarnings, 0, JSON.stringify(validator.issues));
  await page.getByLabel('烘焙动作名称', { exact: true }).fill('基础姿态动画 0–48');
  await page.getByLabel('启用烘焙动作', { exact: true }).check();
  await page.getByRole('button', { name: '保存为新动作', exact: true }).click();
  await saved();
  assert.ok(p.entities.every((e) => !e.constraints?.some((c) => c.enabled)));
  assert.ok(p.entities.every((e) => !e.restPose?.enabled));
  await page.getByRole('button', { name: '关闭', exact: true }).click();
  await page.getByTitle('Ctrl+Z', { exact: true }).click();
  await saved();
  assert.deepEqual(p.entities, original.entities);
  await page.getByRole('button', { name: 'glTF', exact: true }).click();
  const [staticDownload] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: '导出当前帧 GLB', exact: true }).click(),
  ]);
  const staticPath = join(output, 'rest-pose.glb');
  await staticDownload.saveAs(staticPath);
  const staticValidator = await validateBytes(new Uint8Array(await readFile(staticPath)), {
    uri: 'rest-pose.glb',
  });
  assert.equal(staticValidator.issues.numErrors, 0, JSON.stringify(staticValidator.issues));
  await page.getByRole('button', { name: '关闭', exact: true }).click();
  let job: GenerationJob | undefined;
  const videoMeasurements: { frame: number; difference: number }[] = [];
  if (media) {
    job = await api<GenerationJob>(`/projects/${p.id}/jobs`, {
      kind: 'render',
      baseRevision: p.revision,
      requestKey: id(),
    });
    await commands(
      [
        {
          type: 'rig.rest.update',
          preserveShape: false,
          updates: [
            {
              entityId: fixture.joint1,
              transform: { position: [0, 0, 0], rotation: [0, 0, 1], scale: [1, 1, 1] },
            },
          ],
        },
      ],
      '输出提交后修改基础姿态',
    );
    let result = job;
    const deadline = Date.now() + 120000;
    while (['queued', 'running'].includes(result.status) && Date.now() < deadline) {
      await page.waitForTimeout(500);
      result = await api<GenerationJob>(`/jobs/${job.id}`);
    }
    assert.equal(result.status, 'succeeded', result.message);
    const mp4Path = join(output, 'rest-sculpture.mp4');
    await writeFile(
      mp4Path,
      Buffer.from(await (await fetch(`${origin}/api/jobs/${job.id}/artifact`)).arrayBuffer()),
    );
    const probe = JSON.parse(
      (
        await run(ffprobePath(), ['-v', 'error', '-show_streams', '-of', 'json', mp4Path], {
          windowsHide: true,
        })
      ).stdout,
    );
    assert.equal(probe.streams[0].nb_frames, '48');
    for (const frame of frames.filter(Number.isInteger)) {
      const delta = difference(references.get(frame)!, await decode(mp4Path, frame));
      assert.ok(delta < 4, String(delta));
      videoMeasurements.push({ frame, difference: delta });
    }
    p = (await api<{ project: Project }>(`/projects/${p.id}`)).project;
    await commands(
      [
        {
          type: 'entity.update',
          id: fixture.joint1,
          patch: { restPose: original.entities.find((e) => e.id === fixture.joint1)!.restPose },
        },
      ],
      '恢复基础姿态',
    );
  }
  await page.getByRole('button', { name: 'glTF', exact: true }).click();
  await page.getByLabel('选择 glTF 文件', { exact: true }).setInputFiles(glbPath);
  const before = new Set(p.scenes.map((s) => s.id));
  await page.getByRole('button', { name: '导入这些场景', exact: true }).click();
  await saved();
  const imported = p.scenes.find((s) => !before.has(s.id))!;
  const camera = p.entities.find((e) => e.sceneId === imported.id && e.kind === 'camera')!;
  await commands(
    [
      {
        type: 'shot.update',
        id: p.shots[0].id,
        patch: { sceneId: imported.id, cameraId: camera.id },
      },
    ],
    '用重导入的蒙皮动画制作镜头',
  );
  await page.getByRole('button', { name: '成片预览', exact: true }).click();
  const measurements = [];
  for (const frame of frames) {
    const delta = difference(references.get(frame)!, await png('reimport', frame));
    assert.ok(delta < 0.08, JSON.stringify({ frame, delta }));
    measurements.push({ frame, difference: delta });
  }
  await page.getByRole('button', { name: '三维编辑', exact: true }).click();
  await page.getByRole('button', { name: 'glTF', exact: true }).click();
  const existingScenes = new Set(p.scenes.map((s) => s.id));
  await page.getByLabel('选择 glTF 文件', { exact: true }).setInputFiles(staticPath);
  await page.getByRole('button', { name: '导入这些场景', exact: true }).click();
  await saved();
  const staticScene = p.scenes.find((s) => !existingScenes.has(s.id))!;
  const staticCamera = p.entities.find((e) => e.sceneId === staticScene.id && e.kind === 'camera')!;
  await commands(
    [
      {
        type: 'shot.update',
        id: p.shots[0].id,
        patch: { sceneId: staticScene.id, cameraId: staticCamera.id },
      },
    ],
    '检查静态蒙皮姿态',
  );
  await page.getByRole('button', { name: '成片预览', exact: true }).click();
  const staticDifference = difference(references.get(24)!, await png('static', 0));
  assert.ok(staticDifference < 0.02, String(staticDifference));
  await commands(
    [
      {
        type: 'shot.update',
        id: p.shots[0].id,
        patch: { sceneId: imported.id, cameraId: camera.id },
      },
    ],
    '恢复动画镜头',
  );
  const portable = await api<{ project: Project; blobs: unknown[] }>(`/projects/${p.id}/export`);
  await writeFile(join(output, 'rest-sculpture.ffstudio'), JSON.stringify(portable));
  const restored = await api<{ project: Project }>('/projects/import', portable);
  assert.deepEqual(restored.project.entities, portable.project.entities);
  assert.deepEqual(restored.project.geometries, portable.project.geometries);
  assert.deepEqual(restored.project.ikChains, portable.project.ikChains);
  assert.deepEqual(restored.project.ikTracks, portable.project.ikTracks);
  assert.deepEqual(errors, []);
  const report = {
    checkedAt: new Date().toISOString(),
    projectId: p.id,
    importedProjectId: restored.project.id,
    jobId: job?.id,
    media: media ? 'verified' : 'not run (--no-media)',
    browser: browser.version(),
    format: p.schemaVersion,
    frames: 48,
    validator: validator.issues,
    staticValidator: staticValidator.issues,
    staticDifference,
    measurements,
    videoMeasurements,
    pageErrors: errors,
    restNodes: original.entities
      .filter((e) => e.restPose)
      .map((e) => ({ id: e.id, name: e.name, restPose: e.restPose })),
    checks: [
      'rest fields and real world gizmo preserve weighted mesh shape under nonuniform parents',
      'one drag one transaction; Escape cancels; original geometry weights and curves unchanged',
      'uncompensated edit changes shape; compensated reset and capture keep rest shape',
      'undo redo reload portable restore and singular-transform atomic rejection',
      'bake activation disables rest offsets and constraints, undo restores source',
      'static and baked GLB validation UI reimport and pixel comparison',
      ...(media ? ['render snapshot unaffected by source rest edit'] : []),
    ],
  };
  await writeFile(join(output, 'result.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  await writeFile(join(output, 'failure.txt'), await page.locator('body').innerText());
  await page.screenshot({ path: join(output, 'failure.png') });
  throw error;
} finally {
  await browser.close();
}
