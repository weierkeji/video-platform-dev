import { z } from 'zod';
import { GenerationOptionsSchema, GenerationRequestSchema } from './generation';
import { validateTrack } from './animation';
import { dependencyOrder } from './constraints';

export const PROJECT_VERSION = 15;

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
export const InfluenceSchema = z
  .object({
    joint: z.number().int().min(0).max(511),
    weight: z.number().finite().positive().max(1),
  })
  .strict();
export const VertexInfluencesSchema = z.array(InfluenceSchema).min(1).max(32);
export type VertexInfluences = z.infer<typeof VertexInfluencesSchema>;
const BindMatrixSchema = z
  .array(NumberValue)
  .length(16)
  .transform((m, ctx) => {
    // Old native inversions can leave a few ulps in the homogeneous row. Keep
    // those saved projects readable, but do not accept projective matrices.
    if (
      Math.max(Math.abs(m[3]), Math.abs(m[7]), Math.abs(m[11]), Math.abs(m[15] - 1)) >
      Number.EPSILON * 32
    ) {
      ctx.addIssue({ code: 'custom', message: '逆绑定矩阵必须为仿射矩阵' });
      return z.NEVER;
    }
    const affine = [...m];
    affine[3] = affine[7] = affine[11] = 0;
    affine[15] = 1;
    return affine;
  });
export const SkinSchema = z
  .object({
    joints: z.array(ID).min(1).max(512),
    inverseBindMatrices: z.array(BindMatrixSchema).min(1).max(512),
    skeletonId: ID.optional(),
  })
  .strict();
