import { z } from 'zod';
import { type Project } from './model';

const ID = z.string().min(1).max(80);
export const HierarchyCopyOptionsSchema = z
  .object({
    entityIds: z.array(ID).min(1).max(2000),
    geometry: z.enum(['copy', 'linked']).default('copy'),
    materials: z.enum(['copy', 'linked']).default('copy'),
    external: z.enum(['preserve', 'include', 'reject']).default('preserve'),
  })
  .strict();
export const HierarchyCopySchema = HierarchyCopyOptionsSchema.extend({
  type: z.literal('entities.duplicate'),
  batchId: z.string().uuid(),
}).strict();
export type HierarchyCopyOptions = z.infer<typeof HierarchyCopyOptionsSchema>;
export type HierarchyCopyCommand = z.infer<typeof HierarchyCopySchema>;
type Reference = { ownerId: string; targetId: string; kind: string };

/** Build a bounded outgoing-dependency closure. Incoming users remain original. */
export function planHierarchyCopy(p: Project, input: HierarchyCopyOptions) {
  const options = HierarchyCopyOptionsSchema.parse(input);
  const entities = new Map(p.entities.map((e) => [e.id, e]));
  if (new Set(options.entityIds).size !== options.entityIds.length)
    throw new Error('复制选择不能重复');
  const selection = options.entityIds.map((key) => {
    const entity = entities.get(key);
    if (!entity) throw new Error('复制对象不存在');
    return entity;
  });
  if (selection.some((e) => e.sceneId !== selection[0].sceneId))
    throw new Error('请从同一场景选择待复制的子树');
  const children = new Map<string, string[]>();
  for (const e of p.entities)
    if (e.parentId) children.set(e.parentId, [...(children.get(e.parentId) || []), e.id]);
  const scope = new Set<string>();
  const add = (ids: string[]) => {
    const pending = [...ids];
    while (pending.length) {
      const key = pending.pop()!;
      if (scope.has(key)) continue;
      if (!entities.has(key)) throw new Error('复制依赖引用不存在');
      scope.add(key);
      pending.push(...(children.get(key) || []));
    }
  };
  add(options.entityIds);
  const initial = new Set(scope);
  const references = () => {
    const refs: Reference[] = [];
    const ref = (ownerId: string, targetId: string | null | undefined, kind: string) => {
      if (targetId) refs.push({ ownerId, targetId, kind });
    };
    for (const e of p.entities.filter((e) => scope.has(e.id))) {
      for (const constraint of e.constraints || []) ref(e.id, constraint.targetId, '约束目标');
      for (const joint of e.skin?.joints || []) ref(e.id, joint, '蒙皮关节');
      ref(e.id, e.skin?.skeletonId, '骨架根');
    }
    for (const chain of p.ikChains || [])
      if (chain.joints.some((key) => scope.has(key))) {
        for (const key of chain.joints) ref(chain.joints[0], key, 'IK 关节');
        ref(chain.joints[0], chain.targetId, 'IK 目标');
        ref(chain.joints[0], chain.poleId, 'IK 极向');
      }
    for (const profile of p.retargetProfiles || [])
      if (scope.has(profile.targetRootId)) {
        ref(profile.targetRootId, profile.sourceRootId, '重定向源根');
        for (const pair of profile.mappings)
          ref(profile.targetRootId, pair.sourceId, '重定向源节点');
      }
    return refs;
  };
  if (options.external === 'include') {
    let previous = -1;
    while (previous !== scope.size) {
      previous = scope.size;
      add(references().map((r) => r.targetId));
    }
  }
  const chains = (p.ikChains || []).filter((c) => c.joints.some((key) => scope.has(key)));
  if (chains.some((c) => !c.joints.every((key) => scope.has(key))))
    throw new Error('复制只包含部分 IK 关节；请选择整条链或使用“包含外部依赖”');
  const external = references().filter((r) => !scope.has(r.targetId));
  if (options.external === 'reject' && external.length) {
    const first = external[0];
    throw new Error(
      `仍有外部${first.kind}“${entities.get(first.targetId)!.name}”；请包含依赖或保留引用`,
    );
  }
  const selected = p.entities.filter((e) => scope.has(e.id));
  const geometryIds = new Set(selected.flatMap((e) => (e.geometryId ? [e.geometryId] : [])));
  const materialIds = new Set(selected.flatMap((e) => (e.materialId ? [e.materialId] : [])));
  const tracks = p.animationTracks.filter((t) => scope.has(t.entityId));
  const chainIds = new Set(chains.map((c) => c.id));
  const ikTracks = (p.ikTracks || []).filter((t) => chainIds.has(t.chainId));
  const layers = (p.animationLayers || []).filter((l) => scope.has(l.entityId));
  const profiles = (p.retargetProfiles || []).filter((r) => scope.has(r.targetRootId));
  const geometries =
    options.geometry === 'copy' ? p.geometries.filter((g) => geometryIds.has(g.id)) : [];
  const materials =
    options.materials === 'copy' ? p.materials.filter((m) => materialIds.has(m.id)) : [];
  for (const [count, limit, label] of [
    [p.entities.length + selected.length, 2000, '对象'],
    [p.geometries.length + geometries.length, 2000, '几何'],
    [p.materials.length + materials.length, 2000, '材质'],
    [p.animationTracks.length + tracks.length, 6000, '变换轨道'],
    [(p.ikTracks?.length || 0) + ikTracks.length, 6000, 'IK 轨道'],
    [(p.animationLayers?.length || 0) + layers.length, 512, '动作层'],
    [(p.ikChains?.length || 0) + chains.length, 128, 'IK 链'],
    [(p.retargetProfiles?.length || 0) + profiles.length, 128, '重定向配方'],
  ] as const)
    if (count > limit) throw new Error(`复制后${label}超过 ${limit} 项上限`);
  return {
    selected,
    geometries,
    materials,
    tracks,
    ikTracks,
    chains,
    layers,
    profiles,
    external,
    added: selected.filter((e) => !initial.has(e.id)),
    roots: selected.filter((e) => !e.parentId || !scope.has(e.parentId)),
    parents: selected.filter((e) => e.parentId && !scope.has(e.parentId)),
  };
}

