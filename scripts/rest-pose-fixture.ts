import { skinFixture } from './skin-fixture';
import { applyCommands } from '../src/core/commands';
import { id } from '../src/core/model';

/** The existing sculpture is re-articulated without replacing its mesh or authored motion. */
export function restPoseFixture() {
  const f = skinFixture(),
    p = f.p;
  p.name = '基础姿态与绑定外形';
  p.scenes[0].name = 'Rest editing';
  const joint = p.entities.find((e) => e.id === f.joint1)!,
    spacer = p.entities.find((e) => e.id === joint.parentId)!;
  const camera = p.entities.find((e) => e.kind === 'camera')!;
  camera.constraints = [
    {
      id: id(),
      name: '观察关节',
      type: 'aim',
      targetId: f.joint1,
      enabled: true,
      influence: 0.35,
      trackAxis: '-z',
      upAxis: 'y',
      worldUp: [0, 1, 0],
    },
  ];
  const next = applyCommands(p, [
    {
      type: 'rig.rest.update',
      preserveShape: true,
      updates: [
        { entityId: spacer.id, transform: { ...spacer.transform, position: [0.2, 1.45, -0.1] } },
        { entityId: joint.id, transform: { ...joint.transform, rotation: [0.15, -0.25, 0.3] } },
      ],
    },
  ]).project;
  return { ...f, p: next, spacerId: spacer.id, cameraId: camera.id };
}
