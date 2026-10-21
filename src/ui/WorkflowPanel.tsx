import { useState } from 'react';
import { id, type Project, type Workflow } from '../core/model';
import { type Command } from '../core/commands';

export function WorkflowPanel({
  p,
  send,
  run,
}: {
  p: Project;
  send: (commands: Command[], label: string) => void;
  run: (workflowId: string) => void;
}) {
  const w = p.workflows[0],
    [kind, setKind] = useState<'timeline' | 'render' | 'prompt' | 'seedance'>('prompt'),
    [from, setFrom] = useState(''),
    [to, setTo] = useState('');
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
                    ? '未接入：无法执行外部生成'
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
              {n.kind === 'seedance'
                ? '待实现适配器'
                : n.kind === 'prompt'
                  ? '文本端口'
                  : '项目端口'}
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
          <option value="seedance">Seedance（未接入）</option>
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
      <p className="muted">
        本地时间轴 →
        渲染流程可执行。外部模型节点仅保存编排意图；接口适配器尚未实现，执行时会明确报错。
      </p>
    </div>
  );
}
