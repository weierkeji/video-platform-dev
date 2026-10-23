import { z } from 'zod';
import {
  ArtifactSchema,
  AnimationActionSchema,
  AnimationLayerSchema,
  AnimationTrackSchema,
  AssetSchema,
  ClipSchema,
  EntitySchema,
  GeometrySchema,
  KeySchema,
  HandleSchema,
  HandleModeSchema,
  MaterialSchema,
  SceneSchema,
  ShotSchema,
  TimelineSchema,
  TransformSchema,
  WorkflowSchema,
  VertexInfluencesSchema,
  ConstraintSchema,
  id,
  identity,
  parseProject,
  type Project,
} from './model';
import { extrudeFace, primitive, subdivide, projectUV } from './geometry';
import { editTrack, normalizeQuaternion, prepareCubic, activeTracks } from './animation';
import { unwrappedSourceFrame } from './playback';
import { bakeAnimation, BakeOptionsSchema } from './bake';
import { displayColor } from './surface';
import { bindSkin, normalizedInfluences } from './skin';
import { deleteElements, extrudeRegion, mergeVertices, transformVertices } from './mesh';

const ID = z.string().min(1).max(80);
const MeshIndices = z.array(z.number().int().nonnegative()).min(1).max(200000);
export const CommandSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('project.rename'), name: z.string().min(1).max(160) }).strict(),
  z.object({ type: z.literal('scene.add'), scene: SceneSchema }).strict(),
  z
    .object({
      type: z.literal('action.add'),
      action: AnimationActionSchema,
      copyFrom: ID.nullable().optional(),
    })
    .strict(),
  z.object({ type: z.literal('action.rename'), id: ID, name: z.string().min(1).max(160) }).strict(),
  z.object({ type: z.literal('action.delete'), id: ID }).strict(),
  z
    .object({
      type: z.literal('action.bake'),
      action: AnimationActionSchema,
      options: BakeOptionsSchema,
      activate: z.boolean(),
    })
    .strict(),
  z.object({ type: z.literal('layer.add'), layer: AnimationLayerSchema }).strict(),
  z
    .object({
      type: z.literal('layer.update'),
      id: ID,
      patch: AnimationLayerSchema.omit({ id: true, entityId: true }).partial(),
    })
    .strict(),
  z.object({ type: z.literal('layer.delete'), id: ID }).strict(),
  z
    .object({
      type: z.literal('layer.move'),
      id: ID,
      direction: z.union([z.literal(-1), z.literal(1)]),
    })
    .strict(),
  z
    .object({
      type: z.literal('scene.import'),
      scenes: z.array(SceneSchema).min(1).max(100),
      entities: z.array(EntitySchema).max(2000),
      geometries: z.array(GeometrySchema).max(2000),
      materials: z.array(MaterialSchema).max(2000),
      assets: z.array(AssetSchema).max(1000).optional(),
      animationActions: z.array(AnimationActionSchema).max(1000).optional(),
      animationTracks: z.array(AnimationTrackSchema).max(6000).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('scene.update'),
      id: ID,
      patch: SceneSchema.omit({ id: true }).partial(),
    })
    .strict(),
  z
    .object({
      type: z.literal('entity.create'),
      kind: z.enum(['box', 'sphere', 'plane', 'cylinder', 'camera', 'light', 'group', 'joint']),
      sceneId: ID,
    })
    .strict(),
  z
    .object({
      type: z.literal('entity.update'),
      id: ID,
      patch: EntitySchema.omit({ id: true, sceneId: true, kind: true }).partial(),
    })
    .strict(),
  z.object({ type: z.literal('entity.delete'), id: ID }).strict(),
  z.object({ type: z.literal('entity.duplicate'), id: ID }).strict(),
  z
    .object({ type: z.literal('constraint.put'), entityId: ID, constraint: ConstraintSchema })
    .strict(),
  z.object({ type: z.literal('constraint.delete'), entityId: ID, id: ID }).strict(),
  z
    .object({
      type: z.literal('constraint.move'),
      entityId: ID,
      id: ID,
      direction: z.union([z.literal(-1), z.literal(1)]),
    })
    .strict(),
  z
    .object({
      type: z.literal('skin.bind'),
      entityId: ID,
      joints: z.array(ID).min(1).max(512),
      method: z.enum(['nearest', 'first']),
    })
    .strict(),
  z.object({ type: z.literal('skin.unbind'), entityId: ID }).strict(),
  z
    .object({
      type: z.literal('skin.weights'),
      entityId: ID,
      indices: MeshIndices,
      weights: VertexInfluencesSchema,
    })
    .strict(),
  z.object({ type: z.literal('geometry.import'), sceneId: ID, geometry: GeometrySchema }).strict(),
  z
    .object({
      type: z.literal('geometry.vertex'),
      id: ID,
      index: z.number().int().nonnegative(),
      position: TransformSchema.shape.position,
    })
    .strict(),
  z.object({ type: z.literal('geometry.subdivide'), id: ID }).strict(),
  z
    .object({
      type: z.literal('geometry.uvProject'),
      id: ID,
      channel: z.union([z.literal(0), z.literal(1)]),
    })
    .strict(),
  z
    .object({
      type: z.literal('geometry.transform'),
      id: ID,
      indices: MeshIndices,
      matrix: z.array(z.number().finite().min(-1e7).max(1e7)).length(16),
    })
    .strict(),
  z
    .object({
      type: z.literal('geometry.delete'),
      id: ID,
      mode: z.enum(['vertex', 'edge', 'face']),
      indices: MeshIndices,
    })
    .strict(),
  z.object({ type: z.literal('geometry.merge'), id: ID, indices: MeshIndices }).strict(),
  z
    .object({
      type: z.literal('geometry.extrudeRegion'),
      id: ID,
      faces: MeshIndices,
      offset: TransformSchema.shape.position,
    })
    .strict(),
  z
    .object({
      type: z.literal('geometry.extrude'),
      id: ID,
      face: z.number().int().nonnegative(),
      distance: z.number().finite().min(-100).max(100),
    })
    .strict(),
  z
    .object({
      type: z.literal('material.update'),
      id: ID,
      patch: MaterialSchema.omit({ id: true }).partial(),
    })
    .strict(),
  z
    .object({
      type: z.literal('key.set'),
      entityId: ID,
      property: z.enum(['position', 'rotation', 'scale', 'quaternion']),
      key: KeySchema.extend({
        id: ID.optional(),
        interpolation: KeySchema.shape.interpolation.optional(),
      }),
    })
    .strict(),
  z
    .object({
      type: z.literal('key.delete'),
      trackId: ID,
      frame: z.number().finite().nonnegative(),
    })
    .strict(),
  z
    .object({
      type: z.literal('key.update'),
      trackId: ID,
      keyId: ID,
      patch: KeySchema.pick({
        frame: true,
        value: true,
        interpolation: true,
        inTangent: true,
        outTangent: true,
      }).partial(),
    })
    .strict(),
  z
    .object({
      type: z.literal('key.handle'),
      trackId: ID,
      keyId: ID,
      axis: z.number().int().min(0).max(2),
      side: z.enum(['left', 'right']),
      offset: HandleSchema.shape.left,
    })
    .strict(),
  z
    .object({
      type: z.literal('key.handles'),
      trackId: ID,
      keyId: ID,
      axis: z.number().int().min(0).max(2),
      mode: HandleModeSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal('timeline.update'),
      patch: TimelineSchema.omit({ id: true, clips: true }).partial(),
    })
    .strict(),
  z.object({ type: z.literal('shot.add'), shot: ShotSchema }).strict(),
  z
    .object({
      type: z.literal('shot.update'),
      id: ID,
      patch: ShotSchema.omit({ id: true }).partial(),
    })
    .strict(),
  z.object({ type: z.literal('clip.add'), clip: ClipSchema }).strict(),
  z
    .object({
      type: z.literal('clip.update'),
      id: ID,
      patch: ClipSchema.omit({ id: true, kind: true, sourceId: true }).partial(),
    })
    .strict(),
  z.object({ type: z.literal('clip.delete'), id: ID }).strict(),
  z
    .object({ type: z.literal('clip.split'), id: ID, frame: z.number().int().nonnegative() })
    .strict(),
  z.object({ type: z.literal('asset.add'), asset: AssetSchema }).strict(),
  z.object({ type: z.literal('artifact.add'), artifact: ArtifactSchema }).strict(),
  z.object({ type: z.literal('asset.delete'), id: ID }).strict(),
  z.object({ type: z.literal('workflow.put'), workflow: WorkflowSchema }).strict(),
]);
export type Command = z.infer<typeof CommandSchema>;

