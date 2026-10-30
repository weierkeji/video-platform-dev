import { id, type Geometry, type Vec3 } from './model';
import { tessellatePolygon, type PolygonBudget } from './polygon';

export type OBJImport = {
  geometry: Geometry;
  warnings: string[];
  sourceVertices: number;
  polygons: number;
  splitVertices: number;
};
type Corner = { v: number; uv?: number; normal?: number };
type Face = {
  corners: Corner[];
  triangles: [number, number, number][];
  normal: Vec3;
  area: Vec3;
  smooth: string;
  line: number;
};
const normalized = (v: Vec3): Vec3 => {
  const length = Math.hypot(...v);
  if (!length || !Number.isFinite(length)) throw new Error('法线为零或无效，无法归一化');
  return v.map((n) => n / length) as Vec3;
};

export function parseOBJ(text: string): OBJImport {
  if (text.length > 20_000_000 || new TextEncoder().encode(text).length > 20_000_000)
    throw new Error('OBJ 超出 20 MB 限制');
  const positions: Vec3[] = [],
    uv: [number, number][] = [],
    normals: Vec3[] = [],
    faces: Face[] = [];
  const warnings = new Set<string>(),
    budget: PolygonBudget = { remaining: 8_000_000 };
  let name = 'Imported mesh',
    smooth = 'off',
    triangleCount = 0,
    lineNumber = 0,
    continued = '';
  const fail = (message: string): never => {
    throw new Error(`OBJ 第 ${lineNumber} 行：${message}`);
  };
  const number = (token: string) => {
    if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(token)) fail('数字格式无效');
    const value = Number(token);
    if (!Number.isFinite(value) || Math.abs(value) > 1e7) fail('数字超出 ±10000000 范围');
    return value;
  };
  const index = (token: string, count: number) => {
    if (!/^[+-]?\d+$/.test(token)) fail('索引必须为整数');
    const value = Number(token),
      resolved = value > 0 ? value - 1 : count + value;
    if (!Number.isSafeInteger(value) || !value || resolved < 0 || resolved >= count)
      fail('索引为 0 或越界');
    return resolved;
  };
  for (const raw of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    lineNumber++;
    const part = raw.split('#')[0].trim();
    if (part.endsWith('\\')) {
      continued += part.slice(0, -1) + ' ';
      continue;
    }
    const line = (continued + part).trim();
    continued = '';
    if (!line) continue;
    const [type, ...parts] = line.split(/\s+/);
    if (type === 'v') {
      if (![3, 4, 6, 7].includes(parts.length)) fail('顶点需要 xyz，可选权重或颜色');
      const values = parts.map(number);
      if ((values.length === 4 || values.length === 7) && values[3] !== 1)
        fail('尚不支持非 1 顶点权重');
      if (values.length >= 6) warnings.add('顶点颜色未导入。');
      positions.push(values.slice(0, 3) as Vec3);
      if (positions.length > 100000) fail('源顶点超过 10 万限制');
    } else if (type === 'vt') {
      if (!parts.length || parts.length > 3) fail('纹理坐标需要 1–3 个数字');
      const values = parts.map(number);
      if (values[2] && values[2] !== 0) fail('尚不支持三维纹理坐标');
      // OBJ image coordinates are bottom-up; the project's UV convention is top-down.
      const v = 1 - (values[1] || 0);
      if (Math.abs(v) > 1e7) fail('转换后的纹理坐标超出范围');
      uv.push([values[0], v]);
      if (uv.length > 600000) fail('纹理坐标超过 60 万限制');
    } else if (type === 'vn') {
      if (parts.length !== 3) fail('法线需要三个数字');
      try {
        normals.push(normalized(parts.map(number) as Vec3));
      } catch (e) {
        fail((e as Error).message);
      }
      if (normals.length > 600000) fail('法线超过 60 万限制');
    } else if (type === 'f') {
      if (parts.length < 3 || parts.length > 1024) fail('每个面需要 3–1024 个角点');
      const corners = parts.map((token): Corner => {
        const fields = token.split('/');
        if (
          fields.length > 3 ||
          !fields[0] ||
          (fields.length === 2 && !fields[1]) ||
          (fields.length === 3 && !fields[2])
        )
          fail('面角点须为 v、v/vt、v//vn 或 v/vt/vn');
        return {
          v: index(fields[0], positions.length),
          uv: fields[1] ? index(fields[1], uv.length) : undefined,
          normal: fields[2] ? index(fields[2], normals.length) : undefined,
        };
      });
      if (
        corners.some(
          (c) =>
            (c.uv === undefined) !== (corners[0].uv === undefined) ||
            (c.normal === undefined) !== (corners[0].normal === undefined),
        )
      )
        fail('同一个面内必须一致提供 UV 和法线');
      triangleCount += corners.length - 2;
      if (triangleCount > 200000) fail('三角面超过 20 万限制');
      try {
        const result = tessellatePolygon(
          positions,
          corners.map((c) => c.v),
          budget,
        );
        // Source indices are unique within a ring. Convert tessellation to corner offsets.
        const offsets = new Map(corners.map((c, i) => [c.v, i]));
        faces.push({
          corners,
          triangles: result.triangles.map(
            (t) => t.map((v) => offsets.get(v)!) as [number, number, number],
          ),
          normal: result.normal,
          area: result.areaNormal,
          smooth,
          line: lineNumber,
        });
      } catch (e) {
        fail((e as Error).message);
      }
    } else if (type === 's') {
      if (parts.length !== 1 || !/^(?:off|on|\d+)$/.test(parts[0]))
        fail('平滑组需要 off、on 或非负整数');
      smooth =
        parts[0] === 'off' || /^0+$/.test(parts[0])
          ? 'off'
          : parts[0] === 'on'
            ? '1'
            : String(Number(parts[0]));
      if (smooth !== 'off' && !Number.isSafeInteger(Number(smooth))) fail('平滑组编号超出范围');
    } else if (type === 'o' || type === 'g') {
      if (type === 'o' && name === 'Imported mesh' && parts.length)
        name = parts.join(' ').slice(0, 160);
      warnings.add('对象和分组已合并为一个局部网格。');
    } else if (type === 'mtllib' || type === 'usemtl') {
      warnings.add('MTL 材质和贴图未导入；使用平台默认材质。');
    } else if (['p', 'l', 'curv', 'curv2', 'surf', 'cstype', 'vp', 'trim', 'hole'].includes(type)) {
      fail(`尚不支持 ${type} 元素；请转换为多边形网格`);
    } else warnings.add(`未处理的 OBJ 记录：${type.slice(0, 40)}。`);
    if (warnings.size > 32) fail('未支持的记录类型过多');
  }
  if (continued) fail('续行缺少后续内容');
  if (!positions.length) throw new Error('OBJ 没有顶点');
  const geometry: Geometry = {
    id: id(),
    name,
    positions: positions.map((p) => [...p]),
    triangles: [],
  };
  const anyUV = faces.some((f) => f.corners[0].uv !== undefined);
  if (anyUV) geometry.uv = positions.map(() => [0, 0]);
  if (faces.length) geometry.normals = positions.map(() => [0, 1, 0]);
  if (anyUV && faces.some((f) => f.corners[0].uv === undefined))
    warnings.add('部分面缺少 UV，已使用 (0, 0)。');
  const sums = new Map<string, Vec3>();
  for (const face of faces)
    if (face.smooth !== 'off' && face.corners[0].normal === undefined) {
      for (const corner of face.corners) {
        const key = `${corner.v}:${face.smooth}`,
          sum = sums.get(key) || [0, 0, 0];
        face.area.forEach((v, axis) => {
          sum[axis] += v;
        });
        sums.set(key, sum);
      }
    }
  const used = new Set<number>(),
    cache = new Map<string, number>();
  faces.forEach((face, faceIndex) => {
    const mapped = face.corners.map((corner) => {
      const domain =
        corner.normal !== undefined
          ? `n${corner.normal}`
          : face.smooth === 'off'
            ? `f${faceIndex}`
            : `s${face.smooth}`;
      const key = `${corner.v}/${corner.uv ?? ''}/${domain}`;
      let result = cache.get(key);
      if (result !== undefined) return result;
      result = used.has(corner.v) ? geometry.positions.length : corner.v;
      if (result >= 100000) throw new Error('属性接缝拆分超过 10 万顶点限制');
      if (result === geometry.positions.length) geometry.positions.push([...positions[corner.v]]);
      used.add(corner.v);
      cache.set(key, result);
      if (geometry.uv) geometry.uv[result] = corner.uv === undefined ? [0, 0] : [...uv[corner.uv]];
      try {
        geometry.normals![result] =
          corner.normal !== undefined
            ? [...normals[corner.normal]]
            : face.smooth === 'off'
              ? [...face.normal]
              : normalized(sums.get(`${corner.v}:${face.smooth}`)!);
      } catch (e) {
        throw new Error(`OBJ 第 ${face.line} 行：${(e as Error).message}`);
      }
      return result;
    });
    for (const triangle of face.triangles)
      geometry.triangles.push(triangle.map((i) => mapped[i]) as [number, number, number]);
  });
  if (used.size < positions.length && faces.length)
    warnings.add('未引用顶点已保留；其 UV 使用 (0, 0)，法线使用 (0, 1, 0)。');
  return {
    geometry,
    warnings: [...warnings],
    sourceVertices: positions.length,
    polygons: faces.length,
    splitVertices: geometry.positions.length - positions.length,
  };
}

export function importOBJ(text: string): Geometry {
  return parseOBJ(text).geometry;
}

export function exportOBJ(g: Geometry) {
  const lines = [
    '# Frameforge local triangle mesh, metres, Y-up',
    `o ${g.name.replace(/[^\w-]/g, '_')}`,
  ];
  for (const p of g.positions) lines.push(`v ${p.join(' ')}`);
  for (const [u, v] of g.uv || []) lines.push(`vt ${u} ${1 - v}`);
  for (const p of g.normals || []) lines.push(`vn ${p.join(' ')}`);
  // Without custom normals the platform's shared vertices define a smooth domain.
  lines.push('s 1');
  for (const t of g.triangles)
    lines.push(
      `f ${t
        .map((v) => {
          const i = v + 1;
          return g.normals ? `${i}/${g.uv ? i : ''}/${i}` : g.uv ? `${i}/${i}` : String(i);
        })
        .join(' ')}`,
    );
  return lines.join('\n') + '\n';
}
