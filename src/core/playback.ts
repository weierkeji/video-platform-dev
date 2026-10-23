import type { Clip, Project, Shot, ShotPlayback } from './model';

/** Keep the unwrapped phase when splitting: wrapping would lose ping-pong direction. */
export function unwrappedSourceFrame(clip: Clip, frame: number) {
  const rate = clip.kind === 'shot' ? (clip.playback?.rate ?? 1) : 1;
  return clip.sourceIn + (frame - clip.start) * rate;
}

export function sourceFrame(clip: Clip, frame: number) {
  const raw = unwrappedSourceFrame(clip, frame);
  if (clip.kind !== 'shot' || !clip.playback) return raw;
  return mapSourceFrame(raw, clip.playback);
}

export function mapSourceFrame(raw: number, playback: ShotPlayback) {
  const { rangeStart: start, rangeEnd: end, mode, rate } = playback;
  if (mode === 'hold') return Math.max(start, Math.min(end, raw));
  const span = end - start;
  const period = mode === 'pingpong' ? 2 * span : span;
  let phase = (((raw - start) % period) + period) % period;
  const tolerance = Math.min(span * 1e-7, Number.EPSILON * Math.max(1, Math.abs(raw), end) * 8);
  if (phase < tolerance || period - phase < tolerance) phase = 0;
  if (mode === 'pingpong') return phase <= span ? start + phase : end - (phase - span);
  // Reverse cycles include their end and exclude their start, so reverse begins at rangeEnd.
  return rate < 0 && phase === 0 ? end : start + phase;
}

export function shotAction(p: Project, shot: Shot, clip?: Clip): string | null {
  const choice = clip?.action ?? shot.action;
  return choice
    ? choice.actionId
    : p.scenes.find((s) => s.id === shot.sceneId)?.activeActionId || null;
}

export function actionRange(p: Project, sceneId: string, actionId: string | null) {
  const entities = new Set(p.entities.filter((e) => e.sceneId === sceneId).map((e) => e.id));
  let start = Infinity,
    end = -Infinity;
  for (const track of p.animationTracks) {
    if (!entities.has(track.entityId) || (track.actionId || null) !== actionId) continue;
    for (const key of track.keys) {
      start = Math.min(start, key.frame);
      end = Math.max(end, key.frame);
    }
  }
  if (!Number.isFinite(start)) return { start: 0, end: 1 };
  // A single key still needs a usable interval; sampling remains constant at its endpoint.
  return end - start >= 1e-6
    ? { start, end }
    : { start: Math.min(start, 1e6 - 1), end: Math.min(1e6, start + 1) };
}
