import { newProject } from '../src/core/factory';
import { id, identity, parseProject, type Entity, type Geometry } from '../src/core/model';
import { bindSkin } from '../src/core/skin';

/** Original segmented sculpture, rig and motion. No downloaded model or animation. */
export function skinFixture() {
  const p = newProject(),
    sceneId = p.scenes[0].id;
  p.name = '关节与蒙皮';
  p.scenes[0].name = 'Skin sculpture';
  p.timeline.duration = 48;
  p.timeline.width = 480;
  p.timeline.height = 270;
  p.timeline.clips[0].duration = 48;
  const mesh = p.entities.find((e) => e.kind === 'mesh')!;
  mesh.name = 'Flexible column';
  mesh.transform = identity();
  const root: Entity = {
    id: id(),
    name: 'Rig space',
    sceneId,
    parentId: null,
    kind: 'group',
    visible: true,
    transform: {
      ...identity(),
      position: [-0.7, 0, 0],
      rotation: [0, 0.15, 0],
      scale: [1.1, 1, 0.9],
    },
  };
  const joint0: Entity = {
    id: id(),
    name: 'Base joint',
    sceneId,
    parentId: root.id,
    kind: 'group',
    joint: true,
    visible: true,
    transform: identity(),
  };
  const spacer: Entity = {
    id: id(),
    name: 'Ordinary spacer',
    sceneId,
    parentId: joint0.id,
    kind: 'group',
    visible: true,
    transform: { ...identity(), position: [0, 1.2, 0] },
  };
  const joint1: Entity = {
    id: id(),
    name: 'Tip joint',
    sceneId,
    parentId: spacer.id,
    kind: 'group',
    joint: true,
    visible: true,
    transform: identity(),
  };
  p.entities.push(root, joint0, spacer, joint1);
  mesh.parentId = root.id;
  mesh.transform.position = [0.25, 0.1, 0];
  const g: Geometry = {
    id: mesh.geometryId!,
    name: 'Segmented column',
    positions: [],
    triangles: [],
  };
  for (let row = 0; row <= 8; row++) {
    const y = row * 0.3;
    for (const [x, z] of [
      [-0.3, -0.22],
      [0.3, -0.22],
      [0.3, 0.22],
      [-0.3, 0.22],
    ])
      g.positions.push([x, y, z]);
    if (row)
      for (let side = 0; side < 4; side++) {
        const a = (row - 1) * 4 + side,
          b = (row - 1) * 4 + ((side + 1) % 4);
        g.triangles.push([a, b + 4, b], [a, a + 4, b + 4]);
      }
  }
  g.triangles.push([0, 1, 2], [0, 2, 3], [32, 34, 33], [32, 35, 34]);
  p.geometries = p.geometries.map((old) => (old.id === g.id ? g : old));
  const m = p.materials.find((m) => m.id === mesh.materialId)!;
  m.color = '#dc7b42';
  m.flatShading = true;
  mesh.skin = bindSkin(p, mesh, [joint0.id, joint1.id], 'nearest');
  mesh.skin.skeletonId = root.id;
  g.influences = g.positions.map(([, y]) => {
    const w = Math.min(1, Math.max(0, (y - 0.45) / 1.4));
    return [
      { joint: 0, weight: 1 - w },
      { joint: 1, weight: w },
    ].filter((v) => v.weight > 0);
  });
  // Node TRS must still affect ordinary children, but must not re-transform skinned vertices.
  const child: Entity = {
    id: id(),
    name: 'Node attachment',
    sceneId,
    parentId: mesh.id,
    kind: 'group',
    visible: true,
    transform: { ...identity(), position: [0.2, 0.3, 0] },
  };
  p.entities.push(child);
  p.animationTracks = [
    {
      id: id(),
      entityId: joint1.id,
      property: 'rotation',
      keys: [
        { id: id(), frame: 0, value: [0, 0, 0], interpolation: 'linear' },
        { id: id(), frame: 24, value: [0.2, 0, -0.8], interpolation: 'linear' },
        { id: id(), frame: 48, value: [0, 0, 0.3], interpolation: 'linear' },
      ],
    },
  ];
  return {
    p: parseProject(p),
    meshId: mesh.id,
    joint0: joint0.id,
    joint1: joint1.id,
    root: root.id,
    child: child.id,
    sceneId,
  };
}
