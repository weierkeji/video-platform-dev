import { id, type Geometry, type Vec3 } from './model';
import { normalizedInfluences } from './skin';

export function primitive(kind: 'box' | 'plane' | 'sphere' | 'cylinder'): Geometry {
  const g: Geometry = { id: id(), name: kind, positions: [], triangles: [] };
  if (kind === 'box') {
    g.positions = [
      [-1, -1, -1],
      [1, -1, -1],
      [1, 1, -1],
      [-1, 1, -1],
      [-1, -1, 1],
      [1, -1, 1],
      [1, 1, 1],
      [-1, 1, 1],
    ];
    for (const [a, b, c, d] of [
      [0, 3, 2, 1],
      [4, 5, 6, 7],
      [0, 4, 7, 3],
      [1, 2, 6, 5],
      [3, 7, 6, 2],
      [0, 1, 5, 4],
    ])
      g.triangles.push([a, b, c], [a, c, d]);
  } else if (kind === 'plane') {
    g.positions = [
      [-3, 0, -3],
      [-3, 0, 3],
      [3, 0, 3],
      [3, 0, -3],
    ];
    g.triangles = [
      [0, 1, 2],
      [0, 2, 3],
    ];
  } else if (kind === 'sphere') {
    const segments = 24,
      rings = 16;
    g.positions.push([0, 1, 0]);
    for (let y = 1; y < rings; y++)
      for (let x = 0; x < segments; x++) {
        const phi = (y * Math.PI) / rings,
          theta = (x * Math.PI * 2) / segments;
        g.positions.push([
          Math.sin(phi) * Math.cos(theta),
          Math.cos(phi),
          Math.sin(phi) * Math.sin(theta),
        ]);
      }
    const bottom = g.positions.push([0, -1, 0]) - 1;
    for (let x = 0; x < segments; x++) {
      const next = (x + 1) % segments;
      g.triangles.push(
        [0, 1 + next, 1 + x],
        [bottom, 1 + (rings - 2) * segments + x, 1 + (rings - 2) * segments + next],
      );
      for (let y = 0; y < rings - 2; y++) {
        const a = 1 + y * segments + x,
          b = 1 + y * segments + next,
          c = b + segments,
          d = a + segments;
        g.triangles.push([a, b, c], [a, c, d]);
      }
    }
  } else {
    const n = 24;
    g.positions.push([0, -1, 0], [0, 1, 0]);
    for (let i = 0; i < n; i++) {
      const t = (i * 2 * Math.PI) / n;
      g.positions.push([Math.cos(t), -1, Math.sin(t)], [Math.cos(t), 1, Math.sin(t)]);
    }
    for (let i = 0; i < n; i++) {
      const a = 2 + i * 2,
        b = 2 + ((i + 1) % n) * 2;
      g.triangles.push([0, a, b], [1, b + 1, a + 1], [a, a + 1, b + 1], [a, b + 1, b]);
    }
  }
  return g;
}

export function subdivide(g: Geometry) {
  if (g.triangles.length * 4 > 200000) throw new Error('细分将超出当前网格限制');
  const edges = new Map<string, number>();
  const midpoint = (a: number, b: number) => {
    const key = [Math.min(a, b), Math.max(a, b)].join(':');
    if (!edges.has(key)) {
      const pa = g.positions[a],
        pb = g.positions[b];
      edges.set(key, g.positions.length);
      g.positions.push(pa.map((v, i) => (v + pb[i]) / 2) as Vec3);
      if (g.influences) g.influences.push(normalizedInfluences([g.influences[a], g.influences[b]]));
      for (const uv of [g.uv, g.uv1])
        if (uv) uv.push(uv[a].map((v, i) => (v + uv[b][i]) / 2) as [number, number]);
    }
    return edges.get(key)!;
  };
  g.triangles = g.triangles.flatMap(([a, b, c]) => {
    const ab = midpoint(a, b),
      bc = midpoint(b, c),
      ca = midpoint(c, a);
    return [
      [a, ab, ca],
      [ab, b, bc],
      [ca, bc, c],
      [ab, bc, ca],
    ] as [number, number, number][];
  });
  delete g.normals;
  delete g.tangents;
}

