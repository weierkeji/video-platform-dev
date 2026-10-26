import { skinFixture } from './skin-fixture';
import { newProject } from '../src/core/factory';
import { id, identity, parseProject, type Entity, type Vec3 } from '../src/core/model';

export function parentingFixture() {
  const f = skinFixture(),
    p = f.p;
  p.name = '保持世界姿态的层级整理';
  const parent = (name: string): Entity => ({
    id: id(),
    sceneId: f.sceneId,
    name,
    kind: 'group',
    parentId: null,
    visible: true,
    transform: identity(),
  });
  const old = parent('原装配组'),
    next = parent('非均匀缩放组');
  old.transform = { position: [0.3, 0.1, 0], rotation: [0, 0.2, 0.08], scale: [1.05, 1.05, 1.05] };
  next.transform = {
    position: [-0.6, 0.4, 0.1],
    rotation: [0.1, -0.45, 0.2],
    scale: [1.5, 0.8, 1.1],
  };
  for (const e of p.entities) if ([f.root, f.meshId].includes(e.id)) e.parentId = old.id;
  p.entities.push(old, next);
  const fresh = newProject(),
    cube = fresh.entities.find((e) => e.kind === 'mesh')!;
  cube.sceneId = f.sceneId;
  cube.parentId = old.id;
  cube.name = '可编辑方块';
  cube.transform = { ...identity(), position: [1.8, 0.7, 0], scale: [0.45, 0.45, 0.45] };
  p.entities.push(cube);
  p.geometries.push(fresh.geometries.find((g) => g.id === cube.geometryId)!);
  const material = fresh.materials.find((m) => m.id === cube.materialId)!;
  material.color = '#6cb4ea';
  p.materials.push(material);
  p.animationTracks.push({
    id: id(),
    entityId: cube.id,
    property: 'position',
    keys: [0, 24, 48].map((frame, i) => ({
      id: id(),
      frame,
      interpolation: 'cubic',
      value: [1.8 + i * 0.1, 0.7 + (i === 1 ? 0.4 : 0), 0] as Vec3,
      inTangent: [0.01, 0.02, 0],
      outTangent: [0.01, 0.02, 0],
    })),
  });
  return {
    ...f,
    p: parseProject(p),
    oldParent: old.id,
    newParent: next.id,
    cubeId: cube.id,
    selected: [f.root, f.meshId, cube.id],
  };
}