export type Skin = z.infer<typeof SkinSchema>;
export const GeometrySchema = z
  .object({
    id: ID,
    name: Name,
    positions: z.array(Vec3Schema).max(100000),
    influences: z.array(VertexInfluencesSchema).max(100000).optional(),
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
const ConstraintBase = {
  id: ID,
  name: Name,
  targetId: ID,
  enabled: z.boolean(),
  influence: z.number().finite().min(0).max(1),
};
export const ConstraintSchema = z.discriminatedUnion('type', [
  z
    .object({
      ...ConstraintBase,
      type: z.enum(['copy-transform', 'copy-position']),
      targetSpace: z.enum(['local', 'world']),
      ownerSpace: z.enum(['local', 'world']),
    })
    .strict(),
  z
    .object({
      ...ConstraintBase,
      type: z.literal('aim'),
      trackAxis: z.enum(['x', 'y', 'z', '-x', '-y', '-z']),
      upAxis: z.enum(['x', 'y', 'z']),
      worldUp: Vec3Schema,
    })
    .strict(),
]);
export type Constraint = z.infer<typeof ConstraintSchema>;
export const IKLimitSchema = z
  .object({
    jointId: ID,
    enabled: z.boolean(),
    kind: z.enum(['hinge', 'cone']),
    reference: Vec4Schema,
    axis: Vec3Schema,
    min: z.number().finite().min(-Math.PI).max(Math.PI),
    max: z.number().finite().min(-Math.PI).max(Math.PI),
    swing: z.number().finite().min(0).max(Math.PI),
  })
  .strict();
export type IKLimit = z.infer<typeof IKLimitSchema>;
export const IKChainSchema = z
  .object({
    id: ID,
    name: Name,
    sceneId: ID,
    joints: z.array(ID).min(3).max(33),
    targetId: ID,
    poleId: ID.nullable(),
    enabled: z.boolean(),
    influence: z.number().finite().min(0).max(1),
    iterations: z.number().int().min(1).max(64),
    tolerance: z.number().finite().min(1e-6).max(1),
    poleAngle: NumberValue,
    limits: z.array(IKLimitSchema).max(32).optional(),
  })
  .strict();
export type IKChain = z.infer<typeof IKChainSchema>;
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
    joint: z.boolean().optional(),
    skin: SkinSchema.optional(),
    constraints: z.array(ConstraintSchema).max(32).optional(),
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
export const ScalarKeySchema = KeySchema.extend({
  value: z.tuple([NumberValue]),
  handles: z.tuple([HandleSchema]).optional(),
  inTangent: z.tuple([NumberValue]).optional(),
  outTangent: z.tuple([NumberValue]).optional(),
});
export const IKTrackSchema = AnimationTrackSchema.extend({
  chainId: ID,
  property: z.enum(['influence', 'poleAngle']),
  keys: z.array(ScalarKeySchema).max(10000),
});
export type IKTrack = z.infer<typeof IKTrackSchema>;
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
// A missing/null choice inherits; an explicit null actionId selects the original project tracks.
export const ActionChoiceSchema = z.object({ actionId: ID.nullable() }).strict();
export type ActionChoice = z.infer<typeof ActionChoiceSchema>;
export const ShotPlaybackSchema = z
  .object({
    rate: z.number().finite().min(-16).max(16),
    rangeStart: z.number().finite().min(0).max(1000000),
    rangeEnd: z.number().finite().min(0).max(1000000),
    mode: z.enum(['hold', 'repeat', 'pingpong']),
  })
  .strict();
export type ShotPlayback = z.infer<typeof ShotPlaybackSchema>;
export const AnimationLayerSchema = z
  .object({
    id: ID,
    name: Name,
    entityId: ID,
    actionId: ID.nullable(),
    enabled: z.boolean(),
    blend: z.enum(['replace', 'additive']),
    weight: z.number().finite().min(0).max(1),
    channels: z
      .array(z.enum(['position', 'rotation', 'scale', 'ik']))
      .min(1)
      .max(4),
    start: z.number().finite().min(0).max(1e6),
    duration: z.number().finite().min(1e-6).max(1e6),
    sourceIn: z.number().finite().min(-1e9).max(1e9),
    playback: ShotPlaybackSchema,
    fadeIn: z.number().finite().min(0).max(1e6),
    fadeOut: z.number().finite().min(0).max(1e6),
  })
  .strict();
export type AnimationLayer = z.infer<typeof AnimationLayerSchema>;
export const ShotSchema = z
  .object({
    id: ID,
    name: Name,
    sceneId: ID,
    cameraId: ID,
    action: ActionChoiceSchema.nullable().optional(),
  })
  .strict();
export type Shot = z.infer<typeof ShotSchema>;
export const ClipSchema = z
  .object({
    id: ID,
    name: Name,
    kind: z.enum(['shot', 'image', 'video', 'audio']),
    sourceId: ID,
    start: z.number().int().nonnegative().max(1000000),
    duration: z.number().int().positive().max(1000000),
    sourceIn: z.number().finite().min(-1e9).max(1e9),
    action: ActionChoiceSchema.nullable().optional(),
    playback: ShotPlaybackSchema.nullable().optional(),
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
    ikTracks: z.array(IKTrackSchema).max(6000).optional(),
    animationActions: z.array(AnimationActionSchema).max(1000).optional(),
    animationLayers: z.array(AnimationLayerSchema).max(512).optional(),
    ikChains: z.array(IKChainSchema).max(128).optional(),
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
    ...p.entities.flatMap((e) => e.constraints || []),
    ...p.geometries,
    ...p.materials,
    ...p.animationTracks,
    ...(p.ikTracks || []),
    ...(p.animationActions || []),
    ...(p.animationLayers || []),
    ...(p.ikChains || []),
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
    for (const attr of [g.normals, g.tangents, g.uv, g.uv1, g.influences])
      if (attr && attr.length !== g.positions.length)
        throw new Error(`顶点属性长度不匹配：${g.name}`);
    for (const row of g.influences || []) {
      if (new Set(row.map((v) => v.joint)).size !== row.length)
        throw new Error(`同一顶点不能重复引用关节：${g.name}`);
      if (Math.abs(row.reduce((sum, v) => sum + v.weight, 0) - 1) > 1e-6)
        throw new Error(`顶点权重必须归一化：${g.name}`);
    }
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
  dependencyOrder(p.entities, p.ikChains, p.ikTracks);
  const paths = new Set<string>();
  for (const e of p.entities)
    if (e.skin) {
      const skin = e.skin,
        g = p.geometries.find((g) => g.id === e.geometryId);
      if (e.kind !== 'mesh' || !g?.influences) throw new Error('蒙皮绑定必须引用具有权重的网格');
      if (
        new Set(skin.joints).size !== skin.joints.length ||
        skin.inverseBindMatrices.length !== skin.joints.length
      )
        throw new Error('蒙皮关节重复或逆绑定矩阵数量不匹配');
      const chain = (jointId: string) => {
        const result = new Set<string>();
        let joint = entities.get(jointId);
        if (!joint || joint.sceneId !== e.sceneId) throw new Error('蒙皮关节必须属于同一场景');
        while (joint) {
          result.add(joint.id);
          joint = joint.parentId ? entities.get(joint.parentId) : undefined;
        }
        return result;
      };
      const chains = skin.joints.map(chain);
      if (![...chains[0]].some((a) => chains.every((c) => c.has(a))))
        throw new Error('蒙皮关节必须具有公共根节点');
      if (skin.skeletonId && !chains.every((c) => c.has(skin.skeletonId!)))
        throw new Error('骨架根必须是所有关节的祖先或关节本身');
      for (const m of skin.inverseBindMatrices)
        if (m[3] !== 0 || m[7] !== 0 || m[11] !== 0 || m[15] !== 1)
          throw new Error('逆绑定矩阵必须为仿射矩阵');
      if (g.influences.some((row) => row.some((v) => v.joint >= skin.joints.length)))
        throw new Error('顶点权重的关节索引超出绑定范围');
    }
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
  for (const track of p.ikTracks || []) {
    const chain = p.ikChains?.find((c) => c.id === track.chainId);
    if (!chain || track.entityId !== chain.joints[0])
      throw new Error('IK 轨道必须引用链及其根节点');
    if (track.actionId && actions.get(track.actionId)?.sceneId !== chain.sceneId)
      throw new Error('IK 轨道与动作必须属于同一场景');
    const path = `ik:${track.actionId || ''}:${chain.id}:${track.property}`;
    if (paths.has(path)) throw new Error('IK 属性不能有重复动画轨道');
    paths.add(path);
    validateTrack(track);
    if (track.property === 'influence' && track.keys.some((k) => k.value[0] < 0 || k.value[0] > 1))
      throw new Error('IK 影响关键帧必须在 0…1 之间');
  }
  const checkAction = (choice: ActionChoice | null | undefined, sceneId: string) => {
    if (choice?.actionId && actions.get(choice.actionId)?.sceneId !== sceneId)
      throw new Error('镜头或片段的动作必须属于同一场景');
  };
  const layerCounts = new Map<string, number>();
  for (const layer of p.animationLayers || []) {
    const entity = entities.get(layer.entityId);
    if (!entity) throw new Error('动作层的对象不存在');
    if (layer.actionId && actions.get(layer.actionId)?.sceneId !== entity.sceneId)
      throw new Error('动作层与对象必须属于同一场景');
    const count = (layerCounts.get(entity.id) || 0) + 1;
    layerCounts.set(entity.id, count);
    if (count > 64) throw new Error('每个对象最多 64 个动作层');
    if (new Set(layer.channels).size !== layer.channels.length)
      throw new Error('动作层通道不能重复');
    if (layer.start + layer.duration > 1e6 || layer.fadeIn + layer.fadeOut > layer.duration)
      throw new Error('动作层时间或淡入淡出超出范围');
    if (layer.playback.rangeEnd - layer.playback.rangeStart < 1e-6)
      throw new Error('动作层源范围必须递增且至少间隔 0.000001 帧');
    if (Math.abs(layer.sourceIn + layer.duration * layer.playback.rate) > 1e9)
      throw new Error('动作层源时间超出范围');
  }
  for (const s of p.shots) {
    if (
      !scenes.has(s.sceneId) ||
      entities.get(s.cameraId)?.kind !== 'camera' ||
      entities.get(s.cameraId)?.sceneId !== s.sceneId
    )
      throw new Error('镜头摄影机引用无效');
    checkAction(s.action, s.sceneId);
  }
  for (const c of p.timeline.clips) {
    if (c.start + c.duration > p.timeline.duration) throw new Error('片段超出时间轴范围');
    if (c.kind === 'shot') {
      const shot = p.shots.find((s) => s.id === c.sourceId);
      if (!shot) throw new Error('片段引用的镜头不存在');
      checkAction(c.action, shot.sceneId);
      if (c.playback && c.playback.rangeEnd - c.playback.rangeStart < 1e-6)
        throw new Error('动作播放范围必须递增且至少间隔 0.000001 帧');
      if (Math.abs(c.sourceIn + c.duration * (c.playback?.rate ?? 1)) > 1e9)
        throw new Error('片段的源时间超出范围');
    } else {
      if (c.action || c.playback) throw new Error('动作和动画变速只能用于镜头片段');
      if (!Number.isInteger(c.sourceIn) || c.sourceIn < 0 || c.sourceIn > 1000000)
        throw new Error('媒体源入点必须是范围内的非负整帧');
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
    ![1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, PROJECT_VERSION].includes(
      Number(input.schemaVersion),
    ) ||
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
