import { z } from 'zod';
import {
  ArtifactSchema,
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
  id,
  identity,
  parseProject,
  type Project,
} from './model';
import { extrudeFace, primitive, subdivide } from './geometry';
import { editTrack } from './animation';

const ID = z.string().min(1).max(80);
export const CommandSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('project.rename'), name: z.string().min(1).max(160) }).strict(),
  z.object({ type: z.literal('scene.add'), scene: SceneSchema }).strict(),
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
      kind: z.enum(['box', 'sphere', 'plane', 'cylinder', 'camera', 'light', 'group']),
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
      property: z.enum(['position', 'rotation', 'scale']),
      key: KeySchema.extend({
        id: ID.optional(),
        interpolation: KeySchema.shape.interpolation.optional(),
      }),
    })
    .strict(),
  z
    .object({ type: z.literal('key.delete'), trackId: ID, frame: z.number().int().nonnegative() })
    .strict(),
  z
    .object({
      type: z.literal('key.update'),
      trackId: ID,
      keyId: ID,
      patch: KeySchema.pick({ frame: true, value: true, interpolation: true }).partial(),
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
        }[c.kind],
        kind: mesh ? 'mesh' : c.kind,
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
      p.entities = p.entities.filter((e) => !removing.has(e.id));
      p.animationTracks = p.animationTracks.filter((t) => !removing.has(t.entityId));
      p.geometries = p.geometries.filter((g) => p.entities.some((e) => e.geometryId === g.id));
      p.materials = p.materials.filter((m) => p.entities.some((e) => e.materialId === m.id));
      break;
    }
    case 'entity.duplicate': {
      const source = get(p.entities, c.id),
        e = structuredClone(source);
      e.id = id();
      e.name += ' 副本';
      e.transform.position[0] += 2.5;
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
    case 'geometry.vertex': {
      const g = get(p.geometries, c.id);
      if (!g.positions[c.index]) throw new Error('顶点索引不存在');
      g.positions[c.index] = c.position;
      break;
    }
    case 'geometry.subdivide':
      subdivide(get(p.geometries, c.id));
      break;
    case 'geometry.extrude':
      extrudeFace(get(p.geometries, c.id), c.face, c.distance);
      break;
    case 'material.update':
      Object.assign(get(p.materials, c.id), c.patch);
      break;
    case 'key.set': {
      get(p.entities, c.entityId);
      let t = p.animationTracks.find((t) => t.entityId === c.entityId && t.property === c.property);
      if (!t) {
        t = { id: id(), entityId: c.entityId, property: c.property, keys: [] };
        p.animationTracks.push(t);
      }
      const previous = t.keys.find((k) => k.frame === c.key.frame);
      t.keys = t.keys.filter((k) => k.frame !== c.key.frame);
      t.keys.push({
        ...previous,
        ...c.key,
        id: previous?.id || c.key.id || id(),
        interpolation: c.key.interpolation || previous?.interpolation || 'linear',
      });
      t.keys.sort((a, b) => a.frame - b.frame);
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
        sourceIn: clip.sourceIn + left,
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
