import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const output = resolve('.local/research');
await mkdir(output, { recursive: true });
const browser = await chromium.launch({
  executablePath:
    process.env.STUDIO_BROWSER_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  headless: true,
  args: ['--remote-debugging-port=9226'],
  timeout: 30000,
});
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  await page.goto('https://www.liblib.tv/', { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForTimeout(2500);
  const text = await page.locator('body').innerText();
  await writeFile(resolve(output, 'libtv-public.txt'), text);
  await page.screenshot({ path: resolve(output, 'libtv-public.png') });
  const targets = await (await fetch('http://127.0.0.1:9226/json/list')).json();
  const target = targets.find(
    (t) => t.type === 'page' && t.url.startsWith('https://www.liblib.tv/'),
  );
  if (!target) throw new Error('Public page target not found');
  const args = [
    '.local/research-tools/node_modules/rea-agents/scripts/rea.mjs',
    'inspect-web-page',
    'http://127.0.0.1:9226',
    target.id,
    '--allowed-origins',
    'https://www.liblib.tv',
    '--include-accessibility-text',
    '--observation-ms',
    '1000',
    '--format',
    'json',
  ];
  const result = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { windowsHide: true });
    let stdout = '',
      stderr = '';
    child.stdout.on('data', (b) => (stdout += b));
    child.stderr.on('data', (b) => (stderr += b));
    child.on('error', reject);
    child.on('exit', (code) => resolve({ code, stdout, stderr }));
  });
  await writeFile(resolve(output, 'rea-libtv-public.json'), result.stdout);
  await writeFile(resolve(output, 'rea-stderr.txt'), result.stderr);
  const summary = {
    observedAt: new Date().toISOString(),
    reaVersion: '6.7.0',
    browser: browser.version(),
    url: page.url(),
    title: await page.title(),
    reaExitCode: result.code,
    bodyExcerpt: text.slice(0, 1800),
    limits: [
      'Fresh unauthenticated public page only',
      'No private API use',
      'No script-source capture',
      'No server-side algorithm or model access',
    ],
  };
  await writeFile(resolve(output, 'summary.json'), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
} finally {
  await browser.close();
}
