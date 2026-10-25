import { ikFixture } from './ik-fixture';
import { id, parseProject, type IKTrack } from '../src/core/model';

/** Original control-strength transition, with an independently retimed scalar layer. */
export function ikAnimationFixture() {
  const f = ikFixture(),
    p = f.p;
  p.name = 'IK 控制过渡';
  p.scenes[0].name = 'IK transition';
  p.ikChains![0].influence = 0;
  const track = (
    property: IKTrack['property'],
    values: [number, number][],
    actionId?: string,
  ): IKTrack => ({
    id: id(),
    entityId: f.rootJointId,
    chainId: f.chainId,
    property,
    actionId,
    keys: values.map(([frame, v]) => ({ id: id(), frame, value: [v], interpolation: 'smooth' })),
  });
  const action = { id: id(), sceneId: f.sceneId, name: '极向转动叠层' };
  p.animationActions = [...(p.animationActions || []), action];
  p.ikTracks = [
    track('influence', [
      [0, 0],
      [12, 0.8],
      [24, 1],
      [48, 0],
    ]),
    track('poleAngle', [
      [0, -Math.PI / 6],
      [24, Math.PI / 3],
      [48, Math.PI * 1.1],
    ]),
    track(
      'poleAngle',
      [
        [0, -Math.PI / 4],
        [48, Math.PI * 2],
      ],
      action.id,
    ),
  ];
  p.animationLayers = [
    {
      id: id(),
      name: '极向加转',
      entityId: f.rootJointId,
      actionId: action.id,
      enabled: true,
      blend: 'additive',
      weight: 0.25,
      channels: ['ik'],
      start: 8,
      duration: 28,
      sourceIn: 48,
      playback: { rate: -2, rangeStart: 0, rangeEnd: 48, mode: 'pingpong' },
      fadeIn: 4,
      fadeOut: 4,
    },
  ];
  return { ...f, p: parseProject(p), parameterActionId: action.id };
}
