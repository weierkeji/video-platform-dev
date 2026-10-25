import type { IKChain, Project } from './model';
import { sampleCurve } from './animation';
import { layerSourceFrame, layerWeight } from './layers';

export function activeIKTracks(p: Project, entityId: string, actionId?: string | null) {
  const entity = p.entities.find((e) => e.id === entityId);
  const action =
    (actionId === undefined
      ? p.scenes.find((s) => s.id === entity?.sceneId)?.activeActionId
      : actionId) || undefined;
  return (p.ikTracks || []).filter((t) => t.entityId === entityId && t.actionId === action);
}

/** Scalar layers use the chain's saved parameter as the additive reference. */
export function evaluatedIK(
  p: Project,
  chain: IKChain,
  frame: number,
  actionId?: string | null,
  layers = true,
): IKChain {
  const result = { ...chain };
  for (const t of activeIKTracks(p, chain.joints[0], actionId)) {
    if (t.chainId !== chain.id) continue;
    const value = sampleCurve(t, frame)?.[0];
    if (value !== undefined) result[t.property] = value;
  }
  if (layers)
    for (const layer of p.animationLayers || []) {
      if (layer.entityId !== chain.joints[0] || !layer.channels.includes('ik')) continue;
      const weight = layerWeight(layer, frame);
      if (!weight) continue;
      for (const t of activeIKTracks(p, layer.entityId, layer.actionId)) {
        if (t.chainId !== chain.id) continue;
        const value = sampleCurve(t, layerSourceFrame(layer, frame))?.[0];
        if (value === undefined) continue;
        result[t.property] +=
          weight * (value - (layer.blend === 'replace' ? result[t.property] : chain[t.property]));
      }
    }
  result.influence = Math.max(0, Math.min(1, result.influence));
  return result;
}
