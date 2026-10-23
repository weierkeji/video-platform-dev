import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chromium } from 'playwright-core';
import { Quaternion, Vector3 } from 'three';
import { browserPath, ffmpegPath, ffprobePath } from '../server/runtime';
import { animationExchangeFixture } from './animation-exchange-fixture';
import { importGLTF } from '../src/core/gltf';
import {
  id,
  PROJECT_VERSION,
  type Project,
  type GenerationJob,
  type AnimationLayer,
  type AnimationTrack,
  type AnimationValue,
} from '../src/core/model';
import type { Command } from '../src/core/commands';

const origin = process.env.STUDIO_URL || 'http://127.0.0.1:4173',
  output = resolve('.local/checks/layers');
const referenceRenderer = process.argv.includes('--renderer');
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
  await api<{ project: Project }>('/projects', { name: `对象动作层 ${new Date().toISOString()}` })
).project;
async function commands(commands: Command[], label: string) {
  p = (
    await api<{ project: Project }>(`/projects/${p.id}/commands`, {
      baseRevision: p.revision,
      commands,
      label,
    })
  ).project;
}
const imported = await importGLTF(
  new TextEncoder().encode(JSON.stringify(animationExchangeFixture())),
);
const scene = imported.command.scenes.find((s) => s.name === 'Animation exchange')!;
const [root, bar, camera] = ['Motion root', 'Animated bar', 'Motion camera'].map(
  (name) => imported.command.entities.find((e) => e.sceneId === scene.id && e.name === name)!,
);
const [a, b, c] = ['基础移动', '替换姿态', '局部增量'].map((name) => ({
  id: id(),
  name,
  sceneId: scene.id,
}));
imported.command.animationActions = [a, b, c];
imported.command.animationTracks = [];
imported.command.scenes.forEach((s) => (s.activeActionId = s.id === scene.id ? a.id : null));
const track = (
  entityId: string,
  actionId: string,
  property: AnimationTrack['property'],
  v: AnimationValue,
  end?: AnimationValue,
): AnimationTrack => ({
  id: id(),
  entityId,
  actionId,
  property,
  keys: [
    { id: id(), frame: 0, value: v, interpolation: 'linear' },
    ...(end ? [{ id: id(), frame: 48, value: end, interpolation: 'linear' as const }] : []),
  ],
});
const q = (axis: 'x' | 'y' | 'z', angle: number) =>
  new Quaternion()
    .setFromAxisAngle(
      new Vector3(axis === 'x' ? 1 : 0, axis === 'y' ? 1 : 0, axis === 'z' ? 1 : 0),
      angle,
    )
    .toArray();
