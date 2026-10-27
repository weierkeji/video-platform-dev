import { ikFixture } from './ik-fixture';
import { id, identity, parseProject, type Entity } from '../src/core/model';

/** Original assembled sculpture: an animated rig, controls and ordinary attachments. */
export function hierarchyCopyFixture() {
  const f = ikFixture(),
    p = f.p;
  p.name = '装配副本与独立控制';
  p.scenes[0].name = '装配场景';
  const assembly: Entity = {
    id: id(),
    name: '完整装配',
    sceneId: f.sceneId,
    kind: 'group',
    parentId: null,
    visible: true,
    transform: identity(),
  };
  p.entities.push(assembly);
  for (const key of [f.root, f.targetId, f.poleId, f.followerId])
    p.entities.find((e) => e.id === key)!.parentId = assembly.id;
  const base = id(),
    layerAction = id();
  p.animationActions = [
    { id: base, sceneId: f.sceneId, name: '基础控制' },
    { id: layerAction, sceneId: f.sceneId, name: '极向补充' },
  ];
  p.scenes[0].activeActionId = base;
  p.animationTracks.forEach((t) => (t.actionId = base));
  p.animationTracks.push({
    id: id(),
    entityId: f.poleId,
    actionId: layerAction,
    property: 'position',
    keys: [0, 24, 48].map((frame, i) => ({
      id: id(),
      frame,
      value: [0.2 * i, 0.6, 3],
      interpolation: 'cubic' as const,
      inTangent: [0.005, 0, 0],
      outTangent: [0.005, 0, 0],
    })),
  });
  p.ikTracks = [
    {
      id: id(),
      entityId: f.rootJointId,
      chainId: f.chainId,
      actionId: base,
      property: 'influence',
      keys: [0, 24, 48].map((frame, i) => ({
        id: id(),
        frame,
        value: [i === 1 ? 0.7 : 1],
        interpolation: 'linear',
      })),
    },
  ];
  p.animationLayers = [
    {
      id: id(),
      name: '极向补充层',
      entityId: f.poleId,
      actionId: layerAction,
      enabled: true,
      blend: 'replace',
      weight: 0.4,
      channels: ['position'],
      start: 0,
      duration: 48,
      sourceIn: 0,
      playback: { rate: 1, rangeStart: 0, rangeEnd: 48, mode: 'hold' },
      fadeIn: 4,
      fadeOut: 4,
    },
  ];
  // Two ordinary attachments share one source mesh/material inside the assembly.
  const wrist = p.entities.find((e) => e.name === 'Wrist')!;
  const twin = { ...structuredClone(wrist), id: id(), name: '侧面附件' };
  twin.transform.position = [0.35, 0, 0];
  p.entities.push(twin);
  // Keep a fixed camera framing both the original assembly and its moved copy.
  const camera = p.entities.find((e) => e.id === f.cameraId)!;
  camera.constraints = [];
  camera.transform.position = [6, 4.3, 9];
  camera.transform.rotation = [-Math.atan2(3.2, 9), Math.atan2(5.3, Math.hypot(3.2, 9)), 0];
  return {
    ...f,
    p: parseProject(p),
    assemblyId: assembly.id,
    wristId: wrist.id,
    twinId: twin.id,
    baseActionId: base,
    layerActionId: layerAction,
  };
}
