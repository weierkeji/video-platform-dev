import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chromium } from 'playwright-core';
import { validateBytes } from 'gltf-validator';
import { browserPath, ffmpegPath, ffprobePath } from '../server/runtime';
import { id, PROJECT_VERSION, type Project, type GenerationJob } from '../src/core/model';
import type { Command } from '../src/core/commands';
import { bakeAnimation } from '../src/core/bake';

const origin = process.env.STUDIO_URL || 'http://127.0.0.1:4173',
  output = resolve('.local/checks/bake');
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
const bundle = JSON.parse(await readFile('examples/object-layers.ffstudio', 'utf8'));
bundle.project.name = `层动画烘焙 ${new Date().toISOString()}`;
let p = (await api<{ project: Project }>('/projects/import', bundle)).project;
const sourceScene = p.scenes.find((s) => s.name === 'Animation exchange')!,
  root = p.entities.find((e) => e.sceneId === sourceScene.id && e.name === 'Motion root')!;
const base = sourceScene.activeActionId!,
  delta = p.animationActions!.find((a) => a.sceneId === sourceScene.id && a.name === '局部增量')!,
  rootLayer = p.animationLayers!.find((l) => l.entityId === root.id && l.blend === 'additive')!;
async function commands(commands: Command[], label: string) {
  p = (
    await api<{ project: Project }>(`/projects/${p.id}/commands`, {
      baseRevision: p.revision,
      commands,
      label,
    })
  ).project;
}
await commands(
  [
    { type: 'scene.update', id: sourceScene.id, patch: { activeActionId: delta.id } },
    ...[
      [0, [-0.5, 1.4, 0]],
      [12, [0, 1.6, 0]],
      [24, [-0.5, 1.4, 0]],
    ].map(
      ([frame, value]): Command => ({
        type: 'key.set',
        entityId: root.id,
        property: 'position',
        key: {
          frame: frame as number,
          value: value as [number, number, number],
          interpolation: 'constant',
        },
      }),
    ),
    { type: 'scene.update', id: sourceScene.id, patch: { activeActionId: base } },
    {
      type: 'layer.update',
      id: rootLayer.id,
      patch: {
        sourceIn: 24,
        playback: { rate: -0.75, rangeStart: 0, rangeEnd: 24, mode: 'pingpong' },
      },
    },
  ],
  '为原作品增加倒放保持段和往返边界',
);
const original = structuredClone(p),
  options = {
    start: 0,
    end: 48,
    step: 0.5,
    rebase: false,
    interpolation: 'linear' as const,
    actionId: base,
  };
