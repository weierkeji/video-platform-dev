import { useState } from 'react';
import type { Entity, IKChain, IKLimit } from '../core/model';
import type { Command } from '../core/commands';
import { NumberInput, VectorInput } from './Inspector';

export function IKLimits({
  chain,
  entities,
  frame,
  put,
  send,
  angles,
}: {
  chain: IKChain;
  entities: Entity[];
  frame: number;
  put: (chain: IKChain) => void;
  send: (commands: Command[], label: string) => void;
  angles?: { jointId: string; swing: number; twist: number }[];
}) {
  const joints = chain.joints.slice(0, -1),
    [selected, setSelected] = useState(joints[0]),
    [kind, setKind] = useState<'hinge' | 'cone'>('hinge');
  const joint = joints.includes(selected) ? selected : joints[0];
  const name = (id: string) => entities.find((e) => e.id === id)!.name;
  const update = (limit: IKLimit) =>
    put({ ...chain, limits: chain.limits!.map((l) => (l.jointId === limit.jointId ? limit : l)) });
  const capture = (jointId: string, kind?: 'hinge' | 'cone') =>
    send(
      [{ type: 'ik.limit.capture', chainId: chain.id, jointId, frame, kind }],
      '记录 IK 限角参考姿态',
    );
  return (
    <details className="ik-limits" open={!!chain.limits?.length}>
      <summary>关节限角</summary>
      <p className="muted">
        以记录的局部旋转为零姿态，轴在该参考姿态内定义。每次受限迭代及部分影响混合后都遵守限制；影响为零或停用
        IK 时不限制。参考姿态不会改绑蒙皮。
      </p>
      {chain.limits?.map((l) => {
        const angle = angles?.find((a) => a.jointId === l.jointId);
        return (
          <fieldset key={l.jointId} aria-label={`限角 ${name(l.jointId)}`}>
            <legend>{name(l.jointId)}</legend>
            <label className="check">
              <input
                aria-label="启用关节限角"
                type="checkbox"
                checked={l.enabled}
                onChange={(e) => update({ ...l, enabled: e.target.checked })}
              />
              启用限角
            </label>
            <label className="field">
              类型
              <select
                aria-label="关节限角类型"
                value={l.kind}
                onChange={(e) => update({ ...l, kind: e.target.value as IKLimit['kind'] })}
              >
                <option value="hinge">单轴铰链</option>
                <option value="cone">摆动锥与扭转</option>
              </select>
            </label>
            <VectorInput
              label="参考轴"
              value={l.axis}
              onChange={(axis) => update({ ...l, axis })}
            />
            <NumberInput
              label={l.kind === 'hinge' ? '铰链下限 °' : '扭转下限 °'}
              value={(l.min * 180) / Math.PI}
              min={-180}
              max={180}
              step={5}
              onChange={(min) => update({ ...l, min: (min * Math.PI) / 180 })}
            />
            <NumberInput
              label={l.kind === 'hinge' ? '铰链上限 °' : '扭转上限 °'}
              value={(l.max * 180) / Math.PI}
              min={-180}
              max={180}
              step={5}
              onChange={(max) => update({ ...l, max: (max * Math.PI) / 180 })}
            />
            {l.kind === 'cone' && (
              <NumberInput
                label="摆动锥半角 °"
                value={(l.swing * 180) / Math.PI}
                min={0}
                max={180}
                step={5}
                onChange={(swing) => update({ ...l, swing: (swing * Math.PI) / 180 })}
              />
            )}
            {angle && (
              <p className="ik-angle" role="status">
                当前摆动 {((angle.swing * 180) / Math.PI).toFixed(2)}°，
                {l.kind === 'hinge' ? '铰链' : '扭转'} {((angle.twist * 180) / Math.PI).toFixed(2)}°
              </p>
            )}
            <p className="muted">
              参考四元数：{l.reference.map((v) => v.toFixed(3)).join('，')}
              。上下限相等可锁定旋转；角度区间不能跨越 ±180°。
            </p>
            <button onClick={() => capture(l.jointId)}>重新记录输入姿态为零</button>
            <button
              onClick={() =>
                put({
                  ...chain,
                  limits: chain.limits!.filter((item) => item.jointId !== l.jointId),
                })
              }
            >
              移除关节限角
            </button>
          </fieldset>
        );
      })}
      <label className="field">
        关节
        <select aria-label="新限角关节" value={joint} onChange={(e) => setSelected(e.target.value)}>
          {joints.map((id) => (
            <option value={id} key={id}>
              {name(id)}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        类型
        <select
          aria-label="新限角类型"
          value={kind}
          onChange={(e) => setKind(e.target.value as IKLimit['kind'])}
        >
          <option value="hinge">单轴铰链</option>
          <option value="cone">摆动锥与扭转</option>
        </select>
      </label>
      <button
        disabled={chain.limits?.some((l) => l.jointId === joint)}
        onClick={() => capture(joint, kind)}
      >
        添加关节限角
      </button>
      <p className="muted">
        添加/重记使用当前帧、排除本链 IK
        的输入姿态。受限链保持局部位置和伸缩，非均匀父级下世界段长可能变化。极向提供初始偏好，限角优先；局部解不保证连续或全局最优。
      </p>
    </details>
  );
}
