import { ikAnimationFixture } from './ik-animation-fixture';
import { id, parseProject, type Vec3 } from '../src/core/model';
import type { BakeOptions } from '../src/core/bake';

/** Original IK sculpture, retimed parameter layer, follower and moving aim camera. */
export function adaptiveFixture() {
  const f = ikAnimationFixture(),
    p = f.p;
  p.name = '自适应姿态烘焙';
  p.scenes[0].name = 'Adaptive performance';
  const camera = p.entities.find((e) => e.kind === 'camera')!;
  p.animationTracks.push({
    id: id(),
    entityId: camera.id,
    property: 'position',
    keys: [0, 24, 48].map((frame, i) => ({
      id: id(),
      frame,
      value: camera.transform.position.map(
        (v, axis) => v + (axis === 0 ? [0, 0.5, 0][i] : 0),
      ) as Vec3,
      interpolation: 'cubic',
      inTangent: [0, 0, 0] as Vec3,
      outTangent: [0, 0, 0] as Vec3,
    })),
  });
  const options: BakeOptions = {
    start: 0,
    end: 48,
    step: 8,
    actionId: null,
    interpolation: 'linear',
    rebase: false,
    adaptive: { position: 0.001, rotationDegrees: 0.1, scale: 0.001, minStep: 0.001 },
  };
  return { ...f, p: parseProject(p), cameraId: camera.id, options };
}
