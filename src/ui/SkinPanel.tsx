import { useEffect, useState } from 'react';
import type { Command } from '../core/commands';
import type { Entity, Project, VertexInfluences } from '../core/model';
import { NumberInput } from './Inspector';

type Send = (commands: Command[], label: string) => void;
export function SkinPanel({
  project,
  entity,
  send,
}: {
  project: Project;
  entity: Entity;
  send: Send;
}) {
  const [joints, setJoints] = useState<string[]>(entity.skin?.joints || []);
  const [method, setMethod] = useState<'nearest' | 'first'>('nearest');
  if (entity.kind !== 'mesh') return null;
  const candidates = project.entities.filter(
    (e) => e.sceneId === entity.sceneId && (e.joint || entity.skin?.joints.includes(e.id)),
  );
  return (
    <details className="skin-panel" open={!!entity.skin}>
      <summary>骨架与蒙皮</summary>
      {entity.skin ? (
        <>
          <p>
            已绑定 {entity.skin.joints.length}{' '}
            个关节。在线性混合中，网格位置由关节驱动；网格节点变换仍影响普通子对象。
          </p>
          <p className="muted">
            进入网格编辑可查看原始几何和调整选中顶点的权重。解绑恢复原始网格，不固化当前姿态。
          </p>
          <button
            onClick={() => send([{ type: 'skin.unbind', entityId: entity.id }], '解除蒙皮绑定')}
          >
            解除蒙皮绑定
          </button>
        </>
      ) : (
        <p className="muted">
          先添加关节并设置父子层级。绑定使用基础姿态，不包含动画、动作层、约束或 IK。
        </p>
      )}
      <div className="skin-joints" aria-label="绑定关节选择">
        {candidates.map((joint) => (
          <label className="check" key={joint.id}>
            <input
              type="checkbox"
              aria-label={`绑定关节 ${joint.name}`}
              checked={joints.includes(joint.id)}
              onChange={(e) =>
                setJoints((old) =>
                  e.target.checked ? [...old, joint.id] : old.filter((id) => id !== joint.id),
                )
              }
            />
            {joint.name}
          </label>
        ))}
      </div>
      {!candidates.length && <p className="muted">本场景还没有关节，可在“添加对象”中创建。</p>}
      <label className="field">
        初始化权重
        <select
          aria-label="初始化权重"
          value={method}
          onChange={(e) => setMethod(e.target.value as typeof method)}
        >
          <option value="nearest">最近关节 · 每顶点单关节</option>
          <option value="first">全部给第一个关节</option>
        </select>
      </label>
      <p className="muted">
        最近关节只是初始分配。重新绑定会替换现有绑定和权重；可撤销。共享几何会先生成独立副本。
      </p>
      <button
        disabled={!joints.length}
        onClick={() =>
          send([{ type: 'skin.bind', entityId: entity.id, joints, method }], '绑定骨架')
        }
      >
        以基础姿态绑定
      </button>
    </details>
  );
}

export function SkinWeights({
  project,
  entity,
  vertices,
  send,
}: {
  project: Project;
  entity: Entity;
  vertices: number[];
  send: Send;
}) {
  const g = project.geometries.find((g) => g.id === entity.geometryId)!;
  const [weights, setWeights] = useState<VertexInfluences>([]);
  const signature = vertices.join(',');
  useEffect(
    () => setWeights(structuredClone(g.influences?.[vertices[0]] || [])),
    [project.revision, entity.id, signature],
  );
  if (!entity.skin) return null;
  const names = entity.skin.joints.map((id) => project.entities.find((e) => e.id === id)!.name);
  return (
    <section className="skin-weights" aria-label="顶点权重">
      <h3>选中顶点权重</h3>
      <p className="muted">
        网格编辑显示原始几何。下方读取首个选中顶点，应用会替换全部 {vertices.length}{' '}
        个选中顶点的权重并归一化；空权重不能保存。
      </p>
      {weights.map((v, i) => (
        <div className="skin-weight-row" key={i}>
          <select
            aria-label={`权重关节 ${i + 1}`}
            value={v.joint}
            onChange={(e) =>
              setWeights((old) =>
                old.map((w, j) => (j === i ? { ...w, joint: +e.target.value } : w)),
              )
            }
          >
            {names.map((name, joint) => (
              <option key={joint} value={joint}>
                {name}
              </option>
            ))}
          </select>
          <NumberInput
            label={`影响权重 ${i + 1}`}
            min={0.000001}
            max={1}
            value={v.weight}
            onChange={(weight) =>
              setWeights((old) => old.map((w, j) => (j === i ? { ...w, weight } : w)))
            }
          />
          <button
            aria-label={`移除权重 ${i + 1}`}
            onClick={() => setWeights((old) => old.filter((_, j) => j !== i))}
          >
            ×
          </button>
        </div>
      ))}
      <div className="button-row">
        <button
          disabled={!vertices.length || weights.length >= Math.min(32, names.length)}
          onClick={() => {
            const joint = names.findIndex((_, i) => !weights.some((w) => w.joint === i));
            if (joint >= 0) setWeights([...weights, { joint, weight: 0.5 }]);
          }}
        >
          增加关节影响
        </button>
        <button
          disabled={!vertices.length || !weights.length}
          onClick={() =>
            send(
              [{ type: 'skin.weights', entityId: entity.id, indices: vertices, weights }],
              '设置顶点权重',
            )
          }
        >
          应用并归一化权重
        </button>
      </div>
    </section>
  );
}
