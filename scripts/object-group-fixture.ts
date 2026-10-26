import { newProject } from '../src/core/factory';
import { id, identity, parseProject, type Entity, type Vec3 } from '../src/core/model';
import { quaternionFromEuler } from '../src/core/animation';

export function objectGroupFixture() {
  const p = newProject();
  p.name = '共同枢轴与层级编辑';
  p.timeline.duration = 48;
  p.timeline.width = 480;
  p.timeline.height = 270;
  p.timeline.fps = 24;
  p.timeline.clips[0].duration = 48;
  const sceneId = p.scenes[0].id,
    a = p.entities.find((e) => e.kind === 'mesh')!;
  const group = (name: string): Entity => ({
    id: id(),
    sceneId,
    name,
    kind: 'group',
    parentId: null,
    visible: true,
    transform: identity(),
  });
  const left = group('左装配组'),
    right = group('右装配组'),
    destination = group('新装配组');
  left.transform.rotation[1] = 0.2;
  left.transform.scale = [1.1, 1.1, 1.1];
  right.transform.rotation[1] = -0.3;
  right.transform.scale = [0.9, 0.9, 0.9];
  destination.transform = {
    position: [0.2, -0.1, 0.4],
    rotation: [0.1, 0.2, -0.1],
    scale: [1.2, 0.8, 1.1],
  };
  a.name = '左侧方块';
  a.parentId = left.id;
  a.transform = { position: [-1.4, 1, 0], rotation: [0, 0, 0], scale: [0.5, 0.5, 0.5] };
  const b = structuredClone(a);
  b.id = id();
  b.name = '右侧方块';
  b.parentId = right.id;
  b.transform.position = [1.8, 1.1, 0];
  const material = structuredClone(p.materials.find((m) => m.id === a.materialId)!);
  material.id = id();
  material.color = '#73b9e8';
  material.name = '蓝色材质';
  b.materialId = material.id;
  p.materials.push(material);
  const child = structuredClone(b);
  child.id = id();
  child.name = '嵌套方块';
  child.parentId = a.id;
  child.transform = { ...identity(), position: [0, 2.4, 0], scale: [0.5, 0.5, 0.5] };
  p.entities.push(left, right, destination, b, child);
  p.animationTracks = [
    {
      id: id(),
      entityId: a.id,
      property: 'position',
      keys: [0, 24, 48].map((frame, i) => ({
        id: id(),
        frame,
        value: [-1.4 + i * 0.1, 1 + (i === 1 ? 0.2 : 0), 0] as Vec3,
        interpolation: 'cubic',
        inTangent: [0.005, 0, 0],
        outTangent: [0.005, 0, 0],
      })),
    },
    {
      id: id(),
      entityId: b.id,
      property: 'quaternion',
      keys: [0, 24, 48].map((frame, i) => ({
        id: id(),
        frame,
        value: quaternionFromEuler([0, i * 0.3, 0]),
        interpolation: 'linear',
      })),
    },
  ];
  return {
    p: parseProject(p),
    sceneId,
    a: a.id,
    b: b.id,
    child: child.id,
    left: left.id,
    right: right.id,
    destination: destination.id,
    ids: [a.id, child.id, b.id],
  };
}
