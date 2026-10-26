import { useEffect, useRef, useState } from 'react';
import { id, type Project } from '../core/model';
import type { Command } from '../core/commands';
import type { BakeOptions, bakedProject } from '../core/bake';
import { requireBakeTolerance } from '../core/bake';
import { exportGLBWithAssets } from '../core/gltf';
import { download, NumberInput } from './Inspector';

type Result = ReturnType<typeof bakedProject>;
export function BakePanel({
  project,
  sceneId,
  frame,
  disabled,
  setReading,
  onError,
  send,
}: {
  project: Project;
  sceneId: string;
  frame: number;
  disabled: boolean;
  setReading: (value: boolean) => void;
  onError: (message: string) => void;
  send: (commands: Command[], label: string) => Promise<Project | undefined>;
}) {
  const [options, setOptions] = useState<BakeOptions>({
    start: 0,
    end: project.timeline.duration,
    step: 1,
    interpolation: 'linear',
    rebase: false,
    actionId: project.scenes.find((s) => s.id === sceneId)?.activeActionId || null,
  });
  const [name, setName] = useState('烘焙动画'),
    [activate, setActivate] = useState(false);
  const [notes, setNotes] = useState<string[]>([]),
    [working, setWorking] = useState(false);
  const cancel = useRef<(() => void) | null>(null);
  useEffect(() => () => cancel.current?.(), []);
  useEffect(() => setNotes([]), [project.revision, options]);
  const update = (patch: Partial<BakeOptions>) => setOptions((o) => ({ ...o, ...patch }));
  async function calculate(): Promise<Result> {
    return new Promise((resolve, reject) => {
      const worker = new Worker(new URL('./bake.worker.ts', import.meta.url), { type: 'module' });
      const finish = () => {
        worker.terminate();
        clearTimeout(timeout);
        cancel.current = null;
      };
      const timeout = setTimeout(() => {
        finish();
        reject(new Error('烘焙计算超过 60 秒；请缩短区间或增大步长'));
      }, 60000);
      cancel.current = () => {
        finish();
        reject(new Error('已取消烘焙计算'));
      };
      worker.onmessage = (event: MessageEvent<{ result?: Result; error?: string }>) => {
        finish();
        if (event.data.result) resolve(event.data.result);
        else reject(new Error(event.data.error || '烘焙失败'));
      };
      worker.onerror = (event) => {
        finish();
        reject(new Error(event.message || '烘焙工作线程失败'));
      };
      worker.postMessage({ project, sceneId, options });
    });
  }
  async function run(mode: 'analyze' | 'export' | 'save') {
    setReading(true);
    setWorking(true);
    onError('');
    try {
      const result = await calculate();
      setNotes(result.notes);
      if (mode !== 'analyze') requireBakeTolerance(result);
      if (mode === 'export') {
        const output = await exportGLBWithAssets(
          result.project,
          sceneId,
          frame,
          async (asset) => {
            const response = await fetch(`/api/blobs/${asset.blobId}`, {
              signal: AbortSignal.timeout(15000),
            });
            if (!response.ok) throw new Error(`无法读取纹理：${asset.name}`);
            return new Uint8Array(await response.arrayBuffer());
          },
          true,
        );
        setNotes([...result.notes, ...output.notes]);
        download(
          `${output.sceneName}-baked.glb`,
          new Blob([output.bytes], { type: 'model/gltf-binary' }),
        );
      } else if (mode === 'save') {
        const saved = await send(
          [{ type: 'action.bake', action: { id: id(), name, sceneId }, options, activate }],
          '保存烘焙动作',
        );
        if (saved)
          setNotes([
            ...result.notes,
            `已保存新动作“${name}”。原动作、层、约束和 IK保留，可撤销本次操作。`,
          ]);
      }
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    } finally {
      setReading(false);
      setWorking(false);
    }
  }
  return (
    <section className="bake-panel" aria-label="动作层烘焙">
      <h3>烘焙混合动画</h3>
      <p className="muted">
        采样所选基础动作、当前启用的层级补偿、基础偏移、对象层、约束和
        IK，保留父子局部变换。局部剪切不能转换为 TRS，会明确报错；镜头片段调度使用项目包保存。
      </p>
      <fieldset disabled={disabled || working}>
        <label className="field">
          烘焙基础动作
          <select
            aria-label="烘焙基础动作"
            value={options.actionId || ''}
            onChange={(e) => update({ actionId: e.target.value || null })}
          >
            <option value="">项目动画</option>
            {project.animationActions
              ?.filter((a) => a.sceneId === sceneId)
              .map((a) => (
                <option value={a.id} key={a.id}>
                  {a.name}
                </option>
              ))}
          </select>
        </label>
        <div className="bake-range">
          <NumberInput
            label="烘焙起点"
            value={options.start}
            min={0}
            max={1e6}
            onChange={(start) => update({ start })}
          />
          <NumberInput
            label="烘焙终点"
            value={options.end}
            min={0}
            max={1e6}
            onChange={(end) => update({ end })}
          />
          <NumberInput
            label="烘焙步长"
            value={options.step}
            min={0.01}
            max={120}
            onChange={(step) => update({ step })}
          />
        </div>
        <label className="check">
          <input
            type="checkbox"
            aria-label="自适应烘焙"
            checked={!!options.adaptive}
            onChange={(e) =>
              update({
                adaptive: e.target.checked
                  ? { position: 0.001, rotationDegrees: 0.1, scale: 0.001, minStep: 0.01 }
                  : undefined,
              })
            }
          />
          按探测误差自适应补样
        </label>
        {options.adaptive && (
          <>
            <div className="bake-range">
              <NumberInput
                label="烘焙位置分量容差 m"
                precision={8}
                value={options.adaptive.position}
                min={1e-8}
                max={1000}
                step={0.001}
                onChange={(position) => update({ adaptive: { ...options.adaptive!, position } })}
              />
              <NumberInput
                label="烘焙旋转容差 °"
                precision={8}
                value={options.adaptive.rotationDegrees}
                min={1e-6}
                max={180}
                step={0.05}
                onChange={(rotationDegrees) =>
                  update({ adaptive: { ...options.adaptive!, rotationDegrees } })
                }
              />
            </div>
            <div className="bake-range">
              <NumberInput
                label="烘焙缩放分量容差"
                precision={8}
                value={options.adaptive.scale}
                min={1e-8}
                max={1000}
                step={0.001}
                onChange={(scale) => update({ adaptive: { ...options.adaptive!, scale } })}
              />
              <NumberInput
                label="最小采样间隔 帧"
                precision={8}
                value={options.adaptive.minStep}
                min={1e-6}
                max={120}
                step={0.01}
                onChange={(minStep) => update({ adaptive: { ...options.adaptive!, minStep } })}
              />
            </div>
            <p className="muted">
              步长作为初始最大间隔；每段用五个内部时刻检查最终局部变换，再按差异补样。
              达到最小间隔、时间精度或工作量上限后仍未达标时，只提供分析，不保存或导出。
              跳变保护邻域单独报告。短暂变化可能漏检；父级和蒙皮可放大差异，不保证连续时间或世界空间误差。
            </p>
          </>
        )}
        <label className="field">
          烘焙插值
          <select
            aria-label="烘焙插值"
            value={options.interpolation}
            onChange={(e) =>
              update({ interpolation: e.target.value as BakeOptions['interpolation'] })
            }
          >
            <option value="linear">线性 / 四元数球面插值</option>
            <option value="constant">保持每个采样值</option>
          </select>
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={options.rebase}
            aria-label="烘焙起点归零"
            onChange={(e) => update({ rebase: e.target.checked })}
          />
          输出起点归零
        </label>
        <p className="muted">
          包含终点、键和层边界。每轨最多 10000 时刻、合计 20
          万键。帧间为近似；分析提供局部探测误差，不能证明全区间上界。跳变附近加入 Float32
          两侧采样并留出源时间运算的舍入间隔，线性曲线会在极窄间隔内过渡。
        </p>
        <div className="button-row">
          <button onClick={() => void run('analyze')}>分析烘焙</button>
          <button onClick={() => void run('export')}>烘焙动画 GLB</button>
        </div>
        <label className="field">
          烘焙动作名称
          <input
            aria-label="烘焙动作名称"
            value={name}
            maxLength={160}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={activate}
            aria-label="启用烘焙动作"
            onChange={(e) => setActivate(e.target.checked)}
          />
          保存时切换场景动作并停用本场景层级补偿、基础偏移、对象层、约束及 IK
        </label>
        <p className="muted">
          仅保存时保留当前播放设置。勾选切换会影响本场景全部镜头的对象层；镜头/片段显式指定的基础动作需自行选择新动作。原数据保留，可撤销。
        </p>
        <button disabled={!name.trim()} onClick={() => void run('save')}>
          保存为新动作
        </button>
      </fieldset>
      {working && (
        <button disabled={!cancel.current} onClick={() => cancel.current?.()}>
          取消烘焙计算
        </button>
      )}
      {!!notes.length && (
        <ul role="status">
          {notes.map((note, i) => (
            <li key={i}>{note}</li>
          ))}
        </ul>
      )}
    </section>
  );
}
