import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { tessellatePolygon } from '../src/core/polygon';
import { exportOBJ, importOBJ, parseOBJ } from '../src/core/obj';
import { newProject } from '../src/core/factory';
import { applyCommands } from '../src/core/commands';
import { parseProject, type Vec3 } from '../src/core/model';
import { Store } from '../server/store';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import type { Mesh } from 'three';

const boundary = [
  [0, 0],
  [3, 0],
  [3, 1],
  [1, 1],
  [1, 2],
  [3, 2],
  [3, 3],
  [0, 3],
];
const points = boundary.map(([x, y]) => [x, y, 0] as Vec3);
const cross = (a: number[], b: number[], c: number[]) =>
  (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
const source = (p: Vec3[]) => p.map((v) => `v ${v.join(' ')}`).join('\n') + '\n';
const near = (a: number[], b: number[]) =>
  a.forEach((v, i) => assert.ok(Math.abs(v - b[i]) < 1e-10));

test('concave rings retain area, boundary, winding and empty notch in every dominant projection', () => {
  for (const scale of [1e-6, 1, 1e6])
    for (const axis of [0, 1, 2])
      for (const reverse of [false, true]) {
        const p = points.map(([x, y]) => {
          const value = [x * scale + 17, y * scale - 2, 9];
          return [value[axis], value[(axis + 1) % 3], value[(axis + 2) % 3]] as Vec3;
        });
        for (let offset = 0; offset < p.length; offset++) {
          const ring = p.map((_, i) => (i + offset) % p.length);
          if (reverse) ring.reverse();
          const result = tessellatePolygon(p, ring),
            edges = new Map<string, number>();
          assert.equal(result.triangles.length, 6);
          let area = 0;
          for (const triangle of result.triangles) {
            const [a, b, c] = triangle.map((i) => boundary[i]);
            const signed = cross(a, b, c) / 2;
            assert.ok(reverse ? signed < 0 : signed > 0);
            area += signed;
            triangle.forEach((v, i) => {
              const key = [v, triangle[(i + 1) % 3]].sort((a, b) => a - b).join(':');
              edges.set(key, (edges.get(key) || 0) + 1);
            });
          }
          assert.equal(area, reverse ? -7 : 7);
          for (let i = 0; i < p.length; i++)
            assert.equal(edges.get([i, (i + 1) % p.length].sort((a, b) => a - b).join(':')), 1);
          for (let x = 0.13; x < 3; x += 0.31)
            for (let y = 0.17; y < 3; y += 0.29) {
              const inside = result.triangles.some((t) => {
                const [a, b, c] = t.map((i) => boundary[i]),
                  signs = [cross(a, b, [x, y]), cross(b, c, [x, y]), cross(c, a, [x, y])];
                return signs.every((n) => n >= 0) || signs.every((n) => n <= 0);
              });
              assert.equal(inside, !(x > 1 && y > 1 && y < 2), `notch ${x},${y}`);
            }
        }
      }
});

test('collinear boundary vertices are retained without degenerate triangles', () => {
  const p: Vec3[] = [
    [0, 0, 0],
    [1, 0, 0],
    [2, 0, 0],
    [2, 1, 0],
    [0, 1, 0],
  ];
  const { triangles } = tessellatePolygon(p, [0, 1, 2, 3, 4]);
  assert.equal(triangles.length, 3);
  assert.equal(new Set(triangles.flat()).size, 5);
  assert.ok(triangles.every((t) => cross(...(t.map((i) => p[i]) as [Vec3, Vec3, Vec3])) > 0));
});

test('invalid rings reject self intersection, overlap, repeated vertices, nonplanarity and excess work', () => {
  assert.throws(() => tessellatePolygon(points, [0, 1, 2, 3, 0]), /重复/);
  assert.throws(
    () =>
      tessellatePolygon(
        [
          [0, 0, 0],
          [1, 1, 0],
          [0, 1, 0],
          [1, 0, 0],
        ],
        [0, 1, 2, 3],
      ),
    /自交/,
  );
  assert.throws(
    () =>
      tessellatePolygon(
        [
          [0, 0, 0],
          [3, 0, 0],
          [0, 2, 0],
          [3, 3, 0],
          [1, 1, 0],
        ],
        [0, 1, 2, 3, 4],
      ),
    /自交|重叠/,
  );
  assert.throws(
    () =>
      tessellatePolygon(
        [
          [0, 0, 0],
          [1, 0, 0],
          [1, 1, 1],
          [0, 1, 0],
        ],
        [0, 1, 2, 3],
      ),
    /平面/,
  );
  assert.throws(
    () =>
      tessellatePolygon(
        [
          [0, 0, 0],
          [1, 0, 0],
          [2, 0, 0],
        ],
        [0, 1, 2],
      ),
    /退化/,
  );
  assert.throws(
    () =>
      tessellatePolygon(
        points,
        points.map((_, i) => i),
        { remaining: 1 },
      ),
    /预算/,
  );
  assert.throws(
    () =>
      tessellatePolygon(
        points,
        Array.from({ length: 1025 }, (_, i) => i),
      ),
    /1024/,
  );
});

test('OBJ concave import uses independent negative position/UV/normal indices and continuation lines', () => {
  const text =
    source(points) +
    boundary.map(([x, y]) => `vt ${x / 3} ${y / 3}`).join('\n') +
    '\nvn 0 0 7\n' +
    'f -8/-8/-1 -7/-7/-1 -6/-6/-1 -5/-5/-1 \\\n -4/-4/-1 -3/-3/-1 -2/-2/-1 -1/-1/-1 # concave\n';
  const result = parseOBJ(text),
    g = result.geometry;
  assert.equal(result.polygons, 1);
  assert.equal(result.splitVertices, 0);
  assert.deepEqual(g.positions, points);
  assert.deepEqual(
    g.uv,
    boundary.map(([x, y]) => [x / 3, 1 - y / 3]),
  );
  assert.ok(g.normals!.every((n) => n[0] === 0 && n[1] === 0 && n[2] === 1));
  assert.equal(g.triangles.length, 6);
  const roundtrip = importOBJ(exportOBJ(g));
  assert.deepEqual(roundtrip.positions, g.positions);
  assert.deepEqual(roundtrip.triangles, g.triangles);
  assert.deepEqual(roundtrip.uv, g.uv);
  assert.deepEqual(roundtrip.normals, g.normals);
});

const cornerSource = 'v 0 0 0\nv 1 0 0\nv 0 1 0\nv 0 0 1\nvt 0 0\nvt 1 0\nvt 0 1\nvt .5 .5\n';
test('independent OBJLoader reads exported UV orientation, positions and normals at every triangle corner', () => {
  const g = importOBJ(cornerSource + 'vn 0 1 2\nf 1/1/1 2/2/1 3/3/1\nf 1/4/1 4/3/1 2/2/1\n');
  const loaded = new OBJLoader().parse(exportOBJ(g));
  const mesh = loaded.children[0] as Mesh;
  try {
    const position = mesh.geometry.getAttribute('position'),
      uv = mesh.geometry.getAttribute('uv'),
      normal = mesh.geometry.getAttribute('normal');
    g.triangles.flat().forEach((v, corner) => {
      for (let axis = 0; axis < 3; axis++) {
        assert.ok(Math.abs(position.getComponent(corner, axis) - g.positions[v][axis]) < 1e-6);
        assert.ok(Math.abs(normal.getComponent(corner, axis) - g.normals![v][axis]) < 1e-6);
      }
      assert.ok(Math.abs(uv.getX(corner) - g.uv![v][0]) < 1e-6);
      assert.ok(Math.abs(uv.getY(corner) - (1 - g.uv![v][1])) < 1e-6);
    });
    assert.equal(g.uv![0][1], 1); // source vt 0 0, at the image's bottom-left
  } finally {
    mesh.geometry.dispose();
    for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) m.dispose();
  }
});
test('UV seams split vertices but smoothing groups preserve the same area-weighted normal across the seam', () => {
  const g = importOBJ(cornerSource + 's 3\nf 1/1 2/2 3/3\nf 1/4 4/3 2/2\n');
  assert.equal(g.positions.length, 5);
  assert.deepEqual(g.positions[4], g.positions[0]);
  assert.deepEqual(g.uv![0], [0, 1]);
  assert.deepEqual(g.uv![4], [0.5, 0.5]);
  near(g.normals![0], [0, Math.SQRT1_2, Math.SQRT1_2]);
  near(g.normals![4], g.normals![0]);
  near(g.normals![1], g.normals![0]);
  near(g.normals![2], [0, 0, 1]);
  near(g.normals![3], [0, 1, 0]);
  const r = importOBJ(exportOBJ(g));
  assert.deepEqual(r.positions, g.positions);
  assert.deepEqual(r.uv, g.uv);
  r.normals!.forEach((n, i) => near(n, g.normals![i]));
});

