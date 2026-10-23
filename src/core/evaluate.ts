import { type Entity, type Project, type Vec3, type Vec4 } from './model';
import { sampleTrack, activeTracks, eulerFromQuaternion } from './animation';
import { applyLayers } from './layers';
export { sampleTrack } from './animation';
export { sourceFrame } from './playback';
export function evaluatedBaseTransform(
  p: Project,
  entity: Entity,
  frame: number,
  actionId?: string | null,
) {
  const t = structuredClone(entity.transform);
  if (t.quaternion) t.rotation = eulerFromQuaternion(t.quaternion);
  for (const track of activeTracks(p, entity.id, actionId)) {
    const value = sampleTrack(track, frame);
    if (value) {
      if (track.property === 'quaternion') {
        t.quaternion = value as Vec4;
        t.rotation = eulerFromQuaternion(t.quaternion);
      } else {
        t[track.property] = value as Vec3;
        if (track.property === 'rotation') delete t.quaternion;
      }
    }
  }
  return t;
}
export function evaluatedTransform(
  p: Project,
  entity: Entity,
  frame: number,
  actionId?: string | null,
  layers = true,
) {
  const t = evaluatedBaseTransform(p, entity, frame, actionId);
  return layers ? applyLayers(p, entity, frame, t) : t;
}
export function activeClips(p: Project, frame: number) {
  return p.timeline.clips
    .filter((c) => !c.muted && frame >= c.start && frame < c.start + c.duration)
    .sort((a, b) => a.channel - b.channel);
}
