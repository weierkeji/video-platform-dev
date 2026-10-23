import { z } from 'zod';
import { GenerationOptionsSchema, GenerationRequestSchema } from './generation';
import { validateTrack } from './animation';

export const PROJECT_VERSION = 8;

export const id = () => crypto.randomUUID();
const ID = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[a-zA-Z0-9_-]+$/);
const Name = z.string().min(1).max(160);
const NumberValue = z.number().finite().min(-1e7).max(1e7);
export const Vec3Schema = z.tuple([NumberValue, NumberValue, NumberValue]);
export type Vec3 = z.infer<typeof Vec3Schema>;
export const Vec4Schema = z.tuple([NumberValue, NumberValue, NumberValue, NumberValue]);
export type Vec4 = z.infer<typeof Vec4Schema>;
export const AnimationValueSchema = z.union([Vec3Schema, Vec4Schema]);
export type AnimationValue = Vec3 | Vec4;
export const Vec2Schema = z.tuple([NumberValue, NumberValue]);
export const TextureBindingSchema = z
  .object({
    assetId: ID,
    texCoord: z.union([z.literal(0), z.literal(1)]),
    wrapS: z.enum(['repeat', 'clamp', 'mirror']),
    wrapT: z.enum(['repeat', 'clamp', 'mirror']),
    magFilter: z.enum(['nearest', 'linear']),
    minFilter: z.enum([
      'nearest',
      'linear',
      'nearest-mipmap-nearest',
      'linear-mipmap-nearest',
      'nearest-mipmap-linear',
      'linear-mipmap-linear',
    ]),
    offset: Vec2Schema,
    scale: Vec2Schema,
    rotation: NumberValue,
  })
  .strict();
export type TextureBinding = z.infer<typeof TextureBindingSchema>;
export const textureSlots = [
  'baseColor',
  'metallicRoughness',
  'normal',
  'occlusion',
  'emissive',
] as const;
export type TextureSlot = (typeof textureSlots)[number];
export function textureBinding(assetId: string): TextureBinding {
  return {
    assetId,
    texCoord: 0,
    wrapS: 'repeat',
    wrapT: 'repeat',
    magFilter: 'linear',
    minFilter: 'linear-mipmap-linear',
    offset: [0, 0],
    scale: [1, 1],
    rotation: 0,
  };
}
export const TransformSchema = z
  .object({
    position: Vec3Schema,
    rotation: Vec3Schema,
    scale: Vec3Schema,
    quaternion: Vec4Schema.optional(),
  })
  .strict();
export const identity = () => ({
  position: [0, 0, 0] as Vec3,
  rotation: [0, 0, 0] as Vec3,
  scale: [1, 1, 1] as Vec3,
});
export const GeometrySchema = z
  .object({
    id: ID,
    name: Name,
    positions: z.array(Vec3Schema).max(100000),
    normals: z.array(Vec3Schema).max(100000).optional(),
    tangents: z
      .array(
        z.tuple([NumberValue, NumberValue, NumberValue, z.union([z.literal(-1), z.literal(1)])]),
      )
      .max(100000)
      .optional(),
    uv1: z.array(Vec2Schema).max(100000).optional(),
    uv: z
      .array(z.tuple([NumberValue, NumberValue]))
      .max(100000)
      .optional(),
    triangles: z
      .array(
        z.tuple([
          z.number().int().nonnegative(),
          z.number().int().nonnegative(),
          z.number().int().nonnegative(),
        ]),
      )
      .max(200000),
  })
  .strict();
