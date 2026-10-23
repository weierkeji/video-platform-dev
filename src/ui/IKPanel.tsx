import { useMemo, useState } from 'react';
import type { Command } from '../core/commands';
import type { Entity, IKChain, Project } from '../core/model';
import { ikPath } from '../core/ik';
import { sceneEvaluator } from '../core/constraints';
import { NumberInput } from './Inspector';

export function IKPanel({
  project,
  entity,
  frame,
  send,
}: {
  project: Project;
  entity: Entity;
  frame: number;
  send: (commands: Command[], label: string) => void;
}) {
  const scene = useMemo(
    () => project.entities.filter((e) => e.sceneId === entity.sceneId),
    [project.entities, entity.sceneId],
  );
  const tips = useMemo(
    () =>
      scene.filter((e) => {
        try {
          return ikPath(scene, entity.id, e.id).length >= 3;
        } catch {
          return false;
        }
      }),
    [scene, entity.id],
  );
  const [tip, setTip] = useState('');
  const end = tips.some((e) => e.id === tip) ? tip : tips[0]?.id || '';
  const chains = (project.ikChains || []).filter(
    (c) => c.joints.includes(entity.id) || c.targetId === entity.id || c.poleId === entity.id,
  );
  const pose = useMemo(
    () =>
      chains.some((c) => c.enabled && c.influence > 0)
        ? sceneEvaluator(project, entity.sceneId)(frame)
        : undefined,
    [project, entity.sceneId, entity.id, frame],
  );
  const put = (chain: IKChain) => send([{ type: 'ik.put', chain }], '编辑 IK 链');
  if (!chains.length && !tips.length) return null;
  return (
    <details className="ik-panel" open={!!chains.length}>
      <summary>IK 链控制</summary>
      <p className="muted">
        移动目标带动整条链；极向控制弯曲方向。链先计算动画与普通约束，再求
        IK；根的位置固定，不自动拉长。青色为关节，橙色为目标，紫色为极向辅助点。
      </p>
      {chains.map((c) => {
        const state = pose?.ik.find((s) => s.chainId === c.id),
          warnings = pose?.warnings.filter((w) => w.constraintId === c.id);
        const targets = scene.filter((e) => !c.joints.includes(e.id));
        return (
          <fieldset key={c.id} className="ik-card" aria-label={`IK 链 ${c.name}`}>
            <legend>
              {c.joints.length - 1} 段 · {c.name}
            </legend>
            <label className="field">
              链名称
              <input
                aria-label="IK 链名称"
                key={c.name}
                defaultValue={c.name}
                maxLength={160}
                onBlur={(e) => {
                  if (e.target.value && e.target.value !== c.name)
                    put({ ...c, name: e.target.value });
                }}
              />
            </label>
            <p className="muted">
              {c.joints.map((id) => scene.find((e) => e.id === id)!.name).join(' → ')}
            </p>
            <label className="check">
              <input
                type="checkbox"
                aria-label="启用 IK"
                checked={c.enabled}
                onChange={(e) => put({ ...c, enabled: e.target.checked })}
              />
              启用 IK
            </label>
            <label className="field">
              目标
              <select
                aria-label="IK 目标"
                value={c.targetId}
                onChange={(e) => put({ ...c, targetId: e.target.value })}
              >
                {targets.map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              极向对象
              <select
                aria-label="IK 极向对象"
                value={c.poleId || ''}
                onChange={(e) => put({ ...c, poleId: e.target.value || null })}
              >
                <option value="">沿输入姿态弯曲</option>
                {targets.map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.name}
                  </option>
                ))}
              </select>
            </label>
            <NumberInput
              label="IK 极向角 °"
              value={(c.poleAngle * 180) / Math.PI}
              step={5}
              onChange={(angle) => put({ ...c, poleAngle: (angle * Math.PI) / 180 })}
            />
            <NumberInput
              label="IK 影响"
              value={c.influence}
              min={0}
              max={1}
              step={0.05}
              onChange={(influence) => put({ ...c, influence })}
            />
            <NumberInput
              label="IK 最大迭代"
              value={c.iterations}
              min={1}
              max={64}
              step={1}
              onChange={(iterations) => put({ ...c, iterations })}
            />
            <label className="field">
              IK 容差（米）
              <input
                aria-label="IK 容差"
                type="number"
                min={0.000001}
                max={1}
                step={0.000001}
                key={c.tolerance}
                defaultValue={c.tolerance}
                onBlur={(e) => {
                  const tolerance = Number(e.target.value);
                  if (Number.isFinite(tolerance) && tolerance !== c.tolerance)
                    put({ ...c, tolerance });
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') e.currentTarget.blur();
                }}
              />
            </label>
            {state && (
              <p role="status" className="ik-status">
                成片帧 {frame}：末端距离目标 {state.appliedResidual.toPrecision(4)} 米；完整求解误差{' '}
                {state.residual.toPrecision(4)} 米。
                {c.joints.length === 3 ? '双段几何解。' : `迭代 ${state.iterations} 次。`}
                {state.reachable ? '' : '目标超出可达范围。'}
              </p>
            )}
            {!!warnings?.length && <p role="status">{warnings.map((w) => w.message).join('；')}</p>}
            <button onClick={() => send([{ type: 'ik.delete', id: c.id }], '移除 IK 链')}>
              移除 IK 链
            </button>
          </fieldset>
        );
      })}
      {!!tips.length && (
        <>
          <h4>以当前对象为根</h4>
          <label className="field">
            末端节点
            <select aria-label="新 IK 末端" value={end} onChange={(e) => setTip(e.target.value)}>
              {tips.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.name}
                </option>
              ))}
            </select>
          </label>
          <button
            disabled={!end}
            onClick={() =>
              send(
                [{ type: 'ik.create', rootId: entity.id, tipId: end, frame }],
                '创建 IK 链与控制器',
              )
            }
          >
            创建 IK 链与控制器
          </button>
          <p className="muted">
            使用当前场景帧创建两个独立控制对象。之后在场景结构选中目标/极向，移动或记键即可控制链。需要
            2…32 段直接父子链；同一节点暂不能属于多条启用链。
          </p>
        </>
      )}
      <p className="muted">
        求解按世界骨段长度，支持普通中间父级。部分影响混合原姿态与
        IK；非均匀缩放下可能产生局部剪切。GLB 请烘焙；关节限角、末端旋转和伸长尚未支持。
      </p>
    </details>
  );
}
