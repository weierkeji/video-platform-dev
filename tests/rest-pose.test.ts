import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { AnimationMixer, LoopOnce, Matrix4, SkinnedMesh, Vector3 } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { validateBytes } from 'gltf-validator';
import {
  id,
  identity,
  migrateProject,
  parseProject,
  PROJECT_VERSION,
  type Project,
} from '../src/core/model';
import { applyCommands } from '../src/core/commands';
import { restProject, restWorld, rigNodes } from '../src/core/rest-pose';
import { sceneEvaluator, transformMatrix } from '../src/core/constraints';
import { deformGeometry } from '../src/core/skin';
import { evaluatedTransform } from '../src/core/evaluate';
import { bakedProject } from '../src/core/bake';
import { exportGLB } from '../src/core/gltf';
import { Store } from '../server/store';
import { skinFixture } from '../scripts/skin-fixture';
import { ikAnimationFixture } from '../scripts/ik-animation-fixture';
import { restPoseFixture } from '../scripts/rest-pose-fixture';
globalThis.ProgressEvent ||= class extends Event {
  lengthComputable = false;
  loaded = 0;
  total = 0;
} as typeof ProgressEvent;
const near = (a: number[], b: number[], epsilon = 1e-8) =>
  a.forEach((v, i) => assert.ok(Math.abs(v - b[i]) < epsilon, `${v} != ${b[i]}`));
function shape(p: Project, meshId: string, frame?: number) {
  const mesh = p.entities.find((e) => e.id === meshId)!,
    g = p.geometries.find((g) => g.id === mesh.geometryId)!;
  return deformGeometry(
    g,
    mesh.skin!,
    frame === undefined ? restWorld(p, mesh.sceneId) : sceneEvaluator(p, mesh.sceneId)(frame).world,
  );
}

test('rest edits compensate all affected skins under reflected nonuniform ancestors without touching shared geometry or weights', () => {
  const f = skinFixture(),
    p = f.p,
    root = p.entities.find((e) => e.id === f.root)!;
  root.transform.scale = [-1.4, 0.8, 1.2];
  const mesh = p.entities.find((e) => e.id === f.meshId)!,
    other = structuredClone(mesh);
  other.id = id();
  other.name = 'shared';
  other.skin!.inverseBindMatrices = other.skin!.inverseBindMatrices.map((m) =>
    new Matrix4()
      .fromArray(m)
      .multiply(new Matrix4().makeTranslation(0.3, 0, 0))
      .toArray(),
  );
  p.entities.push(other);
  const g = p.geometries.find((g) => g.id === mesh.geometryId)!;
  g.normals = g.positions.map(() => [0, 1, 0]);
  g.tangents = g.positions.map(() => [1, 0, 0, 1]);
  const before = [shape(p, mesh.id), shape(p, other.id)],
    data = structuredClone(p.geometries);
  const joint = p.entities.find((e) => e.id === f.joint1)!;
  const next = applyCommands(parseProject(p), [
    {
      type: 'rig.rest.update',
      preserveShape: true,
      updates: [
        {
          entityId: root.id,
          transform: { ...root.transform, rotation: [0.1, -0.2, 0.4], position: [2, 0, 1] },
        },
        {
          entityId: joint.id,
          transform: {
            ...joint.transform,
            position: [0.3, 0.2, 0],
            rotation: [0.2, 0.3, -0.4],
            scale: [1.1, 0.9, 1.2],
          },
        },
      ],
    },
  ]).project;
  [mesh.id, other.id].forEach((id, n) => {
    const after = shape(next, id);
    after.positions.forEach((v, i) => near(v, before[n].positions[i]));
    after.normals!.forEach((v, i) => near(v, before[n].normals![i]));
    after.tangents!.forEach((v, i) => near(v, before[n].tangents![i]));
  });
  assert.deepEqual(next.geometries, data);
  assert.deepEqual(next.animationTracks, p.animationTracks);
  assert.equal(next.entities.find((e) => e.id === other.id)!.geometryId, mesh.geometryId);
  assert.notDeepEqual(next.entities.find((e) => e.id === mesh.id)!.skin, mesh.skin);
  assert.ok(rigNodes(next, f.sceneId).has(root.id));
});

