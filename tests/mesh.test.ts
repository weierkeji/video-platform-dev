import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BufferGeometry,
  Euler,
  Matrix4,
  Mesh,
  PerspectiveCamera,
  Quaternion,
  Ray,
  Vector3,
} from 'three';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { primitive, subdivide } from '../src/core/geometry';
import {
  convertSelection,
  deleteElements,
  extrudeRegion,
  mergeVertices,
  meshEdges,
  selectedVertices,
  transformVertices,
  vertexCenter,
} from '../src/core/mesh';
import { applyCommands } from '../src/core/commands';
import { newProject } from '../src/core/factory';
import { id, migrateProject, PROJECT_VERSION, type Vec3 } from '../src/core/model';
import { MeshTree } from '../src/render/mesh-spatial';
import { MeshOverlay, MeshPicker } from '../src/render/mesh-edit';
import { Store } from '../server/store';

test('component selection converts complete topology and transforms shared vertices once', () => {
  const g = primitive('box'),
    edges = meshEdges(g);
  assert.equal(edges.length, 18);
  const vertices = selectedVertices(g, 'face', [8, 9]);
  assert.deepEqual(vertices, [2, 3, 6, 7]);
  assert.deepEqual(convertSelection(g, 'vertex', 'face', vertices), [8, 9]);
  const faceEdges = convertSelection(g, 'face', 'edge', [8, 9]);
  assert.equal(faceEdges.length, 5);
  assert.deepEqual(convertSelection(g, 'edge', 'face', faceEdges), [8, 9]);
  assert.equal(convertSelection(g, 'edge', 'face', faceEdges.slice(0, 2)).length, 0);
  transformVertices(g, vertices, new Matrix4().makeTranslation(0, 2, 0).toArray());
  vertices.forEach((i) => assert.equal(g.positions[i][1], 3));
  assert.deepEqual(g.positions[0], [-1, -1, -1]);
});
test('world gizmo conversion preserves affine transforms through rotated nonuniform parents', () => {
  const g = primitive('box'),
    indices = [2, 3, 6, 7];
  const parent = new Matrix4().compose(
    new Vector3(3, 2, -4),
    new Quaternion().setFromEuler(new Euler(0.3, 0.5, 0.2)),
    new Vector3(2, 0.7, 3),
  );
  const world = parent.multiply(
    new Matrix4().compose(
      new Vector3(1, 2, 1),
      new Quaternion().setFromEuler(new Euler(0.8, 0.2, -0.5)),
      new Vector3(0.5, 2, 1),
    ),
  );
  const center = new Vector3(...vertexCenter(g, indices)).applyMatrix4(world);
  const delta = new Vector3(1, 2, 3),
    rotation = new Quaternion().setFromEuler(new Euler(0, 0, Math.PI / 2)),
    scale = new Vector3(1.2, 0.8, 1);
  const start = new Matrix4().makeTranslation(...center.toArray());
  const end = new Matrix4().compose(center.clone().add(delta), rotation, scale);
  const local = world
    .clone()
    .invert()
    .multiply(end)
    .multiply(start.clone().invert())
    .multiply(world);
  const expected = indices.map((i) =>
    new Vector3(...g.positions[i])
      .applyMatrix4(world)
      .sub(center)
      .multiply(scale)
      .applyQuaternion(rotation)
      .add(center)
      .add(delta),
  );
  transformVertices(g, indices, local.toArray());
  indices.forEach((i, n) =>
    assert.ok(new Vector3(...g.positions[i]).applyMatrix4(world).distanceTo(expected[n]) < 1e-10),
  );
});
test('region extrusion joins only boundary edges, retains winding and removes unused interior vertices', () => {
  const g = primitive('box');
  extrudeRegion(g, [8, 9], [0, 1, 0]);
  assert.equal(g.positions.length, 12);
  assert.equal(g.triangles.length, 20);
  assert.deepEqual(
    selectedVertices(g, 'face', [8, 9]).map((i) => g.positions[i][1]),
    [2, 2, 2, 2],
  );
  const edges = new Map<string, number[]>();
  for (const t of g.triangles)
    for (let j = 0; j < 3; j++) {
      const a = t[j],
        b = t[(j + 1) % 3],
        key = [a, b].sort((a, b) => a - b).join(':');
      edges.set(key, [...(edges.get(key) || []), a < b ? 1 : -1]);
    }
  for (const directions of edges.values()) assert.deepEqual([...directions].sort(), [-1, 1]);
  const plane = primitive('plane');
  subdivide(plane);
  const faces = plane.triangles.map((_, i) => i);
  extrudeRegion(plane, faces, [0, 0.5, 0]);
  assert.equal(plane.positions.length, 17);
  assert.equal(plane.triangles.length, 24);
  assert.equal(new Set(plane.triangles.flat()).size, 17);
  assert.throws(
    () =>
      extrudeRegion(
        primitive('box'),
        Array.from({ length: 12 }, (_, i) => i),
        [0, 1, 0],
      ),
    /没有边界/,
  );
  const nonmanifold = primitive('plane');
  nonmanifold.triangles.push([...nonmanifold.triangles[0]]);
  assert.throws(() => extrudeRegion(nonmanifold, [0, 1], [0, 1, 0]), /非流形/);
  const degenerate = primitive('plane');
  degenerate.positions[1] = [...degenerate.positions[0]];
  assert.throws(() => extrudeRegion(degenerate, [0], [0, 1, 0]), /退化/);
});
test('component deletion and welding keep valid indices including empty geometry', () => {
  const g = primitive('box');
  mergeVertices(g, [2, 3, 6, 7]);
  assert.equal(g.positions.length, 5);
  assert.equal(g.triangles.length, 6);
  assert.ok(g.triangles.every((t) => t.every((i) => i < 5) && new Set(t).size === 3));
  deleteElements(g, 'face', [0]);
  assert.equal(g.positions.length, 5);
  assert.equal(g.triangles.length, 5);
  deleteElements(g, 'edge', [0]);
  assert.ok(g.triangles.length < 5);
  deleteElements(
    g,
    'vertex',
    g.positions.map((_, i) => i),
  );
  assert.deepEqual(g.positions, []);
  assert.deepEqual(g.triangles, []);
  const p = newProject(),
    before = JSON.stringify(p),
    geometry = p.geometries[0];
  assert.throws(
    () =>
      applyCommands(p, [
        { type: 'project.rename', name: 'rollback' },
        {
          type: 'geometry.transform',
          id: geometry.id,
          indices: [0, 0],
          matrix: new Matrix4().toArray(),
        },
      ]),
    /重复/,
  );
  const matrix = new Matrix4().toArray();
  matrix[3] = 1;
  assert.throws(
    () => applyCommands(p, [{ type: 'geometry.transform', id: geometry.id, indices: [0], matrix }]),
    /仿射/,
  );
  assert.equal(JSON.stringify(p), before);
});
test('triangle bounds match brute-force rays, transformed objects and empty meshes', () => {
  const g = primitive('sphere'),
    tree = new MeshTree(g);
  const world = new Matrix4().compose(
    new Vector3(2, -1, 4),
    new Quaternion().setFromEuler(new Euler(0.2, 0.4, 0.8)),
    new Vector3(2, 0.6, 1.3),
  );
  for (let i = 0; i < 80; i++) {
    const angle = i * 0.37,
      localOrigin = new Vector3(
        Math.cos(angle) * 4,
        Math.sin(angle * 0.3) * 3,
        Math.sin(angle) * 4,
      );
    const origin = localOrigin.clone().applyMatrix4(world),
      target = new Vector3(i % 4 === 0 ? 3 : 0, 0, 0).applyMatrix4(world);
    const ray = new Ray(origin, target.sub(origin).normalize()),
      hit = tree.intersect(ray, world);
    let nearest = Infinity;
    for (const t of g.triangles) {
      const points = t.map((v) => new Vector3(...g.positions[v]).applyMatrix4(world));
      const point = ray.intersectTriangle(points[0], points[1], points[2], false, new Vector3());
      if (point) nearest = Math.min(nearest, point.distanceTo(origin));
    }
    assert.equal(!!hit, Number.isFinite(nearest));
    if (hit) assert.ok(Math.abs(hit.distance - nearest) < 1e-8);
  }
  assert.equal(
    new MeshTree({ id: id(), name: 'empty', positions: [], triangles: [] }).intersect(
      new Ray(),
      new Matrix4(),
    ),
    null,
  );
});
test('v4 migration retains key identities and empty mesh edits survive restart, undo and redo', () => {
  const root = resolve(tmpdir()),
    directory = mkdtempSync(join(root, 'frameforge-mesh-'));
  let store = new Store(directory);
  try {
    let p = newProject();
    p = applyCommands(p, [
      {
        type: 'key.set',
        entityId: p.entities[0].id,
        property: 'position',
        key: { frame: 0, value: [0, 1, 0] },
      },
    ]).project;
    const old = { ...p, schemaVersion: 4 };
    assert.deepEqual(migrateProject(old).animationTracks, p.animationTracks);
    assert.equal(migrateProject(old).schemaVersion, PROJECT_VERSION);
    const g = p.geometries[0];
    store.create(p);
    store.change(
      p.id,
      0,
      [
        {
          type: 'geometry.delete',
          id: g.id,
          mode: 'vertex',
          indices: g.positions.map((_, i) => i),
        },
      ],
      'user',
      'empty mesh',
    );
    store.close();
    store = new Store(directory);
    assert.deepEqual(store.get(p.id).project.geometries[0].positions, []);
    assert.equal(store.get(p.id).project.entities.length, p.entities.length);
    assert.deepEqual(
      store.change(p.id, 1, undefined, 'user', 'undo', 'undo').project.geometries[0],
      g,
    );
    assert.deepEqual(
      store.change(p.id, 2, undefined, 'user', 'redo', 'redo').project.geometries[0].triangles,
      [],
    );
  } finally {
    store.close();
    assert.ok(resolve(directory).startsWith(root + sep));
    rmSync(directory, { recursive: true, force: true });
  }
});

