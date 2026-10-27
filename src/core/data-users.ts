import { z } from 'zod';
import type { Project } from './model';

export type DataKind = 'geometry' | 'material';
const ID = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[a-zA-Z0-9_-]+$/);
export const DataIsolationOptionsSchema = z
  .object({
    entityIds: z.array(ID).min(1).max(2000),
    resources: z
      .array(z.enum(['geometry', 'material']))
      .min(1)
      .max(2),
    mode: z.enum(['individual', 'selection']),
  })
  .strict();
export const DataIsolationSchema = DataIsolationOptionsSchema.extend({
  type: z.literal('entities.data.isolate'),
  batchId: z.string().uuid(),
}).strict();
export type DataIsolationOptions = z.infer<typeof DataIsolationOptionsSchema>;
export type DataIsolationCommand = z.infer<typeof DataIsolationSchema>;

export const dataProperty = (kind: DataKind) => (kind === 'geometry' ? 'geometryId' : 'materialId');
export function dataUsers(p: Project, kind: DataKind, resourceId: string) {
  return p.entities.filter((e) => e[dataProperty(kind)] === resourceId);
}

export function planDataIsolation(p: Project, input: DataIsolationOptions) {
  const options = DataIsolationOptionsSchema.parse(input);
  if (new Set(options.entityIds).size !== options.entityIds.length)
    throw new Error('解除共享的对象不能重复');
  if (new Set(options.resources).size !== options.resources.length)
    throw new Error('资源类型不能重复');
  const entities = options.entityIds.map((key) => {
    const e = p.entities.find((e) => e.id === key);
    if (!e || e.kind !== 'mesh') throw new Error('解除共享只能选择存在的网格对象');
    return e;
  });
  const selected = new Set(options.entityIds);
  const copies: { kind: DataKind; sourceId: string; entityIds: string[] }[] = [];
  for (const kind of options.resources) {
    const property = dataProperty(kind),
      groups = new Map<string, string[]>();
    for (const e of entities) {
      const key = e[property];
      if (!key) throw new Error('对象缺少待复制数据');
      groups.set(key, [...(groups.get(key) || []), e.id]);
    }
    for (const [sourceId, members] of groups) {
      const users = dataUsers(p, kind, sourceId),
        outside = users.some((e) => !selected.has(e.id));
      if (options.mode === 'selection') {
        if (outside) copies.push({ kind, sourceId, entityIds: members });
      } else if (users.length > 1) {
        for (const key of outside ? members : members.slice(1))
          copies.push({ kind, sourceId, entityIds: [key] });
      }
    }
  }
  const geometries = copies.filter((c) => c.kind === 'geometry').length,
    materials = copies.length - geometries;
  if (p.geometries.length + geometries > 2000 || p.materials.length + materials > 2000)
    throw new Error('解除共享后资源超过每类 2000 项上限');
  return {
    copies,
    geometries,
    materials,
    affectedIds: [...new Set(copies.flatMap((c) => c.entityIds))],
  };
}

export function isolateData(p: Project, input: DataIsolationCommand) {
  const { type: _type, batchId, ...options } = DataIsolationSchema.parse(input);
  const plan = planDataIsolation(p, options);
  if (!plan.copies.length) throw new Error('所选数据已经满足当前独立方式，无需重复复制');
  if ([...p.geometries, ...p.materials].some((d) => d.id.startsWith(`${batchId}_`)))
    throw new Error('数据独立批次 ID 已存在，请重新操作');
  let serial = 0;
  for (const change of plan.copies) {
    const nextId = `${batchId}_${change.kind}_${++serial}`;
    if (change.kind === 'geometry') {
      const source = p.geometries.find((g) => g.id === change.sourceId);
      if (!source) throw new Error('几何数据不存在');
      p.geometries.push({
        ...structuredClone(source),
        id: nextId,
        name: source.name.slice(0, 157) + ' 独立',
      });
    } else {
      const source = p.materials.find((m) => m.id === change.sourceId);
      if (!source) throw new Error('材质数据不存在');
      p.materials.push({
        ...structuredClone(source),
        id: nextId,
        name: source.name.slice(0, 157) + ' 独立',
      });
    }
    for (const key of change.entityIds)
      p.entities.find((e) => e.id === key)![dataProperty(change.kind)] = nextId;
  }
}