test('default and separate smoothing domains produce hard edges; explicit normals override them', () => {
  const hard = importOBJ(cornerSource + 'f 1 2 3\nf 1 4 2\n');
  assert.equal(hard.positions.length, 6);
  near(hard.normals![0], [0, 0, 1]);
  near(hard.normals![4], [0, 1, 0]);
  const groups = importOBJ(cornerSource + 's 1\nf 1 2 3\ns 2\nf 1 4 2\n');
  assert.deepEqual(groups.positions, hard.positions);
  assert.deepEqual(groups.normals, hard.normals);
  const explicit = importOBJ(
    cornerSource + 'vn 0 1 1\ns off\nf 1//1 2//1 3//1\nf 1//1 4//1 2//1\n',
  );
  assert.equal(explicit.positions.length, 4);
  explicit.normals!.forEach((n) => near(n, [0, Math.SQRT1_2, Math.SQRT1_2]));
});

test('OBJ missing UVs and unsupported metadata are visible and unreferenced vertices survive', () => {
  const r = parseOBJ(
    cornerSource +
      'v 9 9 9\nmtllib local.mtl\nusemtl material\no sculpture\ng parts\ns 1\nf 1/1 2/2 3/3\nf 1 4 2\n',
  );
  assert.equal(r.geometry.name, 'sculpture');
  assert.deepEqual(r.geometry.positions[4], [9, 9, 9]);
  assert.deepEqual(r.geometry.uv![4], [0, 0]);
  assert.ok(r.warnings.some((w) => w.includes('MTL')));
  assert.ok(r.warnings.some((w) => w.includes('部分面')));
  assert.ok(r.warnings.some((w) => w.includes('未引用')));
  assert.equal(r.geometry.uv!.length, r.geometry.positions.length);
  assert.equal(r.geometry.normals!.length, r.geometry.positions.length);
  const p = newProject();
  parseProject(
    applyCommands(p, [{ type: 'geometry.import', sceneId: p.scenes[0].id, geometry: r.geometry }])
      .project,
  );
});

