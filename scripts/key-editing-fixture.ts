import { newProject } from '../src/core/factory';
import { id, parseProject, type AnimationTrack, type Vec3 } from '../src/core/model';
import { quaternionFromEuler } from '../src/core/animation';

/** Original editable three-channel motion, also used for actual product integration. */
export function keyEditingFixture() {
  const p = newProject();
  p.name = '多键时间编排';
  const mesh = p.entities.find((e) => e.kind === 'mesh')!;
  const camera = p.entities.find((e) => e.kind === 'camera')!;
  mesh.name = '节奏方块';
  camera.transform.position = [0, 0, 10];
  camera.transform.rotation = [0, 0, 0];
  p.scenes[0].background = '#142033';
  p.scenes[0].ambient = 1;
  p.materials.find((m) => m.id === mesh.materialId)!.color = '#ed9f35';
  p.timeline.duration = 72;
  p.timeline.width = 480;
  p.timeline.height = 270;
  p.timeline.fps = 24;
  p.timeline.clips[0].duration = 72;
  const values: Vec3[] = [
    [-2, 0, 0],
    [-0.8, 0.8, 0],
    [0.8, -0.3, 0],
    [2, 0, 0],
  ];
  p.animationTracks = (['position', 'quaternion', 'scale'] as const).map(
    (property) =>
      ({
        id: id(),
        entityId: mesh.id,
        property,
        keys: [0, 6, 12, 18].map((frame, i) => ({
          id: id(),
          frame,
          value:
            property === 'position'
              ? values[i]
              : property === 'quaternion'
                ? quaternionFromEuler([i * 0.2, i * 0.6, i * 0.1])
                : ([0.65 + i * 0.1, 0.85 - i * 0.05, 0.7] as Vec3),
          interpolation: property === 'position' ? 'cubic' : 'linear',
          ...(property === 'position'
            ? { inTangent: [0.12, 0.04, 0] as Vec3, outTangent: [0.12, 0.04, 0] as Vec3 }
            : {}),
        })),
      }) satisfies AnimationTrack,
  );
  return { p: parseProject(p), entityId: mesh.id, sceneId: mesh.sceneId, cameraId: camera.id };
}
