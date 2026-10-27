import { useEffect, useMemo, useState } from 'react';
import { id, type Project } from '../core/model';
import { planHierarchyCopy, type HierarchyCopyOptions } from '../core/hierarchy-copy';
import type { Command } from '../core/commands';

export function HierarchyCopyPanel({
  project,
  ids,
  busy,
  saveError,
  send,
  onClose,
  onCopied,
}: {
  project: Project;
  ids: string[];
  busy: boolean;
  saveError: string;
  send: (commands: Command[], label: string) => Promise<Project | undefined>;
  onClose: () => void;
  onCopied: (ids: string[]) => void;
}) {
  const [options, setOptions] = useState<HierarchyCopyOptions>({
    entityIds: ids,
    geometry: 'copy',
    materials: 'copy',
    external: 'preserve',
  });
  const preview = useMemo(() => {
    try {
      return { plan: planHierarchyCopy(project, options), error: '' };
    } catch (error) {
      return { plan: undefined, error: (error as Error).message };
    }
  }, [project, options]);
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', keydown);
    return () => window.removeEventListener('keydown', keydown);
  }, [busy, onClose]);
  const plan = preview.plan;
  return (
    <div className="modal-backdrop">
      <section
        className="modal exchange-modal"
        role="dialog"
        aria-modal="true"
        aria-label="复制对象层级"
      >
        <div className="panel-heading">
          <h2>复制对象层级</h2>
          <button disabled={busy} onClick={onClose}>
            取消
          </button>
        </div>
        <p>
          原地复制所选对象及全部后代，内部驱动转向副本。完成后选中副本根节点，可继续移动或编辑。
        </p>
        <fieldset disabled={busy}>
          <label className="field">
            几何数据
            <select
              aria-label="复制几何数据"
              value={options.geometry}
              onChange={(e) =>
                setOptions({
                  ...options,
                  geometry: e.target.value as HierarchyCopyOptions['geometry'],
                })
              }
            >
              <option value="copy">独立复制</option>
              <option value="linked">与原对象共享</option>
            </select>
          </label>
          <label className="field">
            材质数据
            <select
              aria-label="复制材质数据"
              value={options.materials}
              onChange={(e) =>
                setOptions({
                  ...options,
                  materials: e.target.value as HierarchyCopyOptions['materials'],
                })
              }
            >
              <option value="copy">独立复制</option>
              <option value="linked">与原对象共享</option>
            </select>
          </label>
          <label className="field">
            外部驱动与绑定
            <select
              aria-label="复制外部依赖"
              value={options.external}
              onChange={(e) =>
                setOptions({
                  ...options,
                  external: e.target.value as HierarchyCopyOptions['external'],
                })
              }
            >
              <option value="preserve">保留原引用</option>
              <option value="include">包含外部依赖</option>
              <option value="reject">有外部依赖时拒绝</option>
            </select>
          </label>
          <p className="muted">
            独立数据仍保留副本之间原有的共享关系；共享数据的编辑会影响原对象。图片素材继续共用。所有动作的对象轨道、键与对象层独立复制，场景动作选择不变。
          </p>
          <p className="muted">
            外部父级保持原引用。包含依赖会递归复制约束目标、绑定骨架、IK
            控制器及目标骨架的重定向源，可能涉及其他场景；镜头和片段继续引用原对象。
          </p>
          {plan && (
            <>
              <p role="status" data-copy-count={plan.selected.length}>
                复制 {plan.selected.length} 个对象（{plan.roots.length} 个根），其中额外依赖{' '}
                {plan.added.length} 个； 新几何 {plan.geometries.length}，新材质{' '}
                {plan.materials.length}，变换/IK 轨道 {plan.tracks.length + plan.ikTracks.length}，
                动作层 {plan.layers.length}，IK 链 {plan.chains.length}，重定向配方{' '}
                {plan.profiles.length}。
              </p>
              <p>
                保留 {plan.external.length} 项外部驱动/绑定引用、{plan.parents.length} 项外部父级。
              </p>
              {plan.external.length > 0 && (
                <ul>
                  {plan.external.slice(0, 12).map((ref, index) => (
                    <li key={index}>
                      {ref.kind}：{project.entities.find((e) => e.id === ref.targetId)?.name}
                    </li>
                  ))}
                </ul>
              )}
              {plan.external.length > 12 && <p>另有 {plan.external.length - 12} 项引用。</p>}
              <p className="muted">
                复制根：
                {plan.roots
                  .map(
                    (e) => `${e.name}（${project.scenes.find((s) => s.id === e.sceneId)?.name}）`,
                  )
                  .slice(0, 20)
                  .join('、')}
                {plan.roots.length > 20 ? '…' : ''}
              </p>
            </>
          )}
          {(preview.error || saveError) && <p role="alert">{preview.error || saveError}</p>}
          <button
            disabled={!plan}
            onClick={async () => {
              const batchId = id();
              const result = await send(
                [{ type: 'entities.duplicate', ...options, batchId }],
                '复制对象层级',
              );
              if (!result) return;
              const copies = result.entities.filter((e) => e.id.startsWith(`${batchId}_`));
              const copiedIds = new Set(copies.map((e) => e.id));
              const sceneId = project.entities.find((e) => e.id === ids[0])!.sceneId;
              onCopied(
                copies
                  .filter(
                    (e) => e.sceneId === sceneId && (!e.parentId || !copiedIds.has(e.parentId)),
                  )
                  .map((e) => e.id),
              );
            }}
          >
            创建层级副本
          </button>
        </fieldset>
      </section>
    </div>
  );
}
