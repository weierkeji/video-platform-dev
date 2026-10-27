import { useMemo, useState } from 'react';
import { id, type Project } from '../core/model';
import {
  dataProperty,
  dataUsers,
  planDataIsolation,
  type DataKind,
  type DataIsolationOptions,
} from '../core/data-users';
import type { Command } from '../core/commands';

export function DataUsersPanel({
  project,
  ids,
  send,
  onSelectUsers,
}: {
  project: Project;
  ids: string[];
  send: (commands: Command[], label: string) => Promise<Project | undefined>;
  onSelectUsers: (sceneId: string, ids: string[]) => void;
}) {
  const selected = ids
    .map((key) => project.entities.find((e) => e.id === key))
    .filter((e) => e?.kind === 'mesh');
  const entityIds = selected.map((e) => e!.id),
    sceneId = selected[0]?.sceneId;
  const [resources, setResources] = useState<DataKind[]>(['geometry', 'material']);
  const [mode, setMode] = useState<DataIsolationOptions['mode']>(
    entityIds.length > 1 ? 'selection' : 'individual',
  );
  const preview = useMemo(() => {
    if (!resources.length) return { plan: undefined, error: '请选择至少一种数据。' };
    try {
      return { plan: planDataIsolation(project, { entityIds, resources, mode }), error: '' };
    } catch (error) {
      return { plan: undefined, error: (error as Error).message };
    }
  }, [project, ids, resources, mode]);
  if (!entityIds.length) return null;
  const entries = (['geometry', 'material'] as const).flatMap((kind) => {
    const sources = [...new Set(selected.map((e) => e![dataProperty(kind)]!))];
    return sources.map((key) => ({
      kind,
      key,
      users: dataUsers(project, kind, key),
      name: (kind === 'geometry' ? project.geometries : project.materials).find(
        (d) => d.id === key,
      )!.name,
    }));
  });
  return (
    <section className="data-users-panel" aria-label="共享数据管理">
      <h3>共享数据 · {entityIds.length} 个网格</h3>
      <p className="muted">几何或材质编辑会影响其全部使用者，用户数包含其他场景和隐藏对象。</p>
      {entries.slice(0, 12).map((entry) => (
        <details key={`${entry.kind}:${entry.key}`} data-resource-id={entry.key}>
          <summary>
            {entry.kind === 'geometry' ? '几何' : '材质'}：{entry.name} · {entry.users.length}{' '}
            个对象
          </summary>
          <button
            onClick={() =>
              onSelectUsers(
                sceneId!,
                entry.users.filter((e) => e.sceneId === sceneId).map((e) => e.id),
              )
            }
          >
            选择本场景使用者
          </button>
          <ul>
            {entry.users.map((user) => (
              <li key={user.id}>
                <button onClick={() => onSelectUsers(user.sceneId, [user.id])}>
                  {user.name} · {project.scenes.find((s) => s.id === user.sceneId)?.name}
                  {!user.visible ? ' · 自身隐藏' : ''}
                </button>
              </li>
            ))}
          </ul>
        </details>
      ))}
      {entries.length > 12 && (
        <p className="muted">另有 {entries.length - 12} 项数据；缩小选择可查看其使用者。</p>
      )}
      <details className="data-isolation-options">
        <summary>解除共享设置</summary>
        <label className="check">
          <input
            type="checkbox"
            aria-label="独立几何"
            checked={resources.includes('geometry')}
            onChange={(e) =>
              setResources(
                e.target.checked
                  ? [...resources, 'geometry']
                  : resources.filter((k) => k !== 'geometry'),
              )
            }
          />
          几何
        </label>
        <label className="check">
          <input
            type="checkbox"
            aria-label="独立材质"
            checked={resources.includes('material')}
            onChange={(e) =>
              setResources(
                e.target.checked
                  ? [...resources, 'material']
                  : resources.filter((k) => k !== 'material'),
              )
            }
          />
          材质
        </label>
        <label className="field">
          独立方式
          <select
            aria-label="数据独立方式"
            value={mode}
            onChange={(e) => setMode(e.target.value as DataIsolationOptions['mode'])}
          >
            <option value="individual">每个对象独立</option>
            <option value="selection">所选对象保持内部共享</option>
          </select>
        </label>
        <p className="muted">
          仅处理所选网格，图片素材仍共用；动画与绑定保持。几何改为新数据后会退出旧组件编辑。
        </p>
        {preview.error ? (
          <p role="status">{preview.error}</p>
        ) : (
          preview.plan && (
            <p role="status" data-isolation-copies={preview.plan.copies.length}>
              {preview.plan.copies.length
                ? `将新增 ${preview.plan.geometries} 份几何、${preview.plan.materials} 份材质，更新 ${preview.plan.affectedIds.length} 个对象。`
                : '所选数据已满足当前独立方式。'}
            </p>
          )
        )}
        <button
          disabled={!preview.plan?.copies.length}
          onClick={() =>
            void send(
              [{ type: 'entities.data.isolate', batchId: id(), entityIds, resources, mode }],
              '解除几何/材质共享',
            )
          }
        >
          解除所选数据共享
        </button>
      </details>
    </section>
  );
}
