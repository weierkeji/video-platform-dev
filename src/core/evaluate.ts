import { type AnimationTrack, type Entity, type Project, type Vec3 } from './model';

export function sampleTrack(track: AnimationTrack, frame: number): Vec3 | undefined {
  const keys = track.keys;
  if (!keys.length) return;
  if (frame <= keys[0].frame) return [...keys[0].value];
  const last = keys.at(-1)!;
  if (frame >= last.frame) return [...last.value];
  const i = keys.findIndex((k) => k.frame > frame),
    a = keys[i - 1],
    b = keys[i];
  let t = (frame - a.frame) / (b.frame - a.frame);
  if (a.interpolation === 'constant') t = 0;
  else if (a.interpolation === 'smooth') t = t * t * (3 - 2 * t);
  return a.value.map((v, j) => v + (b.value[j] - v) * t) as Vec3;
}
export function evaluatedTransform(p: Project, entity: Entity, frame: number) {
  const t = structuredClone(entity.transform);
  for (const track of p.animationTracks.filter((t) => t.entityId === entity.id)) {
    const value = sampleTrack(track, frame);
    if (value) t[track.property] = value;
  }
  return t;
}
export function activeClips(p: Project, frame: number) {
  return p.timeline.clips
    .filter((c) => !c.muted && frame >= c.start && frame < c.start + c.duration)
    .sort((a, b) => a.channel - b.channel);
}
export function sourceFrame(clip: Project['timeline']['clips'][number], frame: number) {
  return clip.sourceIn + frame - clip.start;
}
