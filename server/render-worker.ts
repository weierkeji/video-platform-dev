import { parentPort, workerData } from 'node:worker_threads';
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { chromium } from 'playwright-core';
import { browserPath, ffmpegPath } from './runtime';
import { id, type Project } from '../src/core/model';
import { audioMix, probeMedia } from './media';

const { jobId, origin, directory, project } = workerData as {
  jobId: string;
  origin: string;
  directory: string;
  project: Project;
};
let cancelled = false;
const abort = new AbortController();
let encoder: ReturnType<typeof spawn> | undefined;
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
parentPort!.on('message', (m) => {
  if (m === 'cancel') {
    cancelled = true;
    abort.abort();
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
  const mix = await audioMix(project, directory, abort.signal);
  check();
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
  args.push(...mix.inputs);
  if (mix.hasAudio) {
    args.push('-filter_complex', mix.filter, '-map', '0:v', '-map', '[audio]', '-c:a', 'aac');
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
  const encoded = await probeMedia(join(output, 'output.mp4'), abort.signal);
  const videoStream = encoded.streams.find((s) => s.codec_type === 'video'),
    audioStream = encoded.streams.find((s) => s.codec_type === 'audio');
  const expectedDuration = project.timeline.duration / fps;
  if (
    !videoStream ||
    videoStream.width !== project.timeline.width ||
    videoStream.height !== project.timeline.height ||
    Math.abs(Number(videoStream.duration) - expectedDuration) > 1 / fps ||
    !Number.isFinite(Number(videoStream.duration))
  )
    throw new Error('编码结果的视频尺寸或时长校验失败');
  if (
    mix.hasAudio &&
    (!audioStream ||
      !Number.isFinite(Number(audioStream.duration)) ||
      Math.abs(Number(audioStream.duration) - expectedDuration) > 0.1 ||
      Math.abs(Number(audioStream.start_time || 0)) > 0.05)
  )
    throw new Error('编码结果的音轨时长或时间戳校验失败');
  const path = join(output, 'output.mp4'),
    bytes = (await stat(path)).size,
    sha256 = createHash('sha256')
      .update(await readFile(path))
      .digest('hex');
  parentPort!.postMessage({
    type: 'done',
    hasAudio: mix.hasAudio,
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
    abort.abort();
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
