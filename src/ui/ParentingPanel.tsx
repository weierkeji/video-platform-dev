import { useState } from 'react';
import type { Project, Entity } from '../core/model';
import type { Command } from '../core/commands';

export function ParentingPanel({
  project,
  entity,
  frame,
  layers,
  send,
}: {
  project: Project;
  entity: Entity;
  frame: number;
  layers: boolean;
  send: (commands: Command[], label: string) => void;
}) {
  const [keepWorld, setKeepWorld] = useState(true);
  const descendants = new Set([entity.id]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const e of project.entities)
      if (e.parentId && descendants.has(e.parentId) && !descendants.has(e.id)) {
        descendants.add(e.id);
        changed = true;
      }
  }
  return (
    <div className="parenting-panel">
      <label className="field">
        父对象
        <select
          aria-label="父对象"
          value={entity.parentId || ''}
          onChange={(event) =>
            send(
              [
                {
                  type: 'entity.reparent',
                  entityIds: [entity.id],
                  parentId: event.target.value || null,
                  frame,
                  keepWorld,
                  layers,
                  rest: false,
                },
              ],
              keepWorld ? '保持世界姿态调整父级' : '保留局部变换调整父级',
            )
          }
        >
          <option value="">场景根节点</option>
          {project.entities
            .filter((e) => e.sceneId === entity.sceneId && !descendants.has(e.id))
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
          checked={keepWorld}
          onChange={(e) => setKeepWorld(e.target.checked)}
          aria-label="重设父级保持世界姿态"
        />
        保持当前场景帧的世界姿态
      </label>
      <p className="muted">
        保持原动画频道，后续帧继承新父级运动；不保持整个动画范围。
        {layers ? '包含动作层。' : '按当前关闭动作层的编辑预览计算。'}
      </p>
      {entity.parentOffset && (
        <label className="check">
          <input
            type="checkbox"
            aria-label="启用层级补偿"
            checked={entity.parentOffset.enabled}
            onChange={(event) =>
              send(
                [
                  {
                    type: 'entity.update',
                    id: entity.id,
                    patch: {
                      parentOffset: { ...entity.parentOffset!, enabled: event.target.checked },
                    },
                  },
                ],
                '切换层级补偿',
              )
            }
          />
          使用层级补偿（关闭会改变姿态）
        </label>
      )}
    </div>
  );
}
