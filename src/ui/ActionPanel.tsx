import { id, type Project } from '../core/model';
import type { Command } from '../core/commands';

export function ActionPanel({
  project: p,
  sceneId,
  send,
  onReduce,
}: {
  project: Project;
  sceneId: string;
  send: (commands: Command[], label: string) => void;
  onReduce: () => void;
}) {
  const scene = p.scenes.find((s) => s.id === sceneId)!;
  if (!scene) return null;
  const actions = (p.animationActions || []).filter((a) => a.sceneId === sceneId),
    current = actions.find((a) => a.id === scene.activeActionId);
  const add = (copy: boolean) =>
    send(
      [
        {
          type: 'action.add',
          action: {
            id: id(),
            sceneId,
            name: copy
              ? `${current?.name || '项目动画'} 副本`.slice(0, 160)
              : `动作 ${actions.length + 1}`,
          },
          ...(copy ? { copyFrom: scene.activeActionId || null } : {}),
        },
      ],
      copy ? '复制动画动作' : '创建动画动作',
    );
  return (
    <div className="action-panel">
      <label className="field">
        动画动作
        <select
          aria-label="动画动作"
          value={scene.activeActionId || ''}
          onChange={(event) =>
            send(
              [
                {
                  type: 'scene.update',
                  id: sceneId,
                  patch: { activeActionId: event.target.value || null },
                },
              ],
              '切换动画动作',
            )
          }
        >
          <option value="">项目动画</option>
          {actions.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
      </label>
      {current && (
        <label className="field">
          名称
          <input
            aria-label="动作名称"
            key={current.id + current.name}
            defaultValue={current.name}
            maxLength={160}
            onBlur={(event) => {
              if (event.target.value.trim() && event.target.value !== current.name)
                send(
                  [{ type: 'action.rename', id: current.id, name: event.target.value.trim() }],
                  '重命名动作',
                );
            }}
          />
        </label>
      )}
      <div className="button-row">
        <button onClick={() => add(false)}>新动作</button>
        <button onClick={() => add(true)}>复制动作</button>
        {current && (
          <button onClick={() => send([{ type: 'action.delete', id: current.id }], '删除动画动作')}>
            删除动作
          </button>
        )}
      </div>
      <button onClick={onReduce}>精简动作</button>
      <p className="muted">场景默认动作；镜头或片段可覆盖选择。场景编辑使用此动作。</p>
    </div>
  );
}
