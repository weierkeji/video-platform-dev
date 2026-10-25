import { useEffect, useRef, useState } from 'react';
import { id, type Project } from '../core/model';
import type { Command } from '../core/commands';
import type { reduceAction, ReduceOptions } from '../core/reduce-curves';
import { NumberInput } from './Inspector';

type Result = Pick<ReturnType<typeof reduceAction>, 'stats' | 'notes'>;
const labels = {
  position: '位置 · m',
  rotation: '欧拉角 · °',
  quaternion: '四元数 · °',
  scale: '缩放 · 绝对差',
  influence: 'IK 影响',
  poleAngle: '极向角 · °',
};

export function ReducePanel({
  project,
  sceneId,
  busy,
  saveError,
  send,
  onClose,
  onActivated,
}: {
  project: Project;
  sceneId: string;
  busy: boolean;
  saveError: string;
  send: (commands: Command[], label: string) => Promise<Project | undefined>;
  onClose: () => void;
  onActivated: () => void;
}) {
  const [options, setOptions] = useState<ReduceOptions>({
    actionId: project.scenes.find((s) => s.id === sceneId)?.activeActionId || null,
    start: 0,
    end: project.timeline.duration,
    position: 0.001,
    rotationDegrees: 0.1,
    scale: 0.001,
    influence: 0.001,
  });
  const [name, setName] = useState('精简动作'),
    [activate, setActivate] = useState(true),
    [working, setWorking] = useState(false),
    [error, setError] = useState(''),
    [result, setResult] = useState<{ revision: number; value: Result } | null>(null);
  const cancel = useRef<(() => void) | null>(null);
  useEffect(() => () => cancel.current?.(), []);
  useEffect(() => setResult(null), [options]);
  const update = (patch: Partial<ReduceOptions>) => setOptions((o) => ({ ...o, ...patch }));
  const visible = result?.revision === project.revision ? result.value : null;
  async function analyze(): Promise<Result> {
    return new Promise((resolve, reject) => {
      const worker = new Worker(new URL('./reduce.worker.ts', import.meta.url), { type: 'module' });
      const finish = () => {
        worker.terminate();
        clearTimeout(timeout);
        cancel.current = null;
      };
      const timeout = setTimeout(() => {
        finish();
        reject(new Error('精简分析超过 60 秒；请缩短范围或拆分动作'));
      }, 60000);
      cancel.current = () => {
        finish();
        reject(new Error('已取消动作精简分析'));
      };
      worker.onmessage = (event: MessageEvent<{ result?: Result; error?: string }>) => {
        finish();
        if (event.data.result) resolve(event.data.result);
        else reject(new Error(event.data.error || '精简分析失败'));
      };
      worker.onerror = (event) => {
        finish();
        reject(new Error(event.message));
      };
      worker.postMessage({ project, sceneId, options });
    });
  }
  async function run(save: boolean) {
    setWorking(true);
    setError('');
    try {
      const value = await analyze();
      if (save) {
        const next = await send(
          [{ type: 'action.reduce', action: { id: id(), name, sceneId }, options, activate }],
          '另存精简动作',
        );
        if (!next) return;
        if (activate) onActivated();
        setResult({
          revision: next.revision,
          value: {
            ...value,
            notes: [...value.notes, `已保存“${name}”。源动作和驱动设置保留，可撤销本次操作。`],
          },
        });
      } else setResult({ revision: project.revision, value });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setWorking(false);
    }
  }
  return (
    <div className="modal-backdrop">
      <section
        className="modal exchange-modal reduce-panel"
        role="dialog"
        aria-modal="true"
        aria-label="动作关键帧精简"
      >
        <div className="panel-heading">
          <h2>动作关键帧精简</h2>
          <button disabled={busy} onClick={onClose}>
            关闭
          </button>
        </div>
        <p className="muted">
          减少密集动画的关键帧，另存完整动作。支持变换与 IK
          参数的保持、线性、smoothstep、Bézier、Hermite
          和四元数曲线；仅在确认整个替换区间满足容差时删键，无法确认的段保留。
        </p>
        <fieldset disabled={busy || working}>
          <label className="field">
            源动作
            <select
              aria-label="精简源动作"
              value={options.actionId || ''}
              onChange={(e) => update({ actionId: e.target.value || null })}
            >
              <option value="">项目动画</option>
              {project.animationActions
                ?.filter((a) => a.sceneId === sceneId)
                .map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
            </select>
          </label>
          <div className="bake-range">
            <NumberInput
              label="精简起点"
              value={options.start}
              min={0}
              max={1e6}
              step={1}
              onChange={(start) => update({ start })}
            />
            <NumberInput
              label="精简终点"
              value={options.end}
              min={0}
              max={1e6}
              step={1}
              onChange={(end) => update({ end })}
            />
          </div>
          <p className="muted">
            区间外的键、首尾和跳变边界保留，不裁剪或移动时间。0 容差表示保留这一类通道的全部键。
          </p>
          <div className="bake-range">
            <NumberInput
              label="位置容差 m"
              precision={8}
              value={options.position}
              min={0}
              max={1000}
              step={0.001}
              onChange={(position) => update({ position })}
            />
            <NumberInput
              label="旋转与极向容差 °"
              precision={8}
              value={options.rotationDegrees}
              min={0}
              max={180}
              step={0.05}
              onChange={(rotationDegrees) => update({ rotationDegrees })}
            />
          </div>
          <div className="bake-range">
            <NumberInput
              label="缩放容差"
              precision={8}
              value={options.scale}
              min={0}
              max={1000}
              step={0.001}
              onChange={(scale) => update({ scale })}
            />
            <NumberInput
              label="IK 影响容差"
              precision={8}
              value={options.influence}
              min={0}
              max={1}
              step={0.001}
              onChange={(influence) => update({ influence })}
            />
          </div>
          <p className="muted">
            数值曲线用控制点上界；四元数按区间旋转速度界限细分检查。欧拉角使用未折回的 XYZ
            差之和，保留多圈运动。上界包含浮点余量；方法保守，不保证键数最少。
          </p>
          <label className="field">
            新动作名称
            <input
              aria-label="精简动作名称"
              maxLength={160}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <label className="check">
            <input
              type="checkbox"
              aria-label="启用精简动作"
              checked={activate}
              onChange={(e) => setActivate(e.target.checked)}
            />{' '}
            设为当前场景默认动作
          </label>
          <p className="muted">
            基础偏移、动作层、约束和 IK
            设置继续生效，镜头/片段指定动作仍优先。容差只约束原始局部通道；父级、层、限角和接触可能放大最终误差。需要精简最终姿态时，可先烘焙或重定向，再处理生成的动作。
          </p>
          <div className="button-row">
            <button onClick={() => void run(false)}>分析精简结果</button>
            <button onClick={() => void run(true)}>保存精简新动作</button>
          </div>
        </fieldset>
        {working && <button onClick={() => cancel.current?.()}>取消精简分析</button>}
        {(error || saveError) && (
          <p role="alert" className="error">
            {error || saveError}
          </p>
        )}
        {visible && (
          <div aria-live="polite">
            {visible.notes.map((note) => (
              <p key={note}>{note}</p>
            ))}
            <p className="muted">
              执行 {visible.stats.checks} 次区间检查；上限 100 万次、输入 20 万键。
            </p>
            <div className="reduce-results">
              <table>
                <thead>
                  <tr>
                    <th>对象 / 通道</th>
                    <th>键数</th>
                    <th>误差上界</th>
                  </tr>
                </thead>
                <tbody>
                  {visible.stats.details.map((d, i) => (
                    <tr key={i}>
                      <td>
                        {project.entities.find((e) => e.id === d.entityId)?.name} /{' '}
                        {labels[d.property]}
                      </td>
                      <td>
                        {d.before} → {d.after}
                      </td>
                      <td>{d.bound.toPrecision(4)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
