import { useState } from 'react';
import { identity, type Project } from '../core/model';
import { objectTransformBlock, type ObjectPivot } from '../core/object-transform';
import type { Command } from '../core/commands';
import { VectorInput } from './Inspector';

export function ObjectGroupPanel({
  project,
  ids,
  frame,
  layers,
  pivot,
  setPivot,
  activate,
  send,
}: {
  project: Project;
  ids: string[];
  frame: number;
  layers: boolean;
  pivot: ObjectPivot;
  setPivot: (pivot: ObjectPivot) => void;
  activate: (id: string) => void;
  send: (commands: Command[], label: string) => Promise<Project | undefined>;
}) {
  const [delta, setDelta] = useState(identity),
    [parentId, setParentId] = useState(''),
    [keepWorld, setKeepWorld] = useState(true);
  const entities = project.entities.filter((e) => ids.includes(e.id)),
    active = ids.at(-1)!;
  const excluded = new Set(ids);
  let changed = true;
  while (changed) {
    changed = false;
    for (const e of project.entities)
      if (e.parentId && excluded.has(e.parentId) && !excluded.has(e.id)) {
        excluded.add(e.id);
        changed = true;
      }
  }
  const blocked = objectTransformBlock(project, ids, frame, layers);
  return (
    <section className="object-group-panel" data-object-selection-count={ids.length}>
      <h3>已选择 {ids.length} 个对象</h3>
      <label className="field">
        活动对象
        <select aria-label="活动对象" value={active} onChange={(e) => activate(e.target.value)}>
          {entities.map((e) => (
            <option key={e.id} value={e.id}>
              {e.name}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        变换枢轴
        <select
          aria-label="对象变换枢轴"
          value={pivot}
          onChange={(e) => setPivot(e.target.value as ObjectPivot)}
        >
          <option value="median">选择原点均值</option>
          <option value="active">活动对象原点</option>
          <option value="individual">各自原点</option>
        </select>
      </label>
      <p className="muted">
        按世界轴编辑当前帧；父子同时选中不会重复变换。已有动画频道写当前帧键，其余频道改对象基础值。
      </p>
      {blocked && <p role="status">{blocked}</p>}
      <VectorInput
        label="成组位移 m"
        value={delta.position}
        onChange={(position) => setDelta({ ...delta, position })}
      />
      <VectorInput
        label="成组旋转 °"
        value={delta.rotation}
        onChange={(rotation) => setDelta({ ...delta, rotation })}
      />
      <VectorInput
        label="成组缩放倍率"
        value={delta.scale}
        onChange={(scale) => setDelta({ ...delta, scale })}
      />
      <div className="button-row">
        <button
          disabled={!!blocked}
          onClick={async () => {
            const result = await send(
              [
                {
                  type: 'entities.transform',
                  entityIds: ids,
                  activeId: active,
                  frame,
                  layers,
                  pivot,
                  delta: {
                    ...delta,
                    rotation: delta.rotation.map(
                      (n) => (n * Math.PI) / 180,
                    ) as typeof delta.rotation,
                  },
                },
              ],
              '成组变换对象',
            );
            if (result) setDelta(identity());
          }}
        >
          应用成组变换
        </button>
        <button onClick={() => setDelta(identity())}>重置变换输入</button>
      </div>
      <h3>批量父级</h3>
      <label className="field">
        统一父对象
        <select
          aria-label="统一父对象"
          value={parentId}
          onChange={(e) => setParentId(e.target.value)}
        >
          <option value="">场景根节点</option>
          {project.entities
            .filter((e) => e.sceneId === entities[0]?.sceneId && !excluded.has(e.id))
            .map((e) => (
              <option key={e.id} value={e.id}>
                {e.name}
              </option>
            ))}
        </select>
      </label>
      <label className="check">
        <input
          type="checkbox"
          aria-label="批量父级保持世界姿态"
          checked={keepWorld}
          onChange={(e) => setKeepWorld(e.target.checked)}
        />
        保持当前帧世界姿态
      </label>
      <p className="muted">
        每个所选对象都附加到指定父级；同时选中的父子会变为同级。后续帧继承新父级运动。
      </p>
      <button
        onClick={() =>
          void send(
            [
              {
                type: 'entity.reparent',
                entityIds: ids,
                parentId: parentId || null,
                frame,
                layers,
                keepWorld,
                rest: false,
              },
            ],
            '批量重设父级',
          )
        }
      >
        重设所选父级
      </button>
      <div className="button-row">
        <button
          onClick={() =>
            void send(
              [{ type: 'entities.visibility', entityIds: ids, visible: true }],
              '显示所选对象',
            )
          }
        >
          显示所选
        </button>
        <button
          onClick={() =>
            void send(
              [{ type: 'entities.visibility', entityIds: ids, visible: false }],
              '隐藏所选对象',
            )
          }
        >
          隐藏所选
        </button>
        <button
          onClick={() =>
            void send([{ type: 'entities.delete', entityIds: ids }], '删除所选对象及后代')
          }
        >
          删除所选及后代
        </button>
      </div>
    </section>
  );
}
