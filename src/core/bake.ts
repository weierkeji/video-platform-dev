import { z } from 'zod';
import {
  id,
  AnimationTrackSchema,
  type AnimationAction,
  type AnimationTrack,
  type AnimationValue,
  type Entity,
  type Project,
} from './model';
import {
  activeTracks,
  normalizeQuaternion,
  quaternionFromEuler,
  sampleTrack,
  validateTrack,
} from './animation';
import { evaluatedTransform } from './evaluate';
import { activeConstraints, matrixTransform, sceneEvaluator } from './constraints';

export const BakeOptionsSchema = z
  .object({
    start: z.number().finite().min(0).max(1e6),
    end: z.number().finite().min(0).max(1e6),
    step: z.number().finite().min(0.01).max(120),
    interpolation: z.enum(['linear', 'constant']),
    rebase: z.boolean(),
    actionId: z.string().min(1).max(80).nullable(),
  })
  .strict();
export type BakeOptions = z.infer<typeof BakeOptionsSchema>;
const MAX_SAMPLES = 10000,
  MAX_KEYS = 200000,
  MAX_EVENTS = 200000;

// Nonnegative IEEE-754 Float32 neighbours. Times are encoded by glTF as seconds.
function neighbour(value: number, direction: -1 | 1) {
  const bytes = new ArrayBuffer(4),
    floats = new Float32Array(bytes),
    bits = new Uint32Array(bytes);
  floats[0] = value;
  if (value === 0 && direction < 0) return -Infinity;
  bits[0] += direction;
  return floats[0];
}
type Event = { frame: number; guard: boolean; epsilon: number };
function frameEvents(p: Project, sceneId: string, options: BakeOptions) {
  const events = new Map<number, Event>();
  let examined = 0;
  const add = (frame: number, guard: boolean, epsilon = 0) => {
    if (++examined > MAX_EVENTS)
      throw new Error('烘焙边界分析超过 20 万项；请缩短范围或减少循环/轨道');
    if (frame < options.start || frame > options.end) return;
    const old = events.get(frame);
    events.set(frame, {
      frame,
      guard: !!old?.guard || guard,
      epsilon: Math.max(
        old?.epsilon || 0,
        epsilon,
        Number.EPSILON * 32 * Math.max(1, Math.abs(frame)),
      ),
    });
    if (events.size > MAX_SAMPLES) throw new Error('烘焙边界超过单轨 10000 键限制');
  };
  for (const entity of p.entities.filter((e) => e.sceneId === sceneId))
    for (const track of activeTracks(p, entity.id, options.actionId))
      track.keys.forEach((key, i) =>
        add(key.frame, i > 0 && track.keys[i - 1].interpolation === 'constant'),
      );
  const entities = new Set(p.entities.filter((e) => e.sceneId === sceneId).map((e) => e.id));
  for (const layer of p.animationLayers || []) {
    if (!entities.has(layer.entityId) || !layer.enabled || !layer.weight) continue;
    const low = Math.max(options.start, layer.start),
      high = Math.min(options.end, layer.start + layer.duration);
    if (low > high) continue;
    add(layer.start, layer.fadeIn === 0);
    add(layer.start + layer.duration, layer.fadeOut === 0);
    add(layer.start + layer.fadeIn, false);
    add(layer.start + layer.duration - layer.fadeOut, false);
    const { rate, rangeStart: start, rangeEnd: end, mode } = layer.playback;
    if (!rate) continue;
    const span = end - start;
    const mapped = (source: number, guard: boolean) => {
      if (source < start || source > end) return;
      const emit = (raw: number) => {
        const frame = layer.start + (raw - layer.sourceIn) / rate;
        if (frame >= low && frame <= high)
          add(
            frame,
            guard,
            (Number.EPSILON * 32 * (Math.abs(raw) + Math.abs(layer.sourceIn) + end)) /
              Math.abs(rate),
          );
      };
      if (mode === 'hold') {
        emit(source);
        return;
      }
      const rawA = layer.sourceIn + (low - layer.start) * rate,
        rawB = layer.sourceIn + (high - layer.start) * rate;
      const period = mode === 'repeat' ? span : 2 * span;
      const phase = mode === 'repeat' && source === end ? 0 : source - start;
      const phases = [phase];
      if (mode === 'pingpong' && phase > 0 && phase < span) phases.push(period - phase);
      for (const phase of phases) {
        const first = Math.ceil((Math.min(rawA, rawB) - start - phase) / period);
        const last = Math.floor((Math.max(rawA, rawB) - start - phase) / period);
        if (last - first > MAX_SAMPLES)
          throw new Error('循环边界超过烘焙 10000 键限制；请缩短范围');
        for (let cycle = first; cycle <= last; cycle++) emit(start + phase + cycle * period);
      }
    };
    mapped(start, mode === 'repeat');
    mapped(end, mode === 'repeat');
    for (const track of activeTracks(p, layer.entityId, layer.actionId)) {
      if (!layer.channels.includes(track.property === 'quaternion' ? 'rotation' : track.property))
        continue;
      track.keys.forEach((key, i) =>
        mapped(key.frame, i > 0 && track.keys[i - 1].interpolation === 'constant'),
      );
    }
  }
  return [...events.values()];
}

