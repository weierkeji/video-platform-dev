import type { Vec3 } from './model';

export type PolygonBudget = { remaining: number };
type Point = [number, number];
const EPS = 1e-10;
const cross = (a: Point, b: Point, c: Point) =>
  (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);

/** Simple planar ring, with no holes. Returns original indices and winding. */
export function tessellatePolygon(
  positions: Vec3[],
  ring: number[],
  budget: PolygonBudget = { remaining: 8_000_000 },
) {
  const spend = () => {
    if (--budget.remaining < 0) throw new Error('多边形计算超出预算，请拆分文件或简化面');
  };
  if (ring.length < 3 || ring.length > 1024) throw new Error('每个多边形需要 3–1024 个角点');
  if (new Set(ring).size !== ring.length) throw new Error('多边形包含重复顶点');
  if (ring.some((i) => !Number.isInteger(i) || i < 0 || i >= positions.length))
    throw new Error('多边形顶点索引无效');
  const source = ring.map((i) => positions[i]),
    origin = source[0];
  if (source.some((p) => p.some((v) => !Number.isFinite(v)))) throw new Error('顶点必须为有限数字');
  const size = Math.max(
    ...[0, 1, 2].map(
      (axis) => Math.max(...source.map((p) => p[axis])) - Math.min(...source.map((p) => p[axis])),
    ),
  );
  if (!size) throw new Error('多边形退化');
  const local = source.map((p) => p.map((v, axis) => (v - origin[axis]) / size) as Vec3);
  const area = [0, 0, 0] as Vec3;
  local.forEach((a, i) => {
    const b = local[(i + 1) % local.length];
    area[0] += (a[1] - b[1]) * (a[2] + b[2]);
    area[1] += (a[2] - b[2]) * (a[0] + b[0]);
    area[2] += (a[0] - b[0]) * (a[1] + b[1]);
  });
  const length = Math.hypot(...area);
  if (length <= EPS) throw new Error('多边形退化或自交');
  const normal = area.map((v) => v / length) as Vec3;
  if (local.some((p) => Math.abs(p.reduce((sum, v, i) => sum + v * normal[i], 0)) > 1e-6))
    throw new Error('多边形不是平面，请先拆分为平面面片');
  const axis = area.reduce((best, v, i) => (Math.abs(v) > Math.abs(area[best]) ? i : best), 0);
  const axes = [0, 1, 2].filter((i) => i !== axis);
  const points = local.map((p) => [p[axes[0]], p[axes[1]]] as Point);
  const onSegment = (a: Point, b: Point, p: Point) =>
    Math.abs(cross(a, b, p)) <= EPS &&
    p[0] >= Math.min(a[0], b[0]) - EPS &&
    p[0] <= Math.max(a[0], b[0]) + EPS &&
    p[1] >= Math.min(a[1], b[1]) - EPS &&
    p[1] <= Math.max(a[1], b[1]) + EPS;
  for (let i = 0; i < points.length; i++) {
    const a = points[i],
      b = points[(i + 1) % points.length];
    if (Math.hypot(a[0] - b[0], a[1] - b[1]) <= EPS) throw new Error('多边形包含重合顶点');
    for (let j = i + 1; j < points.length; j++) {
      if (j === i + 1 || (i === 0 && j === points.length - 1)) continue;
      spend();
      const c = points[j],
        d = points[(j + 1) % points.length];
      const abC = cross(a, b, c),
        abD = cross(a, b, d),
        cdA = cross(c, d, a),
        cdB = cross(c, d, b);
      if (
        (((abC > EPS && abD < -EPS) || (abC < -EPS && abD > EPS)) &&
          ((cdA > EPS && cdB < -EPS) || (cdA < -EPS && cdB > EPS))) ||
        onSegment(a, b, c) ||
        onSegment(a, b, d) ||
        onSegment(c, d, a) ||
        onSegment(c, d, b)
      )
        throw new Error('多边形边界自交或重叠');
    }
  }
  const signedArea = points.reduce((sum, a, i) => {
    const b = points[(i + 1) % points.length];
    return sum + a[0] * b[1] - b[0] * a[1];
  }, 0);
  const sign = Math.sign(signedArea),
    active = points.map((_, i) => i);
  const triangles: [number, number, number][] = [];
  while (active.length > 3) {
    let clipped = false;
    for (let i = 0; i < active.length; i++) {
      spend();
      const a = active[(i + active.length - 1) % active.length],
        b = active[i],
        c = active[(i + 1) % active.length];
      if (sign * cross(points[a], points[b], points[c]) <= EPS) continue;
      const blocked = active.some((p) => {
        if (p === a || p === b || p === c) return false;
        spend();
        return (
          sign * cross(points[a], points[b], points[p]) >= -EPS &&
          sign * cross(points[b], points[c], points[p]) >= -EPS &&
          sign * cross(points[c], points[a], points[p]) >= -EPS
        );
      });
      if (blocked) continue;
      triangles.push([ring[a], ring[b], ring[c]]);
      active.splice(i, 1);
      clipped = true;
      break;
    }
    if (!clipped) throw new Error('多边形无法稳定三角化，请检查极短边或退化边界');
  }
  if (sign * cross(points[active[0]], points[active[1]], points[active[2]]) <= EPS)
    throw new Error('多边形包含退化区域');
  triangles.push(active.map((i) => ring[i]) as [number, number, number]);
  return { triangles, normal, areaNormal: area.map((v) => v * size * size) as Vec3 };
}
