import { z } from 'zod';
import { Euler, Matrix4, Quaternion, Vector3 } from 'three';
import {
  id,
  identity,
  textureBinding,
  textureSlots,
  type Asset,
  type Entity,
  type Geometry,
  type Project,
  type Vec3,
  type TextureBinding,
} from './model';
import { checkedImage, imageInfo, sha256 } from './image';
import { CommandSchema, type Command } from './commands';
import { evaluatedTransform } from './evaluate';
import { displayColor, linearColor, surfaceGeometry } from './surface';

// Independent bounded format mapping. No external URI requests and no runtime product dependency.
const integer = z.number().int().nonnegative().max(100000000);
const vec = (n: number) => z.array(z.number().finite()).length(n);
const base = z
  .object({
    name: z.string().optional(),
    extensions: z.record(z.string(), z.unknown()).optional(),
    extras: z.unknown().optional(),
  })
  .passthrough();
const accessor = base.extend({
  bufferView: integer.optional(),
  byteOffset: integer.default(0),
  componentType: integer,
  normalized: z.boolean().default(false),
  count: integer.max(600000),
  type: z.string(),
  sparse: z
    .object({
      count: integer,
      indices: z.object({
        bufferView: integer,
        byteOffset: integer.default(0),
        componentType: integer,
      }),
      values: z.object({ bufferView: integer, byteOffset: integer.default(0) }),
    })
    .optional(),
});
const documentSchema = base.extend({
  asset: base.extend({
    version: z.literal('2.0'),
    minVersion: z.literal('2.0').optional(),
    copyright: z.string().max(10000).optional(),
    generator: z.string().max(10000).optional(),
  }),
  scene: integer.optional(),
  scenes: z
    .array(base.extend({ nodes: z.array(integer).max(2000).default([]) }))
    .min(1)
    .max(100),
  nodes: z
    .array(
      base.extend({
        children: z.array(integer).max(2000).default([]),
        mesh: integer.optional(),
        camera: integer.optional(),
        matrix: vec(16).optional(),
        translation: vec(3).optional(),
        rotation: vec(4).optional(),
        scale: vec(3).optional(),
        skin: integer.optional(),
        weights: z.array(z.number()).optional(),
      }),
    )
    .max(2000)
    .default([]),
  meshes: z
    .array(
      base.extend({
        primitives: z
          .array(
            base.extend({
              attributes: z.record(z.string(), integer),
              indices: integer.optional(),
              material: integer.optional(),
              mode: integer.default(4),
              targets: z.array(z.unknown()).optional(),
            }),
          )
          .min(1)
          .max(2000),
        weights: z.array(z.number()).optional(),
      }),
    )
    .max(2000)
    .default([]),
  materials: z
    .array(
      base.extend({
        pbrMetallicRoughness: base
          .extend({
            baseColorFactor: vec(4).default([1, 1, 1, 1]),
            metallicFactor: z.number().min(0).max(1).default(1),
            roughnessFactor: z.number().min(0).max(1).default(1),
            baseColorTexture: z.unknown().optional(),
            metallicRoughnessTexture: z.unknown().optional(),
          })
          .optional(),
        normalTexture: z.unknown().optional(),
        occlusionTexture: z.unknown().optional(),
        emissiveTexture: z.unknown().optional(),
        emissiveFactor: vec(3).default([0, 0, 0]),
        alphaMode: z.enum(['OPAQUE', 'MASK', 'BLEND']).default('OPAQUE'),
        alphaCutoff: z.number().min(0).max(1).default(0.5),
        doubleSided: z.boolean().default(false),
      }),
    )
    .max(2000)
    .default([]),
  cameras: z
    .array(
      base.extend({
        type: z.string(),
        perspective: z
          .object({
            yfov: z.number().positive().lt(Math.PI),
            znear: z.number().positive(),
            zfar: z.number().positive().optional(),
            aspectRatio: z.number().positive().optional(),
          })
          .optional(),
      }),
    )
    .max(2000)
    .default([]),
  accessors: z.array(accessor).max(12000).default([]),
  bufferViews: z
    .array(
      base.extend({
        buffer: integer,
        byteOffset: integer.default(0),
        byteLength: integer,
        byteStride: z.number().int().min(4).max(252).multipleOf(4).optional(),
      }),
    )
    .max(12000)
    .default([]),
  buffers: z
    .array(base.extend({ uri: z.string().optional(), byteLength: integer.max(50 * 1024 * 1024) }))
    .max(2000)
    .default([]),
  images: z
    .array(
      base.extend({
        uri: z.string().optional(),
        bufferView: integer.optional(),
        mimeType: z.string().optional(),
      }),
    )
    .max(1000)
    .default([]),
  textures: z
    .array(base.extend({ source: integer.optional(), sampler: integer.optional() }))
    .max(2000)
    .default([]),
  samplers: z
    .array(
      base.extend({
        wrapS: integer.default(10497),
        wrapT: integer.default(10497),
        magFilter: integer.default(9729),
        minFilter: integer.default(9987),
      }),
    )
    .max(2000)
    .default([]),
  animations: z.array(z.unknown()).default([]),
  skins: z.array(z.unknown()).default([]),
  extensionsRequired: z.array(z.string()).default([]),
  extensionsUsed: z.array(z.string()).default([]),
});
type Document = z.infer<typeof documentSchema>;
export type SceneImport = Extract<Command, { type: 'scene.import' }>;
export type GLTFImport = {
  command: SceneImport;
  defaultSceneId: string;
  notes: string[];
  copyright?: string;
  images: { asset: Asset; bytes: Uint8Array }[];
};
export type ExchangeFile = { name: string; bytes: Uint8Array };
const LIMIT = 50 * 1024 * 1024;
const wrapValues = { repeat: 10497, clamp: 33071, mirror: 33648 } as const;
const filterValues = {
  nearest: 9728,
  linear: 9729,
  'nearest-mipmap-nearest': 9984,
  'linear-mipmap-nearest': 9985,
  'nearest-mipmap-linear': 9986,
  'linear-mipmap-linear': 9987,
} as const;
const supportedExtensions = new Set([
  'KHR_lights_punctual',
  'KHR_texture_transform',
  'EXT_texture_webp',
]);
function enumName<T extends Record<string, number>>(values: T, value: number): keyof T {
  const found = Object.entries(values).find(([, v]) => v === value);
  if (!found) throw new Error(`glTF 采样器枚举无效：${value}`);
  return found[0] as keyof T;
}
function externalFile(uri: string, files: ExchangeFile[]) {
  let path: string;
  try {
    path = decodeURIComponent(uri);
  } catch {
    throw new Error('glTF 资源 URI 编码错误');
  }
  if (
    /[\\:#?\x00]/.test(path) ||
    path.startsWith('/') ||
    path.split('/').some((p) => !p || p === '..' || p === '.')
  )
    throw new Error('glTF 只读取此次选择的相对路径文件，不访问网络或上级目录');
  const found = files.filter((f) => f.name === path);
  if (found.length !== 1) throw new Error(`请同时选择唯一的外部资源文件：${path}`);
  return found[0].bytes;
}
function at<T>(items: T[], i: number, label: string): T {
  if (!Number.isInteger(i) || !items[i]) throw new Error(`${label} 索引不存在：${i}`);
  return items[i];
}
function name(value: string | undefined, fallback: string) {
  return (value?.trim() || fallback).slice(0, 160);
}
function unsupported(message: string): never {
  throw new Error(`glTF 暂不支持${message}；尚未修改项目`);
}

export function unpackGLTF(bytes: Uint8Array): {
  json: unknown;
  bin?: Uint8Array;
  notes: string[];
} {
  if (bytes.byteLength > LIMIT) throw new Error('glTF 文件超过 50 MB');
  const notes: string[] = [];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let json = bytes,
    bin: Uint8Array | undefined;
  if (bytes.length >= 4 && view.getUint32(0, true) === 0x46546c67) {
    if (
      bytes.length < 20 ||
      view.getUint32(4, true) !== 2 ||
      view.getUint32(8, true) !== bytes.length
    )
      throw new Error('GLB 头部或长度无效');
    let offset = 12,
      index = 0;
    while (offset < bytes.length) {
      if (offset + 8 > bytes.length) throw new Error('GLB 块头部不完整');
      const length = view.getUint32(offset, true),
        type = view.getUint32(offset + 4, true);
      if (length % 4 || offset + 8 + length > bytes.length) throw new Error('GLB 块长度或对齐无效');
      const data = bytes.subarray(offset + 8, offset + 8 + length);
      if (index === 0) {
        if (type !== 0x4e4f534a) throw new Error('GLB 首块必须为 JSON');
        json = data;
      } else if (type === 0x004e4942) {
        if (bin || index !== 1) throw new Error('GLB BIN 块顺序或数量无效');
        bin = data;
      } else if (type === 0x4e4f534a) throw new Error('GLB JSON 块重复');
      else notes.push('GLB 未知附加块未保留。');
      index++;
      offset += 8 + length;
    }
  }
  if (json.length > 20 * 1024 * 1024) throw new Error('glTF JSON 超过 20 MB');
  return { json: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(json)), bin, notes };
}
function bufferData(doc: Document, bin: Uint8Array | undefined, files: ExchangeFile[]) {
  let total = 0;
  return doc.buffers.map((b, i) => {
    let data: Uint8Array;
    if (b.uri === undefined) {
      if (i !== 0 || !bin) throw new Error('glTF 缺少缓冲区 URI 或 GLB BIN');
      data = bin;
      if (data.length - b.byteLength > 3) throw new Error('GLB BIN 填充长度无效');
    } else if (b.uri.startsWith('data:')) {
      const match =
        /^data:application\/(?:octet-stream|gltf-buffer);base64,([A-Za-z0-9+/]*={0,2})$/.exec(
          b.uri,
        );
      if (!match || match[1].length % 4) throw new Error('glTF 内嵌缓冲区必须是有效 Base64');
      data = Uint8Array.from(atob(match[1]), (c) => c.charCodeAt(0));
    } else {
      let path: string;
      try {
        path = decodeURIComponent(b.uri);
      } catch {
        throw new Error('glTF 缓冲区 URI 编码错误');
      }
      if (
        /[\\:#?\x00]/.test(path) ||
        path.startsWith('/') ||
        path.split('/').some((p) => !p || p === '..' || p === '.')
      )
        throw new Error('glTF 只读取此次选择的相对路径文件，不访问网络或上级目录');
      const found = files.filter((f) => f.name === path);
      if (found.length !== 1) throw new Error(`请同时选择唯一的外部缓冲区文件：${path}`);
      data = found[0].bytes;
    }
    if (data.length < b.byteLength) throw new Error('glTF 缓冲区长度不足');
    total += b.byteLength;
    if (total > LIMIT) throw new Error('glTF 解码缓冲区合计超过 50 MB');
    return data.subarray(0, b.byteLength);
  });
}
function accessors(doc: Document, buffers: Uint8Array[]) {
  const cache = new Map<number, number[][]>();
  let values = 0;
  const read = (
    viewIndex: number,
    offset: number,
    count: number,
    width: number,
    component: number,
    normalized: boolean,
    packed = false,
  ) => {
    const view = at(doc.bufferViews, viewIndex, 'bufferView'),
      buffer = at(buffers, view.buffer, 'buffer');
    const size =
      component === 5126 || component === 5125
        ? 4
        : component === 5123 || component === 5122
          ? 2
          : component === 5121 || component === 5120
            ? 1
            : 0;
    if (!size) throw new Error('glTF accessor 分量类型无效');
    if (packed && view.byteStride !== undefined)
      throw new Error('glTF 稀疏数据不能使用 byteStride');
    const stride = view.byteStride || width * size;
    const start = view.byteOffset + offset,
      length = count ? (count - 1) * stride + width * size : 0;
    if (
      stride < width * size ||
      stride % size ||
      start % size ||
      view.byteOffset + view.byteLength > buffer.length ||
      offset + length > view.byteLength
    )
      throw new Error('glTF accessor 超出缓冲区范围或未正确对齐');
    const data = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    return Array.from({ length: count }, (_, row) =>
      Array.from({ length: width }, (_, axis) => {
        const pos = start + row * stride + axis * size;
        let n =
          component === 5126
            ? data.getFloat32(pos, true)
            : component === 5125
              ? data.getUint32(pos, true)
              : component === 5123
                ? data.getUint16(pos, true)
                : component === 5122
                  ? data.getInt16(pos, true)
                  : component === 5121
                    ? data.getUint8(pos)
                    : data.getInt8(pos);
        if (normalized) {
          if (component === 5120) n = Math.max(n / 127, -1);
          else if (component === 5122) n = Math.max(n / 32767, -1);
          else if (component === 5121) n /= 255;
          else if (component === 5123) n /= 65535;
          else throw new Error('glTF normalized 分量类型无效');
        }
        if (!Number.isFinite(n)) throw new Error('glTF 包含非有限数值');
        return n;
      }),
    );
  };
  return (
    index: number,
    semantic: 'POSITION' | 'NORMAL' | 'TEXCOORD_0' | 'TEXCOORD_1' | 'TANGENT' | 'indices',
  ) => {
    const a = at(doc.accessors, index, 'accessor'),
      width =
        semantic === 'indices'
          ? 1
          : semantic.startsWith('TEXCOORD_')
            ? 2
            : semantic === 'TANGENT'
              ? 4
              : 3;
    if (a.type !== (width === 1 ? 'SCALAR' : `VEC${width}`) || a.count < 1)
      throw new Error(`glTF ${semantic} accessor 形状无效`);
    if (
      semantic === 'indices'
        ? ![5121, 5123, 5125].includes(a.componentType) || a.normalized
        : semantic.startsWith('TEXCOORD_')
          ? !(
              (a.componentType === 5126 && !a.normalized) ||
              ([5121, 5123].includes(a.componentType) && a.normalized)
            )
          : a.componentType !== 5126 || a.normalized
    )
      unsupported(`${semantic} 的分量编码（量化扩展尚未接入）`);
    if (cache.has(index)) return cache.get(index)!;
    values += a.count * width;
    if (values > 3000000) throw new Error('glTF 解码顶点属性超过当前 300 万数值限制');
    const rows =
      a.bufferView === undefined
        ? Array.from({ length: a.count }, () => Array(width).fill(0) as number[])
        : read(a.bufferView, a.byteOffset, a.count, width, a.componentType, a.normalized);
    if (a.bufferView === undefined && a.byteOffset)
      throw new Error('glTF 无 bufferView 的 accessor 偏移无效');
    if (a.sparse) {
      const s = a.sparse;
      if (s.count < 1 || s.count > a.count || ![5121, 5123, 5125].includes(s.indices.componentType))
        throw new Error('glTF sparse 数量或索引类型无效');
      const indices = read(
        s.indices.bufferView,
        s.indices.byteOffset,
        s.count,
        1,
        s.indices.componentType,
        false,
        true,
      );
      const data = read(
        s.values.bufferView,
        s.values.byteOffset,
        s.count,
        width,
        a.componentType,
        a.normalized,
        true,
      );
      indices.forEach(([i], n) => {
        if (i >= a.count || (n > 0 && i <= indices[n - 1][0]))
          throw new Error('glTF sparse 索引必须递增且不越界');
        rows[i] = data[n];
      });
    }
    cache.set(index, rows);
    return rows;
  };
}
function nodeTransform(node: Document['nodes'][number]): Entity['transform'] {
  const p = new Vector3(),
    q = new Quaternion(),
    s = new Vector3(1, 1, 1);
  if (node.matrix) {
    if (node.translation || node.rotation || node.scale)
      throw new Error('glTF 节点不能同时提供 matrix 和 TRS');
    const m = new Matrix4().fromArray(node.matrix);
    m.decompose(p, q, s);
    const back = new Matrix4().compose(p, q, s);
    if (
      m.elements.some(
        (v, i) =>
          !Number.isFinite(back.elements[i]) ||
          Math.abs(v - back.elements[i]) > 1e-6 * Math.max(1, Math.abs(v)),
      )
    )
      unsupported('含剪切或奇异矩阵的节点');
  } else {
    p.fromArray(node.translation || [0, 0, 0]);
    s.fromArray(node.scale || [1, 1, 1]);
    q.fromArray(node.rotation || [0, 0, 0, 1]);
    if (Math.abs(q.length() - 1) > 0.001) throw new Error('glTF 旋转四元数必须归一化');
    q.normalize();
  }
  const e = new Euler().setFromQuaternion(q, 'XYZ');
  return { position: p.toArray(), rotation: [e.x, e.y, e.z], scale: s.toArray() };
}

export async function importGLTF(
  bytes: Uint8Array,
  files: ExchangeFile[] = [],
): Promise<GLTFImport> {
  const unpacked = unpackGLTF(bytes),
    doc = documentSchema.parse(unpacked.json),
    notes = new Set(unpacked.notes);
  if (doc.animations.length) unsupported('动画导入；四元数与秒时间轨道仍待接入');
  if (doc.skins.length || doc.nodes.some((n) => n.skin !== undefined)) unsupported('骨骼蒙皮');
  if (
    doc.nodes.some((n) => n.weights !== undefined) ||
    doc.meshes.some((m) => m.weights !== undefined || m.primitives.some((p) => p.targets?.length))
  )
    unsupported('形态键');
  for (const ext of [...doc.extensionsRequired, ...doc.extensionsUsed])
    if (!supportedExtensions.has(ext)) unsupported(`扩展 ${ext}`);
  // Unknown extensions are rejected even if not declared by a malformed producer.
  function extensions(value: unknown, depth = 0) {
    if (depth > 100) throw new Error('glTF JSON 嵌套过深');
    if (!value || typeof value !== 'object') return;
    for (const [key, item] of Object.entries(value)) {
      if (key === 'extensions' && item && typeof item === 'object')
        for (const ext of Object.keys(item))
          if (!supportedExtensions.has(ext)) unsupported(`扩展 ${ext}`);
      if (key === 'extras') {
        notes.add('自定义 extras 元数据未映射到项目。');
        continue;
      }
      extensions(item, depth + 1);
    }
  }
  extensions(unpacked.json);
  const buffers = bufferData(doc, unpacked.bin, files),
    read = accessors(doc, buffers);
  const imageEntries = new Map<number, { asset: Asset; bytes: Uint8Array }>();
  let imageBytes = 0;
  const image = (index: number) => {
    if (imageEntries.has(index)) return imageEntries.get(index)!.asset.id;
    const source = at(doc.images, index, 'image');
    if ((source.uri === undefined) === (source.bufferView === undefined))
      throw new Error('glTF 图片必须且只能指定 URI 或 bufferView');
    let data: Uint8Array,
      declaredMime = source.mimeType;
    if (source.bufferView !== undefined) {
      const view = at(doc.bufferViews, source.bufferView, 'image.bufferView'),
        buffer = at(buffers, view.buffer, 'image.buffer');
      if (view.byteStride || view.byteOffset + view.byteLength > buffer.length || !source.mimeType)
        throw new Error('glTF 图片缓冲区范围或 MIME 无效');
      data = buffer.subarray(view.byteOffset, view.byteOffset + view.byteLength);
    } else if (source.uri!.startsWith('data:')) {
      const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]*={0,2})$/.exec(
        source.uri!,
      );
      if (!match || match[2].length % 4) throw new Error('glTF 图片 Data URI 无效');
      data = Uint8Array.from(atob(match[2]), (c) => c.charCodeAt(0));
      if (source.mimeType && source.mimeType !== match[1]) throw new Error('glTF 图片 MIME 不匹配');
      declaredMime = match[1];
    } else data = externalFile(source.uri!, files);
    imageBytes += data.length;
    if (imageBytes > LIMIT) throw new Error('glTF 纹理图片合计超过 50 MB');
    const info = imageInfo(data);
    if (declaredMime && declaredMime !== info.mime)
      throw new Error('glTF 图片实际编码与 MIME 不匹配');
    const asset: Asset = {
      id: id(),
      name: name(source.name, `glTF 图片 ${index + 1}`),
      kind: 'image',
      mime: info.mime,
      bytes: data.length,
      blobId: '0'.repeat(64),
      width: info.width,
      height: info.height,
    };
    imageEntries.set(index, { asset, bytes: data });
    return asset.id;
  };
  const binding = (input: unknown): TextureBinding | undefined => {
    if (input === undefined) return;
    const info = base.extend({ index: integer, texCoord: integer.default(0) }).parse(input);
    const texture = at(doc.textures, info.index, 'texture');
    const source = texture.extensions?.EXT_texture_webp
      ? z.object({ source: integer }).parse(texture.extensions.EXT_texture_webp).source
      : texture.source;
    if (source === undefined) throw new Error('glTF 纹理缺少图片来源');
    const assetId = image(source),
      result = textureBinding(assetId);
    if (
      texture.extensions?.EXT_texture_webp &&
      imageEntries.get(source)!.asset.mime !== 'image/webp'
    )
      throw new Error('EXT_texture_webp 必须引用 WebP 图片');
    const sampler =
      texture.sampler === undefined ? undefined : at(doc.samplers, texture.sampler, 'sampler');
    if (sampler) {
      result.wrapS = enumName(wrapValues, sampler.wrapS);
      result.wrapT = enumName(wrapValues, sampler.wrapT);
      const mag = enumName(filterValues, sampler.magFilter);
      if (mag !== 'nearest' && mag !== 'linear') throw new Error('glTF 放大过滤模式无效');
      result.magFilter = mag;
      result.minFilter = enumName(filterValues, sampler.minFilter);
    }
    let coord = info.texCoord;
    if (info.extensions?.KHR_texture_transform) {
      const transform = z
        .object({
          offset: vec(2).default([0, 0]),
          scale: vec(2).default([1, 1]),
          rotation: z.number().finite().default(0),
          texCoord: integer.optional(),
        })
        .parse(info.extensions.KHR_texture_transform);
      result.offset = transform.offset as [number, number];
      result.scale = transform.scale as [number, number];
      result.rotation = transform.rotation;
      coord = transform.texCoord ?? coord;
    }
    if (coord !== 0 && coord !== 1) unsupported(`UV${coord}（当前保存 UV0/UV1）`);
    result.texCoord = coord;
    return result;
  };
  const command: SceneImport = {
    type: 'scene.import',
    scenes: [],
    entities: [],
    geometries: [],
    materials: [],
  };
  const materials = new Map<number, string>(),
    primitives = new Map<string, { geometryId: string; materialId: string }>();
  const material = (index = -1) => {
    if (materials.has(index)) return materials.get(index)!;
    const m = index === -1 ? undefined : at(doc.materials, index, 'material'),
      pbr = m?.pbrMetallicRoughness;
    const rgba = pbr?.baseColorFactor || [1, 1, 1, 1],
      linear = rgba.slice(0, 3) as Vec3;
    const result: Project['materials'][number] = {
      id: id(),
      name: name(m?.name, `材质 ${index + 1}`),
      color: displayColor(linear),
      linearColor: linear,
      opacity: rgba[3],
      metalness: pbr?.metallicFactor ?? 1,
      roughness: pbr?.roughnessFactor ?? 1,
      emissive: (m?.emissiveFactor || [0, 0, 0]) as Vec3,
      alphaMode: m?.alphaMode || 'OPAQUE',
      alphaCutoff: m?.alphaCutoff ?? 0.5,
      doubleSided: m?.doubleSided ?? false,
      flatShading: false,
    };
    const textures = {
      baseColor: binding(pbr?.baseColorTexture),
      metallicRoughness: binding(pbr?.metallicRoughnessTexture),
      normal: binding(m?.normalTexture),
      occlusion: binding(m?.occlusionTexture),
      emissive: binding(m?.emissiveTexture),
    };
    for (const slot of textureSlots) if (!textures[slot]) delete textures[slot];
    if (Object.keys(textures).length) result.textures = textures;
    if (m?.normalTexture !== undefined)
      result.normalScale = z
        .object({ scale: z.number().finite().default(1) })
        .parse(m.normalTexture).scale;
    if (m?.occlusionTexture !== undefined)
      result.occlusionStrength = z
        .object({ strength: z.number().min(0).max(1).default(1) })
        .parse(m.occlusionTexture).strength;
    materials.set(index, result.id);
    command.materials.push(result);
    return result.id;
  };
  let vertices = 0;
  const meshPrimitive = (meshIndex: number, primitiveIndex: number) => {
    const key = `${meshIndex}:${primitiveIndex}`;
    if (primitives.has(key)) return primitives.get(key)!;
    const mesh = at(doc.meshes, meshIndex, 'mesh'),
      p = at(mesh.primitives, primitiveIndex, 'primitive');
    if (![4, 5, 6].includes(p.mode)) unsupported('点或线图元');
    for (const attribute of Object.keys(p.attributes))
      if (!['POSITION', 'NORMAL', 'TEXCOORD_0', 'TEXCOORD_1', 'TANGENT'].includes(attribute))
        unsupported(`顶点属性 ${attribute}`);
    const positions = read(p.attributes.POSITION, 'POSITION').map((r) => [...r] as Vec3);
    vertices += positions.length;
    if (positions.length > 100000 || vertices > 300000)
      throw new Error('glTF 超出当前单网格 10 万 / 场景合计 30 万顶点限制');
    const indices =
      p.indices === undefined
        ? positions.map((_, i) => i)
        : read(p.indices, 'indices').map((r) => r[0]);
    if (indices.some((i) => i >= positions.length)) throw new Error('glTF 图元索引越界');
    if (p.indices !== undefined) {
      const component = doc.accessors[p.indices].componentType,
        restart = component === 5121 ? 255 : component === 5123 ? 65535 : 4294967295;
      if (indices.includes(restart)) throw new Error('glTF 索引不能使用图元重启值');
    }
    if (indices.length < 3 || (p.mode === 4 && indices.length % 3))
      throw new Error('glTF 三角图元索引数量无效');
    const triangles: Geometry['triangles'] = [];
    for (let i = p.mode === 4 ? 0 : 2; i < indices.length; i += p.mode === 4 ? 3 : 1) {
      const t =
        p.mode === 4
          ? indices.slice(i, i + 3)
          : p.mode === 6
            ? [indices[0], indices[i - 1], indices[i]]
            : i % 2
              ? [indices[i - 1], indices[i - 2], indices[i]]
              : [indices[i - 2], indices[i - 1], indices[i]];
      if (new Set(t).size !== 3) {
        notes.add('重复索引构成的退化三角面已去除。');
        continue;
      }
      triangles.push(t as [number, number, number]);
    }
    const g: Geometry = {
      id: id(),
      name: name(mesh.name, `网格 ${meshIndex + 1}`),
      positions,
      triangles,
    };
    if (p.attributes.NORMAL !== undefined)
      g.normals = read(p.attributes.NORMAL, 'NORMAL').map((r) => [...r] as Vec3);
    else notes.add('缺少法线的图元按平面着色显示。');
    if (p.attributes.TEXCOORD_0 !== undefined)
      g.uv = read(p.attributes.TEXCOORD_0, 'TEXCOORD_0').map((r) => [...r] as [number, number]);
    if (p.attributes.TEXCOORD_1 !== undefined)
      g.uv1 = read(p.attributes.TEXCOORD_1, 'TEXCOORD_1').map((r) => [...r] as [number, number]);
    if (p.attributes.TANGENT !== undefined)
      g.tangents = read(p.attributes.TANGENT, 'TANGENT').map(
        (r) => [...r] as [number, number, number, 1 | -1],
      );
    // A missing NORMAL is flat shading in glTF. Split material identity for this shading variant.
    let materialId = material(p.material);
    if (!g.normals) {
      const source = command.materials.find((m) => m.id === materialId)!;
      const existing = command.materials.find(
        (m) => m.name === source.name && m.flatShading === true && m.id === `${source.id}-flat`,
      );
      const flat = existing || { ...source, id: `${source.id}-flat`, flatShading: true };
      if (!existing) command.materials.push(flat);
      materialId = flat.id;
    }
    command.geometries.push(g);
    const ref = { geometryId: g.id, materialId };
    primitives.set(key, ref);
    return ref;
  };
  const lightData = z.object({
    lights: z
      .array(
        base.extend({
          type: z.enum(['point', 'directional', 'spot']),
          color: vec(3).default([1, 1, 1]),
          intensity: z.number().nonnegative().default(1),
          range: z.number().positive().optional(),
        }),
      )
      .max(2000),
  });
  const lights = doc.extensions?.KHR_lights_punctual
    ? lightData.parse(doc.extensions.KHR_lights_punctual).lights
    : [];
  const visitedAll = new Set<number>();
  doc.scenes.forEach((source, sceneIndex) => {
    const scene: Project['scenes'][number] = {
      id: id(),
      name: name(source.name, `导入场景 ${sceneIndex + 1}`),
      background: '#19212e',
      ambient: 0.8,
      source: {
        format: 'gltf2',
        ...(doc.asset.copyright ? { copyright: doc.asset.copyright } : {}),
        ...(doc.asset.generator ? { generator: doc.asset.generator } : {}),
      },
    };
    command.scenes.push(scene);
    const visited = new Set<number>();
    const visit = (index: number, parentId: string | null, depth: number) => {
      if (depth > 128) throw new Error('glTF 对象层级超过 128 层');
      if (visited.has(index)) throw new Error('glTF 场景存在循环或重复父级');
      visited.add(index);
      visitedAll.add(index);
      const node = at(doc.nodes, index, 'node');
      const e: Entity = {
        id: id(),
        sceneId: scene.id,
        parentId,
        name: name(node.name, `节点 ${index + 1}`),
        kind: 'group',
        visible: true,
        transform: nodeTransform(node),
      };
      command.entities.push(e);
      const mesh = node.mesh === undefined ? undefined : at(doc.meshes, node.mesh, 'mesh');
      const lightRef =
        node.extensions?.KHR_lights_punctual === undefined
          ? undefined
          : z.object({ light: integer }).parse(node.extensions.KHR_lights_punctual).light;
      const parts =
        (mesh?.primitives.length || 0) +
        Number(node.camera !== undefined) +
        Number(lightRef !== undefined);
      const child = (suffix: string): Entity => {
        if (parts === 1) return e;
        const c: Entity = {
          ...e,
          id: id(),
          parentId: e.id,
          name: name(`${e.name} · ${suffix}`, suffix),
          transform: identity(),
        };
        command.entities.push(c);
        return c;
      };
      mesh?.primitives.forEach((_, i) =>
        Object.assign(child(`网格 ${i + 1}`), { kind: 'mesh', ...meshPrimitive(node.mesh!, i) }),
      );
      if (node.camera !== undefined) {
        const camera = at(doc.cameras, node.camera, 'camera');
        if (camera.type !== 'perspective' || !camera.perspective) unsupported('正交摄影机');
        const p = camera.perspective;
        if (p.zfar === undefined) unsupported('无限远裁剪摄影机');
        Object.assign(child('摄影机'), {
          kind: 'camera',
          camera: {
            fov: (p.yfov * 180) / Math.PI,
            near: p.znear,
            far: p.zfar,
            ...(p.aspectRatio ? { aspect: p.aspectRatio } : {}),
          },
        });
      }
      if (lightRef !== undefined) {
        const l = at(lights, lightRef, 'light');
        if (l.type === 'spot') unsupported('聚光灯');
        const color = l.color as Vec3;
        Object.assign(child('灯光'), {
          kind: 'light',
          light: {
            kind: l.type,
            color: displayColor(color),
            linearColor: color,
            intensity: l.intensity,
            ...(l.range ? { range: l.range } : {}),
            ...(l.type === 'directional' ? { direction: 'local-negative-z' } : {}),
          },
        });
      }
      if (command.entities.length > 2000) throw new Error('导入对象超过 2000 个');
      node.children.forEach((c) => visit(c, e.id, depth + 1));
    };
    source.nodes.forEach((i) => visit(i, null, 0));
  });
  if (visitedAll.size < doc.nodes.length) notes.add('未被任何场景引用的节点未导入。');
  if (
    primitives.size < doc.meshes.reduce((n, m) => n + m.primitives.length, 0) ||
    materials.size < doc.materials.length ||
    imageEntries.size < doc.images.length
  )
    notes.add('未被场景使用的网格、材质及图像资源未导入。');
  notes.add('导入场景使用本平台背景与环境光；glTF 不包含这两项场景设置。');
  notes.add(
    'UV0/UV1 保留；编辑网格后重算法线并重新推导切线，挤出复制 UV、合并保留目标顶点 UV，尚无 UV 展开编辑器。',
  );
  if (doc.asset.copyright) notes.add(`来源版权：${doc.asset.copyright}`);
  const sceneIndex = doc.scene ?? 0;
  for (const entry of imageEntries.values()) entry.asset.blobId = await sha256(entry.bytes);
  if (imageEntries.size) command.assets = [...imageEntries.values()].map((e) => e.asset);
  CommandSchema.parse(command);
  for (const g of command.geometries) {
    if (
      g.normals &&
      (g.normals.length !== g.positions.length ||
        g.normals.some((n) => Math.abs(Math.hypot(...n) - 1) > 0.001))
    )
      throw new Error('glTF 法线长度或归一化无效');
    for (const attr of [g.uv, g.uv1, g.tangents])
      if (attr && attr.length !== g.positions.length) throw new Error('glTF 顶点属性数量不匹配');
  }
  return {
    command,
    defaultSceneId: at(command.scenes, sceneIndex, 'scene').id,
    notes: [...notes],
    copyright: doc.asset.copyright,
    images: [...imageEntries.values()],
  };
}

