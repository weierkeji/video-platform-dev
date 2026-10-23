import test from 'node:test';
import assert from 'node:assert/strict';
import { AnimationMixer, LoopOnce, Matrix4, Mesh, SkinnedMesh, Vector3 } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { validateBytes } from 'gltf-validator';
import { skinFixture } from '../scripts/skin-fixture';
import { id, identity, parseProject, type Project } from '../src/core/model';
import { deformGeometry, worldMatrices } from '../src/core/skin';
import { applyCommands } from '../src/core/commands';
import { exportGLB, importGLTF } from '../src/core/gltf';
import { newProject } from '../src/core/factory';
import { bakeAnimation } from '../src/core/bake';

globalThis.ProgressEvent ||= class extends Event {
  lengthComputable = false;
  loaded = 0;
  total = 0;
  constructor(type: string, init: ProgressEventInit = {}) {
    super(type);
    Object.assign(this, init);
  }
} as typeof ProgressEvent;
const near = (a: number[], b: number[], tolerance = 2e-5) =>
  a.forEach((v, i) => assert.ok(Math.abs(v - b[i]) < tolerance, `${a} != ${b}`));

test('linear skinning retains bind pose, ignores mesh TRS and follows ordinary joint ancestors and animation', () => {
  const { p, meshId, sceneId, joint1, child } = skinFixture();
  const e = p.entities.find((e) => e.id === meshId)!,
    g = p.geometries.find((g) => g.id === e.geometryId)!;
  const world = worldMatrices(p, sceneId),
    bound = deformGeometry(g, e.skin!, world);
  g.positions.forEach((v, i) =>
    near(bound.positions[i], new Vector3(...v).applyMatrix4(world.get(meshId)!).toArray()),
  );
  const animated = deformGeometry(g, e.skin!, worldMatrices(p, sceneId, 24));
  assert.notDeepEqual(animated.positions, bound.positions);
  const originalChild = world.get(child)!.toArray();
  e.transform.position = [200, -20, 7];
  e.transform.scale = [0, 0, 0];
  const changed = worldMatrices(p, sceneId, 24);
  assert.deepEqual(deformGeometry(g, e.skin!, changed).positions, animated.positions);
  assert.notDeepEqual(changed.get(child)!.toArray(), originalChild);
  assert.ok(changed.has(joint1));
});

test('skin reference, matrix, influence normalization and per-instance bounds reject invalid projects atomically', () => {
  const { p, meshId, joint1 } = skinFixture();
  const cases: ((p: Project) => void)[] = [
    (p) => p.entities.find((e) => e.id === meshId)!.skin!.joints.push(joint1),
    (p) => (p.entities.find((e) => e.id === meshId)!.skin!.inverseBindMatrices[0][3] = 1),
    (p) => (p.entities.find((e) => e.id === meshId)!.skin!.inverseBindMatrices[0][7] = 1e-9),
    (p) => (p.geometries[0].influences![0] = [{ joint: 2, weight: 1 }]),
    (p) => (p.geometries[0].influences![0] = [{ joint: 0, weight: 0.4 }]),
    (p) => (p.entities.find((e) => e.id === joint1)!.parentId = null),
  ];
  for (const change of cases) {
    const copy = structuredClone(p);
    change(copy);
    assert.throws(() => parseProject(copy));
  }
  const before = structuredClone(p);
  const legacy = structuredClone(p);
  legacy.entities.find((e) => e.id === meshId)!.skin!.inverseBindMatrices[0][15] =
    1 - Number.EPSILON;
  assert.equal(
    parseProject(legacy).entities.find((e) => e.id === meshId)!.skin!.inverseBindMatrices[0][15],
    1,
  );
  assert.equal(
    legacy.entities.find((e) => e.id === meshId)!.skin!.inverseBindMatrices[0][15],
    1 - Number.EPSILON,
  );
  assert.throws(() => applyCommands(p, [{ type: 'entity.delete', id: joint1 }]), /蒙皮引用/);
  assert.deepEqual(p, before);
  const unbound = applyCommands(p, [
    { type: 'skin.unbind', entityId: meshId },
    { type: 'entity.delete', id: joint1 },
  ]).project;
  assert.equal(unbound.entities.find((e) => e.id === meshId)!.skin, undefined);
});

