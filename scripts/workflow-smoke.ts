import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { chromium } from 'playwright-core';
import { browserPath } from '../server/runtime';
import { id, type Project, type GenerationJob } from '../src/core/model';

const origin = process.env.STUDIO_URL || 'http://127.0.0.1:4173';
const directory = resolve('.local/checks/workflow');
await mkdir(directory, { recursive: true });
async function api<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(origin + '/api' + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Studio-Client': 'frameforge' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await response.json();
  if (!response.ok) throw new Error(json.error);
  return json;
}
const health = await api<{ version: string; providers: { status: string; message: string }[] }>(
  '/health',
);
assert.ok(
  ['missing-credentials', 'disabled'].includes(health.providers[0].status),
  'This check must run with paid generation disabled',
);
let p = (
  await api<{ project: Project }>('/projects', {
    name: `工作流集成检查 ${new Date().toISOString().slice(0, 19)}`,
  })
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
  await page.getByRole('button', { name: '工作流', exact: true }).click();
  await page.getByLabel('节点类型').selectOption('prompt');
  await page.getByRole('button', { name: '添加节点', exact: true }).click();
  await page.getByLabel('提示词', { exact: true }).fill('海面上方的摄影机缓缓向前移动');
  await page.getByLabel('提示词', { exact: true }).press('Tab');
  await page.waitForTimeout(200);
  await page.getByLabel('节点类型').selectOption('seedance');
  await page.getByRole('button', { name: '添加节点', exact: true }).click();
  await page.getByLabel('模型 ID').fill('doubao-seedance-2-0-260128');
  await page.getByLabel('模型 ID').press('Tab');
  await page.waitForTimeout(200);
  await page.getByLabel('生成时长').fill('6');
  await page.getByLabel('生成时长').press('Tab');
  await page.waitForTimeout(200);
  p = (await api<{ project: Project }>(`/projects/${p.id}`)).project;
  const workflow = p.workflows[0],
    prompt = workflow.nodes.find((n) => n.kind === 'prompt')!,
    generator = workflow.nodes.find((n) => n.kind === 'seedance')!;
  await page.getByLabel('连接源节点').selectOption(prompt.id);
  await page.getByLabel('连接目标节点').selectOption(generator.id);
  await page.getByRole('button', { name: '连接', exact: true }).click();
  await page.waitForTimeout(200);
  assert.equal(await page.getByRole('button', { name: '生成视频（付费）' }).isDisabled(), true);
  await page.reload({ waitUntil: 'networkidle' });
  await page.getByRole('button', { name: '工作流', exact: true }).click();
  assert.equal(await page.getByLabel('生成时长').inputValue(), '6');
  assert.equal(
    await page.getByLabel('提示词', { exact: true }).inputValue(),
    '海面上方的摄影机缓缓向前移动',
  );
  p = (await api<{ project: Project }>(`/projects/${p.id}`)).project;
  const requestKey = id();
  await assert.rejects(
    () =>
      api(`/projects/${p.id}/jobs`, {
        baseRevision: p.revision,
        kind: 'workflow',
        workflowId: workflow.id,
        outputNodeId: generator.id,
        requestKey,
      }),
    /未配置|未启用/,
  );
  assert.equal((await api<GenerationJob[]>(`/projects/${p.id}/jobs`)).length, 0);
  await page.screenshot({ path: join(directory, 'workflow.png'), fullPage: true });
  await page.getByLabel('模型 ID').scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(directory, 'settings.png'), fullPage: true });
  // A configured graph must not prevent the independent local renderer from executing.
  p = (
    await api<{ project: Project }>(`/projects/${p.id}/commands`, {
      baseRevision: p.revision,
      label: '短片本地渲染',
      commands: [
        { type: 'clip.update', id: p.timeline.clips[0].id, patch: { duration: 12 } },
        { type: 'timeline.update', patch: { duration: 12, width: 320, height: 180 } },
      ],
    })
  ).project;
  const local = await api<GenerationJob>(`/projects/${p.id}/jobs`, {
    baseRevision: p.revision,
    kind: 'workflow',
    workflowId: workflow.id,
    outputNodeId: workflow.nodes.find((n) => n.kind === 'render')!.id,
    requestKey: id(),
  });
  let result = local;
  const deadline = Date.now() + 120000;
  while (['queued', 'running'].includes(result.status) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 500));
    result = await api<GenerationJob>(`/jobs/${local.id}`);
  }
  assert.equal(result.status, 'succeeded', result.message);
  assert.equal(result.provider, undefined);
  const bundle = await api<{ project: Project }>(`/projects/${p.id}/export`);
  await writeFile(join(directory, 'workflow.ffstudio'), JSON.stringify(bundle));
  const imported = await api<{ project: Project }>('/projects/import', bundle);
  assert.equal(
    imported.project.workflows[0].nodes.find((n) => n.id === generator.id)?.generation?.duration,
    6,
  );
  assert.deepEqual(errors, []);
  const report = {
    checkedAt: new Date().toISOString(),
    version: health.version,
    browser: browser.version(),
    projectId: p.id,
    provider: health.providers[0],
    externalGenerationExecuted: false,
    localJobId: local.id,
    checks: [
      'prompt and parameter editing',
      'typed graph connection',
      'reload persistence',
      'disabled paid action',
      'server missing-configuration rejection without job',
      'independent local output',
      'portable generation configuration reimport',
    ],
    pageErrors: errors,
  };
  await writeFile(join(directory, 'result.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser.close();
}
