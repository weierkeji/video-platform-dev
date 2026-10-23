import type { AnimationTrack, AnimationValue, Vec3 } from './model';
import { sampleTrack, segmentControls, quaternionFromEuler } from './animation';

/** Preserve glTF-compatible curves; bake only representations glTF cannot store exactly. */
export function animationSampler(track: AnimationTrack, fps: number) {
  const keys = track.keys,
    segments = keys.slice(0, -1),
    modes = new Set(segments.map((k) => k.interpolation));
  const quaternion = track.property === 'quaternion',
    euler = track.property === 'rotation';
  const times = keys.map((k) => k.frame / fps);
  let interpolation: 'LINEAR' | 'STEP' | 'CUBICSPLINE' = 'LINEAR';
  let values: AnimationValue[] = keys.map((k) => [...k.value]),
    baked = euler;
  if (!euler && (!segments.length || (modes.size === 1 && modes.has('linear')))) {
    /* Native linear / SLERP. */
  } else if (!euler && modes.size === 1 && modes.has('constant')) interpolation = 'STEP';
  else if (
    !euler &&
    segments.length &&
    (quaternion ? modes.size === 1 && modes.has('cubic') : !modes.has('constant'))
  ) {
    interpolation = 'CUBICSPLINE';
    const width = quaternion ? 4 : 3;
    const incoming = keys.map(() => Array(width).fill(0)),
      outgoing = keys.map(() => Array(width).fill(0));
    for (let i = 0; i < segments.length; i++) {
      const a = keys[i],
        b = keys[i + 1],
        span = b.frame - a.frame;
      for (let axis = 0; axis < width; axis++) {
        if (a.interpolation === 'cubic') {
          outgoing[i][axis] = a.outTangent![axis];
          incoming[i + 1][axis] = b.inTangent![axis];
        } else if (a.interpolation === 'linear')
          outgoing[i][axis] = incoming[i + 1][axis] = (b.value[axis] - a.value[axis]) / span;
        else if (a.interpolation === 'bezier') {
          const c = segmentControls(track, i, axis);
          if (
            Math.abs(c[1][0] - a.frame - span / 3) > 1e-9 * span ||
            Math.abs(b.frame - c[2][0] - span / 3) > 1e-9 * span
          )
            baked = true;
          outgoing[i][axis] = ((c[1][1] - a.value[axis]) * 3) / span;
          incoming[i + 1][axis] = ((b.value[axis] - c[2][1]) * 3) / span;
        }
      }
    }
    values = keys.flatMap((k, i) => [
      incoming[i].map((v) => v * fps) as AnimationValue,
      [...k.value] as AnimationValue,
      outgoing[i].map((v) => v * fps) as AnimationValue,
    ]);
  } else baked = true;
  if (baked) {
    const frames = new Set(keys.map((k) => k.frame)),
      first = keys[0].frame,
      last = keys.at(-1)!.frame;
    if (Math.ceil(last) - Math.floor(first) > 10000)
      throw new Error('动画采样超过单轨 10000 键限制；请缩短范围');
    for (let f = Math.ceil(first); f < last; f++) frames.add(f);
    const ordered = [...frames].sort((a, b) => a - b);
    if (ordered.length > 10000) throw new Error('动画采样超过单轨 10000 键限制');
    times.splice(0, times.length, ...ordered.map((f) => f / fps));
    values = ordered.map((f) => {
      const value = sampleTrack(track, f)!;
      return euler ? quaternionFromEuler(value as Vec3) : value;
    });
    interpolation = 'LINEAR';
  }
  if (
    times.some(
      (t, i) =>
        !Number.isFinite(Math.fround(t)) || (i > 0 && Math.fround(t) <= Math.fround(times[i - 1])),
    )
  )
    throw new Error('动画时间在 Float32 精度下重合，请调整关键帧间距');
  return { times, values, interpolation, baked };
}