export type Geometry = z.infer<typeof GeometrySchema>;
export const MaterialSchema = z
  .object({
    id: ID,
    name: Name,
    color: z.string().regex(/^#[\da-fA-F]{6}$/),
    roughness: z.number().min(0).max(1),
    metalness: z.number().min(0).max(1),
    linearColor: z
      .tuple([z.number().min(0).max(1), z.number().min(0).max(1), z.number().min(0).max(1)])
      .optional(),
    emissive: z
      .tuple([z.number().min(0).max(1), z.number().min(0).max(1), z.number().min(0).max(1)])
      .optional(),
    opacity: z.number().min(0).max(1).optional(),
    alphaMode: z.enum(['OPAQUE', 'MASK', 'BLEND']).optional(),
    alphaCutoff: z.number().min(0).max(1).optional(),
    doubleSided: z.boolean().optional(),
    flatShading: z.boolean().optional(),
    textures: z
      .object({
        baseColor: TextureBindingSchema.optional(),
        metallicRoughness: TextureBindingSchema.optional(),
        normal: TextureBindingSchema.optional(),
        occlusion: TextureBindingSchema.optional(),
        emissive: TextureBindingSchema.optional(),
      })
      .strict()
      .optional(),
    normalScale: z.number().finite().min(-100).max(100).optional(),
    occlusionStrength: z.number().min(0).max(1).optional(),
  })
  .strict();
export const LightSchema = z
  .object({
    kind: z.enum(['point', 'directional']),
    color: z.string().regex(/^#[\da-fA-F]{6}$/),
    intensity: z.number().min(0).max(10000),
    linearColor: MaterialSchema.shape.linearColor,
    range: z.number().positive().max(1e7).optional(),
    direction: z.literal('local-negative-z').optional(),
  })
  .strict();
export const CameraSchema = z
  .object({
    fov: z.number().positive().lt(180),
    near: z.number().positive(),
    far: z.number().positive(),
    aspect: z.number().positive().optional(),
  })
  .strict();
export const EntitySchema = z
  .object({
    id: ID,
    name: Name,
    sceneId: ID,
    parentId: ID.nullable(),
    kind: z.enum(['mesh', 'camera', 'light', 'group']),
    transform: TransformSchema,
    visible: z.boolean(),
    geometryId: ID.optional(),
    materialId: ID.optional(),
    camera: CameraSchema.optional(),
    light: LightSchema.optional(),
  })
  .strict();
export type Entity = z.infer<typeof EntitySchema>;
export const SceneSchema = z
  .object({
    id: ID,
    name: Name,
    background: z.string().regex(/^#[\da-fA-F]{6}$/),
    ambient: z.number().min(0).max(5),
    activeActionId: ID.nullable().optional(),
    source: z
      .object({
        format: z.literal('gltf2'),
        copyright: z.string().max(10000).optional(),
        generator: z.string().max(10000).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export const HandleModeSchema = z.enum(['free', 'aligned', 'vector', 'auto-clamped']);
export const HandleSchema = z
  .object({
    mode: HandleModeSchema,
    left: z.tuple([NumberValue, NumberValue]),
    right: z.tuple([NumberValue, NumberValue]),
  })
  .strict();
export const KeySchema = z
  .object({
    id: ID,
    frame: z.number().finite().min(0).max(1000000),
    value: AnimationValueSchema,
    interpolation: z.enum(['constant', 'linear', 'smooth', 'bezier', 'cubic']),
    handles: z.tuple([HandleSchema, HandleSchema, HandleSchema]).optional(),
    inTangent: AnimationValueSchema.optional(),
    outTangent: AnimationValueSchema.optional(),
  })
  .strict();
export type Keyframe = z.infer<typeof KeySchema>;
export type KeyHandles = NonNullable<Keyframe['handles']>;
export const AnimationTrackSchema = z
  .object({
    id: ID,
    entityId: ID,
    property: z.enum(['position', 'rotation', 'scale', 'quaternion']),
    actionId: ID.optional(),
    keys: z.array(KeySchema).max(10000),
  })
  .strict();
export type AnimationTrack = z.infer<typeof AnimationTrackSchema>;
export const AnimationActionSchema = z.object({ id: ID, name: Name, sceneId: ID }).strict();
export type AnimationAction = z.infer<typeof AnimationActionSchema>;
export const AssetSchema = z
  .object({
    id: ID,
    name: Name,
    kind: z.enum(['image', 'video', 'audio']),
    mime: z.enum([
      'image/png',
      'image/jpeg',
      'image/webp',
      'video/mp4',
      'video/webm',
      'audio/wav',
      'audio/x-wav',
      'audio/mpeg',
      'audio/ogg',
    ]),
    blobId: z.string().regex(/^[a-f0-9]{64}$/),
    bytes: z.number().int().nonnegative(),
    duration: z.number().nonnegative().optional(),
    width: z.number().int().positive().optional(),
    height: z.number().int().positive().optional(),
    hasAudio: z.boolean().optional(),
    audioStart: z.number().finite().optional(),
  })
  .strict();
export type Asset = z.infer<typeof AssetSchema>;
export const ShotSchema = z.object({ id: ID, name: Name, sceneId: ID, cameraId: ID }).strict();
export const ClipSchema = z
  .object({
    id: ID,
    name: Name,
    kind: z.enum(['shot', 'image', 'video', 'audio']),
    sourceId: ID,
    start: z.number().int().nonnegative().max(1000000),
    duration: z.number().int().positive().max(1000000),
    sourceIn: z.number().int().nonnegative().max(1000000),
    channel: z.number().int().min(0).max(31),
    muted: z.boolean(),
    volume: z.number().min(0).max(2),
    fit: z.enum(['contain', 'cover', 'stretch']).default('contain'),
  })
  .strict();
export type Clip = z.infer<typeof ClipSchema>;
export const TimelineSchema = z
  .object({
    id: ID,
    fps: z.number().int().min(1).max(120),
    duration: z.number().int().min(1).max(1000000),
    width: z.number().int().min(64).max(3840).multipleOf(2),
    height: z.number().int().min(64).max(2160).multipleOf(2),
    clips: z.array(ClipSchema).max(10000),
  })
  .strict();
export const WorkflowNodeSchema = z
  .object({
    id: ID,
    name: Name,
    kind: z.enum(['timeline', 'render', 'prompt', 'seedance']),
    text: z.string().max(10000).optional(),
    generation: GenerationOptionsSchema.optional(),
    x: z.number(),
    y: z.number(),
  })
  .strict();
export const WorkflowSchema = z
  .object({
    id: ID,
    name: Name,
    nodes: z.array(WorkflowNodeSchema).max(100),
    edges: z.array(z.object({ from: ID, to: ID }).strict()).max(200),
  })
  .strict();
export type Workflow = z.infer<typeof WorkflowSchema>;
export const ArtifactSchema = z
  .object({
    id: ID,
    jobId: ID,
    name: Name,
    mime: z.string(),
    bytes: z.number().int().nonnegative(),
    sha256: z.string(),
    createdAt: z.string(),
  })
  .strict();
export type Artifact = z.infer<typeof ArtifactSchema>;
export const GenerationJobSchema = z
  .object({
    id: ID,
    projectId: ID,
    projectRevision: z.number().int(),
    kind: z.enum(['render', 'workflow']),
    status: z.enum(['queued', 'running', 'succeeded', 'failed', 'cancelled', 'interrupted']),
    progress: z.number().min(0).max(1),
    message: z.string(),
    createdAt: z.string(),
    updatedAt: z.string(),
    requestKey: ID,
    artifact: ArtifactSchema.optional(),
    workflowId: ID.optional(),
    outputNodeId: ID.optional(),
    provider: z
      .object({
        id: z.literal('seedance'),
        request: GenerationRequestSchema,
        taskId: z.string().max(200).optional(),
        phase: z.enum(['ready', 'submitting', 'polling', 'downloading', 'done', 'uncertain']),
        remoteStatus: z
          .enum(['queued', 'running', 'succeeded', 'failed', 'cancelled', 'expired'])
          .optional(),
        cancelRequested: z.boolean().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type GenerationJob = z.infer<typeof GenerationJobSchema>;
export type Revision = {
  id: string;
  projectId: string;
  number: number;
  actor: 'user' | 'agent' | 'system';
  label: string;
  command: unknown;
  createdAt: string;
};
export const ProjectSchema = z
  .object({
    format: z.literal('frameforge-project'),
    schemaVersion: z.literal(PROJECT_VERSION),
    id: ID,
    name: Name,
    revision: z.number().int().nonnegative(),
    createdAt: z.string(),
    updatedAt: z.string(),
    conventions: z
      .object({
        units: z.literal('metres'),
        coordinates: z.literal('right-handed-y-up'),
        rotation: z.literal('euler-xyz-radians'),
        color: z.literal('srgb-input-linear-working-aces-output'),
        time: z.literal('integer-frames-zero-based-half-open'),
      })
      .strict(),
    scenes: z.array(SceneSchema).min(1).max(100),
    entities: z.array(EntitySchema).max(2000),
    geometries: z.array(GeometrySchema).max(2000),
    materials: z.array(MaterialSchema).max(2000),
    animationTracks: z.array(AnimationTrackSchema).max(6000),
    animationActions: z.array(AnimationActionSchema).max(1000).optional(),
    assets: z.array(AssetSchema).max(10000),
    shots: z.array(ShotSchema).max(10000),
    timeline: TimelineSchema,
    workflows: z.array(WorkflowSchema).max(100),
    artifacts: z.array(ArtifactSchema).max(10000),
  })
  .strict();
export type Project = z.infer<typeof ProjectSchema>;

export function workflowOrder(workflow: Workflow) {
  const nodes = new Map(workflow.nodes.map((n) => [n.id, n]));
  if (nodes.size !== workflow.nodes.length) throw new Error('工作流节点 ID 重复');
  const visited = new Set<string>(),
    active = new Set<string>(),
    order: Workflow['nodes'] = [];
  const edges = new Set<string>();
  for (const e of workflow.edges) {
    if (!nodes.has(e.from) || !nodes.has(e.to)) throw new Error('工作流连接引用不存在的节点');
    const signature = `${e.from}:${e.to}`;
    if (edges.has(signature)) throw new Error('工作流连接重复');
    edges.add(signature);
    const from = nodes.get(e.from)!,
      to = nodes.get(e.to)!;
    if (
      !(
        (from.kind === 'timeline' && to.kind === 'render') ||
        (from.kind === 'prompt' && to.kind === 'seedance')
      )
    )
      throw new Error('工作流端口类型不兼容');
  }
  function visit(node: Workflow['nodes'][number]) {
    if (active.has(node.id)) throw new Error('工作流不能循环依赖');
    if (visited.has(node.id)) return;
    active.add(node.id);
    for (const e of workflow.edges.filter((e) => e.to === node.id)) visit(nodes.get(e.from)!);
    active.delete(node.id);
    visited.add(node.id);
    order.push(node);
  }
  workflow.nodes.forEach(visit);
  return order;
}

export function parseProject(input: unknown): Project {
  const p = ProjectSchema.parse(input);
  const ids = new Set<string>();
  for (const item of [
    ...p.scenes,
    ...p.entities,
    ...p.geometries,
    ...p.materials,
    ...p.animationTracks,
    ...(p.animationActions || []),
    ...p.assets,
    ...p.shots,
    p.timeline,
    ...p.timeline.clips,
    ...p.workflows,
    ...p.artifacts,
    ...p.workflows.flatMap((w) => w.nodes),
  ]) {
    if (ids.has(item.id)) throw new Error(`重复对象 ID：${item.id}`);
    ids.add(item.id);
  }
  const entities = new Map(p.entities.map((e) => [e.id, e]));
  const scenes = new Set(p.scenes.map((s) => s.id));
  const geometries = new Set(p.geometries.map((g) => g.id));
  const materials = new Set(p.materials.map((m) => m.id));
  for (const asset of p.assets)
    if (!asset.mime.startsWith(asset.kind + '/')) throw new Error('素材 MIME 与类型不匹配');
  for (const g of p.geometries) {
    for (const attr of [g.normals, g.tangents, g.uv, g.uv1])
      if (attr && attr.length !== g.positions.length)
        throw new Error(`顶点属性长度不匹配：${g.name}`);
    if (g.normals?.some((n) => Math.abs(Math.hypot(...n) - 1) > 0.001))
      throw new Error(`顶点法线必须归一化：${g.name}`);
    if (
      g.tangents &&
      (!g.normals || g.tangents.some((t) => Math.abs(Math.hypot(t[0], t[1], t[2]) - 1) > 0.001))
    )
      throw new Error(`切线须归一化且具有法线：${g.name}`);
    for (const t of g.triangles) {
      if (new Set(t).size !== 3 || t.some((i) => i >= g.positions.length))
        throw new Error(`无效三角面：${g.name}`);
    }
  }
  for (const m of p.materials)
    for (const binding of Object.values(m.textures || {})) {
      const a = p.assets.find((a) => a.id === binding.assetId);
      if (!a || a.kind !== 'image') throw new Error(`材质贴图必须引用图片素材：${m.name}`);
      if (
        a.width &&
        a.height &&
        (Math.max(a.width, a.height) > 8192 || a.width * a.height > 16777216)
      )
        throw new Error(`贴图超过 8192 边长或 1600 万像素限制：${a.name}`);
    }
  for (const e of p.entities) {
    if (!scenes.has(e.sceneId)) throw new Error('对象所属场景不存在');
    if (e.kind === 'mesh' && (!geometries.has(e.geometryId!) || !materials.has(e.materialId!)))
      throw new Error('网格缺少几何体或材质');
    if (e.kind === 'mesh') {
      const g = p.geometries.find((g) => g.id === e.geometryId)!,
        m = p.materials.find((m) => m.id === e.materialId)!;
      for (const b of Object.values(m.textures || {}))
        if (!(b.texCoord === 0 ? g.uv : g.uv1))
          throw new Error(`网格“${e.name}”缺少贴图需要的 UV${b.texCoord}`);
    }
    if (e.kind === 'camera' && (!e.camera || e.camera.far <= e.camera.near))
      throw new Error('摄影机裁剪范围无效');
    if (e.kind === 'light' && !e.light) throw new Error('灯光参数缺失');
    if (e.transform.scale.some((v) => Math.abs(v) < 0.00001)) throw new Error('缩放不能为零');
    if (e.transform.quaternion && Math.abs(Math.hypot(...e.transform.quaternion) - 1) > 0.001)
      throw new Error('对象四元数必须归一化');
    const ancestors = new Set([e.id]);
    let parentId = e.parentId;
    while (parentId) {
      if (ancestors.has(parentId)) throw new Error('对象层级存在循环');
      ancestors.add(parentId);
      const parent = entities.get(parentId);
      if (!parent || parent.sceneId !== e.sceneId) throw new Error('父对象必须在同一场景');
      parentId = parent.parentId;
    }
  }
  const paths = new Set<string>();
  const actions = new Map((p.animationActions || []).map((a) => [a.id, a]));
  for (const a of actions.values())
    if (!scenes.has(a.sceneId)) throw new Error('动画动作所属场景不存在');
  for (const s of p.scenes)
    if (s.activeActionId && actions.get(s.activeActionId)?.sceneId !== s.id)
      throw new Error('场景的动画动作引用无效');
  for (const track of p.animationTracks) {
    if (!entities.has(track.entityId)) throw new Error('动画目标不存在');
    if (
      track.actionId &&
      actions.get(track.actionId)?.sceneId !== entities.get(track.entityId)!.sceneId
    )
      throw new Error('动画轨道与动作必须属于同一场景');
    const path = `${track.actionId || ''}:${track.entityId}:${track.property === 'quaternion' ? 'rotation' : track.property}`;
    if (paths.has(path)) throw new Error('同一属性不能有重复动画轨道');
    paths.add(path);
    validateTrack(track);
    if (
      track.property === 'scale' &&
      track.keys.some((k) => k.value.some((v) => Math.abs(v) < 0.00001))
    )
      throw new Error('关键帧缩放不能为零');
  }
  for (const s of p.shots)
    if (
      !scenes.has(s.sceneId) ||
      entities.get(s.cameraId)?.kind !== 'camera' ||
      entities.get(s.cameraId)?.sceneId !== s.sceneId
    )
      throw new Error('镜头摄影机引用无效');
  for (const c of p.timeline.clips) {
    if (c.start + c.duration > p.timeline.duration) throw new Error('片段超出时间轴范围');
    if (c.kind === 'shot') {
      if (!p.shots.some((s) => s.id === c.sourceId)) throw new Error('片段引用的镜头不存在');
    } else {
      const asset = p.assets.find((a) => a.id === c.sourceId);
      if (!asset || asset.kind !== c.kind) throw new Error('片段素材类型不匹配');
      if (
        asset.duration !== undefined &&
        (c.sourceIn + c.duration) / p.timeline.fps > asset.duration + 1 / p.timeline.fps
      )
        throw new Error('片段超出素材时长');
    }
  }
  for (let channel = 0; channel < 32; channel++) {
    const clips = p.timeline.clips
      .filter((c) => c.channel === channel)
      .sort((a, b) => a.start - b.start);
    for (let i = 1; i < clips.length; i++)
      if (clips[i].start < clips[i - 1].start + clips[i - 1].duration)
        throw new Error('同一轨道的片段不能重叠');
  }
  p.workflows.forEach((w) => {
    workflowOrder(w);
    for (const n of w.nodes) {
      if (n.generation && n.kind !== 'seedance') throw new Error('生成参数只能属于 Seedance 节点');
      for (const ref of [n.generation?.firstFrameId, n.generation?.lastFrameId])
        if (ref && !p.assets.some((a) => a.id === ref && a.kind === 'image'))
          throw new Error('生成参考图片不存在');
    }
  });
  return p;
}

export function migrateProject(input: unknown) {
  if (
    typeof input !== 'object' ||
    !input ||
    !('schemaVersion' in input) ||
    ![1, 2, 3, 4, 5, 6, 7, PROJECT_VERSION].includes(Number(input.schemaVersion)) ||
    typeof input.schemaVersion !== 'number'
  )
    throw new Error('不支持此项目版本；原文件未修改');
  if (input.schemaVersion === PROJECT_VERSION) return parseProject(input);
  // v1 always stretched images and kept video sound at its saved volume.
  // Preserve those decisions rather than changing existing edits on upgrade.
  const next = structuredClone(input) as Record<string, unknown>;
  const timeline = next.timeline as { clips?: Record<string, unknown>[] } | undefined;
  if (!timeline || !Array.isArray(timeline.clips)) throw new Error('旧项目时间轴无效');
  if (input.schemaVersion === 1)
    timeline.clips = timeline.clips.map((clip) => ({ ...clip, fit: 'stretch' }));
  if (!Array.isArray(next.animationTracks)) throw new Error('旧项目动画数据无效');
  // Legacy keys were identified by track + frame. Keep that identity consistent across historical snapshots.
  if (input.schemaVersion < 4)
    for (const track of next.animationTracks as { keys: Record<string, unknown>[] }[])
      track.keys = track.keys.map((key) => ({ ...key, id: `legacy-key-${key.frame}` }));
  next.schemaVersion = PROJECT_VERSION;
  return parseProject(next);
}
