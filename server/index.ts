import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import {
  createReadStream,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve, extname } from 'node:path';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { createServer as createViteServer } from 'vite';
import { Store, Conflict } from './store';
import { Jobs } from './jobs';
import { providerStatus } from './seedance';
import { browserPath } from './runtime';
import { probeMedia, audioOffset } from './media';
import { AssetSchema, id, migrateProject, type Asset, type Project } from '../src/core/model';
import { newProject } from '../src/core/factory';

const port = Number(process.env.PORT || 4173),
  host = '127.0.0.1',
  origin = `http://${host}:${port}`;
const directory = resolve(process.env.STUDIO_DATA_DIR || '.local/data');
mkdirSync(join(directory, 'blobs'), { recursive: true });
const store = new Store(directory),
  jobs = new Jobs(store, origin);
if (!store.list().length) store.create(newProject('我的第一部作品'));
const production = process.argv.includes('--production');
const vite = production
  ? null
  : await createViteServer({
      server: {
        middlewareMode: true,
        host,
        fs: {
          strict: true,
          deny: ['.env', '.env.*', '**/.git/**', '**/.local/**', '**/server/**'],
        },
      },
      appType: 'spa',
    });
function json(res: ServerResponse, value: unknown, status = 200) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(JSON.stringify(value));
}
async function body(req: IncomingMessage, max = 100 * 1024 * 1024) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > max) throw new Error('请求超过大小限制');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
async function data(req: IncomingMessage) {
  return JSON.parse((await body(req)).toString('utf8'));
}
function file(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  mime: string,
  attachment?: string,
) {
  if (!existsSync(path)) {
    json(res, { error: '文件不存在' }, 404);
    return;
  }
  const size = statSync(path).size,
    headers: Record<string, string | number> = {
      'Content-Type': mime,
      'Accept-Ranges': 'bytes',
      'X-Content-Type-Options': 'nosniff',
    };
  if (attachment)
    headers['Content-Disposition'] =
      `attachment; filename*=UTF-8''${encodeURIComponent(attachment)}`;
  const range = req.headers.range;
  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (!m) {
      res.writeHead(416);
      res.end();
      return;
    }
    let start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2])),
      end = m[1] ? (m[2] ? Math.min(size - 1, Number(m[2])) : size - 1) : size - 1;
    if (start > end || start >= size) {
      res.writeHead(416, { 'Content-Range': `bytes */${size}` });
      res.end();
      return;
    }
    res.writeHead(206, {
      ...headers,
      'Content-Range': `bytes ${start}-${end}/${size}`,
      'Content-Length': end - start + 1,
    });
    createReadStream(path, { start, end }).pipe(res);
  } else {
    res.writeHead(200, { ...headers, 'Content-Length': size });
    createReadStream(path).pipe(res);
  }
}
function ensureAssets(p: Project) {
  for (const a of p.assets) {
    const b = store.blob(a.blobId);
    if (!b || b.bytes !== a.bytes || b.mime !== a.mime)
      throw new Error(`缺失或不匹配的素材：${a.name}，请导入含素材的项目包`);
  }
}
function commandAssets(input: unknown) {
  if (Array.isArray(input))
    for (const c of input) {
      if (c?.type === 'artifact.add') throw new Error('导出产物仅由后台任务登记');
      if (c?.type === 'asset.add') {
        const b = store.blob(c.asset?.blobId);
        if (!b || b.bytes !== c.asset.bytes || b.mime !== c.asset.mime)
          throw new Error('素材必须先上传');
      }
    }
}
async function upload(req: IncomingMessage) {
  const bytes = await body(req, 50 * 1024 * 1024),
    mime = String(req.headers['content-type'] || '').split(';')[0];
  const supported = [
    'image/png',
    'image/jpeg',
    'image/webp',
    'video/mp4',
    'video/webm',
    'audio/wav',
    'audio/x-wav',
    'audio/mpeg',
    'audio/ogg',
  ];
  if (!supported.includes(mime) || !bytes.length)
    throw new Error('支持 PNG/JPEG/WebP、MP4/WebM、WAV/MP3/OGG，单文件不超过 50 MB');
  const blobId = createHash('sha256').update(bytes).digest('hex'),
    path = join(directory, 'blobs', blobId);
  writeFileSync(path, bytes);
  const probe = await probeMedia(path),
    kind = mime.split('/')[0] as Asset['kind'];
  const stream = probe.streams?.find(
    (s: { codec_type: string }) => s.codec_type === (kind === 'image' ? 'video' : kind),
  );
  if (!stream) throw new Error('素材内容与类型不匹配');
  const asset: Asset = {
    id: id(),
    name: decodeURIComponent(String(req.headers['x-file-name'] || '素材')).slice(0, 160),
    kind,
    mime: mime as Asset['mime'],
    blobId,
    bytes: bytes.length,
    hasAudio: probe.streams.some((s) => s.codec_type === 'audio'),
    audioStart: audioOffset(probe),
  };
  if (stream.width) asset.width = stream.width;
  if (stream.height) asset.height = stream.height;
  if (kind !== 'image') {
    const duration = Number(probe.format?.duration || stream.duration);
    if (!Number.isFinite(duration) || duration <= 0) throw new Error('无法读取媒体时长');
    asset.duration = duration;
  }
  store.addBlob(blobId, mime, bytes.length);
  return asset;
}
const server = createServer(async (req, res) => {
  try {
    if (![`${host}:${port}`, `localhost:${port}`].includes(req.headers.host || '')) {
      json(res, { error: '仅支持本地访问' }, 403);
      return;
    }
    const url = new URL(req.url!, origin),
      parts = url.pathname.split('/').filter(Boolean);
    if (url.pathname === '/favicon.ico') {
      res.writeHead(204);
      res.end();
      return;
    }
    if (parts[0] !== 'api') {
      if (vite) {
        vite.middlewares(req, res);
        return;
      }
      const requested = decodeURIComponent(url.pathname),
        path = resolve('dist', '.' + requested);
      if (
        !path.startsWith(resolve('dist') + '\\') &&
        !path.startsWith(resolve('dist') + '/') &&
        path !== resolve('dist')
      ) {
        json(res, { error: '无效路径' }, 400);
        return;
      }
      const target =
        existsSync(path) && statSync(path).isFile() ? path : resolve('dist/index.html');
      const mime =
        (
          {
            '.html': 'text/html; charset=utf-8',
            '.js': 'text/javascript',
            '.css': 'text/css',
            '.svg': 'image/svg+xml',
            '.png': 'image/png',
            '.json': 'application/json',
          } as Record<string, string>
        )[extname(target)] || 'application/octet-stream';
      file(req, res, target, mime);
      return;
    }
    if (
      !['GET', 'HEAD'].includes(req.method || '') &&
      (req.headers['x-studio-client'] !== 'frameforge' ||
        (req.headers.origin && ![origin, `http://localhost:${port}`].includes(req.headers.origin)))
    ) {
      json(res, { error: '请求来源不被允许' }, 403);
      return;
    }
    if (parts[1] === 'health') {
      let browser: string | null = null;
      try {
        browser = browserPath();
      } catch {}
      json(res, {
        status: 'ok',
        version: '0.6.0',
        browser: !!browser,
        providers: [providerStatus()],
      });
      return;
    }
    if (parts[1] === 'blobs') {
      if (req.method === 'POST') {
        json(res, await upload(req), 201);
        return;
      }
      const blob = store.blob(parts[2]);
      if (!blob || !/^[a-f0-9]{64}$/.test(blob.id)) throw new Error('素材不存在');
      file(req, res, join(directory, 'blobs', blob.id), blob.mime);
      return;
    }
    if (parts[1] === 'projects') {
      const projectId = parts[2],
        action = parts[3];
      if (!projectId) {
        if (req.method === 'GET') json(res, store.list());
        else if (req.method === 'POST') {
          const input = await data(req);
          json(res, store.create(newProject(z.string().min(1).max(160).parse(input.name))), 201);
        } else json(res, { error: '方法不支持' }, 405);
        return;
      }
      if (projectId === 'import' && req.method === 'POST') {
        const input = await data(req),
          project = migrateProject(input.project || input);
        if (input.blobs) {
          const blobs = z
            .array(
              z
                .object({
                  id: z.string().regex(/^[a-f0-9]{64}$/),
                  mime: AssetSchema.shape.mime,
                  base64: z.string().max(70 * 1024 * 1024),
                })
                .strict(),
            )
            .max(10000)
            .parse(input.blobs);
          for (const blob of blobs) {
            const bytes = Buffer.from(blob.base64, 'base64');
            if (createHash('sha256').update(bytes).digest('hex') !== blob.id)
              throw new Error('项目包素材校验失败');
            writeFileSync(join(directory, 'blobs', blob.id), bytes);
            store.addBlob(blob.id, blob.mime, bytes.length);
          }
        }
        ensureAssets(project);
        json(res, store.create(project), 201);
        return;
      }
      const envelope = store.get(projectId);
      if (req.method === 'GET' && !action) {
        json(res, envelope);
        return;
      }
      if (req.method === 'GET' && action === 'export') {
        const unique = [...new Set(envelope.project.assets.map((a) => a.blobId))];
        const total = unique.reduce((n, id) => n + (store.blob(id)?.bytes || 0), 0);
        if (total > 65 * 1024 * 1024)
          throw new Error('便携项目包当前最多包含 65 MB 素材；完整项目仍保存在本地数据目录');
        const blobs = unique.map((id) => ({
          id,
          mime: store.blob(id)!.mime,
          base64: readFileSync(join(directory, 'blobs', id)).toString('base64'),
        }));
        res.setHeader(
          'Content-Disposition',
          `attachment; filename*=UTF-8''${encodeURIComponent(envelope.project.name)}.ffstudio`,
        );
        json(res, { project: envelope.project, blobs });
        return;
      }
      if (action === 'revisions' && req.method === 'GET') {
        json(res, store.revisions(projectId));
        return;
      }
      if (action === 'jobs' && req.method === 'GET') {
        json(res, store.jobs(projectId));
        return;
      }
      if (action === 'jobs' && req.method === 'POST') {
        const input = z
          .object({
            baseRevision: z.number().int(),
            requestKey: z.string().uuid(),
            kind: z.enum(['render', 'workflow']),
            workflowId: z.string().optional(),
            outputNodeId: z.string().uuid().optional(),
          })
          .strict()
          .parse(await data(req));
        const existing = store.jobs(projectId).find((j) => j.requestKey === input.requestKey);
        if (existing) {
          if (
            existing.projectRevision !== input.baseRevision ||
            existing.kind !== input.kind ||
            existing.workflowId !== input.workflowId ||
            existing.outputNodeId !== input.outputNodeId
          )
            throw new Conflict('此提交键已用于不同的任务，请使用新键');
          json(res, existing, 202);
          return;
        }
        if (input.baseRevision !== envelope.project.revision)
          throw new Conflict('导出前请刷新最新项目');
        json(
          res,
          jobs.submit(
            envelope.project,
            input.requestKey,
            input.kind,
            input.workflowId,
            input.outputNodeId,
          ),
          202,
        );
        return;
      }
      if (['commands', 'undo', 'redo', 'restore'].includes(action) && req.method === 'POST') {
        const input = z
          .object({
            baseRevision: z.number().int().nonnegative(),
            actor: z.enum(['user', 'agent']).default('user'),
            label: z.string().min(1).max(160),
            commands: z.unknown().optional(),
            revisionId: z.string().optional(),
          })
          .strict()
          .parse(await data(req));
        commandAssets(input.commands);
        json(
          res,
          store.change(
            projectId,
            input.baseRevision,
            action === 'restore' ? input.revisionId : input.commands,
            input.actor,
            input.label,
            action as 'commands',
          ),
        );
        return;
      }
    }
    if (parts[1] === 'jobs') {
      const jobId = parts[2],
        action = parts[3],
        { job, snapshot } = store.job(jobId);
      if (req.method === 'GET' && action === 'snapshot') {
        json(res, snapshot);
        return;
      }
      if (req.method === 'GET' && action === 'artifact' && job.artifact) {
        file(
          req,
          res,
          join(directory, 'renders', job.id, 'output.mp4'),
          'video/mp4',
          job.artifact.name,
        );
        return;
      }
      if (req.method === 'POST' && action === 'cancel') {
        json(res, jobs.cancel(jobId));
        return;
      }
      if (req.method === 'POST' && action === 'retry') {
        const input = z
          .object({ requestKey: z.string().uuid() })
          .strict()
          .parse(await data(req));
        json(res, jobs.retry(jobId, input.requestKey), 202);
        return;
      }
      if (req.method === 'POST' && action === 'resume') {
        if (!job.provider) throw new Error('本地渲染请使用重试');
        const input = z
          .object({ taskId: z.string().max(200).optional() })
          .strict()
          .parse(await data(req));
        json(res, jobs.generation.resume(jobId, input.taskId), 202);
        return;
      }
      if (req.method === 'GET' && !action) {
        json(res, job);
        return;
      }
    }
    json(res, { error: '接口不存在' }, 404);
  } catch (error) {
    const message =
      error instanceof z.ZodError
        ? error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')
        : error instanceof Error
          ? error.message
          : String(error);
    json(res, { error: message }, error instanceof Conflict ? 409 : 400);
  }
});
server.listen(port, host, () => console.log(`Frameforge Studio: ${origin}\nStorage: ${directory}`));
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  await jobs.close();
  await vite?.close();
  server.close();
  store.close();
  process.exit(0);
}
process.on('SIGINT', () => void close());
process.on('SIGTERM', () => void close());