test('component picking respects near/far clipping and hidden objects', () => {
  const p = newProject(),
    g = p.geometries[0],
    mesh = new Mesh(new BufferGeometry());
  mesh.userData.entityId = p.entities[0].id;
  const camera = new PerspectiveCamera(45, 1, 1, 10);
  camera.updateMatrixWorld(true);
  const picker = new MeshPicker(p, {
    objects: new Map([[p.entities[0].id, mesh]]),
  });
  const overlay = new MeshOverlay(
    g,
    mesh,
    { entityId: p.entities[0].id, geometryId: g.id, mode: 'face', indices: [] },
    false,
  );
  const rect = { width: 400, height: 400 } as DOMRect;
  try {
    mesh.position.z = -1.5;
    mesh.updateMatrixWorld(true);
    assert.ok(
      [0, 1].includes(picker.select(overlay, camera, rect, [200, 200])[0]),
      'near-clipped front must not hide the visible back surface',
    );
    mesh.position.z = -20;
    mesh.updateMatrixWorld(true);
    assert.deepEqual(picker.select(overlay, camera, rect, [200, 200]), []);
    mesh.position.z = -4;
    mesh.visible = false;
    mesh.updateMatrixWorld(true);
    assert.deepEqual(picker.select(overlay, camera, rect, [200, 200]), []);
  } finally {
    overlay.dispose();
    mesh.geometry.dispose();
  }
});
