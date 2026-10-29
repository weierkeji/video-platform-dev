import { z } from 'zod';
import { ClipSchema, type Clip, type Project } from './model';
import { unwrappedSourceFrame } from './playback';

export const ClipEditSchema = z
  .object({
    mode: z.enum(['move', 'trimStart', 'trimEnd']),
    delta: z.number().int().min(-1000000).max(1000000),
    channel: z.number().int().min(0).max(31).optional(),
  })
  .strict();
export type ClipEdit = z.infer<typeof ClipEditSchema>;
export type ClipTiming = Pick<Clip, 'start' | 'duration' | 'sourceIn' | 'channel'>;

/** A bounded draft; authoritative writes still use clip.update and full project validation. */
export function planClipEdit(p: Project, clipId: string, input: ClipEdit) {
  const edit = ClipEditSchema.parse(input),
    source = p.timeline.clips.find((c) => c.id === clipId);
  if (!source) throw new Error('片段不存在');
  if (edit.mode !== 'move' && edit.channel !== undefined) throw new Error('裁剪不能同时更换轨道');
  const next = { ...source };
  if (edit.mode === 'move') {
    next.start += edit.delta;
    next.channel = edit.channel ?? source.channel;
  } else if (edit.mode === 'trimStart') {
    next.start += edit.delta;
    next.duration -= edit.delta;
    next.sourceIn = unwrappedSourceFrame(source, next.start);
  } else next.duration += edit.delta;
  let error = '';
  if (next.duration < 1) error = '片段至少保留 1 帧';
  else if (next.start < 0 || next.start + next.duration > p.timeline.duration)
    error = '片段超出时间轴范围';
  else if (!ClipSchema.safeParse(next).success) error = '片段时间或源入点超出允许范围';
  else if (next.kind === 'shot') {
    if (Math.abs(next.sourceIn + next.duration * (next.playback?.rate ?? 1)) > 1e9)
      error = '镜头源时间超出范围';
  } else {
    const asset = p.assets.find((a) => a.id === next.sourceId);
    if (next.sourceIn < 0 || next.sourceIn > 1000000 || !Number.isInteger(next.sourceIn))
      error = '媒体源入点必须为范围内的非负整帧';
    else if (!asset || asset.kind !== next.kind) error = '片段素材不存在或类型不匹配';
    else if (
      asset.duration !== undefined &&
      (next.sourceIn + next.duration) / p.timeline.fps > asset.duration + 1 / p.timeline.fps
    )
      error = '片段超出素材时长';
  }
  if (
    !error &&
    p.timeline.clips.some(
      (c) =>
        c.id !== clipId &&
        c.channel === next.channel &&
        next.start < c.start + c.duration &&
        c.start < next.start + next.duration,
    )
  )
    error = '同一轨道的片段不能重叠';
  const patch: ClipTiming = {
    start: next.start,
    duration: next.duration,
    sourceIn: next.sourceIn,
    channel: next.channel,
  };
  const changed = (Object.keys(patch) as (keyof ClipTiming)[]).some(
    (key) => patch[key] !== source[key],
  );
  return { clip: next, patch, error, changed };
}

/** Snap distance is measured in CSS pixels by the caller, independent of timeline zoom. */
export function previewClipEdit(
  p: Project,
  clipId: string,
  edit: ClipEdit,
  snap?: { frame: number; threshold: number },
) {
  const raw = planClipEdit(p, clipId, edit);
  if (!snap || !Number.isFinite(snap.threshold) || snap.threshold < 0)
    return { ...raw, snapFrame: undefined as number | undefined };
  const source = p.timeline.clips.find((c) => c.id === clipId)!;
  const targets = [
    ...new Set([
      0,
      p.timeline.duration,
      ...(Number.isInteger(snap.frame) && snap.frame >= 0 && snap.frame <= p.timeline.duration
        ? [snap.frame]
        : []),
      ...p.timeline.clips
        .filter((c) => c.id !== clipId)
        .flatMap((c) => [c.start, c.start + c.duration]),
    ]),
  ].sort((a, b) => a - b);
  const anchors =
    edit.mode === 'move'
      ? [source.start, source.start + source.duration]
      : [edit.mode === 'trimStart' ? source.start : source.start + source.duration];
  const candidates = targets
    .flatMap((target) =>
      anchors.map((anchor) => ({
        target,
        delta: target - anchor,
        distance: Math.abs(target - anchor - edit.delta),
      })),
    )
    .filter((c) => c.distance <= snap.threshold)
    .sort((a, b) => a.distance - b.distance || a.target - b.target || a.delta - b.delta);
  for (const candidate of candidates) {
    if (Math.abs(candidate.delta) > 1000000) continue;
    const result = planClipEdit(p, clipId, { ...edit, delta: candidate.delta });
    if (!result.error) return { ...result, snapFrame: candidate.target };
  }
  return { ...raw, snapFrame: undefined as number | undefined };
}
