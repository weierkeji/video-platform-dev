import { type Entity, type Project } from './model';
import { sampleTrack } from './animation';
export { sampleTrack } from './animation';
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
