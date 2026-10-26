import { Matrix4 } from 'three';
import { z } from 'zod';
import { ParentOffsetSchema, parseProject, type Project } from './model';
import { parentBasis, sceneEvaluator } from './constraints';
import { restProject } from './rest-pose';

const ID = z.string().min(1).max(80);
export const ReparentSchema = z
  .object({
    type: z.literal('entity.reparent'),
    entityIds: z.array(ID).min(1).max(2000),
    parentId: ID.nullable(),
    frame: z.number().finite().min(0).max(1e6),
    keepWorld: z.boolean(),
    layers: z.boolean().default(true),
    rest: z.boolean().default(false),
  })
  .strict();

/** Edit only a command transaction draft. The complete evaluated scene is checked
 * so local-space readers or IK limits cannot silently invalidate preservation. */
export function reparentEntities(p: Project, input: z.infer<typeof ReparentSchema>) {
  const c = ReparentSchema.parse(input),
    byId = new Map(p.entities.map((e) => [e.id, e]));
  if (new Set(c.entityIds).size !== c.entityIds.length) throw new Error('重设父级的对象不能重复');
  const selected = c.entityIds.map((id) => {
    const e = byId.get(id);
    if (!e) throw new Error('重设父级的对象不存在');
    return e;
  });
  const sceneId = selected[0].sceneId;
  if (selected.some((e) => e.sceneId !== sceneId)) throw new Error('所选对象必须属于同一场景');
  if (c.parentId && (!byId.has(c.parentId) || byId.get(c.parentId)!.sceneId !== sceneId))
    throw new Error('父对象必须存在且属于同一场景');
  if (c.parentId && c.entityIds.includes(c.parentId))
    throw new Error('父对象不能属于重设父级的选择');
  const evaluate = () =>
    sceneEvaluator(c.rest ? restProject(p) : p, sceneId)(
      c.rest ? undefined : c.frame,
      undefined,
      c.layers,
    );
  const before = c.keepWorld ? evaluate() : undefined;
  const nextParent = c.parentId && before ? before.world.get(c.parentId)! : new Matrix4();
  if (
    before &&
    (nextParent.elements.some((v) => !Number.isFinite(v)) ||
      Math.abs(nextParent.determinant()) < 1e-12)
  )
    throw new Error('新父级当前矩阵不可逆，无法保持世界变换');
  const inverse = nextParent.clone().invert();
  for (const e of selected) {
    if (e.parentId === c.parentId) continue;
    if (before) {
      const oldParent = e.parentId ? before.world.get(e.parentId)! : new Matrix4();
      const matrix = inverse.clone().multiply(oldParent).multiply(parentBasis(e)).toArray();
      matrix[3] = matrix[7] = matrix[11] = 0;
      matrix[15] = 1;
      e.parentOffset = ParentOffsetSchema.parse({ enabled: true, matrix });
    }
    e.parentId = c.parentId;
  }
  // Check hierarchy, IK chain continuity and active constraint dependencies first.
  parseProject(p);
  if (!before) return;
  const after = evaluate();
  const warning = (w: (typeof after.warnings)[number]) => JSON.stringify(w);
  const oldWarnings = new Set(before.warnings.map(warning));
  if (after.warnings.some((w) => !oldWarnings.has(warning(w))))
    throw new Error('新层级产生求值诊断；保持世界变换未提交，请检查约束/IK');
  for (const [id, old] of before.world) {
    const next = after.world.get(id)!;
    if (
      old.elements.some(
        (v, i) =>
          !Number.isFinite(next.elements[i]) ||
          Math.abs(v - next.elements[i]) >
            (i >= 12 && i <= 14
              ? 1e-6
              : 1e-8 * Math.max(1, Math.abs(v), Math.abs(next.elements[i]))),
      )
    )
      throw new Error(
        `“${byId.get(id)!.name}”的局部约束或 IK 随新层级改变，无法保持当前世界姿态；整次未提交。请调整驱动或先烘焙`,
      );
  }
}
