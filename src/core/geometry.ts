import { id, type Geometry, type Vec3 } from './model';

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
      if (g.uv) g.uv.push(g.uv[a].map((v, i) => (v + g.uv![b][i]) / 2) as [number, number]);
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
    if (g.uv) g.uv.push([...g.uv[i]]);
    return g.positions.length - 1;
  });
  g.triangles[face] = next as [number, number, number];
  for (let i = 0; i < 3; i++) {
    const j = (i + 1) % 3;
    g.triangles.push([t[i], t[j], next[j]], [t[i], next[j], next[i]]);
  }
  delete g.normals;
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