function samplingGrid(p: Project, sceneId: string, options: BakeOptions) {
  const fps = p.timeline.fps,
    offset = options.rebase ? options.start : 0;
  const times = new Map<number, { source: number; event: boolean }>();
  const boundaries = frameEvents(p, sceneId, options);
  const put = (time: number, source: number, event = false) => {
    const previous = times.get(time);
    // Different real event times at one float cannot retain their ordering.
    if (event && previous?.event && previous.source !== source)
      throw new Error('烘焙边界在 Float32 时间下重合；请归零时间或缩短范围');
    if (!previous || event) times.set(time, { source, event });
    if (times.size > MAX_SAMPLES)
      throw new Error('烘焙采样超过单轨 10000 键；请增大步长或缩短范围');
  };
  const encode = (frame: number) => Math.fround((frame - offset) / fps);
  const count = Math.ceil((options.end - options.start) / options.step);
  if (count + 1 > MAX_SAMPLES) throw new Error('烘焙采样超过单轨 10000 键；请增大步长或缩短范围');
  let previous = -Infinity;
  for (let i = 0; i < count; i++) {
    const source = options.start + i * options.step,
      time = encode(source);
    if (time <= previous) throw new Error('烘焙步长小于 Float32 时间精度；请归零时间或增大步长');
    previous = time;
    put(time, time * fps + offset);
  }
  if (encode(options.end) <= previous) throw new Error('烘焙终点在 Float32 时间下重合；请调整区间');
  put(encode(options.start), options.start, true);
  put(encode(options.end), options.end, true);
  for (const boundary of boundaries) put(encode(boundary.frame), boundary.frame, true);
  let guarded = 0;
  const transitionIntervals: [number, number][] = [];
  for (const boundary of boundaries.filter((e) => e.guard)) {
    guarded++;
    const time = encode(boundary.frame);
    for (const direction of [-1, 1] as const) {
      // The next Float32 after zero may not change a source time like 24-frame.
      // Clear source-arithmetic rounding as well as output time quantization.
      const candidate = encode(boundary.frame + direction * boundary.epsilon);
      const adjacent =
          direction < 0
            ? Math.min(neighbour(time, direction), candidate)
            : Math.max(neighbour(time, direction), candidate),
        source = adjacent * fps + offset;
      if (source >= options.start && source <= options.end) {
        put(adjacent, source);
        transitionIntervals.push([Math.min(time, adjacent), Math.max(time, adjacent)]);
      }
    }
  }
  const grid = [...times]
    .sort(([a], [b]) => a - b)
    .map(([time, point]) => ({
      time,
      frame: time * fps,
      source: point.source,
      boundaryAfter: false,
    }));
  transitionIntervals.sort(([a], [b]) => a - b);
  let interval = 0,
    coveredUntil = -Infinity;
  for (let i = 0; i < grid.length - 1; i++) {
    while (
      interval < transitionIntervals.length &&
      transitionIntervals[interval][0] <= grid[i].time
    )
      coveredUntil = Math.max(coveredUntil, transitionIntervals[interval++][1]);
    grid[i].boundaryAfter = grid[i + 1].time <= coveredUntil;
  }
  if (grid.some((g) => g.frame < 0 || g.frame > 1e6))
    throw new Error('量化后的烘焙时间超出项目范围；请归零时间或缩短范围');
  return { grid, guarded, offset };
}

