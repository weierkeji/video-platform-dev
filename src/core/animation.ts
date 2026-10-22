import type { AnimationTrack, Keyframe, Vec3, KeyHandles } from './model';

export type Point = [number, number];
export const cubic = (a: number, b: number, c: number, d: number, t: number) =>
  (1 - t) ** 3 * a + 3 * (1 - t) ** 2 * t * b + 3 * (1 - t) * t * t * c + t ** 3 * d;

/** Local monotone Hermite tangent; independent design, not Blender's smoothing solver. */
function tangent(track: AnimationTrack, index: number, axis: number) {
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
export function keyHandles(track: AnimationTrack, index: number, axis: number) {
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
  track: AnimationTrack,
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
export function validateTrack(track: AnimationTrack) {
  const ids = new Set<string>();
  for (let i = 0; i < track.keys.length; i++) {
    const k = track.keys[i];
    if (ids.has(k.id)) throw new Error('动画轨道内的关键帧 ID 重复');
    ids.add(k.id);
    if (i > 0 && k.frame <= track.keys[i - 1].frame)
      throw new Error('关键帧必须按帧序排列且不重复');
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
export type KeyEdit =
  | {
      type: 'key.update';
      trackId: string;
      keyId: string;
      patch: Partial<Pick<Keyframe, 'frame' | 'value' | 'interpolation'>>;
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

export function editTrack(track: AnimationTrack, edit: KeyEdit) {
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
    track.keys.sort((a, b) => a.frame - b.frame);
  } else {
    const handles = [0, 1, 2].map((axis) => keyHandles(track, index, axis)) as KeyHandles;
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

export function sampleTrack(track: AnimationTrack, frame: number): Vec3 | undefined {
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
  if (a.interpolation === 'bezier')
    return [0, 1, 2].map((axis) => sampleBezier(segmentControls(track, low, axis), frame)) as Vec3;
  let t = (frame - a.frame) / (b.frame - a.frame);
  if (a.interpolation === 'constant') t = 0;
  else if (a.interpolation === 'smooth') t = t * t * (3 - 2 * t);
  return a.value.map((v, j) => v + (b.value[j] - v) * t) as Vec3;
}