function get<T extends { id: string }>(items: T[], id: string) {
  const item = items.find((x) => x.id === id);
  if (!item) throw new Error('目标对象已不存在，请刷新项目');
  return item;
}
function apply(p: Project, c: Command) {
  switch (c.type) {
    case 'project.rename':
      p.name = c.name;
      break;
    case 'scene.add':
      p.scenes.push(c.scene);
      break;
    case 'scene.import':
      if (
        c.entities.some(
          (e) =>
            !c.scenes.some((s) => s.id === e.sceneId) ||
            (e.parentId && !c.entities.some((parent) => parent.id === e.parentId)),
        )
      )
        throw new Error('导入场景必须包含其完整对象层级');
      p.scenes.push(...c.scenes);
      p.entities.push(...c.entities);
      p.geometries.push(...c.geometries);
      p.materials.push(...c.materials);
      p.assets.push(...(c.assets || []));
      if (c.animationActions?.length) (p.animationActions ||= []).push(...c.animationActions);
      p.animationTracks.push(...(c.animationTracks || []));
      break;
    case 'action.add': {
      const scene = get(p.scenes, c.action.sceneId);
      if (c.copyFrom && get(p.animationActions || [], c.copyFrom).sceneId !== scene.id)
        throw new Error('只能复制同一场景的动作');
      if (c.copyFrom !== undefined) {
        const targets = new Set(p.entities.filter((e) => e.sceneId === scene.id).map((e) => e.id));
        const tracks = p.animationTracks.filter(
          (t) => targets.has(t.entityId) && (t.actionId || null) === c.copyFrom,
        );
        p.animationTracks.push(
          ...tracks.map((t) => ({
            ...structuredClone(t),
            id: id(),
            actionId: c.action.id,
            keys: t.keys.map((k) => ({ ...structuredClone(k), id: id() })),
          })),
        );
      }
      (p.animationActions ||= []).push(c.action);
      scene.activeActionId = c.action.id;
      break;
    }
    case 'action.rename':
      get(p.animationActions || [], c.id).name = c.name;
      break;
    case 'action.bake': {
      const result = bakeAnimation(p, c.action.sceneId, c.options, c.action);
      (p.animationActions ||= []).push(result.action);
      p.animationTracks.push(...result.tracks);
      if (c.activate) {
        get(p.scenes, c.action.sceneId).activeActionId = c.action.id;
        const targets = new Set(
          p.entities.filter((e) => e.sceneId === c.action.sceneId).map((e) => e.id),
        );
        for (const layer of p.animationLayers || [])
          if (targets.has(layer.entityId)) layer.enabled = false;
        for (const entity of p.entities)
          if (targets.has(entity.id))
            for (const constraint of entity.constraints || []) constraint.enabled = false;
      }
      break;
    }
    case 'action.delete': {
      get(p.animationActions || [], c.id);
      if (p.animationLayers?.some((layer) => layer.actionId === c.id))
        throw new Error('动作仍被动作层引用，请先删除该层或选择其他动作');
      if (
        p.shots.some((s) => s.action?.actionId === c.id) ||
        p.timeline.clips.some((clip) => clip.action?.actionId === c.id)
      )
        throw new Error('动作仍被镜头或片段引用，请先改为跟随或选择其他动作');
      p.animationActions = p.animationActions?.filter((a) => a.id !== c.id);
      p.animationTracks = p.animationTracks.filter((t) => t.actionId !== c.id);
      p.scenes.forEach((s) => {
        if (s.activeActionId === c.id) s.activeActionId = null;
      });
      break;
    }
    case 'layer.add':
      (p.animationLayers ||= []).push(c.layer);
      break;
    case 'layer.update':
      Object.assign(get(p.animationLayers || [], c.id), c.patch);
      break;
    case 'layer.delete':
      get(p.animationLayers || [], c.id);
      p.animationLayers = p.animationLayers?.filter((l) => l.id !== c.id);
      break;
    case 'layer.move': {
      const layers = p.animationLayers || [],
        current = get(layers, c.id);
      const own = layers.filter((l) => l.entityId === current.entityId);
      const other = own[own.indexOf(current) + c.direction];
      if (other) {
        const a = layers.indexOf(current),
          b = layers.indexOf(other);
        [layers[a], layers[b]] = [layers[b], layers[a]];
      }
      break;
    }
    case 'scene.update':
      Object.assign(get(p.scenes, c.id), c.patch);
      break;
    case 'entity.create': {
      get(p.scenes, c.sceneId);
      const mesh = ['box', 'sphere', 'plane', 'cylinder'].includes(c.kind);
      const entity = {
        id: id(),
        name: {
          box: '立方体',
          sphere: '球体',
          plane: '平面',
          cylinder: '圆柱',
          camera: '摄影机',
          light: '灯光',
          group: '集合',
          joint: '关节',
        }[c.kind],
        kind: mesh ? 'mesh' : c.kind === 'joint' ? 'group' : c.kind,
        ...(c.kind === 'joint' ? { joint: true } : {}),
        sceneId: c.sceneId,
        parentId: null,
        visible: true,
        transform: identity(),
      } as Project['entities'][number];
      if (mesh) {
        const g = primitive(c.kind as 'box'),
          m = { id: id(), name: '新材质', color: '#66b7b0', roughness: 0.5, metalness: 0 };
        entity.geometryId = g.id;
        entity.materialId = m.id;
        p.geometries.push(g);
        p.materials.push(m);
        if (c.kind !== 'plane') entity.transform.position[1] = 1;
      } else if (c.kind === 'camera') {
        entity.camera = { fov: 45, near: 0.1, far: 1000 };
        entity.transform.position = [0, 3, 8];
      } else if (c.kind === 'light') {
        entity.light = { kind: 'point', color: '#ffffff', intensity: 100 };
        entity.transform.position = [2, 5, 3];
      }
      p.entities.push(entity);
      break;
    }
    case 'entity.update':
      Object.assign(get(p.entities, c.id), c.patch);
      break;
    case 'entity.delete': {
      get(p.entities, c.id);
      const removing = new Set([c.id]);
      let changed = true;
      while (changed) {
        changed = false;
        for (const e of p.entities)
          if (e.parentId && removing.has(e.parentId) && !removing.has(e.id)) {
            removing.add(e.id);
            changed = true;
          }
      }
      if (p.shots.some((s) => removing.has(s.cameraId)))
        throw new Error('摄影机被镜头引用，请先为镜头选择其他摄影机');
      if (
        p.entities.some(
          (e) => !removing.has(e.id) && e.constraints?.some((c) => removing.has(c.targetId)),
        )
      )
        throw new Error('对象仍被约束引用，请先删除相关约束或一起删除');
      if (
        p.entities.some(
          (e) =>
            !removing.has(e.id) &&
            e.skin &&
            (e.skin.joints.some((id) => removing.has(id)) ||
              (e.skin.skeletonId && removing.has(e.skin.skeletonId))),
        )
      )
        throw new Error('关节仍被蒙皮引用，请先解绑相关网格或一起删除');
      p.entities = p.entities.filter((e) => !removing.has(e.id));
      p.animationTracks = p.animationTracks.filter((t) => !removing.has(t.entityId));
      p.animationLayers = p.animationLayers?.filter((l) => !removing.has(l.entityId));
      p.geometries = p.geometries.filter((g) => p.entities.some((e) => e.geometryId === g.id));
      p.materials = p.materials.filter((m) => p.entities.some((e) => e.materialId === m.id));
      break;
    }
    case 'entity.duplicate': {
      const source = get(p.entities, c.id),
        e = structuredClone(source);
      e.id = id();
      e.name += ' 副本';
      e.constraints?.forEach((constraint) => {
        constraint.id = id();
      });
      if (!e.skin) e.transform.position[0] += 2.5;
      if (e.geometryId) {
        const g = structuredClone(get(p.geometries, e.geometryId));
        g.id = id();
        e.geometryId = g.id;
        p.geometries.push(g);
      }
      if (e.materialId) {
        const m = structuredClone(get(p.materials, e.materialId));
        m.id = id();
        e.materialId = m.id;
        p.materials.push(m);
      }
      p.entities.push(e);
      for (const layer of p.animationLayers?.filter((l) => l.entityId === source.id) || [])
        p.animationLayers!.push({ ...structuredClone(layer), id: id(), entityId: e.id });
      for (const t of p.animationTracks.filter((t) => t.entityId === source.id)) {
        const copy = structuredClone(t);
        copy.id = id();
        copy.entityId = e.id;
        p.animationTracks.push(copy);
      }
      break;
    }
    case 'geometry.import': {
      const m = { id: id(), name: '导入材质', color: '#9da9bf', roughness: 0.5, metalness: 0 };
      p.materials.push(m);
      p.geometries.push(c.geometry);
      p.entities.push({
        id: id(),
        name: c.geometry.name,
        kind: 'mesh',
        sceneId: c.sceneId,
        parentId: null,
        geometryId: c.geometry.id,
        materialId: m.id,
        visible: true,
        transform: identity(),
      });
      break;
    }
    case 'constraint.put': {
      const constraints = (get(p.entities, c.entityId).constraints ||= []);
      const index = constraints.findIndex((constraint) => constraint.id === c.constraint.id);
      if (index < 0) constraints.push(c.constraint);
      else constraints[index] = c.constraint;
      break;
    }
    case 'constraint.delete': {
      const entity = get(p.entities, c.entityId);
      get(entity.constraints || [], c.id);
      entity.constraints = entity.constraints!.filter((constraint) => constraint.id !== c.id);
      break;
    }
    case 'constraint.move': {
      const constraints = get(p.entities, c.entityId).constraints || [];
      const index = constraints.indexOf(get(constraints, c.id)),
        other = index + c.direction;
      if (constraints[other])
        [constraints[index], constraints[other]] = [constraints[other], constraints[index]];
      break;
    }
    case 'skin.bind': {
      const e = get(p.entities, c.entityId);
      if (e.kind !== 'mesh') throw new Error('只能绑定网格对象');
      if (p.entities.some((other) => other.id !== e.id && other.geometryId === e.geometryId)) {
        const copy = structuredClone(get(p.geometries, e.geometryId!));
        copy.id = id();
        p.geometries.push(copy);
        e.geometryId = copy.id;
      }
      e.skin = bindSkin(p, e, c.joints, c.method);
      break;
    }
    case 'skin.unbind':
      delete get(p.entities, c.entityId).skin;
      break;
    case 'skin.weights': {
      const e = get(p.entities, c.entityId);
      if (!e.skin) throw new Error('网格尚未绑定骨架');
      const g = get(p.geometries, e.geometryId!);
      if (
        new Set(c.indices).size !== c.indices.length ||
        c.indices.some((i) => i >= g.positions.length)
      )
        throw new Error('顶点选择无效');
      const weights = normalizedInfluences([c.weights]);
      for (const i of c.indices) g.influences![i] = structuredClone(weights);
      break;
    }
    case 'geometry.vertex': {
      const g = get(p.geometries, c.id);
      if (!g.positions[c.index]) throw new Error('顶点索引不存在');
      g.positions[c.index] = c.position;
      delete g.normals;
      delete g.tangents;
      break;
    }
    case 'geometry.subdivide':
      subdivide(get(p.geometries, c.id));
      break;
    case 'geometry.uvProject':
      projectUV(get(p.geometries, c.id), c.channel);
      break;
    case 'geometry.transform':
      transformVertices(get(p.geometries, c.id), c.indices, c.matrix);
      break;
    case 'geometry.delete':
      deleteElements(get(p.geometries, c.id), c.mode, c.indices);
      break;
    case 'geometry.merge':
      mergeVertices(get(p.geometries, c.id), c.indices);
      break;
    case 'geometry.extrudeRegion':
      extrudeRegion(get(p.geometries, c.id), c.faces, c.offset);
      break;
    case 'geometry.extrude':
      extrudeFace(get(p.geometries, c.id), c.face, c.distance);
      break;
    case 'material.update': {
      const m = get(p.materials, c.id);
      Object.assign(m, c.patch);
      if (c.patch.linearColor) m.color = displayColor(c.patch.linearColor);
      else if (c.patch.color !== undefined) delete m.linearColor;
      break;
    }
    case 'key.set': {
      const entity = get(p.entities, c.entityId),
        actionId = get(p.scenes, entity.sceneId).activeActionId || undefined;
      let t = activeTracks(p, c.entityId).find((t) => t.property === c.property);
      if (!t) {
        t = {
          id: id(),
          entityId: c.entityId,
          property: c.property,
          keys: [],
          ...(actionId ? { actionId } : {}),
        };
        p.animationTracks.push(t);
      }
      const previous = t.keys.find((k) => k.frame === c.key.frame);
      t.keys = t.keys.filter((k) => k.frame !== c.key.frame);
      t.keys.push({
        ...previous,
        ...c.key,
        id: previous?.id || c.key.id || id(),
        interpolation: c.key.interpolation || previous?.interpolation || 'linear',
        ...(c.property === 'quaternion' ? { value: normalizeQuaternion(c.key.value) } : {}),
      });
      t.keys.sort((a, b) => a.frame - b.frame);
      prepareCubic(t);
      break;
    }
    case 'key.update':
    case 'key.handle':
    case 'key.handles':
      editTrack(get(p.animationTracks, c.trackId), c);
      break;
    case 'key.delete': {
      const t = get(p.animationTracks, c.trackId);
      t.keys = t.keys.filter((k) => k.frame !== c.frame);
      prepareCubic(t);
      if (!t.keys.length) p.animationTracks = p.animationTracks.filter((x) => x.id !== t.id);
      break;
    }
    case 'timeline.update':
      Object.assign(p.timeline, c.patch);
      break;
    case 'shot.add':
      p.shots.push(c.shot);
      break;
    case 'shot.update':
      Object.assign(get(p.shots, c.id), c.patch);
      break;
    case 'clip.add':
      p.timeline.clips.push(c.clip);
      break;
    case 'clip.update':
      Object.assign(get(p.timeline.clips, c.id), c.patch);
      break;
    case 'clip.delete':
      get(p.timeline.clips, c.id);
      p.timeline.clips = p.timeline.clips.filter((x) => x.id !== c.id);
      break;
    case 'clip.split': {
      const clip = get(p.timeline.clips, c.id),
        left = c.frame - clip.start;
      if (left <= 0 || left >= clip.duration) throw new Error('播放头必须位于片段内部');
      p.timeline.clips.push({
        ...clip,
        id: id(),
        name: clip.name + ' · 后段',
        start: c.frame,
        sourceIn: unwrappedSourceFrame(clip, c.frame),
        duration: clip.duration - left,
      });
      clip.duration = left;
      break;
    }
    case 'asset.add':
      p.assets.push(c.asset);
      break;
    case 'artifact.add':
      p.artifacts.push(c.artifact);
      break;
    case 'asset.delete':
      if (p.timeline.clips.some((x) => x.sourceId === c.id)) throw new Error('素材仍被时间轴引用');
      if (p.materials.some((m) => Object.values(m.textures || {}).some((b) => b.assetId === c.id)))
        throw new Error('素材仍被材质贴图引用；请先解除贴图');
      get(p.assets, c.id);
      p.assets = p.assets.filter((x) => x.id !== c.id);
      break;
    case 'workflow.put': {
      const i = p.workflows.findIndex((w) => w.id === c.workflow.id);
      if (i < 0) p.workflows.push(c.workflow);
      else p.workflows[i] = c.workflow;
      break;
    }
  }
}

export function applyCommands(
  project: Project,
  input: unknown,
): { project: Project; commands: Command[] } {
  const commands = z.array(CommandSchema).min(1).max(100).parse(input);
  const next = structuredClone(project);
  commands.forEach((c) => apply(next, c));
  return { project: parseProject(next), commands };
}