export function extrudeFace(g: Geometry, face: number, distance: number) {
  const t = g.triangles[face];
  if (!t) throw new Error('面索引不存在');
  const [a, b, c] = t.map((i) => g.positions[i]);
  const u = b.map((v, i) => v - a[i]),
    v = c.map((x, i) => x - a[i]);
  const normal = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]],
    length = Math.hypot(...normal);
  if (length < 1e-9) throw new Error('退化三角面无法挤出');
  const next = t.map((i) => {
    g.positions.push(g.positions[i].map((v, j) => v + (normal[j] / length) * distance) as Vec3);
    for (const uv of [g.uv, g.uv1]) if (uv) uv.push([...uv[i]]);
    if (g.influences) g.influences.push(structuredClone(g.influences[i]));
    return g.positions.length - 1;
  });
  g.triangles[face] = next as [number, number, number];
  for (let i = 0; i < 3; i++) {
    const j = (i + 1) % 3;
    g.triangles.push([t[i], t[j], next[j]], [t[i], next[j], next[i]]);
  }
  delete g.normals;
  delete g.tangents;
}

export function exportOBJ(geometry: Geometry) {
  return `# Frameforge local mesh, metres\no ${geometry.name.replace(/[^\w-]/g, '_')}\n${geometry.positions.map((p) => `v ${p.join(' ')}`).join('\n')}\n${geometry.triangles.map((t) => `f ${t.map((i) => i + 1).join(' ')}`).join('\n')}\n`;
}

export function importOBJ(text: string): Geometry {
  const g: Geometry = { id: id(), name: 'Imported mesh', positions: [], triangles: [] };
  if (text.length > 20_000_000) throw new Error('OBJ 超出 20 MB 限制');
  for (const line of text.split(/\r?\n/)) {
    const [type, ...parts] = line.trim().split(/\s+/);
    if (type === 'v') {
      if (parts.length < 3) throw new Error('OBJ 顶点格式错误');
      g.positions.push(parts.slice(0, 3).map(Number) as Vec3);
    }
    if (type === 'f') {
      const indices = parts.map((s) => {
        const i = Number(s.split('/')[0]);
        return i > 0 ? i - 1 : g.positions.length + i;
      });
      if (
        indices.length < 3 ||
        indices.some((i) => !Number.isInteger(i) || i < 0 || i >= g.positions.length)
      )
        throw new Error('OBJ 面索引错误');
      // Convex polygon fan; concave polygon triangulation is not supported yet.
      for (let i = 1; i < indices.length - 1; i++)
        g.triangles.push([indices[0], indices[i], indices[i + 1]]);
    }
  }
  return g;
}

/** Box projection in local space, splitting only vertices at UV seams; shape is unchanged. */
export function projectUV(g: Geometry, channel: 0 | 1) {
  if (!g.triangles.length) throw new Error('生成 UV 需要有三角面的网格');
  const min = [Infinity, Infinity, Infinity],
    max = [-Infinity, -Infinity, -Infinity];
  for (const p of g.positions)
    for (let a = 0; a < 3; a++) {
      min[a] = Math.min(min[a], p[a]);
      max[a] = Math.max(max[a], p[a]);
    }
  const norm = (i: number, a: number) => (g.positions[i][a] - min[a]) / (max[a] - min[a] || 1);
  const positions: Vec3[] = [],
    uv: [number, number][] = [],
    originals: number[] = [],
    used = new Set<number>(),
    cache = new Map<string, number>();
  const vertex = (index: number, mapped: [number, number]) => {
    const key = `${index}:${mapped[0]}:${mapped[1]}`;
    if (!cache.has(key)) {
      if (positions.length >= 100000) throw new Error('UV 接缝拆分超过 10 万顶点限制');
      cache.set(key, positions.length);
      positions.push([...g.positions[index]]);
      uv.push(mapped);
      originals.push(index);
      used.add(index);
    }
    return cache.get(key)!;
  };
  const triangles = g.triangles.map((t) => {
    const [a, b, c] = t.map((i) => g.positions[i]),
      u = b.map((n, i) => n - a[i]),
      v = c.map((n, i) => n - a[i]);
    const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    const axis = n.reduce((best, value, i) => (Math.abs(value) > Math.abs(n[best]) ? i : best), 0);
    return t.map((i) => {
      const axes = axis === 0 ? [2, 1] : axis === 1 ? [0, 2] : [0, 1];
      const x = norm(i, axes[0]);
      return vertex(i, [n[axis] < 0 ? 1 - x : x, 1 - norm(i, axes[1])]);
    }) as [number, number, number];
  });
  g.positions.forEach((_, i) => {
    if (!used.has(i)) vertex(i, [norm(i, 0), 1 - norm(i, 1)]);
  });
  if (g.normals) g.normals = originals.map((i) => g.normals![i]);
  if (g.uv) g.uv = originals.map((i) => g.uv![i]);
  if (g.uv1) g.uv1 = originals.map((i) => g.uv1![i]);
  if (g.influences) g.influences = originals.map((i) => structuredClone(g.influences![i]));
  g.positions = positions;
  g.triangles = triangles;
  g[channel === 0 ? 'uv' : 'uv1'] = uv;
  delete g.tangents;
}
