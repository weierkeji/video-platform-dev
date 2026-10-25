import type {
  AnimationTrack,
  Keyframe,
  Vec3,
  Vec4,
  AnimationValue,
  KeyHandles,
  Project,
  Entity,
} from './model';
import { Euler, Quaternion } from 'three';

export function activeTracks(p: Project, entityId: string, actionId?: string | null) {
  const entity = p.entities.find((e) => e.id === entityId);
  const action =
    (actionId === undefined
      ? p.scenes.find((s) => s.id === entity?.sceneId)?.activeActionId
      : actionId) || undefined;
  return p.animationTracks.filter((t) => t.entityId === entityId && t.actionId === action);
}
export function rotationProperty(p: Project, e: Entity) {
  const tracks = activeTracks(p, e.id);
  return tracks.some((t) => t.property === 'quaternion') ||
    (!tracks.some((t) => t.property === 'rotation') && e.transform.quaternion)
    ? 'quaternion'
    : 'rotation';
}
export function normalizeQuaternion(q: readonly number[]): Vec4 {
  const length = Math.hypot(...q);
  if (q.length !== 4 || !Number.isFinite(length) || length < 1e-12)
    throw new Error('四元数长度为零或无效');
  return q.map((v) => v / length) as Vec4;
}
export const quaternionFromEuler = (v: Vec3): Vec4 =>
  new Quaternion().setFromEuler(new Euler(...v, 'XYZ')).toArray();
export const eulerFromQuaternion = (v: Vec4): Vec3 => {
  const e = new Euler().setFromQuaternion(new Quaternion(...v), 'XYZ');
  return [e.x, e.y, e.z];
};
export function slerp(a: Vec4, b: Vec4, t: number): Vec4 {
  let dot = a.reduce((sum, v, i) => sum + v * b[i], 0);
  const end = dot < 0 ? b.map((v) => -v) : b;
  dot = Math.min(1, Math.abs(dot));
  if (dot > 0.9995) return normalizeQuaternion(a.map((v, i) => v + (end[i] - v) * t));
  const angle = Math.acos(dot),
    denominator = Math.sin(angle);
  return normalizeQuaternion(
    a.map((v, i) => (Math.sin((1 - t) * angle) * v + Math.sin(t * angle) * end[i]) / denominator),
  );
}

export type Point = [number, number];
/** Shared numeric curves; scalar parameters retain one component on disk. */
export type CurveKey = Omit<Keyframe, 'value' | 'handles' | 'inTangent' | 'outTangent'> & {
  value: number[];
  handles?: KeyHandles[0][];
  inTangent?: number[];
  outTangent?: number[];
};
export type NumericCurve = { property: string; keys: CurveKey[] };
export const cubic = (a: number, b: number, c: number, d: number, t: number) =>
  (1 - t) ** 3 * a + 3 * (1 - t) ** 2 * t * b + 3 * (1 - t) * t * t * c + t ** 3 * d;

