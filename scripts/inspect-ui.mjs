import { chromium } from 'playwright-core';
import { mkdir } from 'node:fs/promises';
await mkdir('.local/checks', { recursive: true });
const browser = await chromium.launch({
  executablePath:
    process.env.STUDIO_BROWSER_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  headless: true,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
try {
  const page = await browser.newPage({ viewport: { width: 1500, height: 1050 } });
  page.on('pageerror', (e) => console.log('PAGE ERROR', e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') console.log('CONSOLE', m.text().slice(0, 600));
  });
  page.on('response', (r) => {
    if (r.status() >= 400) console.log('HTTP', r.status(), r.url());
  });
  await page.goto(process.env.STUDIO_URL || 'http://127.0.0.1:4173', { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);
  console.log((await page.locator('body').innerText()).slice(0, 3500));
  await page.screenshot({ path: '.local/checks/inspect.png' });
} finally {
  await browser.close();
}
