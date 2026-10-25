import { z } from 'zod';
import {
  id,
  AnimationTrackSchema,
  IKTrackSchema,
  type AnimationAction,
  type AnimationTrack,
  type IKTrack,
  type Project,
} from './model';
import { segmentControls, validateTrack, type NumericCurve, type CurveKey } from './animation';

export const ReduceOptionsSchema = z
  .object({
    actionId: z.string().min(1).max(80).nullable(),
    start: z.number().finite().min(0).max(1e6),
    end: z.number().finite().min(0).max(1e6),
    position: z.number().finite().min(0).max(1000),
    rotationDegrees: z.number().finite().min(0).max(180),
    scale: z.number().finite().min(0).max(1000),
    influence: z.number().finite().min(0).max(1),
  })
  .strict();
export type ReduceOptions = z.infer<typeof ReduceOptionsSchema>;
type Track = AnimationTrack | IKTrack;
type Controls = [number, number, number, number];
type Budget = { remaining: number; exhausted: boolean };
const LIMIT = 1000000;
const norm = (v: number[]) => Math.hypot(...v);
const dot = (a: number[], b: number[]) => a.reduce((sum, v, i) => sum + v * b[i], 0);
const sub = (a: number[], b: number[]) => a.map((v, i) => v - b[i]);
const pad = (magnitude: number) => 128 * Number.EPSILON * Math.max(1, magnitude);
function spend(budget: Budget) {
  if (budget.remaining-- > 0) return true;
  budget.exhausted = true;
  return false;
}

/** Cubic Bernstein controls for the source's actual time/value parameterization. */
function controls(track: NumericCurve, index: number, axis: number) {
  const a = track.keys[index],
    b = track.keys[index + 1],
    dt = b.frame - a.frame,
    v = a.value[axis],
    w = b.value[axis];
  let x: Controls = [a.frame, a.frame + dt / 3, b.frame - dt / 3, b.frame],
    y: Controls;
  switch (a.interpolation) {
    case 'bezier': {
      const points = segmentControls(track, index, axis);
      x = points.map((p) => p[0]) as Controls;
      y = points.map((p) => p[1]) as Controls;
      break;
    }
    case 'cubic':
      y = [v, v + (dt * a.outTangent![axis]) / 3, w - (dt * b.inTangent![axis]) / 3, w];
      break;
    case 'smooth':
      y = [v, v, w, w];
      break;
    case 'constant':
      y = [v, v, v, v];
      break;
    default:
      y = [v, v + (w - v) / 3, w - (w - v) / 3, w];
  }
  return { x, y };
}
function tolerance(property: string, options: ReduceOptions) {
  if (property === 'position') return options.position;
  if (property === 'scale') return options.scale;
  if (property === 'influence') return options.influence;
  return (options.rotationDegrees * Math.PI) / 180;
}
function aggregate(property: string, errors: number[]) {
  // Unwrapped XYZ differences retain winding and bound orientation distance by
  // the sum of the three elementary rotation differences.
  return property === 'rotation' ? errors.reduce((a, b) => a + b, 0) : norm(errors);
}

function polynomialBound(track: NumericCurve, segment: number, left: number, right: number) {
  const a = track.keys[left],
    b = track.keys[right],
    dt = b.frame - a.frame;
  const errors = a.value.map((v, axis) => {
    const { x, y } = controls(track, segment, axis),
      delta = b.value[axis] - v;
    const difference = y.map((w, i) => w - (v + (delta * (x[i] - a.frame)) / dt));
    // Affine subtraction commutes with Bernstein evaluation, even when each
    // Bezier component has its own monotone time polynomial.
    const magnitude = Math.max(...y.map(Math.abs), Math.abs(v), Math.abs(b.value[axis]));
    return Math.max(...difference.map(Math.abs)) + pad(magnitude);
  });
  return aggregate(track.property, errors);
}

