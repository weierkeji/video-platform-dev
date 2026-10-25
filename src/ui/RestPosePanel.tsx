import { useState } from 'react';
import type { Command } from '../core/commands';
import type { Entity, Project, Vec3 } from '../core/model';
import { eulerFromQuaternion } from '../core/animation';
import { restTransform, rigNodes } from '../core/rest-pose';
import { VectorInput } from './Inspector';

export function RestPosePanel({
  project,
  entity,
  frame,
  preserveShape,
  setPreserveShape,
  send,
}: {
  project: Project;
  entity?: Entity;
  frame: number;
  preserveShape: boolean;
  setPreserveShape: (value: boolean) => void;
  send: (commands: Command[], label: string) => void;
}) {
  const [branch, setBranch] = useState(false);
  if (!entity || !rigNodes(project, entity.sceneId).has(entity.id))
    return (
      <div className="inspector-body">
        <h3>基础姿态编辑</h3>
        <p>选择关节、骨架成员或它们的父级。此视图不随动画帧变化。</p>
      </div>
    );
  const e = entity,
    eligible = rigNodes(project, e.sceneId),
    descendants = new Set([e.id]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const n of project.entities)
      if (n.parentId && descendants.has(n.parentId) && !descendants.has(n.id)) {
        descendants.add(n.id);
        changed = true;
      }
  }
  const ids = branch ? [...descendants].filter((id) => eligible.has(id)) : [e.id];
  const meshes = project.entities.filter((n) => n.skin?.joints.some((j) => descendants.has(j)));
  const t = structuredClone(restTransform(e));
  if (t.quaternion) t.rotation = eulerFromQuaternion(t.quaternion);
  const update = (transform: Entity['transform']) =>
    send(
      [{ type: 'rig.rest.update', updates: [{ entityId: e.id, transform }], preserveShape }],
      '编辑基础姿态',
    );
  return (
    <section className="inspector-body rest-pose-panel" aria-label="基础姿态属性">
      <h3>{e.name} · 基础姿态</h3>
      <p className="muted">
        当前只显示基础姿态，动画、动作层、约束和 IK
        暂不预览。字段与手柄修改关节基础；已有曲线保持原值，在新基础上继续运动。
      </p>
      <label className="check">
        <input
          type="checkbox"
          aria-label="保持蒙皮基础外形"
          checked={preserveShape}
          onChange={(event) => setPreserveShape(event.target.checked)}
        />
        保持蒙皮基础外形
      </label>
      <p className="muted">
        {preserveShape
          ? '补偿所有受影响绑定，保持此基础视图的网格世界外形。'
          : '保留原绑定，让网格随骨架基础变化。'}{' '}
        {meshes.length} 个蒙皮对象可能受影响；附件随父级移动。
      </p>
      <VectorInput
        label="基础位置"
        value={t.position}
        onChange={(position) => update({ ...t, position })}
      />
      <VectorInput
        label="基础旋转 °"
        value={t.rotation.map((v) => (v * 180) / Math.PI) as Vec3}
        onChange={(r) =>
          update({
            ...t,
            rotation: r.map((v) => (v * Math.PI) / 180) as Vec3,
            quaternion: undefined,
          })
        }
      />
      <VectorInput label="基础缩放" value={t.scale} onChange={(scale) => update({ ...t, scale })} />
      <label className="check">
        <input
          type="checkbox"
          aria-label="包含骨架子节点"
          checked={branch}
          onChange={(event) => setBranch(event.target.checked)}
        />
        复制/重置包含骨架子节点（{ids.length} 个）
      </label>
      <button
        onClick={() =>
          send(
            [{ type: 'rig.rest.capture', entityIds: ids, frame, preserveShape }],
            '复制当前局部姿态到基础',
          )
        }
      >
        复制当前帧局部姿态到基础
      </button>
      <p className="muted">
        从帧 {frame}{' '}
        的正常求值取局部姿态。不会清除动画、修改限角参考或固化网格；重新播放时运动偏移仍会叠加。
      </p>
      <button
        disabled={!ids.some((id) => project.entities.find((e) => e.id === id)?.restPose)}
        onClick={() =>
          send([{ type: 'rig.rest.reset', entityIds: ids, preserveShape }], '重置基础姿态偏移')
        }
      >
        重置基础姿态偏移
      </button>
      <p className="muted">
        PNG、GLB 和成片使用正常动画求值。退出“基础姿态”检查运动结果；补偿不保证整段动作外形不变。
      </p>
    </section>
  );
}