/** IDs are determined by the audited batch namespace and stable source order. */
export function duplicateHierarchy(p: Project, command: HierarchyCopyCommand) {
  const c = HierarchyCopySchema.parse(command);
  const { type: _type, batchId, ...options } = c;
  const plan = planHierarchyCopy(p, options);
  // A namespace cannot be reused even if its original entities were edited/reordered.
  const existing = [
    ...p.entities,
    ...p.geometries,
    ...p.materials,
    ...p.animationTracks,
    ...(p.ikTracks || []),
    ...(p.animationLayers || []),
    ...(p.ikChains || []),
    ...(p.retargetProfiles || []),
  ];
  if (existing.some((item) => item.id.startsWith(`${batchId}_`)))
    throw new Error('复制批次 ID 已存在，请重新开始复制');
  let serial = 0;
  const next = (kind: string) => `${batchId}_${kind}_${++serial}`;
  const map = new Map<string, string>();
  for (const [kind, items] of [
    ['e', plan.selected],
    ['g', plan.geometries],
    ['m', plan.materials],
    ['t', plan.tracks],
    ['i', plan.chains],
    ['it', plan.ikTracks],
    ['l', plan.layers],
    ['r', plan.profiles],
  ] as const)
    for (const item of items) map.set(item.id, next(kind));
  const remap = (key: string) => map.get(key) || key;
  const name = (value: string) => value.slice(0, 157) + ' 副本';
  for (const item of plan.geometries)
    p.geometries.push({ ...structuredClone(item), id: remap(item.id), name: name(item.name) });
  for (const item of plan.materials)
    p.materials.push({ ...structuredClone(item), id: remap(item.id), name: name(item.name) });
  for (const item of plan.selected) {
    const e = structuredClone(item);
    e.id = remap(e.id);
    e.name = name(e.name);
    if (e.parentId) e.parentId = remap(e.parentId);
    if (e.geometryId) e.geometryId = remap(e.geometryId);
    if (e.materialId) e.materialId = remap(e.materialId);
    for (const constraint of e.constraints || []) {
      constraint.id = next('c');
      constraint.targetId = remap(constraint.targetId);
    }
    if (e.skin) {
      e.skin.joints = e.skin.joints.map(remap);
      if (e.skin.skeletonId) e.skin.skeletonId = remap(e.skin.skeletonId);
    }
    p.entities.push(e);
  }
  for (const item of plan.chains) {
    const chain = structuredClone(item);
    chain.id = remap(chain.id);
    chain.name = name(chain.name);
    chain.joints = chain.joints.map(remap);
    chain.targetId = remap(chain.targetId);
    if (chain.poleId) chain.poleId = remap(chain.poleId);
    for (const limit of chain.limits || []) limit.jointId = remap(limit.jointId);
    (p.ikChains ||= []).push(chain);
  }
  for (const item of plan.tracks) {
    const track = structuredClone(item);
    track.id = remap(track.id);
    track.entityId = remap(track.entityId);
    for (const key of track.keys) key.id = next('k');
    p.animationTracks.push(track);
  }
  for (const item of plan.ikTracks) {
    const track = structuredClone(item);
    track.id = remap(track.id);
    track.entityId = remap(track.entityId);
    track.chainId = remap(track.chainId);
    for (const key of track.keys) key.id = next('k');
    (p.ikTracks ||= []).push(track);
  }
  for (const item of plan.layers)
    (p.animationLayers ||= []).push({
      ...structuredClone(item),
      id: remap(item.id),
      entityId: remap(item.entityId),
      name: name(item.name),
    });
  for (const item of plan.profiles) {
    const profile = structuredClone(item);
    profile.id = remap(profile.id);
    profile.name = name(profile.name);
    profile.sourceRootId = remap(profile.sourceRootId);
    profile.targetRootId = remap(profile.targetRootId);
    profile.mappings = profile.mappings.map((pair) => ({
      sourceId: remap(pair.sourceId),
      targetId: remap(pair.targetId),
    }));
    (p.retargetProfiles ||= []).push(profile);
  }
  return { map, roots: plan.roots.map((e) => remap(e.id)) };
}
