import { Matrix4, Quaternion, Vector3 } from 'three';
import { z } from 'zod';
import { Vec3Schema, type Entity, type Project, type Vec3 } from './model';
import {
  activeConstraints,
  activeIK,
  localBasis,
  matrixTransform,
  sceneEvaluator,
  transformMatrix,
} from './constraints';
import { activeTracks, quaternionFromEuler, rotationProperty } from './animation';
import { evaluatedBaseTransform } from './evaluate';
import { evaluatedIK } from './ik-animation';
import type { Command } from './commands';

const ID = z.string().min(1).max(80);
export const ObjectTransformSchema = z
  .object({
    type: z.literal('entities.transform'),
    entityIds: z.array(ID).min(1).max(2000),
    activeId: ID,
    frame: z.number().finite().min(0).max(1e6),
    layers: z.boolean().default(true),
    pivot: z.enum(['median', 'active', 'individual']),
    delta: z
      .object({
        position: Vec3Schema,
        rotation: Vec3Schema,
        scale: Vec3Schema.refine(
          (v) => v.every((n) => Math.abs(n) >= 1e-6),
          '变换倍率不能为零或过小',
        ),
      })
      .strict(),
  })
  .strict();
export type ObjectTransformCommand = z.infer<typeof ObjectTransformSchema>;
export type ObjectPivot = ObjectTransformCommand['pivot'];
const close = (a: number[], b: number[], tolerance = 1e-8) =>
  a.every(
    (v, i) =>
      Number.isFinite(v) &&
      Number.isFinite(b[i]) &&
      Math.abs(v - b[i]) <= tolerance * Math.max(1, Math.abs(v), Math.abs(b[i])),
  );
const matrixClose = (a: Matrix4, b: Matrix4) =>
  a.elements.every(
    (v, i) =>
      Number.isFinite(v) &&
      Number.isFinite(b.elements[i]) &&
      Math.abs(v - b.elements[i]) <=
        (i >= 12 && i <= 14 ? 1e-6 : 1e-8 * Math.max(1, Math.abs(v), Math.abs(b.elements[i]))),
  );
const inverse = (m: Matrix4, name: string) => {
  if (m.elements.some((v) => !Number.isFinite(v)) || Math.abs(m.determinant()) < 1e-12)
    throw new Error(`“${name}”的父级或频道基底不可逆，无法成组变换`);
  return m.clone().invert();
};
export function objectTransformBlock(p: Project, ids: string[], frame: number, layers: boolean) {
  const selected = new Set(ids);
  for (const e of p.entities.filter((e) => selected.has(e.id))) {
    if (e.skin) return `“${e.name}”是蒙皮网格，请通过骨架或共同父级移动外形`;
    if (activeConstraints(e).length) return `“${e.name}”有启用约束，请先停用约束或烘焙`;
    if (layers && p.animationLayers?.some((l) => l.entityId === e.id && l.enabled))
      return `“${e.name}”有动作层，请关闭“预览动作层”后编辑原频道`;
  }
  for (const chain of activeIK(p.ikChains, p.ikTracks))
    if (
      chain.joints.some((key) => selected.has(key)) &&
      evaluatedIK(p, chain, frame, undefined, layers).influence > 0
    )
      return `“${chain.name}”仍在驱动所选关节，请匹配到 FK 或调整控制器`;
}
export function objectPivot(
  world: Map<string, Matrix4>,
  ids: string[],
  activeId: string,
  pivot: ObjectPivot,
) {
  if (pivot === 'active') return new Vector3().setFromMatrixPosition(world.get(activeId)!);
  const center = new Vector3();
  for (const key of ids) center.add(new Vector3().setFromMatrixPosition(world.get(key)!));
  return center.multiplyScalar(1 / ids.length);
}
function nearestEuler(value: Vec3, reference: Vec3): Vec3 {
  const wrap = (a: number[]) =>
    a.map((n, i) => n + Math.round((reference[i] - n) / (2 * Math.PI)) * 2 * Math.PI) as Vec3;
  const a = wrap(value),
    b = wrap([value[0] + Math.PI, Math.PI - value[1], value[2] + Math.PI]);
  const distance = (v: Vec3) => v.reduce((sum, n, i) => sum + (n - reference[i]) ** 2, 0);
  return distance(a) <= distance(b) ? a : b;
}

/** A single old-pose snapshot defines all desired worlds. A selected descendant
 * is solved relative to its already-transformed parent, never transformed twice. */