imported.command.animationTracks.push(
  track(root.id, a.id, 'position', [-1, 1, 0], [1, 1, 0]),
  track(bar.id, a.id, 'quaternion', [0, 0, 0, 1], q('z', Math.PI / 2)),
  track(root.id, b.id, 'position', [1, 1, 0]),
  track(bar.id, b.id, 'quaternion', q('y', Math.PI / 3)),
  track(bar.id, b.id, 'scale', [0.7, 1.4, 1]),
  track(root.id, c.id, 'position', [-0.5, 1.4, 0]),
  track(bar.id, c.id, 'quaternion', q('x', Math.PI / 6)),
  track(camera.id, c.id, 'position', [0, 1.2, 7]),
);
await commands(
  [
    imported.command,
    { type: 'shot.update', id: p.shots[0].id, patch: { sceneId: scene.id, cameraId: camera.id } },
    { type: 'clip.update', id: p.timeline.clips[0].id, patch: { name: '正放混合', duration: 24 } },
    {
      type: 'clip.add',
      clip: {
        ...p.timeline.clips[0],
        id: id(),
        name: '倒放混合',
        start: 24,
        duration: 24,
        sourceIn: 47,
        playback: { rate: -1, rangeStart: 0, rangeEnd: 48, mode: 'hold' },
      },
    },
    { type: 'timeline.update', patch: { duration: 48, width: 480, height: 270 } },
  ],
  '创建可计算的动作层作品',
);
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
  await page.getByLabel('场景', { exact: true }).selectOption(scene.id);
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
    throw new Error('没有保存：' + (await page.locator('body').innerText()));
  }
  const cursor = async (frame: number) => {
    await page.getByLabel('当前帧', { exact: true }).fill(String(frame));
    await page.getByLabel('当前帧', { exact: true }).press('Tab');
  };
  const select = async (name: string) => page.locator('.entity').filter({ hasText: name }).click();
  async function addLayer(
    name: string,
    actionId: string,
    blend: AnimationLayer['blend'],
    weight: number,
    fade = false,
  ) {
    await page.getByRole('button', { name: '添加动作层', exact: true }).click();
    await saved();
    const layer = p.animationLayers!.at(-1)!,
      panel = page.locator(`[data-layer-id="${layer.id}"]`);
    await panel.locator('summary').click();
    const field = async (label: string, value: string | number) => {
      await panel.getByLabel(label, { exact: true }).fill(String(value));
      await panel.getByLabel(label, { exact: true }).press('Tab');
      await saved();
    };
    await field('层名称', name);
    await panel.getByLabel('层动作', { exact: true }).selectOption(actionId);
    await saved();
    if (blend !== 'replace') {
      await panel.getByLabel('混合方式').selectOption(blend);
      await saved();
    }
    await field('层权重', weight);
    if (fade) {
      await field('淡入帧数', 12);
      await field('淡出帧数', 8);
    }
    return layer.id;
  }
  await select(root.name);
  const rootReplace = await addLayer('位置过渡', b.id, 'replace', 0.5, true),
    rootAdd = await addLayer('位置增量', c.id, 'additive', 0.25);
  const addPanel = page.locator(`[data-layer-id="${rootAdd}"]`);
  await addPanel.getByRole('button', { name: '先混合', exact: true }).click();
  await saved();
  assert.equal(p.animationLayers![0].id, rootAdd);
  await page.getByTitle('Ctrl+Z', { exact: true }).click();
  await saved();
  assert.equal(p.animationLayers![0].id, rootReplace);
  await addPanel.getByLabel('启用动作层').click();
  await saved();
  assert.equal(p.animationLayers![1].enabled, false);
  await page.getByTitle('Ctrl+Z', { exact: true }).click();
  await saved();
  await addPanel.getByRole('button', { name: '删除层', exact: true }).click();
  await saved();
  assert.equal(p.animationLayers!.length, 1);
  await page.getByTitle('Ctrl+Z', { exact: true }).click();
  await saved();
  await page.getByTitle('Ctrl+Shift+Z', { exact: true }).click();
  await saved();
  await page.getByTitle('Ctrl+Z', { exact: true }).click();
  await saved();
  await select(bar.name);
  await addLayer('旋转缩放过渡', b.id, 'replace', 0.6, true);
  const barAdd = await addLayer('局部旋转增量', c.id, 'additive', 0.35);
  const barPanel = page.locator(`[data-layer-id="${barAdd}"]`);
  for (const label of ['层位置', '层缩放']) {
    await barPanel.getByLabel(label, { exact: true }).click();
    await saved();
  }
  await select(camera.name);
  await addLayer('摄影机增量', c.id, 'additive', 0.5);
  await page.getByLabel('动画动作', { exact: true }).selectOption(b.id);
  await saved();
  const before = p.revision;
  await page.getByRole('button', { name: '删除动作', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: '动作层引用' }).waitFor();
  assert.equal((await api<{ project: Project }>(`/projects/${p.id}`)).project.revision, before);
  await page.getByRole('alert').getByRole('button', { name: '关闭', exact: true }).click();
  await page.getByLabel('动画动作', { exact: true }).selectOption(a.id);
  await saved();
  await select(root.name);
  await cursor(12);
  assert.equal(Number(await page.getByLabel('位置 X', { exact: true }).inputValue()), -0.5);
  await page.getByLabel('预览动作层', { exact: true }).click();
  await page.getByLabel('位置 X', { exact: true }).fill('-0.25');
  await page.getByLabel('位置 X', { exact: true }).press('Tab');
  await saved();
  assert.equal(
    p.animationTracks
      .find((t) => t.entityId === root.id && t.actionId === a.id)!
      .keys.find((k) => k.frame === 12)!.value[0],
    -0.25,
  );
  await page.getByTitle('Ctrl+Z', { exact: true }).click();
  await saved();
  await page.getByLabel('预览动作层', { exact: true }).click();
  await page.getByRole('button', { name: 'glTF', exact: true }).click();
  await page.getByRole('button', { name: '导出动画 GLB', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: '动作层烘焙' }).waitFor();
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: '导出当前帧 GLB', exact: true }).click(),
  ]);
  const glbPath = join(output, 'mixed-frame.glb');
  await download.saveAs(glbPath);
  const staticScene = await importGLTF(new Uint8Array(await readFile(glbPath)));
  assert.ok(
    Math.abs(
      staticScene.command.entities.find((e) => e.name === root.name)!.transform.position[0] - 0.375,
    ) < 1e-6,
  );
  await page.getByRole('button', { name: '关闭', exact: true }).click();
  await page.reload({ waitUntil: 'networkidle' });
  await page.getByLabel('切换项目').selectOption(p.id);
  assert.equal(
    (await api<{ project: Project }>(`/projects/${p.id}`)).project.animationLayers!.length,
    5,
  );
  const snapshot = structuredClone(p);
  const job = await api<GenerationJob>(`/projects/${p.id}/jobs`, {
    kind: 'render',
    baseRevision: p.revision,
    requestKey: id(),
  });
  await commands(
    [
      { type: 'layer.update', id: rootReplace, patch: { weight: 0 } },
      { type: 'layer.delete', id: barAdd },
    ],
    '提交后修改层',
  );
  let result = job;
  const deadline = Date.now() + 120000;
  while (['queued', 'running'].includes(result.status) && Date.now() < deadline) {
    await page.waitForTimeout(500);
    result = await api<GenerationJob>(`/jobs/${job.id}`);
  }
  assert.equal(result.status, 'succeeded', result.message);
  const mp4Path = join(output, 'object-layers.mp4');
  await writeFile(
    mp4Path,
    Buffer.from(await (await fetch(`${origin}/api/jobs/${job.id}/artifact`)).arrayBuffer()),
  );
  p = (await api<{ project: Project }>(`/projects/${p.id}`)).project;
  // Job completion registers an artifact as another history entry. Restore layer
  // settings explicitly instead of assuming the most recent undo is our edit.
  await commands(
    [
      { type: 'layer.update', id: rootReplace, patch: { weight: 0.5 } },
      { type: 'layer.add', layer: snapshot.animationLayers!.find((l) => l.id === barAdd)! },
    ],
    '恢复提交时的动作层',
  );
  for (const entity of [root, bar, camera])
    assert.deepEqual(
      p.animationLayers!.filter((l) => l.entityId === entity.id),
      snapshot.animationLayers!.filter((l) => l.entityId === entity.id),
    );
  await page.getByRole('button', { name: '刷新', exact: true }).click();
  await page.waitForFunction(
    (r) => document.querySelector('.save-status')?.textContent?.includes(`r${r}`),
    p.revision,
  );
  await page.getByRole('button', { name: '成片预览', exact: true }).click();
  const run = promisify(execFile);
  const probe = JSON.parse(
    (
      await run(ffprobePath(), ['-v', 'error', '-show_streams', '-of', 'json', mp4Path], {
        windowsHide: true,
      })
    ).stdout,
  );
  assert.equal(probe.streams[0].nb_frames, '48');
  const samples = [0, 6, 12, 23, 24, 28, 35, 47].map((frame) => ({
    frame,
    source: frame < 24 ? frame : 71 - frame,
  }));
  // Analytic reference poses use known fixture values; no product track/layer evaluator.
  const poses = samples.map(({ source: f }) => {
    const envelope = Math.min(1, f / 12, (48 - f) / 8),
      w = 0.5 * envelope,
      r = 0.6 * envelope;
    const rotation = new Quaternion(...q('z', ((Math.PI / 2) * f) / 48))
      .slerp(new Quaternion(...q('y', Math.PI / 3)), r)
      .multiply(new Quaternion(...q('x', (Math.PI / 6) * 0.35)))
      .toArray();
    return {
      position: [(-1 + (2 * f) / 48) * (1 - w) + w + 0.125, 1.1, 0],
      rotation,
      scale: [1 - 0.3 * r, 1 + 0.4 * r, 1],
      camera: [0, 1.1, 7],
    };
  });
  const references = referenceRenderer
    ? await page.evaluate(
        async ({ project, sceneId, rootId, barId, cameraId, poses }) => {
          const path = '/src/render/scene.ts';
          const { SceneRenderer } = await import(/* @vite-ignore */ path);
          const renderer = new SceneRenderer(),
            copy = structuredClone(project),
            images: string[] = [];
          copy.animationTracks = [];
          copy.animationLayers = [];
          try {
            for (const pose of poses) {
              copy.entities.find((e) => e.id === rootId)!.transform.position = pose.position as [
                number,
                number,
                number,
              ];
              Object.assign(copy.entities.find((e) => e.id === barId)!.transform, {
                quaternion: pose.rotation,
                scale: pose.scale,
              });
              copy.entities.find((e) => e.id === cameraId)!.transform.position = pose.camera as [
                number,
                number,
                number,
              ];
              renderer.setProject(copy, sceneId);
              await renderer.ready();
              renderer.evaluate(0);
              renderer.render(renderer.objects.get(cameraId), 480, 270);
              images.push(renderer.renderer.domElement.toDataURL('image/png').split(',')[1]);
            }
            return images;
          } finally {
            renderer.dispose();
          }
        },
        {
          project: p,
          sceneId: scene.id,
          rootId: root.id,
          barId: bar.id,
          cameraId: camera.id,
          poses,
        },
      )
    : [];
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
  const difference = (x: Buffer, y: Buffer) => {
    assert.equal(x.length, 480 * 270 * 3);
    assert.equal(x.length, y.length);
    return x.reduce((sum, v, i) => sum + Math.abs(v - y[i]), 0) / x.length;
  };
  const measurements = [];
  for (const [index, sample] of samples.entries()) {
    await cursor(sample.frame);
    const [png] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: '导出当前帧 PNG', exact: true }).click(),
    ]);
    const path = join(output, `frame-${sample.frame}.png`);
    await png.saveAs(path);
    const pixels = await decode(path),
      videoDifference = difference(pixels, await decode(mp4Path, sample.frame));
    assert.ok(videoDifference < 4);
    let referenceDifference: number | undefined;
    if (referenceRenderer) {
      const ref = join(output, `reference-${sample.frame}.png`);
      await writeFile(ref, Buffer.from(references[index], 'base64'));
      referenceDifference = difference(pixels, await decode(ref));
      assert.ok(referenceDifference < 0.03, JSON.stringify({ sample, referenceDifference }));
    }
    const redPixels = pixels.reduce(
      (n, v, i) =>
        n + Number(i % 3 === 0 && v > 90 && v > pixels[i + 1] * 1.7 && v > pixels[i + 2] * 1.7),
      0,
    );
    assert.ok(redPixels > 100);
    measurements.push({ ...sample, videoDifference, referenceDifference, redPixels });
  }
  const bundle = await api<{ project: Project; blobs: unknown[] }>(`/projects/${p.id}/export`);
  await writeFile(join(output, 'object-layers.ffstudio'), JSON.stringify(bundle));
  const restored = await api<{ project: Project }>('/projects/import', bundle);
  assert.deepEqual(restored.project.animationLayers, bundle.project.animationLayers);
  await page.getByRole('button', { name: '三维编辑', exact: true }).click();
  await page.getByLabel('场景', { exact: true }).selectOption(scene.id);
  await select(bar.name);
  await cursor(12);
  await page.locator('.animation-layer').first().locator('summary').click();
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
    referenceRenderer,
    measurements,
    pageErrors: errors,
    checks: [
      'layer creation weights fades channel masks and additive blend via UI',
      'reorder mute delete undo redo reload',
      'referenced actions protected',
      'base-action edits do not write mixed poses',
      'static GLB mixed pose and explicit animated GLB refusal',
      'fixed render snapshot after layer mutation',
      'PNG/MP4 agreement with retimed shot',
      'portable project retains layers',
    ],
  };
  await writeFile(
    join(output, referenceRenderer ? 'renderer-result.json' : 'result.json'),
    JSON.stringify(report, null, 2),
  );
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
