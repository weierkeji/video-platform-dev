import { existsSync } from 'node:fs';
export function browserPath() {
  const candidate = [
    process.env.STUDIO_BROWSER_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ].find((p) => p && existsSync(p));
  if (!candidate) throw new Error('未找到 Chrome / Chromium / Edge，请配置 STUDIO_BROWSER_PATH');
  return candidate;
}
export const ffmpegPath = () => process.env.STUDIO_FFMPEG_PATH || 'ffmpeg';
export const ffprobePath = () =>
  process.env.STUDIO_FFPROBE_PATH ||
  (process.env.STUDIO_FFMPEG_PATH
    ? ffmpegPath().replace(/ffmpeg(\.exe)?$/i, 'ffprobe$1')
    : 'ffprobe');
