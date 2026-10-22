import { createWriteStream } from 'node:fs';
import { mkdir, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { id, type GenerationJob, type Project, type Artifact, type Asset } from '../src/core/model';
import { validateGeneration } from '../src/core/generation';
import {
  Seedance,
  ProviderError,
  resultUrl,
  providerStatus,
  requireGeneration,
  type VideoProvider,
} from './seedance';
import { probeMedia, audioOffset } from './media';
import { Store } from './store';

export function generationPlan(project: Project, workflowId: string, outputNodeId: string) {
  const workflow = project.workflows.find((w) => w.id === workflowId);
  const node = workflow?.nodes.find((n) => n.id === outputNodeId && n.kind === 'seedance');
  if (!workflow || !node) throw new Error('生成输出节点不存在');
  const sources = workflow.edges
    .filter((e) => e.to === node.id)
    .map((e) => workflow.nodes.find((n) => n.id === e.from)!);
  const prompt = sources
    .map((n) => n.text?.trim() || '')
    .filter(Boolean)
    .join('\n\n');
  return validateGeneration({
    ...node.generation,
    model: node.generation?.model || providerStatus().defaultModel,
    prompt,
  });
}

export async function downloadVideo(
  url: string,
  output: string,
  signal: AbortSignal,
  transport: typeof fetch = fetch,
) {
  let address = resultUrl(url);
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(120000)]);
  for (let redirects = 0; redirects < 5; redirects++) {
    const response = await transport(address, { redirect: 'manual', signal: deadline });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      await response.body?.cancel();
      if (!location) throw new Error('产物下载重定向无效');
      address = resultUrl(new URL(location, address).href);
      continue;
    }
    const limit = 50 * 1024 * 1024;
    if (!response.ok || !response.body || Number(response.headers.get('content-length')) > limit) {
      await response.body?.cancel();
      throw new Error('产物下载失败或超过 50 MB；可恢复原任务重新下载');
    }
    let bytes = 0;
    const hash = createHash('sha256');
    await pipeline(
      Readable.fromWeb(response.body as never),
      new Transform({
        transform(chunk, _, callback) {
          bytes += chunk.length;
          if (bytes > limit) {
            callback(new Error('生成产物超过 50 MB'));
            return;
          }
          hash.update(chunk);
          callback(null, chunk);
        },
      }),
      createWriteStream(output + '.partial'),
      { signal: deadline },
    );
    if (!bytes) throw new Error('生成产物为空');
    await rename(output + '.partial', output);
    return { bytes, sha256: hash.digest('hex') };
  }
  throw new Error('产物下载重定向过多');
}

