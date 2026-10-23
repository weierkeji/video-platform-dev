import type { Geometry, Vec3 } from './model';

export type MeshMode = 'vertex' | 'edge' | 'face';
export type MeshSelection = {
  entityId: string;
  geometryId: string;
  mode: MeshMode;
  indices: number[];
};
export type Edge = [number, number];
export function meshEdges(g: Geometry): Edge[] {
  const edges = new Map<string, Edge>();
  for (const t of g.triangles)
    for (let i = 0; i < 3; i++) {
      const a = Math.min(t[i], t[(i + 1) % 3]),
        b = Math.max(t[i], t[(i + 1) % 3]);
      edges.set(`${a}:${b}`, [a, b]);
    }
  return [...edges.values()].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
}
export function sameTopology(a: Geometry, b: Geometry) {
  return (
    a.positions.length === b.positions.length &&
    a.triangles.length === b.triangles.length &&
    a.triangles.every((t, i) => t.every((v, j) => v === b.triangles[i][j]))
  );
}
function indicesIn(indices: number[], length: number) {
  if (new Set(indices).size !== indices.length) throw new Error('网格选择包含重复索引');
  if (indices.some((i) => !Number.isInteger(i) || i < 0 || i >= length))
    throw new Error('网格选择已失效，请重新选择');
}
export function selectedVertices(
  g: Geometry,
  mode: MeshMode,
  indices: number[],
  edges = meshEdges(g),
) {
  indicesIn(
    indices,
    mode === 'vertex' ? g.positions.length : mode === 'face' ? g.triangles.length : edges.length,
  );
  return [
    ...new Set(
      mode === 'vertex'
        ? indices
        : indices.flatMap((i) => (mode === 'face' ? g.triangles[i] : edges[i])),
    ),
  ].sort((a, b) => a - b);
}
export function convertSelection(g: Geometry, from: MeshMode, to: MeshMode, indices: number[]) {
  if (from === to) return [...indices];
  const edges = meshEdges(g),
    vertices = new Set(selectedVertices(g, from, indices, edges));
  if (to === 'vertex') return [...vertices];
  if (to === 'edge') {
    const faceEdges = new Set<string>();
    if (from === 'face')
      for (const i of indices) {
        const t = g.triangles[i];
        for (let j = 0; j < 3; j++)
          faceEdges.add([t[j], t[(j + 1) % 3]].sort((a, b) => a - b).join(':'));
      }
    return edges.flatMap(([a, b], i) =>
      (from === 'face' ? faceEdges.has(`${a}:${b}`) : vertices.has(a) && vertices.has(b))
        ? [i]
        : [],
    );
  }
  const selectedEdges = new Set(indices.map((i) => edges[i]?.join(':')));
  return g.triangles.flatMap((t, i) =>
    (
      from === 'vertex'
        ? t.every((v) => vertices.has(v))
        : t.every((a, j) => selectedEdges.has([a, t[(j + 1) % 3]].sort((a, b) => a - b).join(':')))
    )
      ? [i]
      : [],
  );
}
export function vertexCenter(g: Geometry, indices: number[]): Vec3 {
  indicesIn(indices, g.positions.length);
  if (!indices.length) return [0, 0, 0];
  return [0, 1, 2].map(
    (axis) => indices.reduce((sum, i) => sum + g.positions[i][axis], 0) / indices.length,
  ) as Vec3;
}
/** Column-major affine matrix in geometry-local coordinates. No projective transform. */
export function transformVertices(g: Geometry, indices: number[], matrix: number[]) {
  indicesIn(indices, g.positions.length);
  if (!indices.length) throw new Error('请先选择网格元素');
  if (
    matrix.length !== 16 ||
    matrix.some((v) => !Number.isFinite(v)) ||
    Math.abs(matrix[3]) > 1e-10 ||
    Math.abs(matrix[7]) > 1e-10 ||
    Math.abs(matrix[11]) > 1e-10 ||
    Math.abs(matrix[15] - 1) > 1e-10
  )
    throw new Error('网格变换必须是有限仿射矩阵');
  const positions = indices.map((i) => {
    const [x, y, z] = g.positions[i];
    const p = [0, 1, 2].map(
      (j) => matrix[j] * x + matrix[4 + j] * y + matrix[8 + j] * z + matrix[12 + j],
    ) as Vec3;
    if (p.some((v) => !Number.isFinite(v) || Math.abs(v) > 1e7))
      throw new Error('网格变换超出坐标范围');
    return p;
  });
  indices.forEach((i, n) => {
    g.positions[i] = positions[n];
  });
  delete g.normals;
}
function removeVertices(g: Geometry, removing: Set<number>) {
  const remap = new Map<number, number>();
  if (g.uv) g.uv = g.uv.filter((_, i) => !removing.has(i));
  delete g.normals;
  g.positions = g.positions.filter((_, i) => {
    if (removing.has(i)) return false;
    remap.set(i, remap.size);
    return true;
  });
  g.triangles = g.triangles
    .filter((t) => t.every((i) => !removing.has(i)))
    .map((t) => t.map((i) => remap.get(i)!) as [number, number, number]);
}
export function deleteElements(g: Geometry, mode: MeshMode, indices: number[]) {
  const edges = meshEdges(g);
  selectedVertices(g, mode, indices, edges);
  if (!indices.length) throw new Error('请先选择网格元素');
  delete g.normals;
  if (mode === 'vertex') removeVertices(g, new Set(indices));
  else if (mode === 'face') {
    const selected = new Set(indices);
    g.triangles = g.triangles.filter((_, i) => !selected.has(i));
  } else {
    const selected = new Set(indices.map((i) => edges[i].join(':')));
    g.triangles = g.triangles.filter(
      (t) => !t.some((a, i) => selected.has([a, t[(i + 1) % 3]].sort((a, b) => a - b).join(':'))),
    );
  }
}
export function mergeVertices(g: Geometry, indices: number[]) {
  indicesIn(indices, g.positions.length);
  if (indices.length < 2) throw new Error('合并至少需要两个顶点');
  const selected = new Set(indices),
    target = indices.reduce((a, b) => Math.min(a, b)),
    center = vertexCenter(g, indices);
  g.positions[target] = center;
  const seen = new Set<string>();
  g.triangles = g.triangles
    .map((t) => t.map((i) => (selected.has(i) ? target : i)) as [number, number, number])
    .filter((t) => {
      const key = [...t].sort((a, b) => a - b).join(':');
      if (new Set(t).size !== 3 || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  selected.delete(target);
  removeVertices(g, selected);
}
export function extrudeRegion(g: Geometry, faces: number[], offset: Vec3) {
  indicesIn(faces, g.triangles.length);
  if (!faces.length) throw new Error('请先选择面');
  if (Math.hypot(...offset) < 1e-8) throw new Error('挤出位移不能为零');
  for (const face of faces) {
    const [a, b, c] = g.triangles[face].map((i) => g.positions[i]);
    const u = b.map((v, i) => v - a[i]),
      v = c.map((x, i) => x - a[i]);
    if (
      Math.hypot(u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]) <
      1e-9
    )
      throw new Error('区域包含退化三角面，无法挤出');
  }
  const selected = new Set(faces),
    vertices = selectedVertices(g, 'face', faces);
  const edges = new Map<
    string,
    { a: number; b: number; selected: number; total: number; direction: number }
  >();
  g.triangles.forEach((t, face) => {
    for (let j = 0; j < 3; j++) {
      const a = t[j],
        b = t[(j + 1) % 3],
        key = [a, b].sort((a, b) => a - b).join(':');
      const edge = edges.get(key) || { a, b, selected: 0, total: 0, direction: 0 };
      edge.total++;
      if (selected.has(face)) {
        edge.a = a;
        edge.b = b;
        edge.selected++;
        edge.direction += a < b ? 1 : -1;
      }
      edges.set(key, edge);
    }
  });
  const affected = [...edges.values()].filter((e) => e.selected);
  if (affected.some((e) => e.total > 2 || (e.selected === 2 && e.direction !== 0)))
    throw new Error('区域包含非流形边或面绕序不一致，请先修复拓扑');
  const boundary = affected.filter((e) => e.selected === 1);
  if (!boundary.length) throw new Error('所选区域没有边界；请用移动工具变换封闭网格');
  if (
    g.positions.length + vertices.length > 100000 ||
    g.triangles.length + boundary.length * 2 > 200000
  )
    throw new Error('挤出将超出网格限制');
  const remap = new Map<number, number>();
  for (const i of vertices) {
    remap.set(i, g.positions.length);
    g.positions.push(g.positions[i].map((v, a) => v + offset[a]) as Vec3);
    if (g.uv) g.uv.push([...g.uv[i]]);
  }
  for (const face of faces)
    g.triangles[face] = g.triangles[face].map((i) => remap.get(i)!) as [number, number, number];
  for (const { a, b } of boundary)
    g.triangles.push([a, b, remap.get(b)!], [a, remap.get(b)!, remap.get(a)!]);
  // Remove newly unused original interior vertices; preserve pre-existing loose vertices.
  const used = new Set(g.triangles.flat());
  removeVertices(g, new Set(vertices.filter((i) => !used.has(i))));
}