/** Local monotone Hermite tangent; independent design, not Blender's smoothing solver. */
function tangent(track: NumericCurve, index: number, axis: number) {
  const a = track.keys[index - 1],
    k = track.keys[index],
    b = track.keys[index + 1];
  const left = a ? (k.value[axis] - a.value[axis]) / (k.frame - a.frame) : undefined;
  const right = b ? (b.value[axis] - k.value[axis]) / (b.frame - k.frame) : undefined;
  if (left === undefined) return right || 0;
  if (right === undefined) return left;
  if (left * right <= 0) return 0;
  const h0 = k.frame - a.frame,
    h1 = b.frame - k.frame;
  const w0 = 2 * h1 + h0,
    w1 = h1 + 2 * h0;
  return (w0 + w1) / (w0 / left + w1 / right);
}
export function keyHandles(track: NumericCurve, index: number, axis: number) {
  const k = track.keys[index],
    a = track.keys[index - 1],
    b = track.keys[index + 1];
  const saved = k.handles?.[axis];
  const mode = saved?.mode || 'auto-clamped';
  if (saved && (mode === 'free' || mode === 'aligned')) return structuredClone(saved);
  const leftTime = a ? (a.frame - k.frame) / 3 : -1;
  const rightTime = b ? (b.frame - k.frame) / 3 : 1;
  const slope = tangent(track, index, axis);
  return {
    mode,
    left: [
      leftTime,
      mode === 'vector' ? (a ? (a.value[axis] - k.value[axis]) / 3 : 0) : slope * leftTime,
    ] as Point,
    right: [
      rightTime,
      mode === 'vector' ? (b ? (b.value[axis] - k.value[axis]) / 3 : 0) : slope * rightTime,
    ] as Point,
  };
}
/** Shorten crossing time handles proportionally, retaining their tangent directions. */
export function segmentControls(
  track: NumericCurve,
  index: number,
  axis: number,
): [Point, Point, Point, Point] {
  const a = track.keys[index],
    b = track.keys[index + 1],
    span = b.frame - a.frame;
  const outgoing = keyHandles(track, index, axis).right;
  const incoming = keyHandles(track, index + 1, axis).left;
  const total = outgoing[0] - incoming[0];
  const factor = total > span ? span / total : 1;
  return [
    [a.frame, a.value[axis]],
    [a.frame + outgoing[0] * factor, a.value[axis] + outgoing[1] * factor],
    [b.frame + incoming[0] * factor, b.value[axis] + incoming[1] * factor],
    [b.frame, b.value[axis]],
  ];
}
export function sampleBezier(points: [Point, Point, Point, Point], frame: number) {
  // Time is itself cubic. Solve x(t)=frame, rather than treating normalized time as t.
  let low = 0,
    high = 1;
  for (let i = 0; i < 48; i++) {
    const middle = (low + high) / 2;
    if (cubic(points[0][0], points[1][0], points[2][0], points[3][0], middle) < frame) low = middle;
    else high = middle;
  }
  return cubic(points[0][1], points[1][1], points[2][1], points[3][1], (low + high) / 2);
}
const polynomial = (coefficients: number[], t: number) =>
  coefficients.reduceRight((value, coefficient) => value * t + coefficient, 0);
