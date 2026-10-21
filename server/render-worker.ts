import { parentPort, workerData } from 'node:worker_threads';
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { chromium } from 'playwright-core';
import { browserPath, ffmpegPath } from './runtime';
import { id, type Project } from '../src/core/model';

const { jobId, origin, directory, project } = workerData as {
  jobId: string;
  origin: string;
  directory: string;
  project: Project;
};
let cancelled = false;
let encoder: ReturnType<typeof spawn> | undefined;
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
parentPort!.on('message', (m) => {
  if (m === 'cancel') {
    cancelled = true;
    encoder?.kill();
    void browser?.close();
  }
});
function check() {
  if (cancelled) throw new Error('任务已取消');
}
async function encode(args: string[]) {
  check();
  await new Promise<void>((resolve, reject) => {
    encoder = spawn(ffmpegPath(), args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    let error = '';
    encoder.stderr!.on('data', (b) => {
      error = (error + b.toString()).slice(-3000);
    });
    encoder.on('error', reject);
    encoder.on('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`FFmpeg 失败 (${code})：${error}`)),
    );
  });
}
async function run() {
  const output = join(directory, 'renders', jobId),
    frames = join(output, 'frames');
  await mkdir(frames, { recursive: true });
  browser = await chromium.launch({
    executablePath: browserPath(),
    headless: true,
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
    timeout: 30000,
  });
  const page = await browser.newPage();
  await page.goto(`${origin}/?render=1&job=${jobId}`, { waitUntil: 'networkidle' });
  await page.waitForFunction(
    () => window.studioReady || window.studioError,
    {},
    { timeout: 30000 },
  );
  const error = await page.evaluate(() => window.studioError);
  if (error) throw new Error(error);
  for (let frame = 0; frame < project.timeline.duration; frame++) {
    check();
    const png = await page.evaluate(async (frame) => window.studioRender!(frame), frame);
    await writeFile(
      join(frames, `${String(frame).padStart(6, '0')}.png`),
      Buffer.from(png, 'base64'),
    );
    parentPort!.postMessage({
      type: 'progress',
      progress: ((frame + 1) / project.timeline.duration) * 0.85,
      message: `渲染帧 ${frame + 1} / ${project.timeline.duration}`,
    });
  }
  await browser.close();
  browser = undefined;
  check();
  const fps = project.timeline.fps,
    args = [
      '-y',
      '-hide_banner',
      '-loglevel',
      'error',
      '-framerate',
      String(fps),
      '-i',
      join(frames, '%06d.png'),
    ];
  const audioClips = project.timeline.clips.filter((c) => !c.muted && c.kind === 'audio');
  // Video sound requires a separate audio asset in v0.1; fail explicitly if it would be silently omitted.
  if (project.timeline.clips.some((c) => !c.muted && c.kind === 'video' && c.volume > 0))
    throw new Error('当前视频片段导出需将音量设为 0；如需原声，请另导入音频轨道');
  for (const clip of audioClips)
    args.push(
      '-i',
      join(directory, 'blobs', project.assets.find((a) => a.id === clip.sourceId)!.blobId),
    );
  if (audioClips.length) {
    const filters = audioClips.map(
      (c, i) =>
        `[${i + 1}:a]atrim=start=${c.sourceIn / fps}:duration=${c.duration / fps},asetpts=PTS-STARTPTS,volume=${c.volume},adelay=${Math.round((c.start / fps) * 1000)}:all=1[a${i}]`,
    );
    filters.push(
      `${audioClips.map((_, i) => `[a${i}]`).join('')}amix=inputs=${audioClips.length}:duration=longest:normalize=0,apad[audio]`,
    );
    args.push(
      '-filter_complex',
      filters.join(';'),
      '-map',
      '0:v',
      '-map',
      '[audio]',
      '-c:a',
      'aac',
    );
  }
  args.push(
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    '-crf',
    '18',
    '-movflags',
    '+faststart',
    '-t',
    String(project.timeline.duration / fps),
    join(output, 'output.mp4'),
  );
  parentPort!.postMessage({ type: 'progress', progress: 0.9, message: '编码 MP4' });
  await encode(args);
  check();
  const path = join(output, 'output.mp4'),
    bytes = (await stat(path)).size,
    sha256 = createHash('sha256')
      .update(await readFile(path))
      .digest('hex');
  parentPort!.postMessage({
    type: 'done',
    artifact: {
      id: id(),
      jobId,
      name: `${project.name}.mp4`,
      mime: 'video/mp4',
      bytes,
      sha256,
      createdAt: new Date().toISOString(),
    },
  });
}
const deadline = setTimeout(
  () => {
    cancelled = true;
    encoder?.kill();
    void browser?.close();
  },
  30 * 60 * 1000,
);
run()
  .catch((error) =>
    parentPort!.postMessage({
      type: 'error',
      message: cancelled ? '任务已取消或达到 30 分钟上限' : String(error),
    }),
  )
  .finally(async () => {
    clearTimeout(deadline);
    encoder?.kill();
    await browser?.close().catch(() => {});
    parentPort!.close();
  });