function qdistance(a: number[], b: number[]) {
  const qa = a.map((v) => v / norm(a)),
    sign = dot(a, b) < 0 ? -1 : 1,
    qb = b.map((v) => (sign * v) / norm(b));
  return 4 * Math.atan2(norm(sub(qa, qb)), norm(qa.map((v, i) => v + qb[i])));
}
type QuaternionPath = { at: (u: number) => number[]; derivative: number };
function quaternionPath(a: CurveKey, b: CurveKey, constant = false): QuaternionPath {
  if (constant || a.interpolation === 'constant') return { at: () => [...a.value], derivative: 0 };
  if (a.interpolation === 'cubic') {
    const dt = b.frame - a.frame,
      c = a.value.map((v, i) => v + (dt * a.outTangent![i]) / 3),
      d = b.value.map((v, i) => v - (dt * b.inTangent![i]) / 3);
    return {
      derivative: 3 * Math.max(norm(sub(c, a.value)), norm(sub(d, c)), norm(sub(b.value, d))),
      at: (u) =>
        a.value.map(
          (v, i) =>
            (1 - u) ** 3 * v +
            3 * (1 - u) ** 2 * u * c[i] +
            3 * (1 - u) * u * u * d[i] +
            u ** 3 * b.value[i],
        ),
    };
  }
  const rawDot = dot(a.value, b.value),
    end = b.value.map((v) => (rawDot < 0 ? -v : v)),
    cosine = Math.min(1, Math.abs(rawDot));
  if (cosine > 0.9995)
    return {
      derivative: norm(sub(end, a.value)),
      at: (u) => a.value.map((v, i) => v + (end[i] - v) * u),
    };
  const theta = Math.acos(cosine),
    sine = Math.sin(theta);
  return {
    derivative: (theta * (norm(a.value) + norm(end))) / sine,
    at: (u) =>
      a.value.map((v, i) => (Math.sin((1 - u) * theta) * v + Math.sin(u * theta) * end[i]) / sine),
  };
}
function radius(path: QuaternionPath, low: number, high: number) {
  const raw = path.at((low + high) / 2),
    length = norm(raw),
    motion = (path.derivative * (high - low)) / 2,
    minimum = length - motion - pad(length + motion);
  // |d normalize(q)/dt| <= |q'| / min|q|. Orientation distance is twice
  // quaternion-sphere distance. Reject/refine uncertain lower norm bounds.
  return { raw, angle: minimum > 1e-12 ? (2 * motion) / minimum + pad(length + motion) : Infinity };
}
function quaternionBound(
  track: NumericCurve,
  segment: number,
  left: number,
  right: number,
  allowed: number,
  budget: Budget,
) {
  const keys = track.keys,
    a = keys[segment],
    b = keys[segment + 1],
    source = quaternionPath(a, b),
    candidate = quaternionPath({ ...keys[left], interpolation: 'linear' }, keys[right]),
    span = keys[right].frame - keys[left].frame;
  const map = (u: number) => (a.frame - keys[left].frame + u * (b.frame - a.frame)) / span;
  const stack: [number, number, number][] = [[0, 1, 0]];
  let bound = 0;
  while (stack.length) {
    if (!spend(budget)) return Infinity;
    const [lo, hi, depth] = stack.pop()!,
      x = radius(source, lo, hi),
      y = radius(candidate, map(lo), map(hi)),
      distance = qdistance(x.raw, y.raw),
      upper = distance + x.angle + y.angle + 1e-12;
    if (!Number.isFinite(distance) || distance > allowed) return Infinity;
    if (upper <= allowed) {
      bound = Math.max(bound, upper);
      continue;
    }
    if (depth >= 20) return Infinity;
    const mid = (lo + hi) / 2;
    stack.push([lo, mid, depth + 1], [mid, hi, depth + 1]);
  }
  return bound;
}