/** Isolate polynomial roots on [0,1] using derivative extrema, including double roots. */
function intervalRoots(coefficients: number[]): number[] {
  const c = [...coefficients];
  while (c.length > 1 && c.at(-1) === 0) c.pop();
  if (c.length === 1) return [];
  const magnitude = Math.max(...c.map(Math.abs));
  const normalized = c.map((v) => v / magnitude);
  const boundaries = [
    0,
    ...intervalRoots(normalized.slice(1).map((v, i) => v * (i + 1))).filter((t) => t > 0 && t < 1),
    1,
  ];
  const roots = boundaries.filter((t) => Math.abs(polynomial(normalized, t)) < 1e-13);
  for (let i = 1; i < boundaries.length; i++) {
    let low = boundaries[i - 1],
      high = boundaries[i];
    // Each interval is monotone. An endpoint already identified as a root cannot
    // also bracket a distinct root; roundoff near a double root otherwise adds one.
    if (roots.includes(low) || roots.includes(high)) continue;
    const sign = Math.sign(polynomial(normalized, low));
    if (sign * polynomial(normalized, high) >= 0) continue;
    for (let step = 0; step < 60; step++) {
      const middle = (low + high) / 2;
      if (sign * polynomial(normalized, middle) > 0) low = middle;
      else high = middle;
    }
    roots.push((low + high) / 2);
  }
  return [...new Set(roots)].sort((a, b) => a - b);
}
function validateQuaternionSegment(a: CurveKey, b: CurveKey) {
  const span = b.frame - a.frame;
  const coefficients = a.value.map((v, i) => {
    const outgoing = span * a.outTangent![i],
      incoming = span * b.inTangent![i];
    return [
      v,
      outgoing,
      -3 * v - 2 * outgoing + 3 * b.value[i] - incoming,
      2 * v + outgoing - 2 * b.value[i] + incoming,
    ];
  });
  // A common zero must be a root of every component; use a nonzero component to find candidates.
  const axis = a.value.reduce(
    (best, v, i) => (Math.abs(v) > Math.abs(a.value[best]) ? i : best),
    0,
  );
  if (
    intervalRoots(coefficients[axis]).some(
      (t) => Math.hypot(...coefficients.map((c) => polynomial(c, t))) < 1e-8,
    )
  )
    throw new Error('四元数 Hermite 段经过零长度旋转，请调整关键帧符号或切线');
}
/** Scalar zero crossings, including tangencies, for baking influence activation. */
export function scalarZeros(track: NumericCurve) {
  const frames: number[] = [];
  for (let i = 0; i + 1 < track.keys.length; i++) {
    const a = track.keys[i],
      b = track.keys[i + 1],
      span = b.frame - a.frame;
    if (a.interpolation === 'constant') continue;
    const v = a.value[0],
      delta = b.value[0] - v;
    let coefficients: number[], controls: ReturnType<typeof segmentControls> | undefined;
    if (a.interpolation === 'bezier') {
      controls = segmentControls(track, i, 0);
      const c = controls[1][1],
        d = controls[2][1];
      coefficients = [v, 3 * (c - v), 3 * (v - 2 * c + d), -v + 3 * c - 3 * d + b.value[0]];
    } else if (a.interpolation === 'cubic') {
      const out = span * a.outTangent![0],
        incoming = span * b.inTangent![0];
      coefficients = [v, out, 3 * delta - 2 * out - incoming, -2 * delta + out + incoming];
    } else
      coefficients =
        a.interpolation === 'smooth' ? [v, 0, 3 * delta, -2 * delta] : [v, delta, 0, 0];
    for (const t of intervalRoots(coefficients))
      if (t > 0 && t < 1)
        frames.push(
          controls
            ? cubic(controls[0][0], controls[1][0], controls[2][0], controls[3][0], t)
            : a.frame + span * t,
        );
  }
  return frames;
}
export function validateTrack(track: NumericCurve) {
  const ids = new Set<string>();
  for (let i = 0; i < track.keys.length; i++) {
    const k = track.keys[i];
    if (ids.has(k.id)) throw new Error('动画轨道内的关键帧 ID 重复');
    ids.add(k.id);
    const width =
      track.property === 'quaternion'
        ? 4
        : ['influence', 'poleAngle'].includes(track.property)
          ? 1
          : 3;
    if (
      k.value.length !== width ||
      [k.inTangent, k.outTangent].some((t) => t && t.length !== width)
    )
      throw new Error('动画数值或切线维度不匹配');
    if (track.property === 'quaternion') {
      if (Math.abs(Math.hypot(...k.value) - 1) > 0.001)
        throw new Error('旋转关键帧的四元数必须归一化');
      if (!['linear', 'constant', 'cubic'].includes(k.interpolation) || k.handles)
        throw new Error('四元数支持球面线性、保持或 Hermite 插值');
    }
    if (
      k.interpolation === 'cubic' &&
      (!k.outTangent || (i + 1 < track.keys.length && !track.keys[i + 1].inTangent))
    )
      throw new Error('Hermite 段缺少出入切线');
    if (i > 0 && k.frame <= track.keys[i - 1].frame)
      throw new Error('关键帧必须按帧序排列且不重复');
    if (track.property === 'quaternion' && k.interpolation === 'cubic' && track.keys[i + 1])
      validateQuaternionSegment(k, track.keys[i + 1]);
    for (const h of k.handles || []) {
      if (h.left[0] > 0 || h.right[0] < 0) throw new Error('左手柄必须朝过去，右手柄必须朝未来');
      if (h.mode === 'aligned') {
        const cross = h.left[0] * h.right[1] - h.left[1] * h.right[0];
        const magnitude = Math.hypot(...h.left) * Math.hypot(...h.right);
        const dot = h.left[0] * h.right[0] + h.left[1] * h.right[1];
        if (Math.abs(cross) > 1e-8 * Math.max(1, magnitude) || dot > 1e-8)
          throw new Error('对齐手柄必须保持反向共线');
      }
    }
  }
}
export function prepareCubic(track: NumericCurve) {
  track.keys.forEach((k, i) => {
    if (k.interpolation !== 'cubic') return;
    const zero = k.value.map(() => 0);
    k.inTangent ||= [...zero];
    k.outTangent ||= [...zero];
    const next = track.keys[i + 1];
    if (next) next.inTangent ||= [...zero];
  });
}
export type KeyEdit<K extends CurveKey = Keyframe> =
  | {
      type: 'key.update';
      trackId: string;
      keyId: string;
      patch: Partial<Pick<K, 'frame' | 'value' | 'interpolation' | 'inTangent' | 'outTangent'>>;
    }
  | {
      type: 'key.handle';
      trackId: string;
      keyId: string;
      axis: number;
      side: 'left' | 'right';
      offset: Point;
    }
  | {
      type: 'key.handles';
      trackId: string;
      keyId: string;
      axis: number;
      mode: KeyHandles[0]['mode'];
    };