test('OBJ rejects invalid attributes and indices with line numbers before any command is applied', () => {
  const prefix = 'v 0 0 0\nv 1 0 0\nv 0 1 0\nvt 0 0\nvn 0 0 1\n';
  for (const line of [
    'f 0 2 3',
    'f 1 2 4',
    'f -4 -2 -1',
    'f 1.0 2 3',
    'f 1/0 2/1 3/1',
    'f 1//0 2//1 3//1',
    'f 1/1 2 3',
    'f 1//1 2//1 3',
    'f 1/ 2/ 3/',
    'f 1/1/1/1 2 3',
    'v NaN 1 2',
    'v Infinity 1 2',
    'v 0x10 1 2',
    'v 0 0 0 2',
    'vt 1 1 1',
    'vn 0 0 0',
    'l 1 2',
    'curv 1 2',
    's -1',
  ])
    assert.throws(() => parseOBJ(prefix + line), /OBJ 第 6 行/);
  assert.throws(() => parseOBJ(''), /没有顶点/);
  assert.throws(() => parseOBJ('v 1 2 3 \\'), /续行/);
  assert.throws(() => parseOBJ('v 0 0 0\n'.repeat(100001)), /10 万/);
});

test('OBJ references are resolved where each face occurs; authored normals and seam data persist through SQLite history', () => {
  const g = importOBJ('v 0 0 0\nv 1 0 0\nv 0 1 0\nf -3 -2 -1\nv 0 0 1\nf -4 -1 -3\n');
  assert.deepEqual(g.triangles[0], [0, 1, 2]);
  assert.deepEqual(
    g.triangles[1].map((i) => g.positions[i]),
    [
      [0, 0, 0],
      [0, 0, 1],
      [1, 0, 0],
    ],
  );
  const root = resolve(tmpdir()),
    directory = mkdtempSync(join(root, 'frameforge-obj-'));
  let store = new Store(directory);
  try {
    const p = newProject();
    store.create(p);
    const result = store.change(
      p.id,
      0,
      [{ type: 'geometry.import', sceneId: p.scenes[0].id, geometry: g }],
      'user',
      'OBJ',
    ).project;
    const entity = result.entities.find((e) => e.geometryId === g.id)!;
    assert.equal(result.materials.find((m) => m.id === entity.materialId)!.flatShading, false);
    store.close();
    store = new Store(directory);
    assert.deepEqual(
      store.get(p.id).project.geometries.find((x) => x.id === g.id),
      g,
    );
    const undone = store.change(p.id, 1, undefined, 'user', 'undo', 'undo').project;
    assert.deepEqual(undone.geometries, p.geometries);
    assert.deepEqual(undone.materials, p.materials);
    const redone = store.change(p.id, 2, undefined, 'user', 'redo', 'redo').project;
    assert.deepEqual(redone.geometries, result.geometries);
    assert.deepEqual(redone.entities, result.entities);
  } finally {
    store.close();
    assert.ok(resolve(directory).startsWith(root + sep));
    rmSync(directory, { recursive: true, force: true });
  }
});