function protectedKeys(track: NumericCurve, options: ReduceOptions, fps: number) {
  const pinned = new Set([0, track.keys.length - 1]);
  // Float32 exchange guard neighborhoods remain authored even if a tolerance
  // would permit averaging their extremely brief transitions.
  const spacing = (frame: number) => {
    const time = Math.abs(frame / fps),
      exponent = time ? Math.floor(Math.log2(time)) : -149;
    return Math.max(1e-6, fps * 8 * 2 ** Math.max(-149, exponent - 23));
  };
  for (let i = 0; i < track.keys.length; i++) {
    const a = track.keys[i],
      b = track.keys[i + 1];
    if (a.frame <= options.start || a.frame >= options.end) pinned.add(i);
    if (i && track.keys[i - 1].frame < options.start) pinned.add(i);
    if (b && b.frame > options.end) pinned.add(i);
    if (track.property === 'quaternion' && Math.abs(norm(a.value) - 1) > 1e-10) pinned.add(i);
    if (!b) continue;
    const jump = a.interpolation === 'constant' && a.value.some((v, axis) => v !== b.value[axis]);
    let threshold = false;
    if (track.property === 'influence' || track.property === 'scale')
      for (let axis = 0; axis < a.value.length; axis++) {
        const y = controls(track, i, axis).y,
          min = Math.min(...y),
          max = Math.max(...y);
        for (const level of track.property === 'influence' ? [0, 1] : [0])
          if (min <= level && max >= level && min !== max) threshold = true;
      }
    if (jump || threshold || b.frame - a.frame <= spacing(b.frame)) {
      pinned.add(i);
      pinned.add(i + 1);
    }
  }
  return [...pinned].sort((a, b) => a - b);
}

/** A deterministic, conservative subdivision reducer. Not a minimum-key solver. */
function reduceTrack(track: Track, options: ReduceOptions, fps: number, budget: Budget) {
  const allowed = tolerance(track.property, options),
    before = track.keys.length;
  const unchanged = (reason = '') => ({
    keys: structuredClone(track.keys),
    before,
    after: before,
    bound: 0,
    reason,
  });
  if (before < 3 || !allowed) return unchanged();
  const pinned = protectedKeys(track, options, fps),
    stack: [number, number][] = [],
    edges: { left: number; right: number; linear: boolean }[] = [];
  for (let i = 0; i < pinned.length - 1; i++) stack.push([pinned[i], pinned[i + 1]]);
  let maximum = 0;
  while (stack.length) {
    const [left, right] = stack.pop()!;
    if (right - left === 1) {
      edges.push({ left, right, linear: false });
      continue;
    }
    if (budget.remaining <= 0) {
      budget.exhausted = true;
      for (let i = left; i < right; i++) edges.push({ left: i, right: i + 1, linear: false });
      continue;
    }
    // Split at a large deviation, not the first failing sample: the latter
    // needlessly retains long runs leading up to a single bend.
    if (track.property === 'quaternion') {
      const a = track.keys[left],
        b = track.keys[right],
        path = quaternionPath({ ...a, interpolation: 'linear' }, b);
      let worst = allowed,
        split = -1;
      for (let i = left + 1; i < right && spend(budget); i++) {
        const key = track.keys[i],
          error = qdistance(key.value, path.at((key.frame - a.frame) / (b.frame - a.frame)));
        if (error > worst) {
          worst = error;
          split = i;
        }
      }
      if (split >= 0) {
        stack.push([split, right], [left, split]);
        continue;
      }
    }
    let bound = 0,
      failing = -1,
      worst = allowed;
    for (let i = left; i < right; i++) {
      if (!spend(budget)) {
        failing = i;
        break;
      }
      const error =
        track.property === 'quaternion'
          ? quaternionBound(track, i, left, right, allowed, budget)
          : polynomialBound(track, i, left, right);
      if (!Number.isFinite(error) || error > worst) {
        failing = i;
        worst = error;
        if (track.property === 'quaternion') break;
      }
      bound = Math.max(bound, error);
    }
    if (failing < 0) {
      edges.push({ left, right, linear: true });
      maximum = Math.max(maximum, bound);
    } else {
      const split = Math.max(left + 1, Math.min(right - 1, failing + 1));
      stack.push([split, right], [left, split]);
    }
  }
  edges.sort((a, b) => a.left - b.left);
  if (edges.length + 1 === before) return unchanged();
  const selected = [...edges.map((e) => e.left), before - 1],
    keys = selected.map((i) => structuredClone(track.keys[i])) as CurveKey[],
    byIndex = new Map(selected.map((index, i) => [index, keys[i]]));
  const fixedHandles = new Set<number>();
  for (const edge of edges) {
    const a = byIndex.get(edge.left)!,
      b = byIndex.get(edge.right)!;
    if (edge.linear) {
      a.interpolation = 'linear';
      continue;
    }
    if (a.interpolation !== 'bezier') continue;
    // Freeze effective handles for every original Bezier segment we retain.
    // Auto/vector neighbors can otherwise move after a key is removed.
    for (const index of [edge.left, edge.right])
      if (!fixedHandles.has(index)) {
        const k = byIndex.get(index)!;
        k.handles = k.value.map(() => ({ mode: 'free', left: [0, 0], right: [0, 0] }));
        fixedHandles.add(index);
      }
    for (let axis = 0; axis < a.value.length; axis++) {
      const c = segmentControls(track, edge.left, axis);
      a.handles![axis].right = [c[1][0] - a.frame, c[1][1] - a.value[axis]];
      b.handles![axis].left = [c[2][0] - b.frame, c[2][1] - b.value[axis]];
    }
  }
  // Preserve source curves if explicit effective handles exceed the file format.
  const schema = 'chainId' in track ? IKTrackSchema : AnimationTrackSchema;
  if (!schema.safeParse({ ...track, keys }).success)
    return unchanged('固定手柄超出项目格式范围，保留整轨');
  validateTrack({ ...track, keys });
  return { keys, before, after: keys.length, bound: maximum, reason: '' };
}