test('weight editing and topology changes retain normalized influences; rebinding isolates shared geometry', () => {
  const { p, meshId, joint0, joint1 } = skinFixture();
  const e = p.entities.find((e) => e.id === meshId)!,
    gid = e.geometryId!;
  const changed = applyCommands(p, [
    {
      type: 'skin.weights',
      entityId: meshId,
      indices: [0, 1],
      weights: [
        { joint: 0, weight: 0.3 },
        { joint: 1, weight: 0.3 },
      ],
    },
  ]).project;
  assert.deepEqual(changed.geometries.find((g) => g.id === gid)!.influences![0], [
    { joint: 0, weight: 0.5 },
    { joint: 1, weight: 0.5 },
  ]);
  for (const command of [
    { type: 'geometry.subdivide', id: gid },
    { type: 'geometry.uvProject', id: gid, channel: 0 },
    { type: 'geometry.extrude', id: gid, face: 0, distance: 0.2 },
    { type: 'geometry.delete', id: gid, mode: 'vertex', indices: [0] },
    { type: 'geometry.merge', id: gid, indices: [0, 1] },
  ]) {
    const next = applyCommands(changed, [command]).project,
      g = next.geometries.find((g) => g.id === gid)!;
    assert.equal(g.influences!.length, g.positions.length);
    g.influences!.forEach((row) => near([row.reduce((s, v) => s + v.weight, 0)], [1]));
  }
  const clone = { ...structuredClone(e), id: id(), name: 'Shared instance' };
  p.entities.push(clone);
  const next = applyCommands(p, [
    { type: 'skin.bind', entityId: clone.id, joints: [joint0, joint1], method: 'first' },
  ]).project;
  assert.notEqual(next.entities.find((e) => e.id === clone.id)!.geometryId, gid);
  assert.deepEqual(
    next.geometries.find((g) => g.id === gid)!.influences,
    p.geometries.find((g) => g.id === gid)!.influences,
  );
});

test('animated and frozen GLB validate, reimport and match independent GLTFLoader vertex deformation', async () => {
  const { p, meshId, sceneId, joint0 } = skinFixture();
  const e = p.entities.find((e) => e.id === meshId)!,
    g = p.geometries.find((g) => g.id === e.geometryId)!;
  p.entities.find((e) => e.id === joint0)!.visible = false;
  const out = exportGLB(p, sceneId, 0, new Map(), true);
  const report = await validateBytes(out.bytes, { uri: 'skin.glb' });
  assert.equal(report.issues.numErrors, 0, JSON.stringify(report.issues));
  assert.equal(report.issues.numWarnings, 0, JSON.stringify(report.issues));
  assert.ok(
    report.issues.messages.every((m) => m.code !== 'UNUSED_OBJECT'),
    JSON.stringify(report.issues),
  );
  const loaded = await new GLTFLoader().parseAsync(Uint8Array.from(out.bytes).buffer, '');
  let skinned: SkinnedMesh | undefined;
  loaded.scene.traverse((o) => {
    if (o instanceof SkinnedMesh) skinned = o;
  });
  assert.ok(skinned);
  const mixer = new AnimationMixer(loaded.scene),
    action = mixer.clipAction(loaded.animations[0]);
  action.setLoop(LoopOnce, 1);
  action.clampWhenFinished = true;
  action.play();
  for (const frame of [0, 6.25, 24, 36.5, 47]) {
    mixer.setTime(frame / 24);
    loaded.scene.updateMatrixWorld(true);
    skinned.skeleton.update();
    const expected = deformGeometry(g, e.skin!, worldMatrices(p, sceneId, frame));
    g.triangles
      .flat()
      .forEach((index, i) =>
        near(
          skinned!.getVertexPosition(i, new Vector3()).applyMatrix4(skinned!.matrixWorld).toArray(),
          expected.positions[index],
          0.001,
        ),
      );
  }
  const imported = await importGLTF(out.bytes);
  const restored = applyCommands(newProject(), [imported.command]).project;
  const body = restored.entities.find((e) => e.skin)!,
    rg = restored.geometries.find((g) => g.id === body.geometryId)!;
  const expected = deformGeometry(g, e.skin!, worldMatrices(p, sceneId, 24));
  const actual = deformGeometry(rg, body.skin!, worldMatrices(restored, body.sceneId, 24));
  g.triangles.flat().forEach((v, i) => near(actual.positions[i], expected.positions[v], 0.001));
  const frozen = exportGLB(p, sceneId, 24);
  const check = await validateBytes(frozen.bytes, { uri: 'frozen.glb' });
  assert.equal(check.issues.numErrors, 0, JSON.stringify(check.issues));
  const frozenGLTF = await new GLTFLoader().parseAsync(Uint8Array.from(frozen.bytes).buffer, '');
  frozenGLTF.scene.updateMatrixWorld(true);
  let posed: Mesh | undefined;
  frozenGLTF.scene.traverse((o) => {
    if (o instanceof Mesh && o.name.includes('当前姿态')) posed = o;
  });
  assert.ok(posed && !(posed instanceof SkinnedMesh));
  g.triangles
    .flat()
    .forEach((v, i) =>
      near(
        posed!.getVertexPosition(i, new Vector3()).applyMatrix4(posed!.matrixWorld).toArray(),
        expected.positions[v],
        0.001,
      ),
    );
});