test('fixed channel reference preserves curves while applying a new local basis before constraints and IK', () => {
  const { p, joint1, sceneId } = skinFixture(),
    e = p.entities.find((e) => e.id === joint1)!;
  e.transform.rotation = [0.15, -0.2, 0.1];
  const original = structuredClone(p),
    R = {
      ...identity(),
      position: [0.1, 0.3, -0.2] as [number, number, number],
      rotation: [0.4, 0.2, -0.3] as [number, number, number],
    };
  let next = applyCommands(p, [
    { type: 'rig.rest.update', updates: [{ entityId: e.id, transform: R }], preserveShape: true },
  ]).project;
  const delta = transformMatrix(R).multiply(transformMatrix(e.transform).invert());
  for (const frame of [0, 6.25, 24, 47]) {
    const expected = delta
      .clone()
      .multiply(transformMatrix(evaluatedTransform(original, e, frame)));
    near(sceneEvaluator(next, sceneId)(frame).local.get(e.id)!.elements, expected.elements);
  }
  next = applyCommands(next, [
    {
      type: 'rig.rest.update',
      updates: [{ entityId: e.id, transform: { ...R, position: [0.2, 0.4, 0.1] } }],
      preserveShape: true,
    },
  ]).project;
  assert.deepEqual(next.entities.find((n) => n.id === e.id)!.restPose!.reference, e.transform);
  assert.deepEqual(next.animationTracks, original.animationTracks);
  const ik = ikAnimationFixture(),
    root = ik.p.entities.find((e) => e.id === ik.rootJointId)!;
  const rig = applyCommands(ik.p, [
    {
      type: 'rig.rest.update',
      updates: [{ entityId: root.id, transform: { ...root.transform, rotation: [0, 0, 0.15] } }],
      preserveShape: true,
    },
  ]).project;
  const pose = sceneEvaluator(rig, ik.sceneId)(24);
  assert.ok(pose.ik[0].appliedResidual < 1e-5);
  near(
    pose.world.get(ik.tipId)!.elements.slice(12, 15),
    pose.world.get(ik.followerId)!.elements.slice(12, 15),
  );
});

test('uncompensated edits deform the base mesh and compensated reset removes the offset without reshaping that result', () => {
  const f = skinFixture(),
    e = f.p.entities.find((e) => e.id === f.joint1)!;
  const before = shape(f.p, f.meshId);
  const changed = applyCommands(f.p, [
    {
      type: 'rig.rest.update',
      preserveShape: false,
      updates: [{ entityId: e.id, transform: { ...e.transform, rotation: [0, 0, 0.5] } }],
    },
  ]).project;
  assert.notDeepEqual(shape(changed, f.meshId).positions, before.positions);
  assert.deepEqual(
    changed.entities.find((n) => n.id === f.meshId)!.skin,
    f.p.entities.find((n) => n.id === f.meshId)!.skin,
  );
  const reset = applyCommands(changed, [
    { type: 'rig.rest.reset', entityIds: [e.id], preserveShape: true },
  ]).project;
  assert.equal(reset.entities.find((n) => n.id === e.id)!.restPose, undefined);
  shape(reset, f.meshId).positions.forEach((v, i) =>
    near(v, shape(changed, f.meshId).positions[i]),
  );
});

test('capture uses final local pose, leaves animation authored, and rejects singular edits, duplicates and unrepresentable shear atomically', () => {
  const f = skinFixture(),
    original = structuredClone(f.p);
  const captured = sceneEvaluator(f.p, f.sceneId)(24).local.get(f.joint1)!;
  const next = applyCommands(f.p, [
    { type: 'rig.rest.capture', entityIds: [f.joint1], frame: 24, preserveShape: false },
  ]).project;
  near(
    transformMatrix(next.entities.find((e) => e.id === f.joint1)!.restPose!.transform).elements,
    captured.elements,
  );
  assert.deepEqual(next.animationTracks, original.animationTracks);
  assert.notDeepEqual(
    sceneEvaluator(next, f.sceneId)(24).local.get(f.joint1)!.elements,
    captured.elements,
  );
  for (const ids of [[f.joint1, f.joint1], [f.p.entities.find((e) => e.kind === 'camera')!.id]])
    assert.throws(() =>
      applyCommands(f.p, [
        { type: 'rig.rest.capture', entityIds: ids, frame: 0, preserveShape: true },
      ]),
    );
  assert.throws(
    () =>
      applyCommands(f.p, [
        {
          type: 'rig.rest.update',
          preserveShape: true,
          updates: [{ entityId: f.joint1, transform: { ...identity(), scale: [0, 1, 1] } }],
        },
      ]),
    /不可逆/,
  );
  assert.deepEqual(f.p, original);
  const shear = applyCommands(f.p, [
    {
      type: 'rig.rest.update',
      preserveShape: true,
      updates: [{ entityId: f.joint1, transform: { ...identity(), scale: [2, 1, 1] } }],
    },
  ]).project;
  assert.throws(
    () =>
      applyCommands(shear, [
        { type: 'rig.rest.capture', entityIds: [f.joint1], frame: 24, preserveShape: true },
      ]),
    /剪切/,
  );
  assert.throws(
    () =>
      bakedProject(shear, f.sceneId, {
        start: 0,
        end: 48,
        step: 1,
        actionId: null,
        rebase: false,
        interpolation: 'linear',
      }),
    /剪切/,
  );
});

