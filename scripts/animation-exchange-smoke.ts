import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chromium } from 'playwright-core';
import { validateBytes } from 'gltf-validator';
import { browserPath, ffmpegPath, ffprobePath } from '../server/runtime';
import { animationExchangeFixture } from './animation-exchange-fixture';
import { importGLTF } from '../src/core/gltf';
import { id, PROJECT_VERSION, type Project, type GenerationJob } from '../src/core/model';
const origin = process.env.STUDIO_URL || 'http://127.0.0.1:4173',
  output = resolve('.local/checks/animation-exchange');
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
  await api<{ project: Project }>('/projects', { name: `动画交换检查 ${new Date().toISOString()}` })
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
    throw new Error('未保存：' + (await page.locator('body').innerText()));
  }
  await page.getByRole('button', { name: 'glTF', exact: true }).click();
  await page.getByLabel('选择 glTF 文件', { exact: true }).setInputFiles({
    name: 'motion.gltf',
    mimeType: 'model/gltf+json',
    buffer: Buffer.from(JSON.stringify(animationExchangeFixture())),
  });
  await page.getByRole('button', { name: '导入这些场景', exact: true }).click();
  await saved();
  assert.equal(p.revision, 1);
  assert.equal(p.animationActions?.length, 4);
  assert.equal(p.animationTracks.length, 10);
  const sceneId = p.scenes.find((s) => s.name === 'Animation exchange')!.id,
    arc = p.animationActions!.find((a) => a.sceneId === sceneId && a.name === 'Arc and turn')!,
    hold = p.animationActions!.find((a) => a.sceneId === sceneId && a.name === 'Hold and tilt')!;
  const bar = p.entities.find((e) => e.sceneId === sceneId && e.name === 'Animated bar')!,
    root = p.entities.find((e) => e.sceneId === sceneId && e.name === 'Motion root')!;
  await page.getByTitle('Ctrl+Z', { exact: true }).click();
  await saved();
  assert.equal(p.animationActions?.length || 0, 0);
  await page.getByTitle('Ctrl+Shift+Z', { exact: true }).click();
  await saved();
  assert.equal(p.animationTracks.length, 10);
  await page.getByLabel('场景', { exact: true }).selectOption(sceneId);
  await page.getByLabel('动画动作', { exact: true }).selectOption(hold.id);
  await saved();
  await page.locator('.entity').filter({ hasText: 'Motion root' }).click();
  assert.equal(Number(await page.getByLabel('位置 X', { exact: true }).inputValue()), 1);
  await page.getByLabel('动画动作', { exact: true }).selectOption(arc.id);
  await saved();
  assert.equal(Number(await page.getByLabel('位置 X', { exact: true }).inputValue()), -1);
  await page.locator('.entity').filter({ hasText: 'Animated bar' }).click();
  await page.getByRole('button', { name: '动画曲线', exact: true }).click();
  await page.getByLabel('动画属性', { exact: true }).selectOption('quaternion');
  const track = p.animationTracks.find((t) => t.actionId === arc.id && t.entityId === bar.id)!,
    key = track.keys[1];
  await page.getByLabel(`关键帧 ${key.frame}`, { exact: true }).click();
  await page.getByLabel('关键帧时间', { exact: true }).fill('9.25');
  await page.getByLabel('关键帧时间', { exact: true }).press('Tab');
  await saved();
  assert.equal(p.animationTracks.find((t) => t.id === track.id)!.keys[1].frame, 9.25);
  await page.getByLabel('当前帧', { exact: true }).fill('9.25');
  await page.getByLabel('当前帧', { exact: true }).press('Tab');
  const clipCount = p.timeline.clips.length;
  await page.getByTitle('加入时间轴（吸附最近整帧）', { exact: true }).click();
  await saved();
  assert.equal(p.timeline.clips.length, clipCount + 1);
  assert.equal(p.timeline.clips.at(-1)!.start, 9);
  assert.ok(Number.isInteger(p.timeline.clips.at(-1)!.duration));
  await page.getByTitle('Ctrl+Z', { exact: true }).click();
  await saved();
  assert.equal(p.timeline.clips.length, clipCount);
  await page.getByLabel('曲线 W', { exact: true }).click();
  await page.getByLabel('关键帧 W（分量）', { exact: true }).fill('0.6');
  await page.getByLabel('关键帧 W（分量）', { exact: true }).press('Tab');
  await saved();
  assert.ok(
    Math.abs(Math.hypot(...p.animationTracks.find((t) => t.id === track.id)!.keys[1].value) - 1) <
      1e-10,
  );
  await page.getByTitle('Ctrl+Z', { exact: true }).click();
  await saved();
  assert.deepEqual(p.animationTracks.find((t) => t.id === track.id)!.keys[1].value, key.value);
  // Hermite derivative editing uses value/frame units and keeps other keys intact.
  await page.locator('.entity').filter({ hasText: 'Motion root' }).click();
  await page.getByLabel('动画属性', { exact: true }).selectOption('position');
  await page.getByLabel('关键帧 0', { exact: true }).click();
  await page.getByLabel('出切线 X / 帧', { exact: true }).fill('0.12');
  await page.getByLabel('出切线 X / 帧', { exact: true }).press('Tab');
  await saved();
  assert.equal(
    p.animationTracks.find((t) => t.actionId === arc.id && t.entityId === root.id)!.keys[0]
      .outTangent![0],
    0.12,
  );
  await page.getByTitle('Ctrl+Z', { exact: true }).click();
  await saved();
  await page.getByRole('button', { name: '复制动作', exact: true }).click();
  await saved();
  const copy = p.scenes.find((s) => s.id === sceneId)!.activeActionId!;
  await page.getByLabel('动作名称', { exact: true }).fill('Arc revision');
  await page.getByLabel('动作名称', { exact: true }).press('Tab');
  await saved();
  await page.getByRole('button', { name: '删除动作', exact: true }).click();
  await saved();
  assert.ok(!p.animationActions?.some((a) => a.id === copy));
  await page.getByTitle('Ctrl+Z', { exact: true }).click();
  await saved();
  assert.ok(p.animationActions?.some((a) => a.id === copy));
  await page.getByLabel('动画动作', { exact: true }).selectOption(arc.id);
  await saved();
  await page.screenshot({ path: join(output, 'curves.png') });
  await page.reload({ waitUntil: 'networkidle' });
  await page.getByLabel('切换项目').selectOption(p.id);
  await page.getByLabel('场景', { exact: true }).selectOption(sceneId);
  assert.equal(await page.getByLabel('动画动作', { exact: true }).inputValue(), arc.id);
  await page.getByRole('button', { name: 'glTF', exact: true }).click();
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: '导出动画 GLB', exact: true }).click(),
  ]);
  const glbPath = join(output, 'animation-exchange.glb');
  await download.saveAs(glbPath);
  const glb = await readFile(glbPath),
    validation = await validateBytes(glb);
  await writeFile(join(output, 'validator.json'), JSON.stringify(validation, null, 2));
  assert.equal(validation.issues.numErrors, 0, JSON.stringify(validation.issues));
  assert.equal(validation.issues.numWarnings, 0, JSON.stringify(validation.issues));
  const imported = await importGLTF(glb, [], p.timeline.fps);
  assert.equal(imported.command.animationActions?.length, 3);
  await page.getByLabel('选择 glTF 文件', { exact: true }).setInputFiles(glbPath);
  await page.getByRole('button', { name: '导入这些场景', exact: true }).click();
  await saved();
  assert.equal(p.animationActions?.length, 8);
  const cameraId = p.entities.find((e) => e.sceneId === sceneId && e.kind === 'camera')!.id;
  p = (
    await api<{ project: Project }>(`/projects/${p.id}/commands`, {
      baseRevision: p.revision,
      label: '动画镜头输出',
      commands: [
        { type: 'shot.update', id: p.shots[0].id, patch: { sceneId, cameraId } },
        { type: 'clip.update', id: p.timeline.clips[0].id, patch: { duration: 36 } },
        { type: 'timeline.update', patch: { duration: 36, width: 480, height: 270 } },
      ],
    })
  ).project;
  const job = await api<GenerationJob>(`/projects/${p.id}/jobs`, {
    kind: 'render',
    baseRevision: p.revision,
    requestKey: id(),
  });
  p = (
    await api<{ project: Project }>(`/projects/${p.id}/commands`, {
      baseRevision: p.revision,
      label: '提交后切换动作',
      commands: [{ type: 'scene.update', id: sceneId, patch: { activeActionId: hold.id } }],
    })
  ).project;
  let result = job;
  const deadline = Date.now() + 120000;
  while (['queued', 'running'].includes(result.status) && Date.now() < deadline) {
    await page.waitForTimeout(500);
    result = await api<GenerationJob>(`/jobs/${job.id}`);
  }
  assert.equal(result.status, 'succeeded', result.message);
  const mp4Path = join(output, 'animation-exchange.mp4');
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
  assert.equal(probe.streams[0].nb_frames, '36');
  await page.getByRole('button', { name: '刷新', exact: true }).click();
  p = (await api<{ project: Project }>(`/projects/${p.id}`)).project;
  await page.waitForFunction(
    (r) => document.querySelector('.save-status')?.textContent?.includes(`r${r}`),
    p.revision,
  );
  await page.getByLabel('场景', { exact: true }).selectOption(sceneId);
  assert.equal(await page.getByLabel('动画动作', { exact: true }).inputValue(), hold.id);
  await page.getByLabel('动画动作', { exact: true }).selectOption(arc.id);
  await saved();
  await page.getByRole('button', { name: '成片预览', exact: true }).click();
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
  const pixels = [];
  for (const frame of [0, 8, 16, 26]) {
    await page.getByLabel('当前帧', { exact: true }).fill(String(frame));
    await page.getByLabel('当前帧', { exact: true }).press('Tab');
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: '导出当前帧 PNG', exact: true }).click(),
    ]);
    const path = join(output, `frame-${frame}.png`);
    await download.saveAs(path);
    const a = await decode(path),
      b = await decode(mp4Path, frame);
    assert.equal(a.length, 480 * 270 * 3);
    assert.equal(a.length, b.length);
    const difference = a.reduce((sum, v, i) => sum + Math.abs(v - b[i]), 0) / a.length;
    assert.ok(difference < 4, String(difference));
    let count = 0,
      x = 0,
      y = 0;
    for (let i = 0; i < a.length; i += 3)
      if (a[i] > 90 && a[i] > a[i + 1] * 1.7 && a[i] > a[i + 2] * 1.7) {
        count++;
        x += (i / 3) % 480;
        y += Math.floor(i / 3 / 480);
      }
    assert.ok(count > 100);
    pixels.push({ frame, difference, redPixels: count, center: [x / count, y / count] });
  }
  assert.ok(
    Math.max(...pixels.map((p) => p.center[0])) - Math.min(...pixels.map((p) => p.center[0])) > 50,
  );
  const bundle = await api<{ project: Project; blobs: unknown[] }>(`/projects/${p.id}/export`);
  await writeFile(join(output, 'animation-exchange.ffstudio'), JSON.stringify(bundle));
  const restored = await api<{ project: Project }>('/projects/import', bundle);
  assert.deepEqual(restored.project.animationActions, bundle.project.animationActions);
  assert.deepEqual(restored.project.animationTracks, bundle.project.animationTracks);
  assert.deepEqual(restored.project.scenes, bundle.project.scenes);
  assert.deepEqual(errors, []);
  await page.screenshot({ path: join(output, 'product.png') });
  const report = {
    checkedAt: new Date().toISOString(),
    projectId: p.id,
    importedProjectId: restored.project.id,
    jobId: job.id,
    browser: browser.version(),
    format: PROJECT_VERSION,
    validator: validation.issues,
    frames: 36,
    pixels,
    pageErrors: errors,
    checks: [
      'multiple actions and shared scenes imported in one undo transaction',
      'action selection changes evaluated transform',
      'fractional quaternion key and normalized W edit',
      'clip insertion snaps fractional playhead to integer frame and remains undoable',
      'Hermite derivative edit and undo',
      'action copy rename delete undo and reload',
      'animated GLB validation and reimport',
      'submitted action snapshot remains fixed while editing',
      'actual PNG and MP4 frames agree',
      'portable project retains all actions and tracks',
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
