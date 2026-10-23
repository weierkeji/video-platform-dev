import { Quaternion } from 'three';
import type { AnimationLayer, Entity, Project, Vec3, Vec4 } from './model';
import {
  activeTracks,
  eulerFromQuaternion,
  quaternionFromEuler,
  sampleTrack,
  slerp,
} from './animation';
import { mapSourceFrame } from './playback';

export function layerWeight(layer: AnimationLayer, frame: number) {
  const elapsed = frame - layer.start,
    remaining = layer.duration - elapsed;
  if (!layer.enabled || elapsed < 0 || remaining <= 0) return 0;
  return (
    layer.weight *
    Math.min(
      1,
      layer.fadeIn ? elapsed / layer.fadeIn : 1,
      layer.fadeOut ? remaining / layer.fadeOut : 1,
    )
  );
}
export const layerSourceFrame = (layer: AnimationLayer, frame: number) =>
  mapSourceFrame(layer.sourceIn + (frame - layer.start) * layer.playback.rate, layer.playback);

/** Ordered local-transform stack. Only authored, enabled channels contribute.
 * Additive vectors use rest-pose deltas (including linear scale deltas).
 * Rotation adds a local delta: current * slerp(identity, inverse(rest) * sample, w).
 */
export function applyLayers(p: Project, entity: Entity, frame: number, t: Entity['transform']) {
  for (const layer of p.animationLayers || []) {
    if (layer.entityId !== entity.id) continue;
    const weight = layerWeight(layer, frame);
    if (!weight) continue;
    const source = layerSourceFrame(layer, frame);
    for (const track of activeTracks(p, entity.id, layer.actionId)) {
      const channel = track.property === 'quaternion' ? 'rotation' : track.property;
      if (!layer.channels.includes(channel)) continue;
      const value = sampleTrack(track, source);
      if (!value) continue;
      if (channel === 'rotation') {
        const q =
          track.property === 'quaternion' ? (value as Vec4) : quaternionFromEuler(value as Vec3);
        const current = t.quaternion || quaternionFromEuler(t.rotation);
        if (layer.blend === 'replace') t.quaternion = slerp(current, q, weight);
        else {
          const rest =
            entity.transform.quaternion || quaternionFromEuler(entity.transform.rotation);
          const delta = new Quaternion(...rest)
            .invert()
            .multiply(new Quaternion(...q))
            .normalize()
            .toArray();
          t.quaternion = new Quaternion(...current)
            .multiply(new Quaternion(...slerp([0, 0, 0, 1], delta, weight)))
            .normalize()
            .toArray();
        }
        t.rotation = eulerFromQuaternion(t.quaternion);
      } else {
        t[channel] = t[channel].map((current, i) =>
          layer.blend === 'replace'
            ? current + (value[i] - current) * weight
            : current + (value[i] - entity.transform[channel][i]) * weight,
        ) as Vec3;
      }
    }
  }
  return t;
}
