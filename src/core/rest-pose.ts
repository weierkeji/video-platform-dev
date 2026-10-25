import { Matrix4 } from 'three';
import type { Entity, Project } from './model';
import { matrixTransform, sceneEvaluator, transformMatrix } from './constraints';

export const restTransform = (e: Entity) =>
  e.restPose?.enabled ? e.restPose.transform : e.transform;

/** Read-only editing scope: no actions, constraints, layers or IK. Skinning remains active. */
export function restProject(p: Project): Project {
  return {
    ...p,
    entities: p.entities.map((e) => ({
      ...e,
      transform: restTransform(e),
      restPose: undefined,
      constraints: undefined,
    })),
    animationTracks: [],
    ikTracks: [],
    animationLayers: [],
    ikChains: p.ikChains?.map((c) => ({ ...c, enabled: false })),
  };
}
export const restWorld = (p: Project, sceneId: string) =>
  sceneEvaluator(restProject(p), sceneId)().world;

export function rigNodes(p: Project, sceneId: string) {
  const entities = p.entities.filter((e) => e.sceneId === sceneId),
    byId = new Map(entities.map((e) => [e.id, e]));
  const nodes = new Set([
    ...entities.filter((e) => e.joint || e.restPose).map((e) => e.id),
    ...entities.flatMap((e) => e.skin?.joints || []),
    ...(p.ikChains || []).filter((c) => c.sceneId === sceneId).flatMap((c) => c.joints),
  ]);
  for (const id of nodes) {
    let e = byId.get(id);
    while (e?.parentId && !nodes.has(e.parentId)) {
      nodes.add(e.parentId);
      e = byId.get(e.parentId);
    }
  }
  return nodes;
}

function invert(matrix: Matrix4, label: string) {
  if (matrix.elements.some((v) => !Number.isFinite(v)) || Math.abs(matrix.determinant()) < 1e-12)
    throw new Error(`${label}不可逆，无法更新基础姿态`);
  return matrix.clone().invert();
}
function affine(matrix: Matrix4) {
  const a = matrix.toArray();
  if (a.some((v) => !Number.isFinite(v) || Math.abs(v) > 1e7))
    throw new Error('补偿后的绑定矩阵超出有限数值范围');
  a[3] = a[7] = a[11] = 0;
  a[15] = 1;
  return a;
}
function selected(p: Project, ids: string[]) {
  if (!ids.length || new Set(ids).size !== ids.length)
    throw new Error('基础姿态节点不能为空或重复');
  const entities = ids.map((id) => p.entities.find((e) => e.id === id));
  const sceneId = entities[0]?.sceneId;
  if (!sceneId || entities.some((e) => !e || e.sceneId !== sceneId))
    throw new Error('基础姿态节点必须属于同一场景');
  const eligible = rigNodes(p, sceneId);
  if (ids.some((id) => !eligible.has(id)))
    throw new Error('只能编辑关节、骨架成员及其祖先的基础姿态');
  return entities as Entity[];
}

/** Mutates only the transaction draft. Preserve every influenced joint contribution. */
export function updateRestPose(
  p: Project,
  updates: { entityId: string; transform: Entity['transform'] }[],
  preserveShape: boolean,
  reset = false,
) {
  const entities = selected(
      p,
      updates.map((u) => u.entityId),
    ),
    sceneId = entities[0].sceneId;
  const before = preserveShape ? restWorld(p, sceneId) : undefined;
  for (let i = 0; i < entities.length; i++) {
    const e = entities[i],
      transform = updates[i].transform;
    invert(transformMatrix(transform), '新基础变换');
    if (reset) delete e.restPose;
    else {
      const reference = e.restPose?.enabled ? e.restPose.reference : e.transform;
      invert(transformMatrix(reference), '频道参考');
      e.restPose = {
        enabled: true,
        transform: structuredClone(transform),
        reference: structuredClone(reference),
      };
    }
  }
  if (!before) return;
  const after = restWorld(p, sceneId);
  for (const mesh of p.entities.filter((e) => e.sceneId === sceneId && e.skin)) {
    mesh.skin!.inverseBindMatrices = mesh.skin!.joints.map((id, i) => {
      const old = before.get(id)!,
        next = after.get(id)!,
        binding = mesh.skin!.inverseBindMatrices[i];
      if (old.elements.every((v, j) => v === next.elements[j])) return binding;
      return affine(
        invert(next, '关节基础世界矩阵').multiply(old).multiply(new Matrix4().fromArray(binding)),
      );
    });
  }
}

export function captureRestPose(
  p: Project,
  entityIds: string[],
  frame: number,
  preserveShape: boolean,
) {
  const entities = selected(p, entityIds),
    pose = sceneEvaluator(p, entities[0].sceneId)(frame);
  // A fallback pose from a failed solver/constraint is not an authoritative capture.
  if (pose.warnings.length)
    throw new Error('当前姿态有求解诊断，请先处理后再复制到基础姿态：' + pose.warnings[0].message);
  const updates = entities.map((e) => ({
    entityId: e.id,
    transform: matrixTransform(pose.local.get(e.id)!, e.name),
  }));
  updateRestPose(p, updates, preserveShape);
}

export function resetRestPose(p: Project, entityIds: string[], preserveShape: boolean) {
  const entities = selected(p, entityIds);
  updateRestPose(
    p,
    entities.map((e) => ({ entityId: e.id, transform: e.transform })),
    preserveShape,
    true,
  );
}