export function bakeAnimation(
  p: Project,
  sceneId: string,
  input: BakeOptions,
  action: AnimationAction = { id: id(), name: '烘焙动画', sceneId },
) {
  const options = BakeOptionsSchema.parse(input);
  if (options.end - options.start < 1e-6)
    throw new Error('烘焙终点必须大于起点且至少间隔 0.000001 帧');
  const scene = p.scenes.find((s) => s.id === sceneId);
  if (!scene || action.sceneId !== sceneId) throw new Error('烘焙场景无效');
  if (
    options.actionId &&
    !p.animationActions?.some((a) => a.id === options.actionId && a.sceneId === sceneId)
  )
    throw new Error('烘焙基础动作必须属于当前场景');
  const { grid, guarded, offset } = samplingGrid(p, sceneId, options);
  const tracks: AnimationTrack[] = [];
  const errors = { position: 0, rotationDegrees: 0, scale: 0 };
  const smoothErrors = { ...errors },
    boundaryErrors = { ...errors };
  let maxBoundarySpanFrames = 0;
  let probes = 0,
    entities = 0;
  const plans: { entity: Entity; scope: Project; created: AnimationTrack[] }[] = [];
  for (const entity of p.entities.filter((e) => e.sceneId === sceneId)) {
    const layers = (p.animationLayers || []).filter(
      (l) => l.entityId === entity.id && l.enabled && l.weight,
    );
    const sourceTracks = p.animationTracks.filter((t) => t.entityId === entity.id);
    const channels = new Set<'position' | 'quaternion' | 'scale'>();
    const include = (track: AnimationTrack) => {
      if (track.keys.length)
        channels.add(track.property === 'rotation' ? 'quaternion' : track.property);
    };
    activeTracks(p, entity.id, options.actionId).forEach(include);
    for (const layer of layers)
      activeTracks(p, entity.id, layer.actionId)
        .filter((t) =>
          layer.channels.includes(t.property === 'quaternion' ? 'rotation' : t.property),
        )
        .forEach(include);
    if (activeConstraints(entity).length) {
      channels.add('position');
      channels.add('quaternion');
      channels.add('scale');
    }
    if (!channels.size) continue;
    if (
      (plans.reduce((n, plan) => n + plan.created.length, 0) + channels.size) * grid.length >
      MAX_KEYS
    )
      throw new Error('烘焙总量超过 20 万键；请增大步长或缩短范围');
    entities++;
    // Unconstrained local channels can still use a narrow lookup scope. Owners
    // with constraints use the full scene graph sampled once at each time below.
    const scope: Project = {
      ...p,
      entities: [entity],
      animationTracks: sourceTracks,
      animationLayers: layers,
    };
    const created = [...channels].map(
      (property): AnimationTrack => ({
        id: id(),
        entityId: entity.id,
        actionId: action.id,
        property,
        keys: [],
      }),
    );
    plans.push({ entity, scope, created });
  }
  const value = (
    t: Entity['transform'],
    channel: 'position' | 'quaternion' | 'scale',
  ): AnimationValue =>
    channel === 'quaternion'
      ? normalizeQuaternion(t.quaternion || quaternionFromEuler(t.rotation))
      : t[channel];
  const hasConstraints = plans.some(({ entity }) => activeConstraints(entity).length);
  const evaluateScene = hasConstraints ? sceneEvaluator(p, sceneId) : undefined;
  const warnings = new Set<string>();
  const sample = (frame: number) => {
    const pose = evaluateScene?.(frame, options.actionId);
    for (const warning of pose?.warnings || [])
      if (warnings.size < 20)
        warnings.add(
          `${p.entities.find((e) => e.id === warning.entityId)!.name}：${warning.message}`,
        );
    return plans.map(({ entity, scope }) =>
      activeConstraints(entity).length
        ? matrixTransform(pose!.local.get(entity.id)!, `${entity.name}（帧 ${frame}）`)
        : evaluatedTransform(scope, entity, frame, options.actionId),
    );
  };
  for (const g of grid) {
    const poses = sample(g.source);
    plans.forEach(({ created }, index) => {
      for (const track of created)
        track.keys.push({
          id: id(),
          frame: g.frame,
          value: value(poses[index], track.property as 'position' | 'quaternion' | 'scale'),
          interpolation: options.interpolation,
        });
    });
  }
  for (const { entity, created } of plans) {
    for (const track of created) {
      AnimationTrackSchema.parse(track);
      validateTrack(track);
      if (
        track.property === 'scale' &&
        track.keys.some((k) => k.value.some((v) => Math.abs(v) < 1e-5))
      )
        throw new Error(`对象“${entity.name}”的烘焙缩放接近零，不能保存为动画键`);
    }
    tracks.push(...created);
  }
  for (let i = 0; i < grid.length - 1; i++) {
    const atBoundary = grid[i].boundaryAfter;
    const category = atBoundary ? boundaryErrors : smoothErrors;
    if (atBoundary)
      maxBoundarySpanFrames = Math.max(maxBoundarySpanFrames, grid[i + 1].frame - grid[i].frame);
    for (const fraction of [0.25, 0.5, 0.75]) {
      const frame = grid[i].frame + (grid[i + 1].frame - grid[i].frame) * fraction;
      const actual = sample(frame + offset);
      plans.forEach(({ created }, index) => {
        probes++;
        for (const track of created) {
          const channel = track.property as 'position' | 'quaternion' | 'scale';
          const expected = value(actual[index], channel),
            sampled = sampleTrack(track, frame)!;
          if (channel === 'quaternion') {
            const dot = Math.min(
              1,
              Math.abs(expected.reduce((sum, v, j) => sum + v * sampled[j], 0)),
            );
            const error = (2 * Math.acos(dot) * 180) / Math.PI;
            errors.rotationDegrees = Math.max(errors.rotationDegrees, error);
            category.rotationDegrees = Math.max(category.rotationDegrees, error);
          } else {
            const error = Math.max(...expected.map((v, j) => Math.abs(v - sampled[j])));
            errors[channel] = Math.max(errors[channel], error);
            category[channel] = Math.max(category[channel], error);
          }
        }
      });
    }
  }
  if (!tracks.length) throw new Error('当前场景和所选动作没有可烘焙的变换动画');
  const stats = {
    samples: grid.length,
    tracks: tracks.length,
    keys: tracks.length * grid.length,
    entities,
    guardedBoundaries: guarded,
    probes,
    errors,
    smoothErrors,
    boundaryErrors,
    maxBoundarySpanFrames,
  };
  const notes = [
    `烘焙场景帧 ${options.start}…${options.end}，步长 ${options.step}；${grid.length} 个时刻、${tracks.length} 条轨道、${stats.keys} 个键。${options.rebase ? '起点归零。' : '保留场景时间；范围前后保持端点。'}`,
    `每段 1/4、1/2、3/4 位置共 ${probes} 次探测：最大位置分量差 ${errors.position.toPrecision(4)} 米、旋转差 ${errors.rotationDegrees.toPrecision(4)}°、缩放分量差 ${errors.scale.toPrecision(4)}。这是局部变换探测值，不是全区间误差上界；GLB 数值另有 Float32 量化。`,
    `边界细分段以外的探测最大差：位置 ${smoothErrors.position.toPrecision(4)} 米、旋转 ${smoothErrors.rotationDegrees.toPrecision(4)}°、缩放 ${smoothErrors.scale.toPrecision(4)}。边界细分段最长 ${maxBoundarySpanFrames.toPrecision(4)} 帧；其中最大差：位置 ${boundaryErrors.position.toPrecision(4)} 米、旋转 ${boundaryErrors.rotationDegrees.toPrecision(4)}°、缩放 ${boundaryErrors.scale.toPrecision(4)}。`,
    `${guarded} 个可能跳变的边界加入 Float32 两侧时刻，并留出源时间浮点运算的舍入间隔。时间按秒量化；边界位置与两侧过渡为近似，不能精确表达瞬时跳变。`,
    '烘焙采样所选基础动作、当前启用的对象层与约束；保留父子局部变换。无法由 TRS 表达的局部剪切会拒绝烘焙。镜头/片段调度、层/约束设置和原始曲线不写入该动作；完整作品保存项目包。',
    ...warnings,
  ];
  return { action, tracks, stats, notes, options };
}

export function bakedProject(p: Project, sceneId: string, options: BakeOptions) {
  const baked = bakeAnimation(p, sceneId, options),
    targets = new Set(p.entities.filter((e) => e.sceneId === sceneId).map((e) => e.id));
  return {
    ...baked,
    project: {
      ...p,
      entities: p.entities.map((e) =>
        targets.has(e.id) && e.constraints
          ? { ...e, constraints: e.constraints.map((c) => ({ ...c, enabled: false })) }
          : e,
      ),
      animationActions: [
        ...(p.animationActions || []).filter((a) => a.sceneId !== sceneId),
        baked.action,
      ],
      animationTracks: [
        ...p.animationTracks.filter((t) => !targets.has(t.entityId)),
        ...baked.tracks,
      ],
      animationLayers: (p.animationLayers || []).filter((l) => !targets.has(l.entityId)),
      scenes: p.scenes.map((s) =>
        s.id === sceneId ? { ...s, activeActionId: baked.action.id } : s,
      ),
    },
  };
}