test('new binding uses the isolated rest basis and excludes animated targets, constraints and IK', () => {
  const f = ikAnimationFixture();
  const root = f.p.entities.find((e) => e.id === f.rootJointId)!;
  root.constraints = [
    {
      id: id(),
      type: 'copy-position',
      name: 'base shift',
      targetId: f.targetId,
      enabled: true,
      influence: 0.1,
      ownerSpace: 'world',
      targetSpace: 'world',
    },
  ];
  const changed = applyCommands(f.p, [
    {
      type: 'rig.rest.update',
      preserveShape: false,
      updates: [{ entityId: root.id, transform: { ...root.transform, rotation: [0, 0.2, 0.3] } }],
    },
    {
      type: 'skin.bind',
      entityId: f.meshId,
      joints: [f.rootJointId, f.elbowId],
      method: 'nearest',
    },
  ]).project;
  const mesh = changed.entities.find((e) => e.id === f.meshId)!,
    g = changed.geometries.find((g) => g.id === mesh.geometryId)!,
    world = restWorld(changed, f.sceneId);
  shape(changed, mesh.id).positions.forEach((v, i) =>
    near(v, new Vector3(...g.positions[i]).applyMatrix4(world.get(mesh.id)!).toArray()),
  );
  assert.equal(sceneEvaluator(restProject(changed), f.sceneId)(24).ik.length, 0);
});

test('rest basis, compensation, source channels and bake activation persist across restart, undo and redo', () => {
  const parent = resolve(tmpdir()),
    directory = mkdtempSync(join(parent, 'frameforge-rest-'));
  let store = new Store(directory);
  try {
    const f = skinFixture(),
      p = store.create(f.p).project;
    const result = store.change(
      p.id,
      p.revision,
      [
        {
          type: 'rig.rest.update',
          updates: [
            { entityId: f.joint1, transform: { ...identity(), rotation: [0.2, 0.1, -0.3] } },
          ],
          preserveShape: true,
        },
      ],
      'user',
      'rest edit',
    ).project;
    store.close();
    store = new Store(directory);
    assert.deepEqual(store.get(p.id).project.entities, result.entities);
    const undo = store.change(p.id, result.revision, undefined, 'user', 'undo', 'undo').project;
    assert.deepEqual(undo.entities, p.entities);
    const redo = store.change(p.id, undo.revision, undefined, 'user', 'redo', 'redo').project;
    assert.deepEqual(redo.entities, result.entities);
    const baked = applyCommands(redo, [
      {
        type: 'action.bake',
        action: { id: id(), sceneId: f.sceneId, name: 'new rest bake' },
        activate: true,
        options: {
          start: 0,
          end: 48,
          step: 0.5,
          actionId: null,
          rebase: false,
          interpolation: 'linear',
        },
      },
    ]).project;
    assert.equal(baked.entities.find((e) => e.id === f.joint1)!.restPose!.enabled, false);
    near(
      sceneEvaluator(baked, f.sceneId)(24).world.get(f.joint1)!.elements,
      sceneEvaluator(redo, f.sceneId)(24).world.get(f.joint1)!.elements,
      1e-6,
    );
    const legacy = { ...p, schemaVersion: 15 };
    assert.deepEqual(migrateProject(legacy), { ...legacy, schemaVersion: PROJECT_VERSION });
  } finally {
    store.close();
    assert.ok(resolve(directory).startsWith(parent + sep));
    rmSync(directory, { recursive: true, force: true });
  }
});

test('independent glTF skin and camera evaluation matches edited rest bases and compensated inverse bindings', async () => {
  const f = restPoseFixture(),
    { p, sceneId } = f;
  assert.throws(
    () =>
      exportGLB(
        { ...p, entities: p.entities.map((e) => ({ ...e, constraints: undefined })) },
        sceneId,
        0,
        new Map(),
        true,
      ),
    /基础姿态/,
  );
  const out = exportGLB(p, sceneId, 0, new Map(), true, {
    start: 0,
    end: 48,
    step: 0.25,
    actionId: null,
    rebase: false,
    interpolation: 'linear',
  });
  const report = await validateBytes(out.bytes);
  assert.equal(report.issues.numErrors, 0);
  assert.equal(report.issues.numWarnings, 0);
  const loaded = await new GLTFLoader().parseAsync(Uint8Array.from(out.bytes).buffer, '');
  const mixer = new AnimationMixer(loaded.scene),
    action = mixer.clipAction(loaded.animations[0]);
  action.setLoop(LoopOnce, 1);
  action.clampWhenFinished = true;
  action.play();
  let skin: SkinnedMesh | undefined;
  loaded.scene.traverse((o) => {
    if (o instanceof SkinnedMesh) skin = o;
  });
  assert.ok(skin);
  const mesh = p.entities.find((e) => e.id === f.meshId)!,
    g = p.geometries.find((g) => g.id === mesh.geometryId)!;
  for (const frame of [0, 6.25, 12, 24, 36.5, 47]) {
    mixer.setTime(frame / 24);
    loaded.scene.updateMatrixWorld(true);
    skin.skeleton.update();
    const pose = sceneEvaluator(p, sceneId)(frame),
      expected = shape(p, mesh.id, frame);
    near(loaded.cameras[0].matrixWorld.elements, pose.world.get(f.cameraId)!.elements, 1e-5);
    g.triangles
      .flat()
      .forEach((index, i) =>
        near(
          skin!.getVertexPosition(i, new Vector3()).applyMatrix4(skin!.matrixWorld).toArray(),
          expected.positions[index],
          1e-5,
        ),
      );
  }
});
