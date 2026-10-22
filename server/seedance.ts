import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  validateGeneration,
  type GenerationRequest,
  type ProviderStatus,
} from '../src/core/generation';
import type { Project } from '../src/core/model';

const endpoint = 'https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks';
const token = z.string().regex(/^[a-zA-Z0-9._-]{1,200}$/);
const TaskSchema = z.object({
  id: token,
  status: z.enum(['queued', 'running', 'succeeded', 'failed', 'cancelled', 'expired']),
  content: z.object({ video_url: z.string().optional() }).optional(),
});
export type RemoteTask = z.infer<typeof TaskSchema>;
export function providerStatus(): ProviderStatus {
  const key = !!process.env.ARK_API_KEY?.trim();
  const enabled = process.env.STUDIO_ENABLE_PAID_GENERATION === 'true';
  return {
    id: 'seedance',
    status: !key ? 'missing-credentials' : enabled ? 'configured' : 'disabled',
    message: !key
      ? '未配置服务端 ARK_API_KEY'
      : !enabled
        ? '已配置凭据，付费生成尚未启用'
        : '已配置；模型权限与实际生成尚需供应商验证',
    defaultModel: process.env.STUDIO_SEEDANCE_MODEL || '',
  };
}
export function requireGeneration() {
  const state = providerStatus();
  if (state.status !== 'configured') throw new Error(state.message);
}
export class ProviderError extends Error {
  constructor(
    message: string,
    public uncertain = false,
  ) {
    super(message);
  }
}
export interface VideoProvider {
  create(
    request: GenerationRequest,
    project: Project,
    directory: string,
    signal: AbortSignal,
  ): Promise<{ id: string }>;
  get(taskId: string, signal: AbortSignal): Promise<RemoteTask>;
  cancel(taskId: string, signal: AbortSignal): Promise<void>;
}

export async function requestBody(request: GenerationRequest, project: Project, directory: string) {
  const r = validateGeneration(request);
  const content: unknown[] = [{ type: 'text', text: r.prompt }];
  for (const [ref, role] of [
    [r.firstFrameId, 'first_frame'],
    [r.lastFrameId, 'last_frame'],
  ] as const) {
    if (!ref) continue;
    const a = project.assets.find((a) => a.id === ref && a.kind === 'image');
    if (!a || !['image/png', 'image/jpeg', 'image/webp'].includes(a.mime))
      throw new Error('首尾帧请选择 PNG、JPEG 或 WebP 图片');
    if (
      !a.width ||
      !a.height ||
      Math.min(a.width, a.height) < 300 ||
      Math.max(a.width, a.height) > 6000 ||
      a.width / a.height < 0.4 ||
      a.width / a.height > 2.5
    )
      throw new Error('首尾帧边长应为 300–6000 像素，宽高比应为 0.4–2.5');
    if (a.bytes > 20 * 1024 * 1024) throw new Error('本地直传首尾帧每张最多 20 MB');
    const bytes = await readFile(join(directory, 'blobs', a.blobId));
    if (bytes.length !== a.bytes || createHash('sha256').update(bytes).digest('hex') !== a.blobId)
      throw new Error('参考图片内容校验失败');
    content.push({
      type: 'image_url',
      image_url: { url: `data:${a.mime};base64,${bytes.toString('base64')}` },
      role,
    });
  }
  return {
    model: r.model,
    content,
    duration: r.duration,
    resolution: r.resolution,
    ratio: r.ratio,
    seed: r.seed,
    watermark: r.watermark,
    ...(r.profile.startsWith('1.0') ? {} : { generate_audio: r.generateAudio }),
  };
}

export class Seedance implements VideoProvider {
  // Injected transport is only used by protocol tests. Production has no configurable proxy URL.
  constructor(private transport: typeof fetch = fetch) {}
  private async call(method: string, path: string, signal: AbortSignal, body?: unknown) {
    const key = process.env.ARK_API_KEY?.trim();
    if (!key) throw new ProviderError('未配置服务端 ARK_API_KEY');
    let response: Response;
    try {
      response = await this.transport(endpoint + path, {
        method,
        redirect: 'error',
        signal: AbortSignal.any([signal, AbortSignal.timeout(60000)]),
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      throw new ProviderError('Seedance 网络请求未完成', method === 'POST');
    }
    if (!response.ok) {
      await response.body?.cancel();
      // Never echo provider bodies, signed URLs, Authorization or prompts to logs.
      throw new ProviderError(
        `Seedance 返回 HTTP ${response.status}；请核对模型权限、参数或服务状态`,
        method === 'POST' && (response.status >= 500 || response.status === 408),
      );
    }
    try {
      const chunks: Uint8Array[] = [];
      let size = 0;
      if (response.body) {
        const reader = response.body.getReader();
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.length;
            if (size > 1024 * 1024) {
              await reader.cancel();
              throw new Error();
            }
            chunks.push(value);
          }
        } finally {
          reader.releaseLock();
        }
      }
      return JSON.parse(Buffer.concat(chunks).toString() || '{}');
    } catch {
      throw new ProviderError('Seedance 响应格式无效', method === 'POST');
    }
  }
  async create(
    request: GenerationRequest,
    project: Project,
    directory: string,
    signal: AbortSignal,
  ) {
    requireGeneration();
    const body = await requestBody(request, project, directory);
    const response = await this.call('POST', '', signal, body);
    const parsed = z.object({ id: token }).safeParse(response);
    if (!parsed.success)
      throw new ProviderError('提交响应没有有效任务 ID；请在供应商控制台核对', true);
    return parsed.data;
  }
  async get(taskId: string, signal: AbortSignal) {
    token.parse(taskId);
    const response = await this.call('GET', '/' + taskId, signal);
    const parsed = TaskSchema.safeParse(response);
    if (!parsed.success || parsed.data.id !== taskId)
      throw new ProviderError('Seedance 查询响应无效');
    return parsed.data;
  }
  async cancel(taskId: string, signal: AbortSignal) {
    token.parse(taskId);
    await this.call('DELETE', '/' + taskId, signal);
  }
}

export function resultUrl(input: string) {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new Error('供应商产物地址无效');
  }
  if (
    url.protocol !== 'https:' ||
    !url.hostname.endsWith('.volces.com') ||
    url.port ||
    url.username ||
    url.password
  )
    throw new Error('供应商产物地址不在允许的 HTTPS 域名中');
  return url;
}