/** Static snapshot at the exact evaluated frame; never presented as animation export. */
export function exportGLB(
  project: Project,
  sceneId: string,
  frame: number,
  imageBytes: ReadonlyMap<string, Uint8Array> = new Map(),
) {
  if (!Number.isFinite(frame) || frame < 0) throw new Error('导出帧无效');
  const scene = project.scenes.find((s) => s.id === sceneId);
  if (!scene) throw new Error('场景不存在');
  const entities = project.entities.filter((e) => e.sceneId === sceneId),
    byId = new Map(entities.map((e) => [e.id, e]));
  const visible = (e: Entity): boolean =>
    e.visible && (!e.parentId || visible(byId.get(e.parentId)!));
  const included = entities.filter(visible),
    nodeIndex = new Map(included.map((e, i) => [e.id, i]));
  const notes = [
    '仅导出当前帧的可见场景；动画曲线、时间轴、背景、环境光、阴影设置和工作流不属于此 GLB。',
    '位置、法线和 UV 以 Float32 编码。',
  ];
  if (included.length !== entities.length) notes.push('隐藏对象及其子对象未导出。');
  type JSONRecord = Record<string, unknown>;
  const images: JSONRecord[] = [],
    textures: JSONRecord[] = [],
    samplers: JSONRecord[] = [];
  const imageMap = new Map<string, number>(),
    textureMap = new Map<string, number>(),
    samplerMap = new Map<string, number>();
  const extensionsUsed = new Set<string>(),
    extensionsRequired = new Set<string>();
  const nodes: JSONRecord[] = [],
    meshes: JSONRecord[] = [],
    materials: JSONRecord[] = [],
    cameras: JSONRecord[] = [],
    lights: JSONRecord[] = [],
    views: JSONRecord[] = [],
    outputAccessors: JSONRecord[] = [];
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  function textureInfo(binding: TextureBinding | undefined): JSONRecord | undefined {
    if (!binding) return;
    const asset = project.assets.find((a) => a.id === binding.assetId)!;
    if (!asset || asset.kind !== 'image') throw new Error('导出纹理引用无效');
    if (!imageMap.has(asset.blobId)) {
      const bytes = imageBytes.get(asset.id);
      if (!bytes) throw new Error(`导出前必须读取纹理原始字节：${asset.name}`);
      const info = imageInfo(bytes);
      if (info.mime !== asset.mime || bytes.length !== asset.bytes)
        throw new Error('导出纹理与素材元数据不匹配');
      const padded = new Uint8Array(Math.ceil(bytes.length / 4) * 4);
      padded.set(bytes);
      views.push({ buffer: 0, byteOffset: byteLength, byteLength: bytes.length });
      chunks.push(padded);
      byteLength += padded.length;
      if (byteLength > LIMIT) throw new Error('GLB 纹理与几何合计超过 50 MB');
      imageMap.set(asset.blobId, images.length);
      images.push({ name: asset.name, bufferView: views.length - 1, mimeType: asset.mime });
    }
    const sampler = {
        wrapS: wrapValues[binding.wrapS],
        wrapT: wrapValues[binding.wrapT],
        magFilter: filterValues[binding.magFilter],
        minFilter: filterValues[binding.minFilter],
      },
      sKey = JSON.stringify(sampler);
    if (!samplerMap.has(sKey)) {
      samplerMap.set(sKey, samplers.length);
      samplers.push(sampler);
    }
    const index = imageMap.get(asset.blobId)!,
      sampleIndex = samplerMap.get(sKey)!,
      key = `${index}:${sampleIndex}`;
    if (!textureMap.has(key)) {
      textureMap.set(key, textures.length);
      if (asset.mime === 'image/webp') {
        extensionsUsed.add('EXT_texture_webp');
        extensionsRequired.add('EXT_texture_webp');
        textures.push({
          sampler: sampleIndex,
          extensions: { EXT_texture_webp: { source: index } },
        });
      } else textures.push({ source: index, sampler: sampleIndex });
    }
    const info: JSONRecord = { index: textureMap.get(key), texCoord: binding.texCoord };
    if (
      binding.rotation ||
      binding.offset.some((n) => n !== 0) ||
      binding.scale.some((n) => n !== 1)
    ) {
      extensionsUsed.add('KHR_texture_transform');
      extensionsRequired.add('KHR_texture_transform');
      info.extensions = {
        KHR_texture_transform: {
          offset: binding.offset,
          scale: binding.scale,
          rotation: binding.rotation,
        },
      };
    }
    return info;
  }
  function attribute(values: number[], width: number, type: 'FLOAT' | 'INDEX', bounds = false) {
    const bytes = new Uint8Array(values.length * 4),
      view = new DataView(bytes.buffer);
    values.forEach((v, i) =>
      type === 'FLOAT' ? view.setFloat32(i * 4, v, true) : view.setUint32(i * 4, v, true),
    );
    views.push({
      buffer: 0,
      byteOffset: byteLength,
      byteLength: bytes.length,
      target: type === 'INDEX' ? 34963 : 34962,
    });
    chunks.push(bytes);
    byteLength += bytes.length;
    if (byteLength > LIMIT) throw new Error('导出 GLB 超过 50 MB 限制');
    const a: JSONRecord = {
      bufferView: views.length - 1,
      componentType: type === 'FLOAT' ? 5126 : 5125,
      count: values.length / width,
      type: width === 1 ? 'SCALAR' : `VEC${width}`,
    };
    if (bounds) {
      const min = Array(width).fill(Infinity),
        max = Array(width).fill(-Infinity);
      values.forEach((_, i) => {
        const v = view.getFloat32(i * 4, true),
          axis = i % width;
        min[axis] = Math.min(min[axis], v);
        max[axis] = Math.max(max[axis], v);
      });
      a.min = min;
      a.max = max;
    }
    outputAccessors.push(a);
    return outputAccessors.length - 1;
  }
  const matMap = new Map<string, number>(),
    meshMap = new Map<string, number>(),
    geometryMap = new Map<string, JSONRecord>();
  const world = new Map<string, Matrix4>();
  const localMatrix = (e: Entity) => {
    const t = evaluatedTransform(project, e, frame);
    return new Matrix4().compose(
      new Vector3(...t.position),
      new Quaternion().setFromEuler(new Euler(...t.rotation, 'XYZ')),
      new Vector3(...t.scale),
    );
  };
  const worldMatrix = (e: Entity): Matrix4 => {
    if (!world.has(e.id))
      world.set(
        e.id,
        (e.parentId ? worldMatrix(byId.get(e.parentId)!).clone() : new Matrix4()).multiply(
          localMatrix(e),
        ),
      );
    return world.get(e.id)!;
  };
  included.forEach((e) => {
    const t = evaluatedTransform(project, e, frame),
      node: JSONRecord = {
        name: e.name,
        translation: t.position,
        rotation: new Quaternion().setFromEuler(new Euler(...t.rotation, 'XYZ')).toArray(),
        scale: t.scale,
      };
    const children = included.filter((c) => c.parentId === e.id).map((c) => nodeIndex.get(c.id)!);
    if (children.length) node.children = children;
    nodes.push(node);
    if (e.kind === 'mesh') {
      const g = project.geometries.find((g) => g.id === e.geometryId)!,
        m = project.materials.find((m) => m.id === e.materialId)!;
      if (!g.triangles.length) {
        notes.push(`空网格“${e.name}”保留为变换节点。`);
        return;
      }
      if (new Set(g.triangles.flat()).size < g.positions.length)
        notes.push(`网格“${e.name}”的孤立顶点未导出。`);
      const key = `${g.id}:${m.id}`;
      if (!meshMap.has(key)) {
        if (!matMap.has(m.id)) {
          matMap.set(m.id, materials.length);
          materials.push({
            name: m.name,
            pbrMetallicRoughness: {
              baseColorFactor: [...linearColor(m.color, m.linearColor).toArray(), m.opacity ?? 1],
              metallicFactor: m.metalness,
              roughnessFactor: m.roughness,
              ...(m.textures?.baseColor
                ? { baseColorTexture: textureInfo(m.textures.baseColor) }
                : {}),
              ...(m.textures?.metallicRoughness
                ? { metallicRoughnessTexture: textureInfo(m.textures.metallicRoughness) }
                : {}),
            },
            emissiveFactor: m.emissive || [0, 0, 0],
            alphaMode: m.alphaMode || 'OPAQUE',
            ...(m.alphaMode === 'MASK' ? { alphaCutoff: m.alphaCutoff ?? 0.5 } : {}),
            doubleSided: m.doubleSided ?? true,
            ...(m.textures?.normal
              ? { normalTexture: { ...textureInfo(m.textures.normal), scale: m.normalScale ?? 1 } }
              : {}),
            ...(m.textures?.occlusion
              ? {
                  occlusionTexture: {
                    ...textureInfo(m.textures.occlusion),
                    strength: m.occlusionStrength ?? 1,
                  },
                }
              : {}),
            ...(m.textures?.emissive ? { emissiveTexture: textureInfo(m.textures.emissive) } : {}),
          });
        }
        const gKey = `${g.id}:${m.flatShading ?? true}`;
        if (!geometryMap.has(gKey)) {
          const used = [...new Set(g.triangles.flat())].sort((a, b) => a - b),
            remap = new Map(used.map((v, i) => [v, i]));
          const compact: Geometry = {
            ...g,
            positions: used.map((i) => g.positions[i]),
            triangles: g.triangles.map(
              (t) => t.map((i) => remap.get(i)!) as [number, number, number],
            ),
            ...(g.normals ? { normals: used.map((i) => g.normals![i]) } : {}),
            ...(g.uv ? { uv: used.map((i) => g.uv![i]) } : {}),
            ...(g.uv1 ? { uv1: used.map((i) => g.uv1![i]) } : {}),
            ...(g.tangents ? { tangents: used.map((i) => g.tangents![i]) } : {}),
          };
          let geometry = surfaceGeometry(compact);
          if (m.flatShading ?? true) {
            const flat = geometry.toNonIndexed();
            geometry.dispose();
            geometry = flat;
            geometry.deleteAttribute('normal');
            geometry.deleteAttribute('tangent');
            geometry.computeVertexNormals();
          }
          const normal = geometry.getAttribute('normal');
          for (let i = 0; i < normal.count; i++)
            if (Math.hypot(normal.getX(i), normal.getY(i), normal.getZ(i)) < 0.001) {
              geometry.dispose();
              throw new Error(`网格“${e.name}”存在退化面或无法确定的法线，请修复后导出`);
            }
          const attrs: JSONRecord = {
            POSITION: attribute(
              Array.from(geometry.getAttribute('position').array),
              3,
              'FLOAT',
              true,
            ),
            NORMAL: attribute(Array.from(geometry.getAttribute('normal').array), 3, 'FLOAT'),
          };
          if (g.uv)
            attrs.TEXCOORD_0 = attribute(Array.from(geometry.getAttribute('uv').array), 2, 'FLOAT');
          if (g.uv1)
            attrs.TEXCOORD_1 = attribute(
              Array.from(geometry.getAttribute('uv1').array),
              2,
              'FLOAT',
            );
          if (geometry.hasAttribute('tangent'))
            attrs.TANGENT = attribute(
              Array.from(geometry.getAttribute('tangent').array),
              4,
              'FLOAT',
            );
          const data: JSONRecord = { attributes: attrs, mode: 4 };
          if (geometry.index)
            data.indices = attribute(Array.from(geometry.index.array), 1, 'INDEX');
          geometry.dispose();
          geometryMap.set(gKey, data);
        }
        meshMap.set(key, meshes.length);
        meshes.push({
          name: g.name,
          primitives: [{ ...geometryMap.get(gKey), material: matMap.get(m.id) }],
        });
      }
      node.mesh = meshMap.get(key);
    } else if (e.kind === 'camera') {
      const c = e.camera!;
      node.camera = cameras.length;
      cameras.push({
        name: e.name,
        type: 'perspective',
        perspective: {
          yfov: (c.fov * Math.PI) / 180,
          znear: c.near,
          zfar: c.far,
          ...(c.aspect ? { aspectRatio: c.aspect } : {}),
        },
      });
    } else if (e.kind === 'light') {
      const l = e.light!;
      node.extensions = { KHR_lights_punctual: { light: lights.length } };
      lights.push({
        name: e.name,
        type: l.kind,
        color: linearColor(l.color, l.linearColor).toArray(),
        intensity: l.intensity,
        ...(l.range && l.kind === 'point' ? { range: l.range } : {}),
      });
    }
  });
  // Legacy directional lights point toward the world origin. Put the light on a rotated child,
  // preserving the exported transform of any ordinary children attached to the original node.
  included.forEach((e, i) => {
    if (e.light?.kind !== 'directional' || e.light.direction) return;
    const matrix = worldMatrix(e),
      direction = new Vector3().setFromMatrixPosition(matrix).negate();
    if (direction.lengthSq() < 1e-12)
      throw new Error('位于世界原点的旧式平行光没有明确方向，请先移动灯光');
    direction.transformDirection(matrix.clone().invert());
    const child: JSONRecord = {
      name: `${e.name} 光线方向`,
      rotation: new Quaternion().setFromUnitVectors(new Vector3(0, 0, -1), direction).toArray(),
      extensions: nodes[i].extensions,
    };
    delete nodes[i].extensions;
    nodes[i].children = [...((nodes[i].children as number[]) || []), nodes.length];
    nodes.push(child);
  });
  if (lights.length) extensionsUsed.add('KHR_lights_punctual');
  const json: JSONRecord = {
    asset: {
      version: '2.0',
      generator: 'Frameforge Studio 0.7 scene exchange',
      ...(scene.source?.copyright ? { copyright: scene.source.copyright } : {}),
    },
    scene: 0,
    scenes: [
      {
        name: scene.name,
        nodes: included.filter((e) => !e.parentId).map((e) => nodeIndex.get(e.id)!),
      },
    ],
    ...(nodes.length ? { nodes } : {}),
    ...(meshes.length
      ? {
          meshes,
          materials,
          accessors: outputAccessors,
          bufferViews: views,
          buffers: [{ byteLength }],
        }
      : {}),
    ...(cameras.length ? { cameras } : {}),
    ...(images.length ? { images, textures, samplers } : {}),
    ...(extensionsUsed.size ? { extensionsUsed: [...extensionsUsed] } : {}),
    ...(extensionsRequired.size ? { extensionsRequired: [...extensionsRequired] } : {}),
    ...(lights.length ? { extensions: { KHR_lights_punctual: { lights } } } : {}),
  };
  const encoded = new TextEncoder().encode(JSON.stringify(json)),
    jsonLength = Math.ceil(encoded.length / 4) * 4;
  const result = new Uint8Array(12 + 8 + jsonLength + (byteLength ? 8 + byteLength : 0)),
    out = new DataView(result.buffer);
  if (result.length > LIMIT) throw new Error('导出 GLB 超过 50 MB 限制');
  out.setUint32(0, 0x46546c67, true);
  out.setUint32(4, 2, true);
  out.setUint32(8, result.length, true);
  out.setUint32(12, jsonLength, true);
  out.setUint32(16, 0x4e4f534a, true);
  result.fill(32, 20, 20 + jsonLength);
  result.set(encoded, 20);
  if (byteLength) {
    out.setUint32(20 + jsonLength, byteLength, true);
    out.setUint32(24 + jsonLength, 0x004e4942, true);
    let offset = 28 + jsonLength;
    for (const c of chunks) {
      result.set(c, offset);
      offset += c.length;
    }
  }
  return { bytes: result, notes: [...new Set(notes)], frame, sceneName: scene.name };
}

export async function exportGLBWithAssets(
  project: Project,
  sceneId: string,
  frame: number,
  load: (asset: Asset) => Promise<Uint8Array>,
) {
  const images = new Map<string, Uint8Array>();
  const entities = project.entities.filter((e) => e.sceneId === sceneId),
    byId = new Map(entities.map((e) => [e.id, e]));
  const visible = (e: Entity): boolean =>
    e.visible && (!e.parentId || visible(byId.get(e.parentId)!));
  const materials = new Set(
    entities
      .filter(
        (e) =>
          e.kind === 'mesh' &&
          visible(e) &&
          project.geometries.find((g) => g.id === e.geometryId)!.triangles.length,
      )
      .map((e) => e.materialId),
  );
  for (const m of project.materials.filter((m) => materials.has(m.id)))
    for (const binding of Object.values(m.textures || {})) {
      if (images.has(binding.assetId)) continue;
      const asset = project.assets.find((a) => a.id === binding.assetId)!;
      if (!asset) throw new Error('导出纹理图片不存在');
      const bytes = await load(asset);
      await checkedImage(bytes, asset);
      images.set(asset.id, bytes);
    }
  return exportGLB(project, sceneId, frame, images);
}