export function reduceAction(
  p: Project,
  sceneId: string,
  input: ReduceOptions,
  action?: AnimationAction,
) {
  const options = ReduceOptionsSchema.parse(input);
  if (!p.scenes.some((s) => s.id === sceneId)) throw new Error('动作精简场景不存在');
  if (options.end <= options.start) throw new Error('精简终点必须大于起点');
  if (
    options.actionId &&
    !p.animationActions?.some((a) => a.id === options.actionId && a.sceneId === sceneId)
  )
    throw new Error('精简源动作必须属于当前场景');
  action ||= { id: id(), name: '精简动作', sceneId };
  if (action.sceneId !== sceneId) throw new Error('精简结果必须属于源场景');
  const targets = new Set(p.entities.filter((e) => e.sceneId === sceneId).map((e) => e.id)),
    source = [...p.animationTracks, ...(p.ikTracks || [])].filter(
      (t) => targets.has(t.entityId) && (t.actionId || null) === options.actionId,
    );
  const inputKeys = source.reduce((sum, t) => sum + t.keys.length, 0);
  if (!inputKeys) throw new Error('所选动作没有关键帧');
  if (inputKeys > 200000) throw new Error('精简输入超过 20 万键；请先拆分动作');
  const budget: Budget = { remaining: LIMIT, exhausted: false },
    tracks: AnimationTrack[] = [],
    ikTracks: IKTrack[] = [];
  const details = source.map((track) => {
    const result = reduceTrack(track, options, p.timeline.fps, budget);
    const next = {
      ...structuredClone(track),
      id: id(),
      actionId: action!.id,
      keys: result.keys.map((k) => ({ ...k, id: id() })),
    } as Track;
    if ('chainId' in next) ikTracks.push(next);
    else tracks.push(next);
    const angular = ['rotation', 'quaternion', 'poleAngle'].includes(track.property);
    return {
      entityId: track.entityId,
      property: track.property,
      before: result.before,
      after: result.after,
      bound: angular ? (result.bound * 180) / Math.PI : result.bound,
      reason: result.reason,
    };
  });
  const outputKeys = details.reduce((sum, d) => sum + d.after, 0),
    stats = {
      inputKeys,
      outputKeys,
      removed: inputKeys - outputKeys,
      tracks: source.length,
      checks: LIMIT - Math.max(0, budget.remaining),
      exhausted: budget.exhausted,
      details,
    };
  const notes = [
    `${inputKeys} → ${outputKeys} 个关键帧，删除 ${stats.removed} 个；${source.length} 条变换/IK 参数轨道。`,
    '只精简指定区间；完整动作另存，区间外、首尾、保持跳变、时间保护邻域及单轨开关跨越保留。',
    '误差按原始局部通道计算：位置为米，缩放为绝对差，旋转/极向角为度，IK 影响为数值差；不保证世界空间、接触或图像误差。',
    ...(budget.exhausted
      ? ['达到区间检查预算；未确认的剩余区间保留原键，没有按未经确认的误差删键。']
      : []),
    ...details
      .filter((d) => d.reason)
      .map(
        (d) => `${p.entities.find((e) => e.id === d.entityId)!.name} / ${d.property}：${d.reason}`,
      ),
  ];
  return { action, tracks, ikTracks, stats, notes };
}
