import { retargetFixture } from './retarget-fixture';
import { applyCommands } from '../src/core/commands';
import { id, type Vec3 } from '../src/core/model';
import type { ReduceOptions } from '../src/core/reduce-curves';

/** Original dense skeletal performance with an exactly linear Hermite camera move. */
export function reduceFixture() {
  const f = retargetFixture(),
    sourceActionId = id();
  const p = applyCommands(f.p, [
    { type: 'retarget.put', profile: f.profile },
    {
      type: 'retarget.bake',
      profileId: f.profile.id,
      action: { id: sourceActionId, sceneId: f.target.sceneId, name: 'Dense target motion' },
      options: { ...f.options, step: 0.25 },
      activate: true,
    },
  ]).project;
  p.name = '误差约束动作精简';
  const camera = p.entities.find((e) => e.sceneId === f.target.sceneId && e.kind === 'camera')!,
    derivative: Vec3 = [0.006, 0.002, 0];
  p.animationTracks.push({
    id: id(),
    entityId: camera.id,
    actionId: sourceActionId,
    property: 'position',
    keys: Array.from({ length: 13 }, (_, i) => ({
      id: id(),
      frame: i * 4,
      value: camera.transform.position.map((v, axis) => v + derivative[axis] * i * 4) as Vec3,
      interpolation: 'cubic',
      inTangent: [...derivative],
      outTangent: [...derivative],
    })),
  });
  const options: ReduceOptions = {
    actionId: sourceActionId,
    start: 0,
    end: 48,
    position: 0.001,
    rotationDegrees: 0.1,
    scale: 0.001,
    influence: 0.001,
  };
  return { ...f, p, sourceActionId, options, sceneId: f.target.sceneId, cameraId: camera.id };
}
