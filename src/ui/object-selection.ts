import type { Entity, Project } from '../core/model';

/** Ordered, temporary selection. The last ID is the single active object. */
export function chooseObjects(
  previous: string[],
  ids: string[],
  mode: 'replace' | 'add' | 'remove' | 'toggle',
) {
  const input = [...new Set(ids)];
  if (mode === 'replace') return input;
  if (mode === 'remove') return previous.filter((key) => !input.includes(key));
  if (mode === 'add') return [...previous.filter((key) => !input.includes(key)), ...input];
  return [
    ...previous.filter((key) => !input.includes(key)),
    ...input.filter((key) => !previous.includes(key)),
  ];
}
export function sceneRows(p: Project, sceneId: string) {
  const children = new Map<string | null, Entity[]>();
  for (const e of p.entities.filter((e) => e.sceneId === sceneId))
    children.set(e.parentId, [...(children.get(e.parentId) || []), e]);
  const pending = (children.get(null) || []).map((entity) => ({ entity, depth: 0 })).reverse(),
    rows: typeof pending = [];
  while (pending.length) {
    const row = pending.pop()!;
    rows.push(row);
    for (const entity of [...(children.get(row.entity.id) || [])].reverse())
      pending.push({ entity, depth: row.depth + 1 });
  }
  return rows;
}
export function visibleObjects(p: Project, sceneId: string) {
  const hidden = new Set<string>();
  return sceneRows(p, sceneId)
    .filter(({ entity }) => {
      if (!entity.visible || (entity.parentId && hidden.has(entity.parentId))) {
        hidden.add(entity.id);
        return false;
      }
      return true;
    })
    .map((row) => row.entity.id);
}