export function editTrack(track: NumericCurve, edit: KeyEdit<CurveKey>) {
  const index = track.keys.findIndex((k) => k.id === edit.keyId);
  if (index < 0) throw new Error('关键帧已不存在');
  const k = track.keys[index];
  if (edit.type === 'key.update') {
    if (
      edit.patch.frame !== undefined &&
      track.keys.some((other) => other.id !== k.id && other.frame === edit.patch.frame)
    )
      throw new Error('目标帧已有关键帧；此次移动未覆盖原关键帧');
    Object.assign(k, edit.patch);
    if (track.property === 'quaternion' && edit.patch.value) k.value = normalizeQuaternion(k.value);
    track.keys.sort((a, b) => a.frame - b.frame);
    prepareCubic(track);
  } else {
    if (track.property === 'quaternion') throw new Error('四元数不能使用欧拉角 Bézier 手柄');
    if (edit.axis < 0 || edit.axis >= k.value.length) throw new Error('曲线分量不存在');
    const handles = k.value.map((_, axis) => keyHandles(track, index, axis));
    const h = handles[edit.axis];
    if (edit.type === 'key.handles') {
      h.mode = edit.mode;
      if (edit.mode === 'aligned') align(h, 'right');
    } else {
      if (h.mode !== 'aligned') h.mode = 'free';
      h[edit.side] = [...edit.offset];
      if (h.mode === 'aligned') align(h, edit.side);
    }
    k.handles = handles;
  }
  validateTrack(track);
}
function align(h: KeyHandles[0], side: 'left' | 'right') {
  const other = side === 'left' ? 'right' : 'left';
  const length = Math.hypot(...h[side]);
  if (!length) {
    h[other] = [0, 0];
    return;
  }
  const ratio = -Math.hypot(...h[other]) / length;
  h[other] = [h[side][0] * ratio, h[side][1] * ratio];
}

export function sampleTrack(track: AnimationTrack, frame: number): AnimationValue | undefined {
  return sampleCurve(track, frame) as AnimationValue | undefined;
}
export function sampleCurve(track: NumericCurve, frame: number): number[] | undefined {
  const keys = track.keys;
  if (!keys.length) return;
  if (frame <= keys[0].frame) return [...keys[0].value];
  const last = keys.at(-1)!;
  if (frame >= last.frame) return [...last.value];
  let low = 0,
    high = keys.length - 1;
  while (high - low > 1) {
    const mid = (low + high) >> 1;
    if (keys[mid].frame <= frame) low = mid;
    else high = mid;
  }
  const a = keys[low],
    b = keys[high];
  if (frame === a.frame) return [...a.value];
  let t = (frame - a.frame) / (b.frame - a.frame);
  if (a.interpolation === 'constant') return [...a.value];
  if (a.interpolation === 'cubic') {
    const span = b.frame - a.frame,
      t2 = t * t,
      t3 = t2 * t;
    const value = a.value.map(
      (v, i) =>
        (2 * t3 - 3 * t2 + 1) * v +
        (t3 - 2 * t2 + t) * span * a.outTangent![i] +
        (-2 * t3 + 3 * t2) * b.value[i] +
        (t3 - t2) * span * b.inTangent![i],
    );
    return track.property === 'quaternion' ? normalizeQuaternion(value) : value;
  }
  if (track.property === 'quaternion') return slerp(a.value as Vec4, b.value as Vec4, t);
  if (a.interpolation === 'bezier')
    return a.value.map((_, axis) => sampleBezier(segmentControls(track, low, axis), frame));
  if (a.interpolation === 'smooth') t = t * t * (3 - 2 * t);
  return a.value.map((v, j) => v + (b.value[j] - v) * t);
}
