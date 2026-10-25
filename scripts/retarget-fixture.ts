import { ikMatchFixture } from './ik-match-fixture';
import { skinFixture } from './skin-fixture';
import { id, identity, parseProject, type Entity, type RetargetProfile } from '../src/core/model';
import { bindSkin } from '../src/core/skin';
import { applyCommands } from '../src/core/commands';
import type { BakeOptions } from '../src/core/bake';

/** Original source rig and a taller target with different rest axes and an extra parent. */
export function retargetFixture() {
  const source = ikMatchFixture(),
    target = skinFixture();
  const p = source.p,
    t = target.p;
  p.name = '不同骨架的动作转移';
  p.scenes[0].name = 'Source gesture';
  t.scenes[0].name = 'Target performance';
  const sourceActionId = id(),
    targetActionId = id();
  p.animationActions = [
    { id: sourceActionId, sceneId: source.sceneId, name: 'Source FK IK gesture' },
  ];
  p.animationTracks.forEach((track) => {
    track.actionId = sourceActionId;
  });
  p.ikTracks?.forEach((track) => {
    track.actionId = sourceActionId;
  });
  p.scenes[0].activeActionId = sourceActionId;
  t.animationActions = [
    { id: targetActionId, sceneId: target.sceneId, name: 'Original target action' },
  ];
  t.animationTracks.forEach((track) => {
    track.actionId = targetActionId;
  });
  t.scenes[0].activeActionId = targetActionId;
  const root = t.entities.find((e) => e.id === target.joint0)!,
    tip = t.entities.find((e) => e.id === target.joint1)!,
    spacer = t.entities.find((e) => e.id === tip.parentId)!,
    space = t.entities.find((e) => e.id === target.root)!;
  space.transform = { ...identity(), position: [0, -0.3, 0], rotation: [0, -0.2, 0] };
  root.name = 'Pelvis B';
  root.transform.rotation = [0.1, 0.2, -0.1];
  spacer.name = 'Shoulder B';
  spacer.transform.position = [0, 1.35, 0];
  spacer.transform.rotation = [0.12, -0.3, 0.08];
  tip.name = 'Wrist B';
  tip.transform.position = [0, 0.9, 0];
  tip.transform.rotation = [-0.2, 0.1, 0.2];
  const extra: Entity = {
    id: id(),
    name: 'Unmapped spacer B',
    sceneId: target.sceneId,
    parentId: root.id,
    kind: 'group' as const,
    visible: true,
    transform: { ...identity(), position: [0, 0.25, 0], rotation: [0, 0.1, 0] },
  };
  spacer.parentId = extra.id;
  t.entities.push(extra);
  const mesh = t.entities.find((e) => e.id === target.meshId)!,
    geometry = t.geometries.find((g) => g.id === mesh.geometryId)!;
  mesh.name = 'Target flexible sculpture';
  geometry.positions = geometry.positions.map(([x, y, z]) => [x * 1.25, y * 1.45, z * 1.2]);
  mesh.skin = bindSkin(t, mesh, [root.id, spacer.id, tip.id], 'nearest');
  mesh.skin.skeletonId = target.root;
  geometry.influences = geometry.positions.map(([, y]) => {
    const a = Math.min(1, Math.max(0, y / 1.75)),
      b = Math.min(1, Math.max(0, (y - 1.75) / 1.6));
    return [
      { joint: 0, weight: (1 - a) * (1 - b) },
      { joint: 1, weight: a * (1 - b) },
      { joint: 2, weight: b },
    ].filter((v) => v.weight > 0);
  });
  t.materials.find((m) => m.id === mesh.materialId)!.color = '#5dc4b9';
  t.entities.find((e) => e.kind === 'camera')!.transform.position = [5.8, 3.5, 7.5];
  t.entities.find((e) => e.kind === 'camera')!.transform.rotation = [
    -Math.atan2(1.9, 7.5),
    Math.atan2(5.8, Math.hypot(1.9, 7.5)),
    0,
  ];
  p.scenes.push(...t.scenes);
  p.entities.push(...t.entities);
  p.geometries.push(...t.geometries);
  p.materials.push(...t.materials);
  p.animationActions.push(...t.animationActions);
  p.animationTracks.push(...t.animationTracks);
  p.shots.push(...t.shots);
  p.timeline.clips[0].sourceId = t.shots[0].id;
  // The source root has explicit locomotion in addition to IK/FK switching.
  let result = applyCommands(
    p,
    [0, 24, 48].map((frame) => ({
      type: 'key.set' as const,
      entityId: source.rootJointId,
      property: 'position' as const,
      key: {
        frame,
        value: [frame / 72, 0, 0] as [number, number, number],
        interpolation: 'linear' as const,
      },
    })),
  ).project;
  result = applyCommands(result, [
    {
      type: 'rig.rest.update',
      preserveShape: true,
      updates: [
        { entityId: tip.id, transform: { ...tip.transform, rotation: [-0.12, 0.2, 0.25] } },
      ],
    },
  ]).project;
  const profile: RetargetProfile = {
    id: id(),
    name: 'Sculpture A to B',
    sourceRootId: source.rootJointId,
    targetRootId: root.id,
    mappings: [
      { sourceId: source.rootJointId, targetId: root.id },
      { sourceId: source.elbowId, targetId: spacer.id },
      { sourceId: source.tipId, targetId: tip.id },
    ],
    rootMotion: 'scaled',
    motionScale: 1.4,
    alignment: [0, 0, 0, 1],
  };
  const options: BakeOptions = {
    start: 0,
    end: 48,
    step: 0.5,
    actionId: sourceActionId,
    rebase: false,
    interpolation: 'linear',
  };
  return {
    p: parseProject(result),
    source,
    target,
    profile,
    options,
    sourceActionId,
    targetActionId,
    spacerId: spacer.id,
    extraId: extra.id,
  };
}
