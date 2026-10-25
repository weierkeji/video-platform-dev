import type { Entity, Project, RetargetProfile } from './model';
import { rigNodes } from './rest-pose';

/** Stable parent-before-child traversal, including unmapped attachment nodes. */
export function retargetSubtree(p: Project, rootId: string): Entity[] {
  const root = p.entities.find((e) => e.id === rootId);
  if (!root) throw new Error('重定向根节点不存在；请先修改或删除引用它的映射');
  const result = [root];
  const visited = new Set([root.id]);
  for (let i = 0; i < result.length; i++)
    for (const child of p.entities.filter((e) => e.parentId === result[i].id)) {
      if (visited.has(child.id)) throw new Error('重定向子树层级存在循环');
      visited.add(child.id);
      result.push(child);
    }
  return result;
}

export function validateRetargetProfile(p: Project, profile: RetargetProfile) {
  const source = retargetSubtree(p, profile.sourceRootId),
    target = retargetSubtree(p, profile.targetRootId),
    sourceIds = new Set(source.map((e) => e.id)),
    targetIds = new Set(target.map((e) => e.id)),
    sourceRig = rigNodes(p, source[0].sceneId),
    targetRig = rigNodes(p, target[0].sceneId);
  if (target.some((e) => sourceIds.has(e.id))) throw new Error('重定向源与目标子树不能重叠');
  if (!sourceRig.has(source[0].id) || !targetRig.has(target[0].id))
    throw new Error('重定向根必须是关节、骨架成员或其祖先');
  if (Math.abs(Math.hypot(...profile.alignment) - 1) > 1e-6)
    throw new Error('重定向方向对齐四元数必须归一化');
  if (!profile.mappings.some((m) => m.sourceId === source[0].id && m.targetId === target[0].id))
    throw new Error('重定向必须包含源根到目标根的映射');
  const mapped = new Set<string>();
  for (const m of profile.mappings) {
    if (
      !sourceIds.has(m.sourceId) ||
      !targetIds.has(m.targetId) ||
      !sourceRig.has(m.sourceId) ||
      !targetRig.has(m.targetId)
    )
      throw new Error('重定向映射必须引用各自子树内的骨架节点；请先修改或删除相关映射');
    if (mapped.has(m.targetId)) throw new Error('每个目标骨架节点只能映射一次');
    mapped.add(m.targetId);
  }
  return { source, target };
}
