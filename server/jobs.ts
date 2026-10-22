import { Worker } from 'node:worker_threads';
import { mkdirSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  id,
  workflowOrder,
  type Artifact,
  type GenerationJob,
  type Project,
} from '../src/core/model';
import { Store } from './store';

export class Jobs {
  active?: { id: string; worker: Worker };
  closing = false;
  constructor(
    public store: Store,
    public origin: string,
  ) {
    for (const job of store.jobs())
      if (job.status === 'running') {
        job.status = 'interrupted';
        job.message = '服务中断；可重试原始快照';
        store.saveJob(job);
      }
    setTimeout(() => this.pump(), 100);
  }
  submit(project: Project, requestKey: string, kind: 'render' | 'workflow', workflowId?: string) {
    if (project.timeline.duration > 2400)
      throw new Error('此版本单次后台导出最多 2400 帧；请先缩短时间轴');
    if (project.timeline.duration * project.timeline.width * project.timeline.height > 500_000_000)
      throw new Error('当前单任务最多渲染 5 亿像素帧，请缩短时长或降低分辨率');
    if (
      this.store.jobs().filter((j) => j.status === 'queued' || j.status === 'running').length >= 20
    )
      throw new Error('本机任务队列已满（20 项），请等待或取消任务');
    if (kind === 'workflow') {
      const workflow = project.workflows.find((w) => w.id === workflowId);
      if (!workflow) throw new Error('工作流不存在');
      const nodes = workflowOrder(workflow);
      if (nodes.some((n) => n.kind === 'seedance'))
        throw new Error('Seedance 适配器尚未接入；此工作流不能执行外部生成');
      const outputs = nodes.filter((n) => n.kind === 'render');
      if (
        outputs.length !== 1 ||
        !workflow.edges.some(
          (e) => e.to === outputs[0].id && nodes.find((n) => n.id === e.from)?.kind === 'timeline',
        )
      )
        throw new Error('当前本地工作流需要一个时间轴节点连接一个渲染节点');
    }
    const now = new Date().toISOString(),
      job: GenerationJob = {
        id: id(),
        projectId: project.id,
        projectRevision: project.revision,
        kind,
        status: 'queued',
        progress: 0,
        message: '等待渲染资源',
        createdAt: now,
        updatedAt: now,
        requestKey,
      };
    const result = this.store.createJob(job, project);
    this.pump();
    return result;
  }
  cancel(jobId: string) {
    const { job } = this.store.job(jobId);
    if (!['queued', 'running'].includes(job.status)) return job;
    job.status = 'cancelled';
    job.message = '已取消';
    this.store.saveJob(job);
    if (this.active?.id === jobId) this.active.worker.postMessage('cancel');
    return job;
  }
  retry(jobId: string, requestKey: string) {
    const { job, snapshot } = this.store.job(jobId);
    if (!['failed', 'cancelled', 'interrupted'].includes(job.status))
      throw new Error('仅可重试失败、取消或中断的任务');
    return this.submit(snapshot, requestKey, 'render');
  }
  pump() {
    if (this.active || this.closing) return;
    const job = this.store.jobs().find((j) => j.status === 'queued');
    if (!job) return;
    const { snapshot } = this.store.job(job.id);
    job.status = 'running';
    job.message = '启动渲染工作线程';
    this.store.saveJob(job);
    const worker = new Worker(new URL('./worker-bootstrap.mjs', import.meta.url), {
      workerData: {
        jobId: job.id,
        origin: this.origin,
        directory: this.store.directory,
        project: snapshot,
      },
      resourceLimits: { maxOldGenerationSizeMb: 512 },
    });
    this.active = { id: job.id, worker };
    worker.on(
      'message',
      (message: {
        type: string;
        progress?: number;
        message?: string;
        artifact?: Artifact;
        hasAudio?: boolean;
      }) => {
        const current = this.store.job(job.id).job;
        if (current.status === 'cancelled') return;
        if (message.type === 'progress') {
          current.progress = message.progress!;
          current.message = message.message!;
        }
        if (message.type === 'done') {
          try {
            const artifact = message.artifact!;
            mkdirSync(join(this.store.directory, 'blobs'), { recursive: true });
            copyFileSync(
              join(this.store.directory, 'renders', job.id, 'output.mp4'),
              join(this.store.directory, 'blobs', artifact.sha256),
            );
            this.store.addBlob(artifact.sha256, artifact.mime, artifact.bytes);
            const latest = this.store.get(job.projectId).project;
            this.store.change(
              latest.id,
              latest.revision,
              [
                { type: 'artifact.add', artifact },
                {
                  type: 'asset.add',
                  asset: {
                    id: id(),
                    name: artifact.name,
                    kind: 'video',
                    mime: 'video/mp4',
                    blobId: artifact.sha256,
                    bytes: artifact.bytes,
                    duration: snapshot.timeline.duration / snapshot.timeline.fps,
                    width: snapshot.timeline.width,
                    height: snapshot.timeline.height,
                    hasAudio: message.hasAudio,
                    audioStart: 0,
                  },
                },
              ],
              'system',
              '导出结果加入素材库',
            );
            current.status = 'succeeded';
            current.progress = 1;
            current.message = '导出完成；成片已加入项目素材库';
            current.artifact = artifact;
          } catch (error) {
            current.status = 'failed';
            current.message = `登记导出结果失败：${String(error)}`;
          }
        }
        if (message.type === 'error') {
          current.status = 'failed';
          current.message = message.message!;
        }
        this.store.saveJob(current);
      },
    );
    worker.on('error', (error) => {
      const current = this.store.job(job.id).job;
      if (current.status !== 'cancelled') {
        current.status = 'failed';
        current.message = String(error);
        this.store.saveJob(current);
      }
    });
    worker.on('exit', () => {
      const current = this.store.job(job.id).job;
      if (current.status === 'running') {
        current.status = 'failed';
        current.message = '渲染工作线程异常退出';
        this.store.saveJob(current);
      }
      this.active = undefined;
      this.pump();
    });
  }
  async close() {
    this.closing = true;
    const active = this.active;
    if (active) {
      active.worker.postMessage('cancel');
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          void active.worker.terminate().then(() => resolve());
        }, 5000);
        active.worker.once('exit', () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  }
}
