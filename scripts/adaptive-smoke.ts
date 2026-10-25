import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chromium } from 'playwright-core';
import { validateBytes } from 'gltf-validator';
import { adaptiveFixture } from './adaptive-fixture';
import { browserPath, ffmpegPath, ffprobePath } from '../server/runtime';
import { id, type Project, type GenerationJob } from '../src/core/model';
import { bakeAnimation } from '../src/core/bake';
import type { Command } from '../src/core/commands';

const origin = process.env.STUDIO_URL || 'http://127.0.0.1:4173',
  output = resolve('.local/checks/adaptive');
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
const fixture = adaptiveFixture();
fixture.p.name += ' ' + new Date().toISOString();
let p = (await api<{ project: Project }>('/projects/import', { project: fixture.p, blobs: [] }))
  .project;
const original = structuredClone(p),
  sourceScene = fixture.sceneId,
  renderShotId = p.timeline.clips[0].sourceId;
const browser = await chromium.launch({
  executablePath: browserPath(),
  headless: true,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 1100 } }),
  errors: string[] = [];
try {
  await page.addInitScript('globalThis.__name = (fn) => fn');
  page.on('pageerror', (e) => errors.push(e.stack || e.message));
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

  await page.getByLabel('场景', { exact: true }).selectOption(sourceScene);
  const stats = bakeAnimation(original, sourceScene, fixture.options).stats;
  const coarseStats = bakeAnimation(original, sourceScene, {
    ...fixture.options,
    adaptive: undefined,
  }).stats;
  const sourceMeasurements: { frame: number; difference: number }[] = [];
  const originalImages = new Map<number, Buffer>();
  await page.getByRole('button', { name: '成片预览', exact: true }).click();
  for (const frame of [0, 6.25, 12, 24, 36, 36.5, 47])
    originalImages.set(frame, await png('original', frame));
  await page.getByRole('button', { name: '三维编辑', exact: true }).click();
  await page.getByRole('button', { name: 'glTF', exact: true }).click();
  await page.getByLabel('自适应烘焙', { exact: true }).check();
  await field('烘焙终点', 48);
  await field('烘焙步长', 8);
  await field('最小采样间隔 帧', 0.001);
  await field('烘焙位置分量容差 m', 0.000001);
  assert.equal(await page.getByLabel('烘焙位置分量容差 m').inputValue(), '0.000001');
  await field('烘焙位置分量容差 m', 0.001);
  await page.getByRole('button', { name: '分析烘焙', exact: true }).click();
  await page.getByRole('status').filter({ hasText: '自适应探测已达到目标' }).waitFor();
  await page
    .getByRole('status')
    .filter({ hasText: '自适应探测已达到目标' })
    .scrollIntoViewIfNeeded();
  assert.equal((await api<{ project: Project }>('/projects/' + p.id)).project.revision, p.revision);
  await page.screenshot({ path: join(output, 'analysis.png') });
  await page.evaluate(() => {
    [...document.querySelectorAll('button')].find((b) => b.textContent === '分析烘焙')!.click();
    requestAnimationFrame(() =>
      [...document.querySelectorAll('button')]
        .find((b) => b.textContent === '取消烘焙计算')
        ?.click(),
    );
  });
  await page.getByRole('alert').filter({ hasText: '已取消烘焙计算' }).waitFor();
  await field('最小采样间隔 帧', 16);
  await page.getByRole('button', { name: '分析烘焙', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: '最小采样间隔不能大于' }).waitFor();
  await field('最小采样间隔 帧', 8);
  await page.getByRole('button', { name: '分析烘焙', exact: true }).click();
  await page.getByRole('status').filter({ hasText: '自适应探测未达到目标' }).waitFor();
  await page.getByRole('button', { name: '保存为新动作', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: '未达到目标' }).waitFor();
  await page.getByRole('button', { name: '烘焙动画 GLB', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: '未达到目标' }).waitFor();
  await assert.rejects(
    () =>
      api('/projects/' + p.id + '/commands', {
        baseRevision: p.revision,
        label: 'Reject unresolved',
        commands: [
          {
            type: 'action.bake',
            action: { id: id(), sceneId: sourceScene, name: 'Unresolved' },
            options: { ...fixture.options, adaptive: { ...fixture.options.adaptive!, minStep: 8 } },
            activate: true,
          },
        ],
      }),
    /未达到目标/,
  );
  assert.equal((await api<{ project: Project }>('/projects/' + p.id)).project.revision, p.revision);
  await page.screenshot({ path: join(output, 'unresolved.png') });
  await field('最小采样间隔 帧', 0.001);
  const [direct] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: '烘焙动画 GLB', exact: true }).click(),
  ]);
  const directPath = join(output, 'adaptive-direct.glb');
  await direct.saveAs(directPath);
  const directValidator = await validateBytes(new Uint8Array(await readFile(directPath)));
  assert.equal(directValidator.issues.numErrors, 0);
  assert.equal(directValidator.issues.numWarnings, 0);
  await page.getByLabel('烘焙动作名称', { exact: true }).fill('自适应动作 0–48');
  await page.getByLabel('启用烘焙动作', { exact: true }).check();
  const previousRevision = p.revision;
  await page.getByRole('button', { name: '保存为新动作', exact: true }).click();
  await saved();
  assert.equal(p.revision, previousRevision + 1);
  const actionId = p.scenes.find((s) => s.id === sourceScene)!.activeActionId!;
  const generated = structuredClone(p);
  assert.equal(
    p.animationTracks
      .filter((t) => t.actionId === actionId)
      .reduce((sum, t) => sum + t.keys.length, 0),
    stats.keys,
  );
  assert.deepEqual(
    p.animationTracks.filter((t) => t.actionId !== actionId),
    original.animationTracks,
  );
  assert.deepEqual(p.ikTracks, original.ikTracks);
  assert.deepEqual(p.geometries, original.geometries);
  assert.ok(p.ikChains!.every((c) => !c.enabled));
  assert.ok(p.animationLayers!.every((l) => !l.enabled));
  await page.getByRole('button', { name: '关闭', exact: true }).click();
  await page.getByTitle('Ctrl+Z', { exact: true }).click();
  await saved();
  assert.deepEqual(p.animationTracks, original.animationTracks);
  assert.deepEqual(p.ikChains, original.ikChains);
  assert.deepEqual(p.animationLayers, original.animationLayers);
  await page.getByTitle('Ctrl+Shift+Z', { exact: true }).click();
  await saved();
  assert.deepEqual(p.animationTracks, generated.animationTracks);
  await page.reload({ waitUntil: 'networkidle' });
  await page.getByLabel('切换项目').selectOption(p.id);
  await page.getByLabel('场景', { exact: true }).selectOption(sourceScene);
  assert.equal(await page.getByLabel('动画动作', { exact: true }).inputValue(), actionId);
  const frames = [0, 6.25, 12, 24, 36, 36.5, 47],
    references = new Map<number, Buffer>();
  await page.getByRole('button', { name: '成片预览', exact: true }).click();
  for (const frame of frames) {
    const pixels = await png('source', frame);
    references.set(frame, pixels);
    const delta = difference(originalImages.get(frame)!, pixels);
    assert.ok(delta < 0.2, JSON.stringify({ frame, delta }));
    sourceMeasurements.push({ frame, difference: delta });
  }
  assert.ok(difference(references.get(0)!, references.get(24)!) > 0.1);
  await page.screenshot({ path: join(output, 'product.png') });
  await page.getByRole('button', { name: '三维编辑', exact: true }).click();
  await field('当前帧', 24);
  await page.getByRole('button', { name: 'glTF', exact: true }).click();
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: '导出动画 GLB', exact: true }).click(),
  ]);
  const glbPath = join(output, 'adaptive-performance.glb');
  await download.saveAs(glbPath);
  const validator = await validateBytes(new Uint8Array(await readFile(glbPath)), {
    uri: 'adaptive-performance.glb',
  });
  assert.equal(validator.issues.numErrors, 0, JSON.stringify(validator.issues));
  assert.equal(validator.issues.numWarnings, 0, JSON.stringify(validator.issues));
  const [staticDownload] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: '导出当前帧 GLB', exact: true }).click(),
  ]);
  const staticPath = join(output, 'adaptive-pose.glb');
  await staticDownload.saveAs(staticPath);
  const staticValidator = await validateBytes(new Uint8Array(await readFile(staticPath)), {
    uri: 'adaptive-pose.glb',
  });
  assert.equal(staticValidator.issues.numErrors, 0);
  assert.equal(staticValidator.issues.numWarnings, 0);
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
          type: 'scene.update',
          id: sourceScene,
          patch: { activeActionId: null },
        },
      ],
      '提交后切换到另一动作',
    );
    let result = job;
    const deadline = Date.now() + 120000;
    while (['queued', 'running'].includes(result.status) && Date.now() < deadline) {
      await page.waitForTimeout(500);
      result = await api<GenerationJob>(`/jobs/${job.id}`);
    }
    assert.equal(result.status, 'succeeded', result.message);
    const mp4Path = join(output, 'adaptive-performance.mp4');
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
      [{ type: 'scene.update', id: sourceScene, patch: { activeActionId: actionId } }],
      '恢复自适应输出动作',
    );
  }
  await page.getByRole('button', { name: 'glTF', exact: true }).click();
  await page.getByLabel('选择 glTF 文件', { exact: true }).setInputFiles(glbPath);
  const before = new Set(p.scenes.map((s) => s.id));
  await page.getByRole('button', { name: '导入这些场景', exact: true }).click();
  await saved();
  const imported = p.scenes.find((s) => !before.has(s.id))!;
  const camera = p.entities.find((e) => e.sceneId === imported.id && e.kind === 'camera')!;
  const importedAction = p.animationActions!.find(
    (a) => a.sceneId === imported.id && a.name === '自适应动作 0–48',
  )!;
  assert.ok(importedAction);
  assert.equal(
    p.animationTracks
      .filter((t) => t.actionId === importedAction.id)
      .reduce((sum, t) => sum + t.keys.length, 0),
    stats.keys,
  );
  await page.getByLabel('动画动作', { exact: true }).selectOption(importedAction.id);
  await saved();
  await commands(
    [
      {
        type: 'shot.update',
        id: renderShotId,
        patch: { sceneId: imported.id, cameraId: camera.id },
      },
    ],
    '用重导入的自适应动作制作镜头',
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
        id: renderShotId,
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
        id: renderShotId,
        patch: { sceneId: imported.id, cameraId: camera.id },
      },
    ],
    '恢复动画镜头',
  );
  const portable = await api<{ project: Project; blobs: unknown[] }>(`/projects/${p.id}/export`);
  await writeFile(join(output, 'adaptive-performance.ffstudio'), JSON.stringify(portable));
  const restored = await api<{ project: Project }>('/projects/import', portable);
  assert.deepEqual(restored.project.entities, portable.project.entities);
  assert.deepEqual(restored.project.geometries, portable.project.geometries);
  assert.deepEqual(restored.project.ikChains, portable.project.ikChains);
  assert.deepEqual(restored.project.ikTracks, portable.project.ikTracks);
  assert.deepEqual(restored.project.retargetProfiles, portable.project.retargetProfiles);
  assert.deepEqual(restored.project.animationTracks, portable.project.animationTracks);
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
    options: fixture.options,
    stats,
    coarseStats,
    directValidator: directValidator.issues,
    sourceMeasurements,
    sourceActionId: null,
    targetActionId: actionId,
    checks: [
      'actual adaptive fields, precision and non-mutating analysis',
      'worker cancellation, invalid interval and unresolved save/export/API rejection',
      'direct adaptive GLB export, saved native clip, undo redo and reload',
      'source drivers preserved, activation disables duplicates and original curves remain editable',
      'original versus baked PNG, native animated and static GLB UI reimport',
      ...(media ? ['fixed render snapshot survives later action switch'] : []),
      'portable project retains source, drivers, nonuniform baked action and imported scenes',
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