export class GenerationJobs {
  private active?: { id: string; abort: AbortController; done: Promise<void> };
  private timer: ReturnType<typeof setTimeout>;
  private closing = false;
  constructor(
    private store: Store,
    private provider: VideoProvider = new Seedance(),
    private download: typeof downloadVideo = downloadVideo,
  ) {
    for (const job of store
      .jobs()
      .filter((j) => j.provider && ['queued', 'running'].includes(j.status))) {
      const state = job.provider!;
      if (!state.taskId && state.phase !== 'ready') {
        state.phase = 'uncertain';
        job.status = 'interrupted';
        job.message = '提交状态未知；请在供应商控制台核对任务 ID 后关联恢复，勿直接重复生成';
      } else {
        job.status = 'queued';
        job.message = state.taskId ? '等待恢复已有供应商任务' : '等待提交';
      }
      store.saveJob(job);
    }
    this.timer = setTimeout(() => this.pump(), 100);
  }
  submit(
    project: Project,
    requestKey: string,
    workflowId: string,
    outputNodeId: string,
    requestedOutputNodeId?: string,
  ) {
    this.queueRoom();
    requireGeneration();
    const request = generationPlan(project, workflowId, outputNodeId);
    const now = new Date().toISOString();
    const job = this.store.createJob(
      {
        id: id(),
        projectId: project.id,
        projectRevision: project.revision,
        kind: 'workflow',
        workflowId,
        outputNodeId: requestedOutputNodeId,
        requestKey,
        status: 'queued',
        progress: 0,
        message: '等待提交 Seedance',
        createdAt: now,
        updatedAt: now,
        provider: { id: 'seedance', request, phase: 'ready' },
      },
      project,
    );
    this.pump();
    return job;
  }
  cancel(jobId: string) {
    const { job } = this.store.job(jobId),
      state = job.provider!;
    if (!['queued', 'running', 'interrupted'].includes(job.status)) return job;
    if (!state.taskId && state.phase === 'ready') {
      job.status = 'cancelled';
      job.message = '已取消，尚未发送给供应商';
    } else {
      if (!state.taskId) throw new Error('提交尚未确认，不能宣称已取消；请核对供应商任务');
      if (state.remoteStatus && state.remoteStatus !== 'queued')
        throw new Error('供应商只允许取消排队任务；当前任务继续查询或下载');
      state.cancelRequested = true;
      job.message = '已请求取消，等待供应商状态确认';
      if (job.status === 'interrupted') job.status = 'queued';
    }
    this.store.saveJob(job);
    this.pump();
    return job;
  }
  resume(jobId: string, taskId?: string) {
    this.queueRoom();
    const { job } = this.store.job(jobId),
      state = job.provider!;
    if (job.status !== 'interrupted') throw new Error('只有中断的生成任务可以恢复');
    if (taskId) {
      if (state.taskId || !/^[a-zA-Z0-9._-]{1,200}$/.test(taskId))
        throw new Error('供应商任务 ID 无效或已关联');
      state.taskId = taskId;
    }
    if (!state.taskId) throw new Error('请先从供应商控制台取得此次请求的任务 ID');
    state.phase = 'polling';
    job.status = 'queued';
    job.message = '等待恢复查询；不会重新生成';
    this.store.saveJob(job);
    this.pump();
    return job;
  }
  retry(jobId: string, requestKey: string) {
    const { job, snapshot } = this.store.job(jobId);
    const existing = this.store.jobs(job.projectId).find((j) => j.requestKey === requestKey);
    if (existing) return existing;
    this.queueRoom();
    if (!['failed', 'cancelled'].includes(job.status))
      throw new Error('中断的生成任务请恢复查询，不能重发付费请求');
    requireGeneration();
    const now = new Date().toISOString();
    const next = this.store.createJob(
      {
        ...job,
        id: id(),
        requestKey,
        status: 'queued',
        progress: 0,
        message: '等待重新生成（新计费任务）',
        createdAt: now,
        updatedAt: now,
        artifact: undefined,
        provider: { id: 'seedance', request: job.provider!.request, phase: 'ready' },
      },
      snapshot,
    );
    this.pump();
    return next;
  }
  private queueRoom() {
    if (this.store.jobs().filter((j) => ['queued', 'running'].includes(j.status)).length >= 20)
      throw new Error('本机任务队列已满（20 项），请等待或取消任务');
  }
  pump() {
    if (this.closing || this.active) return;
    const job = this.store.jobs().find((j) => j.provider && j.status === 'queued');
    if (!job) return;
    const abort = new AbortController();
    const done = this.run(job.id, abort.signal).finally(() => {
      this.active = undefined;
      this.pump();
    });
    this.active = { id: job.id, abort, done };
  }
  private async run(jobId: string, signal: AbortSignal) {
    let { job, snapshot } = this.store.job(jobId);
    try {
      const state = job.provider!;
      job.status = 'running';
      if (!state.taskId) {
        state.phase = 'submitting';
        job.message = '正在提交给 Seedance';
        this.store.saveJob(job);
        const created = await this.provider.create(
          state.request,
          snapshot,
          this.store.directory,
          signal,
        );
        state.taskId = created.id;
        state.phase = 'polling';
        this.store.saveJob(job);
      }
      this.store.saveJob(job);
      const deadline = Date.now() + 60 * 60 * 1000;
      while (!signal.aborted && Date.now() < deadline) {
        job = this.store.job(jobId).job;
        const remote = await this.provider.get(job.provider!.taskId!, signal);
        job = this.store.job(jobId).job;
        const current = job.provider!;
        current.remoteStatus = remote.status;
        if (remote.status === 'queued' && current.cancelRequested) {
          await this.provider.cancel(current.taskId!, signal);
          current.cancelRequested = false;
          job.message = '取消请求已发送，正在确认远端状态';
        } else if (remote.status === 'succeeded') {
          if (!remote.content?.video_url) throw new Error('生成结果缺少视频地址');
          current.phase = 'downloading';
          job.message = '生成完成，正在下载并探测视频';
          this.store.saveJob(job);
          const folder = join(this.store.directory, 'renders', job.id);
          await mkdir(folder, { recursive: true });
          const path = join(folder, 'output.mp4');
          const file = await this.download(remote.content.video_url, path, signal);
          const probe = await probeMedia(path, signal);
          const stream = probe.streams.find((s) => s.codec_type === 'video');
          const duration = Number(probe.format.duration);
          if (!stream?.width || !stream.height || !Number.isFinite(duration) || duration <= 0)
            throw new Error('供应商产物不是有效视频');
          const artifact: Artifact = {
            id: id(),
            jobId,
            name: `Seedance-${job.id.slice(0, 8)}.mp4`,
            mime: 'video/mp4',
            ...file,
            createdAt: new Date().toISOString(),
          };
          const asset: Asset = {
            id: id(),
            name: artifact.name,
            kind: 'video',
            mime: 'video/mp4',
            blobId: file.sha256,
            bytes: file.bytes,
            width: stream.width,
            height: stream.height,
            duration,
            hasAudio: probe.streams.some((s) => s.codec_type === 'audio'),
            audioStart: audioOffset(probe),
          };
          await this.store.registerResult(jobId, artifact, asset, path);
          return;
        } else if (['cancelled', 'failed', 'expired'].includes(remote.status)) {
          job.status = remote.status === 'cancelled' ? 'cancelled' : 'failed';
          current.phase = 'done';
          job.message = `Seedance 任务${remote.status === 'cancelled' ? '已取消' : remote.status === 'expired' ? '已超时' : '失败'}；可在供应商控制台查看详情`;
          this.store.saveJob(job);
          return;
        } else {
          if (current.cancelRequested && remote.status === 'running')
            current.cancelRequested = false;
          job.message =
            remote.status === 'queued'
              ? 'Seedance 排队中'
              : 'Seedance 生成中；供应商不支持取消运行中的任务';
        }
        this.store.saveJob(job);
        await delay(5000, undefined, { signal });
      }
      throw new Error('本地等待超时');
    } catch (error) {
      job = this.store.job(jobId).job;
      const state = job.provider!;
      const uncertain =
        state.taskId || (error instanceof ProviderError && error.uncertain) || signal.aborted;
      job.status = uncertain ? 'interrupted' : 'failed';
      if (!state.taskId && uncertain) state.phase = 'uncertain';
      job.message = state.taskId
        ? '查询或下载中断；可恢复已有任务，不会重新生成'
        : uncertain
          ? '提交结果未知；请在供应商控制台核对并关联任务 ID，避免重复计费'
          : error instanceof ProviderError
            ? error.message
            : '生成提交失败；请检查输入图片和生成参数';
      this.store.saveJob(job);
    }
  }
  async close() {
    this.closing = true;
    clearTimeout(this.timer);
    this.active?.abort.abort();
    await this.active?.done;
  }
}