export function planObjectTransform(p: Project, input: ObjectTransformCommand) {
  const c = ObjectTransformSchema.parse(input),
    byId = new Map(p.entities.map((e) => [e.id, e]));
  if (new Set(c.entityIds).size !== c.entityIds.length) throw new Error('成组变换的对象不能重复');
  const entities = c.entityIds.map((key) => {
    const e = byId.get(key);
    if (!e) throw new Error('所选对象不存在');
    return e;
  });
  const sceneId = entities[0].sceneId;
  if (entities.some((e) => e.sceneId !== sceneId))
    throw new Error('成组变换只能包含同一场景的对象');
  if (!c.entityIds.includes(c.activeId)) throw new Error('活动对象必须属于当前选择');
  const blocked = objectTransformBlock(p, c.entityIds, c.frame, c.layers);
  if (blocked) throw new Error(blocked);
  const pose = sceneEvaluator(p, sceneId)(c.frame, undefined, c.layers);
  const center = objectPivot(pose.world, c.entityIds, c.activeId, c.pivot);
  const deltas = new Map<string, Matrix4>(),
    wanted = new Map<string, Matrix4>();
  for (const e of entities) {
    const pivot =
      c.pivot === 'individual'
        ? new Vector3().setFromMatrixPosition(pose.world.get(e.id)!)
        : center;
    const delta = new Matrix4()
      .makeTranslation(...c.delta.position)
      .multiply(new Matrix4().makeTranslation(pivot.x, pivot.y, pivot.z))
      .multiply(transformMatrix({ ...c.delta, position: [0, 0, 0] }))
      .multiply(new Matrix4().makeTranslation(-pivot.x, -pivot.y, -pivot.z));
    deltas.set(e.id, delta);
    wanted.set(e.id, delta.clone().multiply(pose.world.get(e.id)!));
  }
  const commands: Command[] = [];
  for (const e of entities) {
    let parent = e.parentId,
      ancestor = parent;
    while (ancestor && !deltas.has(ancestor)) ancestor = byId.get(ancestor)!.parentId;
    const parentWorld = parent ? pose.world.get(parent)!.clone() : new Matrix4();
    if (ancestor) parentWorld.premultiply(deltas.get(ancestor)!);
    const desired = inverse(localBasis(e), e.name)
      .multiply(inverse(parentWorld, e.name))
      .multiply(wanted.get(e.id)!);
    const old = evaluatedBaseTransform(p, e, c.frame),
      oldMatrix = transformMatrix(old);
    if (matrixClose(oldMatrix, desired)) continue;
    // Pure translation must preserve negative scale and multi-turn Euler channels.
    const sameLinear = close(oldMatrix.elements.slice(0, 12), desired.elements.slice(0, 12));
    const value: Entity['transform'] = sameLinear
      ? { ...old, position: new Vector3().setFromMatrixPosition(desired).toArray() }
      : matrixTransform(desired, e.name);
    const oldQ = new Quaternion(...(old.quaternion || quaternionFromEuler(old.rotation))),
      nextQ = new Quaternion(...(value.quaternion || quaternionFromEuler(value.rotation)));
    if (oldQ.dot(nextQ) < 0) nextQ.set(-nextQ.x, -nextQ.y, -nextQ.z, -nextQ.w);
    const sameRotation = close(oldQ.toArray(), nextQ.toArray(), 1e-10);
    value.rotation = sameRotation ? old.rotation : nearestEuler(value.rotation, old.rotation);
    const base = structuredClone(e.transform),
      tracks = activeTracks(p, e.id);
    for (const property of ['position', 'rotation', 'scale'] as const) {
      if (
        property === 'rotation'
          ? sameRotation
          : property === 'position'
            ? old.position.every((n, i) => Math.abs(n - value.position[i]) < 1e-7)
            : close(old[property], value[property])
      )
        continue;
      const channel = property === 'rotation' ? rotationProperty(p, e) : property;
      if (tracks.some((t) => t.property === channel))
        commands.push({
          type: 'key.set',
          entityId: e.id,
          property: channel,
          key: {
            frame: c.frame,
            value: channel === 'quaternion' ? nextQ.toArray() : value[property],
          },
        });
      else if (property === 'rotation') {
        base.rotation = value.rotation;
        if (base.quaternion) base.quaternion = nextQ.toArray();
      } else base[property] = value[property];
    }
    if (JSON.stringify(base) !== JSON.stringify(e.transform))
      commands.push({ type: 'entity.update', id: e.id, patch: { transform: base } });
  }
  return { commands, wanted, sceneId, beforeWarnings: pose.warnings.map((w) => JSON.stringify(w)) };
}
export function verifyObjectTransform(
  p: Project,
  c: ObjectTransformCommand,
  plan: ReturnType<typeof planObjectTransform>,
) {
  const pose = sceneEvaluator(p, plan.sceneId)(c.frame, undefined, c.layers),
    before = new Set(plan.beforeWarnings);
  if (pose.warnings.some((w) => !before.has(JSON.stringify(w))))
    throw new Error('成组变换产生新的求值诊断，整次操作未提交');
  for (const [key, expected] of plan.wanted)
    if (!matrixClose(expected, pose.world.get(key)!))
      throw new Error(
        `“${p.entities.find((e) => e.id === key)!.name}”受层级或驱动影响，无法达到目标世界姿态；整次操作未提交`,
      );
}