const expected = bakeAnimation(p, sourceScene.id, options);
assert.ok(expected.stats.smoothErrors.position < 0.001, JSON.stringify(expected.stats));
const browser = await chromium.launch({
  executablePath: browserPath(),
  headless: true,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const errors: string[] = [];
try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1100 } });
  await page.addInitScript('globalThis.__name = (fn) => fn');
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(origin, { waitUntil: 'networkidle' });
  await page.getByLabel('切换项目').selectOption(p.id);
  const saved = async (previous = p.revision) => {
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
    throw new Error('未保存：' + (await page.locator('body').innerText()));
  };
  const cursor = async (frame: number) => {
    await page.getByLabel('当前帧', { exact: true }).fill(String(frame));
    await page.getByLabel('当前帧', { exact: true }).press('Tab');
  };
  const field = async (label: string, value: number) => {
    await page.getByLabel(label, { exact: true }).fill(String(value));
    await page.getByLabel(label, { exact: true }).press('Tab');
  };
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
    await cursor(frame);
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: '导出当前帧 PNG', exact: true }).click(),
    ]);
    const path = join(output, `${prefix}-${frame}.png`);
    await download.saveAs(path);
    return decode(path);
  };
  const frames = [0, 0.125, 0.25, 6, 12, 15.999, 16, 16.001, 17, 23, 24, 31, 32, 35, 47],
    references = new Map<number, Buffer>();
  await page.getByRole('button', { name: '成片预览', exact: true }).click();
  for (const frame of frames) references.set(frame, await png('source', frame));
  await page.getByRole('button', { name: '三维编辑', exact: true }).click();
  await page.getByLabel('场景', { exact: true }).selectOption(sourceScene.id);
  await page.getByRole('button', { name: 'glTF', exact: true }).click();
  await field('烘焙终点', 0);
  await page.getByRole('button', { name: '分析烘焙', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: '终点必须大于起点' }).waitFor();
  assert.equal((await api<{ project: Project }>(`/projects/${p.id}`)).project.revision, p.revision);
  await field('烘焙终点', 90);
  await field('烘焙步长', 0.01);
  const [worker] = await Promise.all([
    page.waitForEvent('worker'),
    page.getByRole('button', { name: '分析烘焙', exact: true }).click(),
  ]);
  assert.ok(worker.url().includes('bake.worker'));
  await page.getByRole('button', { name: '取消烘焙计算', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: '已取消烘焙计算' }).waitFor();
  await field('烘焙终点', 48);
  await field('烘焙步长', 0.5);
  await page.getByRole('button', { name: '分析烘焙', exact: true }).click();
  await page
    .locator('.bake-panel')
    .getByRole('status')
    .filter({ hasText: `${expected.stats.samples} 个时刻` })
    .waitFor();
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: '烘焙动画 GLB', exact: true }).click(),
  ]);
  const glbPath = join(output, 'baked-layers.glb');
  await download.saveAs(glbPath);
  const validator = await validateBytes(new Uint8Array(await readFile(glbPath)), {
    uri: 'baked-layers.glb',
  });
  assert.equal(validator.issues.numErrors, 0, JSON.stringify(validator.issues));
  assert.equal(validator.issues.numWarnings, 0);
  await page.getByLabel('烘焙动作名称').fill('层结果 0–48');
  await page.getByLabel('启用烘焙动作', { exact: true }).click();
  await page.getByRole('button', { name: '保存为新动作', exact: true }).click();
  await saved();
  const bakedAction = p.animationActions!.find((a) => a.name === '层结果 0–48')!;
  assert.equal(p.scenes.find((s) => s.id === sourceScene.id)!.activeActionId, bakedAction.id);
  assert.ok(p.animationLayers!.every((l) => !l.enabled));
  assert.deepEqual(
    p.animationTracks.filter((t) => t.actionId !== bakedAction.id),
    original.animationTracks,
  );
  await page.getByRole('button', { name: '关闭', exact: true }).click();
  await page.getByTitle('Ctrl+Z', { exact: true }).click();
  await saved();
  assert.deepEqual(p.animationLayers, original.animationLayers);
  await page.getByTitle('Ctrl+Shift+Z', { exact: true }).click();
  await saved();
  await page.reload({ waitUntil: 'networkidle' });
  await page.getByLabel('切换项目').selectOption(p.id);
  const bakedKeys = p.animationTracks.filter((t) => t.actionId === bakedAction.id);
  assert.equal(
    bakedKeys.reduce((n, t) => n + t.keys.length, 0),
    expected.stats.keys,
  );
  await page.getByRole('button', { name: '成片预览', exact: true }).click();
  const measurements = [];
  for (const frame of frames) {
    const pixels = await png('baked', frame),
      bakeDifference = difference(pixels, references.get(frame)!);
    assert.ok(bakeDifference < 0.05, JSON.stringify({ frame, bakeDifference }));
    measurements.push({ frame, bakeDifference });
  }
  const job = await api<GenerationJob>(`/projects/${p.id}/jobs`, {
    kind: 'render',
    baseRevision: p.revision,
    requestKey: id(),
  });
  // Mutating source layers and base selection after submission cannot affect the baked snapshot.
  await commands(
    [
      { type: 'scene.update', id: sourceScene.id, patch: { activeActionId: base } },
      { type: 'layer.update', id: rootLayer.id, patch: { enabled: true, weight: 1 } },
    ],
    '提交后修改源动作和层',
  );
  let result = job;
  const deadline = Date.now() + 120000;
  while (['queued', 'running'].includes(result.status) && Date.now() < deadline) {
    await page.waitForTimeout(500);
    result = await api<GenerationJob>(`/jobs/${job.id}`);
  }
  assert.equal(result.status, 'succeeded', result.message);
  const mp4Path = join(output, 'baked-layers.mp4');
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
    const videoDifference = difference(references.get(frame)!, await decode(mp4Path, frame));
    assert.ok(videoDifference < 4);
    videoMeasurements.push({ frame, videoDifference });
  }
  p = (await api<{ project: Project }>(`/projects/${p.id}`)).project;
  await commands(
    [
      { type: 'scene.update', id: sourceScene.id, patch: { activeActionId: bakedAction.id } },
      {
        type: 'layer.update',
        id: rootLayer.id,
        patch: { enabled: false, weight: rootLayer.weight },
      },
    ],
    '恢复烘焙动作预览',
  );
  await page.getByRole('button', { name: '刷新', exact: true }).click();
  await page.waitForFunction(
    (r) => document.querySelector('.save-status')?.textContent?.includes(`r${r}`),
    p.revision,
  );
  await page.getByRole('button', { name: 'glTF', exact: true }).click();
  await page.getByLabel('选择 glTF 文件', { exact: true }).setInputFiles(glbPath);
  const sceneIds = new Set(p.scenes.map((s) => s.id));
  await page.getByRole('button', { name: '导入这些场景', exact: true }).click();
  await saved();
  const importedScene = p.scenes.find((s) => !sceneIds.has(s.id))!,
    camera = p.entities.find((e) => e.sceneId === importedScene.id && e.kind === 'camera')!;
  await commands(
    [
      {
        type: 'shot.update',
        id: p.shots[0].id,
        patch: { sceneId: importedScene.id, cameraId: camera.id },
      },
    ],
    '用重导入的烘焙动画制作镜头',
  );
  await page.getByRole('button', { name: '刷新', exact: true }).click();
  await page.waitForFunction(
    (r) => document.querySelector('.save-status')?.textContent?.includes(`r${r}`),
    p.revision,
  );
  await page.getByRole('button', { name: '成片预览', exact: true }).click();
  const roundtrip = [];
  for (const frame of frames) {
    const pixels = await png('reimport', frame),
      differenceAfterImport = difference(pixels, references.get(frame)!);
    assert.ok(differenceAfterImport < 0.05, JSON.stringify({ frame, differenceAfterImport }));
    roundtrip.push({ frame, differenceAfterImport });
  }
  const portable = await api<{ project: Project; blobs: unknown[] }>(`/projects/${p.id}/export`);
  await writeFile(join(output, 'baked-layers.ffstudio'), JSON.stringify(portable));
  const restored = await api<{ project: Project }>('/projects/import', portable);
  assert.deepEqual(restored.project.animationTracks, portable.project.animationTracks);
  assert.deepEqual(restored.project.animationLayers, portable.project.animationLayers);
  await page.getByRole('button', { name: '三维编辑', exact: true }).click();
  await page.getByLabel('场景', { exact: true }).selectOption(sourceScene.id);
  await page.getByRole('button', { name: 'glTF', exact: true }).click();
  await page.getByLabel('烘焙基础动作', { exact: true }).selectOption(base);
  await field('烘焙起点', 6.25);
  await field('烘焙终点', 18.75);
  await field('烘焙步长', 0.5);
  await page.getByLabel('烘焙起点归零').click();
  await page.getByLabel('烘焙插值').selectOption('constant');
  await page.getByRole('button', { name: '分析烘焙', exact: true }).click();
  await page.locator('.bake-panel').getByRole('status').filter({ hasText: '起点归零' }).waitFor();
  await page.locator('.bake-panel').scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(output, 'product.png') });
  assert.deepEqual(errors, []);
  const report = {
    checkedAt: new Date().toISOString(),
    projectId: p.id,
    importedProjectId: restored.project.id,
    jobId: job.id,
    browser: browser.version(),
    format: PROJECT_VERSION,
    frames: 48,
    stats: expected.stats,
    validator: validator.issues,
    measurements,
    videoMeasurements,
    roundtrip,
    pageErrors: errors,
    checks: [
      'worker cancellation and invalid range leave project unchanged',
      'UI sampling range step interpolation and rebase',
      'baked GLB validated and reimported through UI',
      'save new action retains originals; activation disables layers atomically',
      'undo redo and reload retain baked keys',
      'original vs baked vs reimported images',
      'fixed render snapshot while editing source layers',
      'portable project retains source and baked actions',
    ],
  };
  await writeFile(join(output, 'result.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  const page = browser.contexts()[0]?.pages()[0];
  if (page) {
    await page.screenshot({ path: join(output, 'failure.png') });
    await writeFile(join(output, 'failure.txt'), await page.locator('body').innerText());
  }
  throw error;
} finally {
  await browser.close();
}
