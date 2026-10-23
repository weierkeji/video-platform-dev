import { skinFixture } from './skin-fixture';
import { id, identity, parseProject, type Entity } from '../src/core/model';
import { applyCommands } from '../src/core/commands';
import { primitive } from '../src/core/geometry';

/** Original two-segment sculpture with animated controls and an ordinary follower. */
export function ikFixture() {
  const fixture = skinFixture();
  let p = fixture.p;
  p.name = '双段 IK 雕塑';
  p.scenes[0].name = 'IK reach';
  const root = p.entities.find((e) => e.id === fixture.joint0)!,
    elbow = p.entities.find((e) => e.id === fixture.joint1)!;
  const spacer = elbow.parentId;
  root.name = 'Arm root';
  elbow.name = 'Arm elbow';
  elbow.parentId = root.id;
  elbow.transform.position = [0, 1.2, 0];
  p.entities = p.entities.filter((e) => e.id !== spacer);
  p.entities.find((e) => e.id === fixture.root)!.transform.scale = [1, 1, 1];
  const tip: Entity = {
    id: id(),
    name: 'Arm tip',
    kind: 'group',
    joint: true,
    sceneId: fixture.sceneId,
    parentId: elbow.id,
    visible: true,
    transform: { ...identity(), position: [0, 1.2, 0] },
  };
  p.entities.push(tip);
  p.animationTracks = [];
  p = applyCommands(p, [{ type: 'ik.create', rootId: root.id, tipId: tip.id, frame: 0 }]).project;
  const chain = p.ikChains![0];
  chain.name = 'Sculpture reach';
  p.entities.find((e) => e.id === chain.targetId)!.name = 'Hand target';
  const pole = p.entities.find((e) => e.id === chain.poleId)!;
  pole.name = 'Elbow pole';
  pole.transform.position = [0, 0.6, 3];
  const geometry = primitive('sphere'),
    material = { id: id(), name: '腕部青色', color: '#65cbd2', roughness: 0.4, metalness: 0.1 };
  p.geometries.push(geometry);
  p.materials.push(material);
  p.entities.push({
    id: id(),
    name: 'Wrist',
    kind: 'mesh',
    sceneId: fixture.sceneId,
    parentId: tip.id,
    visible: true,
    geometryId: geometry.id,
    materialId: material.id,
    transform: { ...identity(), scale: [0.13, 0.13, 0.13] },
  });
  const follower: Entity = {
    id: id(),
    name: 'Tip follower',
    kind: 'group',
    sceneId: fixture.sceneId,
    parentId: null,
    visible: true,
    transform: identity(),
    constraints: [
      {
        id: id(),
        name: '跟随末端',
        type: 'copy-position',
        targetId: tip.id,
        enabled: true,
        influence: 1,
        targetSpace: 'world',
        ownerSpace: 'world',
      },
    ],
  };
  p.entities.push(follower);
  const camera = p.entities.find((e) => e.kind === 'camera')!;
  camera.name = 'IK camera';
  camera.constraints = [
    {
      id: id(),
      name: '看向末端',
      type: 'aim',
      targetId: follower.id,
      enabled: true,
      influence: 1,
      trackAxis: '-z',
      upAxis: 'y',
      worldUp: [0, 1, 0],
    },
  ];
  p.animationTracks = [
    {
      id: id(),
      entityId: chain.targetId,
      property: 'position',
      keys: [
        { id: id(), frame: 0, value: [0.8, 1.7, 0.2], interpolation: 'linear' },
        { id: id(), frame: 24, value: [-1.7, 1.4, 0.6], interpolation: 'linear' },
        { id: id(), frame: 48, value: [0.3, 1.9, -0.4], interpolation: 'linear' },
      ],
    },
  ];
  return {
    ...fixture,
    p: parseProject(p),
    chainId: chain.id,
    targetId: chain.targetId,
    poleId: chain.poleId!,
    tipId: tip.id,
    rootJointId: root.id,
    elbowId: elbow.id,
    followerId: follower.id,
    cameraId: camera.id,
  };
}