test('multiple weight sets and absent inverse-bind matrices import without silently truncating influences', async () => {
  const { p, meshId, sceneId, root } = skinFixture();
  const e = p.entities.find((e) => e.id === meshId)!,
    g = p.geometries.find((g) => g.id === e.geometryId)!;
  for (let i = 0; i < 3; i++) {
    const joint = {
      id: id(),
      name: `Extra ${i}`,
      kind: 'group' as const,
      joint: true,
      visible: true,
      sceneId,
      parentId: root,
      transform: identity(),
    };
    p.entities.push(joint);
    e.skin!.joints.push(joint.id);
    e.skin!.inverseBindMatrices.push(new Matrix4().toArray());
  }
  g.influences = g.positions.map(() =>
    Array.from({ length: 5 }, (_, joint) => ({ joint, weight: 0.2 })),
  );
  const out = exportGLB(parseProject(p), sceneId, 0, new Map(), true);
  const imported = await importGLTF(out.bytes);
  assert.ok(imported.command.geometries.some((g) => g.influences?.[0].length === 5));
  const view = new DataView(out.bytes.buffer, out.bytes.byteOffset),
    length = view.getUint32(12, true);
  const json = JSON.parse(new TextDecoder().decode(out.bytes.subarray(20, 20 + length)));
  delete json.skins[0].inverseBindMatrices;
  const bin = out.bytes.subarray(28 + length);
  json.buffers[0].uri = 'skin.bin';
  const absent = await importGLTF(new TextEncoder().encode(JSON.stringify(json)), [
    { name: 'skin.bin', bytes: bin },
  ]);
  assert.deepEqual(
    absent.command.entities.find((e) => e.skin)!.skin!.inverseBindMatrices[0],
    new Matrix4().toArray(),
  );
});

test('layer baking keeps bindings and produces editable joint motion', () => {
  const { p, sceneId, meshId } = skinFixture();
  const baked = bakeAnimation(p, sceneId, {
    start: 0,
    end: 48,
    step: 1,
    rebase: false,
    interpolation: 'linear',
    actionId: null,
  });
  assert.equal(baked.tracks.length, 1);
  const next = applyCommands(p, [
    { type: 'action.bake', action: baked.action, options: baked.options, activate: true },
  ]).project;
  assert.deepEqual(
    next.entities.find((e) => e.id === meshId)!.skin,
    p.entities.find((e) => e.id === meshId)!.skin,
  );
});
