import { z } from 'zod';
import { slerp } from './animation';
import type { AnimationValue, Vec4 } from './model';

export const AdaptiveSettingsSchema = z
  .object({
    position: z.number().finite().min(1e-8).max(1000),
    rotationDegrees: z.number().finite().min(1e-6).max(180),
    scale: z.number().finite().min(1e-8).max(1000),
    minStep: z.number().finite().min(1e-6).max(120),
  })
  .strict();
export type AdaptiveSettings = z.infer<typeof AdaptiveSettingsSchema>;
export type GridPoint = { time: number; frame: number; source: number; boundaryAfter: boolean };
type Point = GridPoint & { values: AnimationValue[] };
type Channel = 'position' | 'quaternion' | 'scale';
type Errors = { position: number; rotationDegrees: number; scale: number };
const zero = (): Errors => ({ position: 0, rotationDegrees: 0, scale: 0 });
const merge = (a: Errors, b: Errors) => {
  for (const key of ['position', 'rotationDegrees', 'scale'] as const)
    a[key] = Math.max(a[key], b[key]);
};
const NODE_BUDGET = 2000000;
class SamplingBudget extends Error {}

/** Finite probes drive refinement. They do not certify a continuous-time bound. */
export function sampleAnimationGrid(
  grid: GridPoint[],
  channels: Channel[],
  sample: (sourceFrame: number) => AnimationValue[],
  config: {
    fps: number;
    offset: number;
    interpolation: 'linear' | 'constant';
    nodeCost: number;
    entities: number;
    maxSamples: number;
    adaptive?: AdaptiveSettings;
  },
) {
  const adaptive = config.adaptive;
  // Extra non-quarter probes expose common multi-turn aliases at quarter points.
  // Arbitrarily narrow/oscillatory motion can still evade any finite probe set.
  const fractions = adaptive
    ? [(1 - 1 / Math.sqrt(3)) / 2, 0.25, 0.5, 0.75, (1 + 1 / Math.sqrt(3)) / 2]
    : [0.25, 0.5, 0.75];
  let evaluations = 0,
    probes = 0,
    finalProbes = 0,
    added = 0;
  const cost = Math.max(1, config.nodeCost);
  const evaluate = (frame: number) => {
    if ((evaluations + 1) * cost > NODE_BUDGET) throw new SamplingBudget();
    evaluations++;
    return sample(frame);
  };
  // Every seed key must have an actual pose, including those outside an interval
  // whose later refinement exhausts the budget. Never emit missing key values.
  if (grid.length * cost > NODE_BUDGET)
    throw new Error('烘焙初始网格超过 200 万次节点采样预算；请增大步长或缩短范围');
  const points = new Map<number, Point>(
    grid.map((g) => [g.time, { ...g, values: evaluate(g.source) }]),
  );
  const stack: { left: Point; right: Point; depth: number }[] = [];
  for (let i = grid.length - 2; i >= 0; i--)
    stack.push({ left: points.get(grid[i].time)!, right: points.get(grid[i + 1].time)!, depth: 0 });
  const errors = zero(),
    smoothErrors = zero(),
    boundaryErrors = zero(),
    initialSmoothErrors = zero();
  let maxBoundarySpanFrames = 0,
    unresolved = 0,
    unchecked = 0;
  const reasons = new Set<string>();
  const unresolvedIntervals: { start: number; end: number; reason: string; errors: Errors }[] = [];
  const record = (left: Point, right: Point, reason: string, found: Errors) => {
    unresolved++;
    reasons.add(reason);
    if (unresolvedIntervals.length < 20)
      unresolvedIntervals.push({ start: left.frame, end: right.frame, reason, errors: found });
  };
  const compare = (
    a: AnimationValue,
    b: AnimationValue,
    actual: AnimationValue,
    channel: Channel,
    u: number,
  ) => {
    const expected =
      config.interpolation === 'constant'
        ? a
        : channel === 'quaternion'
          ? slerp(a as Vec4, b as Vec4, u)
          : a.map((v, i) => v + (b[i] - v) * u);
    if (channel !== 'quaternion')
      return Math.max(...actual.map((v, i) => Math.abs(v - expected[i])));
    const normA = Math.hypot(...actual),
      normB = Math.hypot(...expected);
    const sign = actual.reduce((sum, v, i) => sum + v * expected[i], 0) < 0 ? -1 : 1;
    const qa = actual.map((v) => v / normA),
      qb = expected.map((v) => (sign * v) / normB);
    return (
      (4 *
        Math.atan2(
          Math.hypot(...qa.map((v, i) => v - qb[i])),
          Math.hypot(...qa.map((v, i) => v + qb[i])),
        ) *
        180) /
      Math.PI
    );
  };
  while (stack.length) {
    const { left, right, depth } = stack.pop()!,
      found = zero();
    let checked = 0;
    try {
      for (const fraction of fractions) {
        const frame = left.frame + (right.frame - left.frame) * fraction;
        const actual = evaluate(frame + config.offset);
        probes += config.entities;
        checked += config.entities;
        channels.forEach((channel, i) => {
          const key = channel === 'quaternion' ? 'rotationDegrees' : channel;
          // Match runtime time subtraction, including rounding at large frame numbers.
          const u = (frame - left.frame) / (right.frame - left.frame);
          const delta = compare(left.values[i], right.values[i], actual[i], channel, u);
          if (!Number.isFinite(delta)) throw new Error('烘焙探测出现非有限误差，无法生成动作');
          found[key] = Math.max(found[key], delta);
        });
      }
    } catch (error) {
      if (!(error instanceof SamplingBudget)) throw error;
      if (!adaptive) throw new Error('烘焙分析超过 200 万次节点采样预算；请增大步长或缩短范围');
      unchecked = stack.length + 1;
      reasons.add('节点采样预算');
      // Partial probes cannot represent an interval's completed analysis.
      break;
    }
    if (!depth && !left.boundaryAfter) merge(initialSmoothErrors, found);
    const over =
      adaptive &&
      !left.boundaryAfter &&
      (found.position > adaptive.position ||
        found.rotationDegrees > adaptive.rotationDegrees ||
        found.scale > adaptive.scale);
    if (over) {
      const middleTime = Math.fround((left.time + right.time) / 2),
        middleFrame = middleTime * config.fps;
      let reason =
        depth >= 20
          ? '细分深度'
          : points.size >= config.maxSamples
            ? '输出键数上限'
            : middleTime <= left.time || middleTime >= right.time
              ? 'Float32 时间精度'
              : Math.min(middleFrame - left.frame, right.frame - middleFrame) < adaptive.minStep
                ? '最小采样间隔'
                : '';
      if (!reason) {
        try {
          const middle: Point = {
            time: middleTime,
            frame: middleFrame,
            source: middleFrame + config.offset,
            boundaryAfter: false,
            values: evaluate(middleFrame + config.offset),
          };
          points.set(middleTime, middle);
          added++;
          stack.push(
            { left: middle, right, depth: depth + 1 },
            { left, right: middle, depth: depth + 1 },
          );
          continue;
        } catch (error) {
          if (!(error instanceof SamplingBudget)) throw error;
          reason = '节点采样预算';
        }
      }
      record(left, right, reason, found);
    }
    finalProbes += checked;
    merge(errors, found);
    merge(left.boundaryAfter ? boundaryErrors : smoothErrors, found);
    if (left.boundaryAfter)
      maxBoundarySpanFrames = Math.max(maxBoundarySpanFrames, right.frame - left.frame);
  }
  return {
    points: [...points.values()].sort((a, b) => a.time - b.time),
    errors,
    smoothErrors,
    boundaryErrors,
    maxBoundarySpanFrames,
    probes,
    finalProbes,
    evaluations,
    nodeEvaluations: evaluations * cost,
    adaptive: adaptive
      ? {
          satisfied: !unresolved && !unchecked,
          initialSamples: grid.length,
          added,
          unresolved,
          unchecked,
          reasons: [...reasons],
          unresolvedIntervals,
          initialSmoothErrors,
          maxDepth: 20,
          nodeBudget: NODE_BUDGET,
        }
      : undefined,
  };
}
