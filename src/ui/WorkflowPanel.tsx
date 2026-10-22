import { useState, useEffect } from 'react';
import { id, type Project, type Workflow } from '../core/model';
import { type Command } from '../core/commands';
import {
  GenerationOptionsSchema,
  type GenerationOptions,
  type ProviderStatus,
} from '../core/generation';

export function WorkflowPanel({
  p,
  send,
  run,
}: {
  p: Project;
  send: (commands: Command[], label: string) => void;
  run: (workflowId: string, outputNodeId?: string) => void;
}) {
  const w = p.workflows[0],
    [kind, setKind] = useState<'timeline' | 'render' | 'prompt' | 'seedance'>('prompt'),
    [from, setFrom] = useState(''),
    [to, setTo] = useState('');
  const [provider, setProvider] = useState<ProviderStatus>();
  useEffect(() => {
    let active = true;
    void fetch('/api/health')
      .then((r) => r.json())
      .then((r) => {
        if (active) setProvider(r.providers[0]);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, []);
  const put = (workflow: Workflow, label: string) =>
    send([{ type: 'workflow.put', workflow }], label);
  if (!w) return null;
  return (
    <div className="workflow-panel">
      <div className="section-toolbar">
        <div>
          <h2>{w.name}</h2>
          <p>共享当前项目时间轴，每次执行固定一份项目快照。</p>
        </div>
        <button className="primary" onClick={() => run(w.id)}>
          运行工作流
        </button>
      </div>
      <div className="node-canvas">
        <svg aria-hidden="true">
          {w.edges.map((e, i) => {
            const a = w.nodes.find((n) => n.id === e.from)!,
              b = w.nodes.find((n) => n.id === e.to)!;
            return (
              <path
                key={i}
                d={`M ${a.x + 210} ${a.y + 65} C ${a.x + 250} ${a.y + 65}, ${b.x - 40} ${b.y + 65}, ${b.x} ${b.y + 65}`}
              />
            );
          })}
        </svg>
        {w.nodes.map((n) => (
          <article className={'node ' + n.kind} key={n.id} style={{ left: n.x, top: n.y }}>
            <header>
              <span>
                {n.kind === 'timeline'
                  ? '▥'
                  : n.kind === 'render'
                    ? '↗'
                    : n.kind === 'prompt'
                      ? 'T'
                      : '✦'}{' '}
                {n.name}
              </span>
              <button
                aria-label={`删除节点 ${n.name}`}
                onClick={() =>
                  put(
                    {
                      ...w,
                      nodes: w.nodes.filter((x) => x.id !== n.id),
                      edges: w.edges.filter((e) => e.from !== n.id && e.to !== n.id),
                    },
                    '删除工作流节点',
                  )
                }
              >
                ×
              </button>
            </header>
            <p>
              {n.kind === 'timeline'
                ? `${p.timeline.duration} 帧 · ${p.timeline.fps} FPS`
                : n.kind === 'render'
                  ? '逐帧渲染 → FFmpeg → 素材库'
                  : n.kind === 'seedance'
                    ? provider?.message || '读取供应商配置…'
                    : '文本输入'}
            </p>
            {n.kind === 'prompt' && (
              <textarea
                aria-label="提示词"
                defaultValue={n.text || ''}
                onBlur={(e) =>
                  put(
                    {
                      ...w,
                      nodes: w.nodes.map((x) =>
                        x.id === n.id ? { ...x, text: e.target.value } : x,
                      ),
                    },
                    '修改提示词',
                  )
                }
              />
            )}
            <footer>
              {n.kind === 'seedance' ? (
                <button
                  disabled={provider?.status !== 'configured'}
                  onClick={() => run(w.id, n.id)}
                >
                  生成视频（付费）
                </button>
              ) : n.kind === 'render' ? (
                <button onClick={() => run(w.id, n.id)}>渲染此输出</button>
              ) : n.kind === 'prompt' ? (
                '文本端口'
              ) : (
                '项目端口'
              )}
            </footer>
          </article>
        ))}
      </div>
      <div className="workflow-controls">
        <select
          aria-label="节点类型"
          value={kind}
          onChange={(e) => setKind(e.target.value as typeof kind)}
        >
          <option value="prompt">文本输入</option>
          <option value="seedance">Seedance 视频生成</option>
          <option value="timeline">时间轴</option>
          <option value="render">渲染输出</option>
        </select>
        <button
          onClick={() =>
            put(
              {
                ...w,
                nodes: [
                  ...w.nodes,
                  {
                    id: id(),
                    kind,
                    name: {
                      prompt: '提示词',
                      seedance: 'Seedance',
                      timeline: '项目时间轴',
                      render: '渲染 MP4',
                    }[kind],
                    x: 24 + (w.nodes.length % 2) * 256,
                    y: 50 + Math.floor(w.nodes.length / 2) * 210,
                    text: kind === 'prompt' ? '' : undefined,
                  },
                ],
              },
              '添加工作流节点',
            )
          }
        >
          添加节点
        </button>
        <select aria-label="连接源节点" value={from} onChange={(e) => setFrom(e.target.value)}>
          <option value="">源节点</option>
          {w.nodes.map((n) => (
            <option key={n.id} value={n.id}>
              {n.name}
            </option>
          ))}
        </select>
        <span>→</span>
        <select aria-label="连接目标节点" value={to} onChange={(e) => setTo(e.target.value)}>
          <option value="">目标节点</option>
          {w.nodes.map((n) => (
            <option key={n.id} value={n.id}>
              {n.name}
            </option>
          ))}
        </select>
        <button
          disabled={!from || !to}
          onClick={() => put({ ...w, edges: [...w.edges, { from, to }] }, '连接工作流节点')}
        >
          连接
        </button>
      </div>
      <div className="edge-list">
        {w.edges.map((e, i) => (
          <span key={i}>
            {w.nodes.find((n) => n.id === e.from)?.name} →{' '}
            {w.nodes.find((n) => n.id === e.to)?.name}{' '}
            <button
              onClick={() =>
                put({ ...w, edges: w.edges.filter((_, index) => index !== i) }, '断开工作流连接')
              }
            >
              断开
            </button>
          </span>
        ))}
      </div>
      {w.nodes
        .filter((n) => n.kind === 'seedance')
        .map((n) => {
          const options = GenerationOptionsSchema.parse(n.generation || {});
          const update = (patch: Partial<GenerationOptions>) =>
            put(
              {
                ...w,
                nodes: w.nodes.map((x) =>
                  x.id === n.id ? { ...x, generation: { ...options, ...patch } } : x,
                ),
              },
              '修改生成参数',
            );
          return (
            <section className="generation-settings" key={n.id}>
              <h3>{n.name} · 生成设置</h3>
              <p>
                {provider?.message || '读取供应商配置…'}
                。提示词及所选图片会发送到火山方舟；结果回到本项目素材库。
              </p>
              <div className="generation-fields">
                <label>
                  模型 / 接入点 ID
                  <input
                    aria-label="模型 ID"
                    key={options.model || ''}
                    defaultValue={options.model || ''}
                    placeholder={provider?.defaultModel || '填写已开通模型 ID'}
                    onBlur={(e) => update({ model: e.target.value.trim() || undefined })}
                  />
                </label>
                <label>
                  模型系列
                  <select
                    aria-label="模型系列"
                    value={options.profile}
                    onChange={(e) =>
                      update({ profile: e.target.value as GenerationOptions['profile'] })
                    }
                  >
                    {['1.0-pro', '1.0-pro-fast', '2.0', '2.0-fast', '2.0-mini', '2.5'].map((v) => (
                      <option key={v}>{v}</option>
                    ))}
                  </select>
                </label>
                <label>
                  时长（秒）
                  <input
                    aria-label="生成时长"
                    type="number"
                    min={2}
                    max={30}
                    key={options.duration}
                    defaultValue={options.duration}
                    onBlur={(e) => update({ duration: Number(e.target.value) })}
                  />
                </label>
                <label>
                  分辨率
                  <select
                    aria-label="生成分辨率"
                    value={options.resolution}
                    onChange={(e) =>
                      update({ resolution: e.target.value as GenerationOptions['resolution'] })
                    }
                  >
                    {['480p', '720p', '1080p', '4k'].map((v) => (
                      <option key={v}>{v}</option>
                    ))}
                  </select>
                </label>
                <label>
                  画幅
                  <select
                    aria-label="生成画幅"
                    value={options.ratio}
                    onChange={(e) =>
                      update({ ratio: e.target.value as GenerationOptions['ratio'] })
                    }
                  >
                    {['16:9', '4:3', '1:1', '3:4', '9:16', '21:9', 'adaptive'].map((v) => (
                      <option key={v} value={v}>
                        {v === 'adaptive' ? '自适应' : v}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  随机种子（-1 随机）
                  <input
                    aria-label="生成种子"
                    type="number"
                    min={-1}
                    max={2147483647}
                    key={options.seed}
                    defaultValue={options.seed}
                    onBlur={(e) => update({ seed: Number(e.target.value) })}
                  />
                </label>
                {(['firstFrameId', 'lastFrameId'] as const).map((field) => (
                  <label key={field}>
                    {field === 'firstFrameId' ? '首帧图片' : '尾帧图片'}
                    <select
                      aria-label={field === 'firstFrameId' ? '首帧图片' : '尾帧图片'}
                      value={options[field] || ''}
                      onChange={(e) => update({ [field]: e.target.value || undefined })}
                    >
                      <option value="">不使用</option>
                      {p.assets
                        .filter((a) => a.kind === 'image')
                        .map((a) => (
                          <option key={a.id} value={a.id}>
                            {a.name}
                          </option>
                        ))}
                    </select>
                  </label>
                ))}
                {!options.profile.startsWith('1.0') && (
                  <label className="check">
                    <input
                      type="checkbox"
                      checked={options.generateAudio}
                      onChange={(e) => update({ generateAudio: e.target.checked })}
                    />
                    生成原声
                  </label>
                )}
                <label className="check">
                  <input
                    type="checkbox"
                    checked={options.watermark}
                    onChange={(e) => update({ watermark: e.target.checked })}
                  />
                  AI 生成水印
                </label>
              </div>
              <p className="muted">
                系列用于参数校验，须与模型 ID 对应。首尾帧支持 PNG/JPEG/WebP，每张最多 20
                MB；Seedance 2.5
                使用首尾帧时请选择自适应画幅。密钥在启动服务前配置，项目文件不保存密钥。
              </p>
            </section>
          );
        })}
      <p className="muted">
        时间轴 → 渲染输出；提示词 →
        Seedance。多个输出时请使用对应节点的执行按钮。生成中断后可恢复同一任务；重新生成会创建新的计费任务。
      </p>
    </div>
  );
}
