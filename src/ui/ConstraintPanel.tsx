import { useState } from 'react';
import type { Command } from '../core/commands';
import { id, type Constraint, type Entity, type Project } from '../core/model';
import { NumberInput, VectorInput } from './Inspector';

const names = { aim: '目标朝向', 'copy-position': '复制位置', 'copy-transform': '复制变换' };
export function ConstraintPanel({
  project,
  entity,
  send,
}: {
  project: Project;
  entity: Entity;
  send: (commands: Command[], label: string) => void;
}) {
  const [kind, setKind] = useState<Constraint['type']>('aim');
  const candidates = project.entities.filter(
    (e) => e.sceneId === entity.sceneId && e.id !== entity.id,
  );
  const [targetId, setTargetId] = useState(candidates[0]?.id || '');
  const target = candidates.some((e) => e.id === targetId) ? targetId : candidates[0]?.id || '';
  const put = (constraint: Constraint) =>
    send([{ type: 'constraint.put', entityId: entity.id, constraint }], '编辑变换约束');
  return (
    <details className="constraint-panel" open={!!entity.constraints?.length}>
      <summary>变换约束</summary>
      <p className="muted">
        先计算基础动画和动作层，再从上到下应用约束。属性与记键编辑源变换；启用约束时请在属性中编辑，或暂时禁用约束再使用对象手柄。
      </p>
      {entity.skin && (
        <p className="muted">
          此网格由关节驱动；对象约束只改变节点及普通子对象。要改变蒙皮姿态，请约束关节。
        </p>
      )}
      {entity.light?.kind === 'directional' && !entity.light.direction && (
        <p className="muted">
          此平行光仍朝向世界原点；在灯光属性中启用“方向跟随对象 −Z”后，朝向约束才会控制照射方向。
        </p>
      )}
      {(entity.constraints || []).map((c, index, rows) => (
        <fieldset key={c.id} className="constraint-card" aria-label={`约束 ${c.name}`}>
          <legend>
            {index + 1}. {names[c.type]}
          </legend>
          <label className="field">
            约束名称
            <input
              aria-label="约束名称"
              key={c.name}
              defaultValue={c.name}
              maxLength={160}
              onBlur={(e) => {
                if (e.target.value && e.target.value !== c.name)
                  put({ ...c, name: e.target.value });
              }}
            />
          </label>
          <label className="check">
            <input
              type="checkbox"
              aria-label="启用约束"
              checked={c.enabled}
              onChange={(e) => put({ ...c, enabled: e.target.checked })}
            />
            启用
          </label>
          <label className="field">
            目标对象
            <select
              aria-label="约束目标"
              value={c.targetId}
              onChange={(e) => put({ ...c, targetId: e.target.value })}
            >
              {candidates.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.name}
                </option>
              ))}
            </select>
          </label>
          <NumberInput
            label="约束影响"
            value={c.influence}
            min={0}
            max={1}
            step={0.05}
            onChange={(influence) => put({ ...c, influence })}
          />
          {c.type === 'aim' ? (
            <>
              <label className="field">
                朝向轴
                <select
                  aria-label="朝向轴"
                  value={c.trackAxis}
                  onChange={(e) => {
                    const trackAxis = e.target.value as typeof c.trackAxis;
                    put({
                      ...c,
                      trackAxis,
                      upAxis:
                        trackAxis.replace('-', '') === c.upAxis
                          ? c.upAxis === 'y'
                            ? 'x'
                            : 'y'
                          : c.upAxis,
                    });
                  }}
                >
                  {['x', 'y', 'z', '-x', '-y', '-z'].map((axis) => (
                    <option key={axis} value={axis}>
                      {axis.toUpperCase()}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                向上轴
                <select
                  aria-label="向上轴"
                  value={c.upAxis}
                  onChange={(e) => put({ ...c, upAxis: e.target.value as typeof c.upAxis })}
                >
                  {['x', 'y', 'z']
                    .filter((axis) => axis !== c.trackAxis.replace('-', ''))
                    .map((axis) => (
                      <option key={axis} value={axis}>
                        {axis.toUpperCase()}
                      </option>
                    ))}
                </select>
              </label>
              <VectorInput
                label="世界向上"
                value={c.worldUp}
                onChange={(worldUp) => put({ ...c, worldUp })}
              />
              <p className="muted">
                朝向目标原点。重合时保留输入姿态；向上向量平行时使用替代世界轴，穿越极点可能翻转。
              </p>
            </>
          ) : (
            <>
              {(['targetSpace', 'ownerSpace'] as const).map((field) => (
                <label className="field" key={field}>
                  {field === 'targetSpace' ? '读取目标空间' : '应用到对象空间'}
                  <select
                    aria-label={field === 'targetSpace' ? '目标空间' : '对象空间'}
                    value={c[field]}
                    onChange={(e) => put({ ...c, [field]: e.target.value as 'local' | 'world' })}
                  >
                    <option value="world">世界</option>
                    <option value="local">相对父级</option>
                  </select>
                </label>
              ))}
              {c.type === 'copy-transform' && (
                <p className="muted">
                  复制完整仿射变换，包含剪切。部分影响插值位置、旋转与缩放/剪切；不是逐元素矩阵平均。
                </p>
              )}
            </>
          )}
          <div className="button-row">
            <button
              aria-label={`上移约束 ${c.name}`}
              disabled={!index}
              onClick={() =>
                send(
                  [{ type: 'constraint.move', entityId: entity.id, id: c.id, direction: -1 }],
                  '上移约束',
                )
              }
            >
              ↑
            </button>
            <button
              aria-label={`下移约束 ${c.name}`}
              disabled={index === rows.length - 1}
              onClick={() =>
                send(
                  [{ type: 'constraint.move', entityId: entity.id, id: c.id, direction: 1 }],
                  '下移约束',
                )
              }
            >
              ↓
            </button>
            <button
              onClick={() =>
                send([{ type: 'constraint.delete', entityId: entity.id, id: c.id }], '删除约束')
              }
            >
              删除约束
            </button>
          </div>
        </fieldset>
      ))}
      <label className="field">
        新约束类型
        <select
          aria-label="新约束类型"
          value={kind}
          onChange={(e) => setKind(e.target.value as Constraint['type'])}
        >
          {Object.entries(names).map(([value, name]) => (
            <option key={value} value={value}>
              {name}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        新约束目标
        <select
          aria-label="新约束目标"
          value={target}
          onChange={(e) => setTargetId(e.target.value)}
        >
          {candidates.map((e) => (
            <option key={e.id} value={e.id}>
              {e.name}
            </option>
          ))}
        </select>
      </label>
      <button
        disabled={!target || (entity.constraints?.length || 0) >= 32}
        onClick={() => {
          const common = {
            id: id(),
            name: names[kind],
            targetId: target,
            enabled: true,
            influence: 1,
          };
          put(
            kind === 'aim'
              ? {
                  ...common,
                  type: 'aim',
                  trackAxis: entity.joint ? 'y' : '-z',
                  upAxis: entity.joint ? 'z' : 'y',
                  worldUp: [0, 1, 0],
                }
              : { ...common, type: kind, targetSpace: 'world', ownerSpace: 'world' },
          );
        }}
      >
        添加约束
      </button>
      <p className="muted">
        每对象最多 32 个约束。循环依赖会拒绝整次修改；约束随项目保存。动画 GLB
        请使用烘焙；局部剪切不能保真转换成 TRS 动作。
      </p>
    </details>
  );
}
