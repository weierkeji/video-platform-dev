import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chromium } from 'playwright-core';
import { validateBytes } from 'gltf-validator';
import { skinFixture } from './skin-fixture';
import { browserPath, ffmpegPath, ffprobePath } from '../server/runtime';
import { id, type Project, type GenerationJob } from '../src/core/model';
import type { Command } from '../src/core/commands';

const origin = process.env.STUDIO_URL || 'http://127.0.0.1:4173',
  output = resolve('.local/checks/skin');
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
const fixture = skinFixture();
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
  await field('旋转 ° Z', -25);
  await saved();
  assert.ok(Math.abs(p.animationTracks[0].keys[0].value[2] + (25 * Math.PI) / 180) < 1e-7);
  await page.getByTitle('Ctrl+Z', { exact: true }).click();
  await saved();
  assert.deepEqual(p.animationTracks, original.animationTracks);
  // Create and parent a new editable joint through the same UI used for ordinary objects.
  await page.getByRole('combobox', { name: '添加对象' }).selectOption('joint');
  await saved();
  const extra = p.entities.at(-1)!;
  assert.equal(extra.joint, true);
  await select('关节');
  await page.getByLabel('父对象', { exact: true }).selectOption(fixture.joint1);
  await saved();
  assert.equal(p.entities.find((e) => e.id === extra.id)!.parentId, fixture.joint1);
  await commands([{ type: 'entity.delete', id: extra.id }], '移除临时关节');
  await select('Flexible column');
  await page.getByRole('button', { name: '解除蒙皮绑定', exact: true }).click();
  await saved();
  assert.equal(p.entities.find((e) => e.id === fixture.meshId)!.skin, undefined);
  if (!(await page.locator('.skin-panel').evaluate((e) => (e as HTMLDetailsElement).open)))
    await page.locator('.skin-panel summary').click();
  await page.getByLabel('绑定关节 Base joint', { exact: true }).check();
  await page.getByLabel('绑定关节 Tip joint', { exact: true }).check();
  await page.getByRole('button', { name: '以基础姿态绑定', exact: true }).click();
  await saved();
  assert.equal(p.entities.find((e) => e.id === fixture.meshId)!.skin!.joints.length, 2);
  await page.getByTitle('Ctrl+Z', { exact: true }).click();
  await saved();
  await page.getByTitle('Ctrl+Z', { exact: true }).click();
  await saved();
  assert.deepEqual(
    p.entities.find((e) => e.id === fixture.meshId)!.skin,
    original.entities.find((e) => e.id === fixture.meshId)!.skin,
  );
  await page.getByRole('button', { name: '编辑网格', exact: true }).click();
  await page.getByRole('button', { name: '全选', exact: true }).click();
  await page.getByRole('button', { name: '增加关节影响', exact: true }).click();
  await field('影响权重 1', 0.5);
  await page.getByRole('button', { name: '应用并归一化权重', exact: true }).click();
  await saved();
  assert.ok(
    p.geometries[0].influences!.every(
      (row) => row.length === 2 && row.every((v) => v.weight === 0.5),
    ),
  );
  await page.screenshot({ path: join(output, 'weights.png') });
  await page.getByTitle('Ctrl+Z', { exact: true }).click();
  await saved();
  assert.deepEqual(p.geometries[0].influences, original.geometries[0].influences);
  await page.getByTitle('Ctrl+Shift+Z', { exact: true }).click();
  await saved();
  await page.getByTitle('Ctrl+Z', { exact: true }).click();
  await saved();
  await page.getByRole('button', { name: '完成编辑', exact: true }).click();
  await page.reload({ waitUntil: 'networkidle' });
  await page.getByLabel('切换项目').selectOption(p.id);
  await page.getByLabel('显示关节', { exact: true }).uncheck();
  await page.getByLabel('显示关节', { exact: true }).check();
  await field('当前帧', 24);
  await select('Tip joint');
  await page.screenshot({ path: join(output, 'product.png') });
  await page.getByRole('button', { name: 'glTF', exact: true }).click();
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: '导出动画 GLB', exact: true }).click(),
  ]);
  const glbPath = join(output, 'skin-sculpture.glb');
  await download.saveAs(glbPath);
  const validator = await validateBytes(new Uint8Array(await readFile(glbPath)), {
    uri: 'skin-sculpture.glb',
  });
  assert.equal(validator.issues.numErrors, 0, JSON.stringify(validator.issues));
  assert.equal(validator.issues.numWarnings, 0, JSON.stringify(validator.issues));
  const [staticDownload] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: '导出当前帧 GLB', exact: true }).click(),
  ]);
  const staticPath = join(output, 'skin-pose.glb');
  await staticDownload.saveAs(staticPath);
  const staticValidator = await validateBytes(new Uint8Array(await readFile(staticPath)), {
    uri: 'skin-pose.glb',
  });
  assert.equal(staticValidator.issues.numErrors, 0, JSON.stringify(staticValidator.issues));
  await page.getByRole('button', { name: '关闭', exact: true }).click();
  const job = await api<GenerationJob>(`/projects/${p.id}/jobs`, {
    kind: 'render',
    baseRevision: p.revision,
    requestKey: id(),
  });
  await commands(
    [
      {
        type: 'skin.weights',
        entityId: fixture.meshId,
        indices: [24, 25, 26, 27],
        weights: [{ joint: 0, weight: 1 }],
      },
    ],
    '输出提交后修改权重',
  );
  let result = job;
  const deadline = Date.now() + 120000;
  while (['queued', 'running'].includes(result.status) && Date.now() < deadline) {
    await page.waitForTimeout(500);
    result = await api<GenerationJob>(`/jobs/${job.id}`);
  }
  assert.equal(result.status, 'succeeded', result.message);
  const mp4Path = join(output, 'skin-sculpture.mp4');
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
  const videoMeasurements = [];
  for (const frame of frames.filter(Number.isInteger)) {
    const delta = difference(references.get(frame)!, await decode(mp4Path, frame));
    assert.ok(delta < 4, String(delta));
    videoMeasurements.push({ frame, difference: delta });
  }
  p = (await api<{ project: Project }>(`/projects/${p.id}`)).project;
  await commands(
    [24, 25, 26, 27].map((index) => ({
      type: 'skin.weights',
      entityId: fixture.meshId,
      indices: [index],
      weights: original.geometries[0].influences![index],
    })),
    '恢复原始权重',
  );
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
    assert.ok(delta < 0.02, JSON.stringify({ frame, delta }));
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
  await writeFile(join(output, 'skin-sculpture.ffstudio'), JSON.stringify(portable));
  const restored = await api<{ project: Project }>('/projects/import', portable);
  assert.deepEqual(restored.project.entities, portable.project.entities);
  assert.deepEqual(restored.project.geometries, portable.project.geometries);
  assert.deepEqual(errors, []);
  const report = {
    checkedAt: new Date().toISOString(),
    projectId: p.id,
    importedProjectId: restored.project.id,
    jobId: job.id,
    browser: browser.version(),
    format: p.schemaVersion,
    frames: 48,
    validator: validator.issues,
    staticValidator: staticValidator.issues,
    staticDifference,
    measurements,
    videoMeasurements,
    pageErrors: errors,
    checks: [
      'joint creation hierarchy and animated posing',
      'bind unbind and undo restore exact source',
      'vertex weight edit normalization undo redo reload',
      'editor joints and rest mesh helpers',
      'animated GLB validation and UI reimport',
      'fixed render snapshot while editing weights',
      'portable project preserves skin and weights',
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
