import { skinFixture } from './skin-fixture';
import { id, identity, parseProject, type Entity, type Constraint } from '../src/core/model';
import { primitive } from '../src/core/geometry';

export function constraintsFixture() {
  const fixture = skinFixture(),
    p = fixture.p,
    sceneId = fixture.sceneId;
  p.name = '目标驱动的雕塑与摄影机';
  p.scenes[0].name = 'Target study';
  // The original skin's inverse binds still preserve its original rest shape.
  // Uniform controller ancestry permits an exact local TRS animation bake.
  p.entities.find((e) => e.id === fixture.root)!.transform.scale = [1, 1, 1];
  const geometry = primitive('sphere'),
    material = { id: id(), name: '青色目标', color: '#65cbd2', roughness: 0.35, metalness: 0.2 };
  p.geometries.push(geometry);
  p.materials.push(material);
  const control: Entity = {
    id: id(),
    name: 'Target orbit',
    kind: 'mesh',
    sceneId,
    parentId: null,
    visible: true,
    geometryId: geometry.id,
    materialId: material.id,
    transform: { ...identity(), position: [1.5, 3, 0], scale: [0.16, 0.16, 0.16] },
  };
  const focus: Entity = {
    id: id(),
    name: 'Camera focus',
    kind: 'group',
    sceneId,
    parentId: null,
    visible: true,
    transform: { ...identity(), position: [0, 1.2, 0] },
    constraints: [
      {
        id: id(),
        name: '跟随目标位置',
        type: 'copy-position',
        targetId: control.id,
        enabled: true,
        influence: 0.25,
        targetSpace: 'world',
        ownerSpace: 'world',
      },
    ],
  };
  const aim = (
    name: string,
    targetId: string,
    trackAxis: 'y' | '-z',
    upAxis: 'y' | 'z',
    worldUp: [number, number, number],
  ): Constraint => ({
    id: id(),
    name,
    type: 'aim',
    targetId,
    trackAxis,
    upAxis,
    worldUp,
    enabled: true,
    influence: 1,
  });
  p.entities.find((e) => e.id === fixture.joint1)!.constraints = [
    aim('关节朝向目标', control.id, 'y', 'z', [0, 0, 1]),
  ];
  const camera = p.entities.find((e) => e.kind === 'camera')!;
  camera.name = 'Tracking camera';
  camera.constraints = [aim('摄影机跟随焦点', focus.id, '-z', 'y', [0, 1, 0])];
  p.entities.push(control, focus);
  p.animationTracks = [
    {
      id: id(),
      entityId: control.id,
      property: 'position',
      keys: [
        { id: id(), frame: 0, value: [1.5, 3, 0], interpolation: 'linear' },
        { id: id(), frame: 24, value: [-1.5, 2.5, 0.6], interpolation: 'linear' },
        { id: id(), frame: 48, value: [0.9, 3.2, -0.5], interpolation: 'linear' },
      ],
    },
  ];
  return {
    ...fixture,
    p: parseProject(p),
    targetId: control.id,
    focusId: focus.id,
    cameraId: camera.id,
  };
}
