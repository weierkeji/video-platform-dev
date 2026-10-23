import test from 'node:test';
import assert from 'node:assert/strict';
import { AnimationMixer, LoopOnce, Matrix4, Vector3, SkinnedMesh } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { validateBytes } from 'gltf-validator';
import { newProject } from '../src/core/factory';
import {
  id,
  identity,
  parseProject,
  type Constraint,
  type Entity,
  type Project,
} from '../src/core/model';
import { applyCommands } from '../src/core/commands';
import { sceneEvaluator, matrixTransform, transformMatrix } from '../src/core/constraints';
import { bakeAnimation, bakedProject } from '../src/core/bake';
import { exportGLB, importGLTF } from '../src/core/gltf';
import { deformGeometry } from '../src/core/skin';
import { constraintsFixture } from '../scripts/constraints-fixture';

globalThis.ProgressEvent ||= class extends Event {
  lengthComputable = false;
  loaded = 0;
  total = 0;
} as typeof ProgressEvent;
const near = (a: number[], b: number[], tolerance = 1e-7) => {
  assert.equal(a.length, b.length);
  a.forEach((v, i) => assert.ok(Math.abs(v - b[i]) <= tolerance, `${i}: ${v} != ${b[i]}`));
};
const position = (m: Matrix4) => new Vector3().setFromMatrixPosition(m).toArray();
function group(p: Project, name: string, parentId: string | null = null) {
  const e: Entity = {
    id: id(),
    name,
    parentId,
    kind: 'group',
    sceneId: p.scenes[0].id,
    visible: true,
    transform: identity(),
  };
  p.entities.push(e);
  return e;
}
function copy(
  targetId: string,
  type: 'copy-transform' | 'copy-position' = 'copy-transform',
): Constraint {
  return {
    id: id(),
    name: type,
    targetId,
    type,
    enabled: true,
    influence: 1,
    targetSpace: 'world',
    ownerSpace: 'world',
  };
}

test('constraint spaces preserve exact affine matrices, including nonuniform ancestors and shear', () => {
  const p = newProject(),
    parentA = group(p, 'A'),
    parentB = group(p, 'B');
  parentA.transform.scale = [2, 1, 0.6];
  parentA.transform.rotation = [0.1, 0.4, 0.2];
  parentA.transform.position = [2, 4, -1];
  parentB.transform.rotation = [0, -0.2, 0.3];
  parentB.transform.position = [-3, 1, 2];
  const target = group(p, 'target', parentA.id),
    owner = group(p, 'owner', parentB.id);
  target.transform.rotation = [0.4, 0.2, -0.1];
  target.transform.position = [1, 2, 3];
  target.visible = false;
  const c = copy(target.id);
  owner.constraints = [c];
  let pose = sceneEvaluator(parseProject(p), owner.sceneId)(0);
  near(pose.world.get(owner.id)!.elements, pose.world.get(target.id)!.elements);
  assert.throws(() => matrixTransform(pose.local.get(owner.id)!, owner.name), /剪切/);
  if (c.type === 'aim') throw new Error('fixture');
  c.ownerSpace = 'local';
  c.targetSpace = 'local';
  pose = sceneEvaluator(p, owner.sceneId)(0);
  near(pose.local.get(owner.id)!.elements, transformMatrix(target.transform).elements);
  c.targetSpace = 'world';
  c.influence = 0.5;
  pose = sceneEvaluator(p, owner.sceneId)(0);
  assert.ok(pose.local.get(owner.id)!.elements.every(Number.isFinite));
  near(
    position(pose.local.get(owner.id)!),
    position(pose.world.get(target.id)!).map((v) => v * 0.5),
  );
  assert.equal(pose.warnings.length, 0);
});

test('aim aligns signed axes under nonuniform parents while retaining world stretch and deterministic degeneracy handling', () => {
  const p = newProject(),
    parent = group(p, 'parent'),
    owner = group(p, 'owner', parent.id),
    target = group(p, 'target');
  parent.transform.scale = [1.8, 0.7, 1.2];
  parent.transform.rotation = [0.2, 0.3, 0.4];
  owner.transform.rotation = [-0.3, 0.5, 0.6];
  owner.transform.scale = [-0.8, 1.3, 0.9];
  target.transform.position = [4, 2, -3];
  const rest = sceneEvaluator(p, owner.sceneId)(0).world.get(owner.id)!;
  const gram = (m: Matrix4) =>
    [0, 1, 2].flatMap((i) =>
      [0, 1, 2].map((j) =>
        new Vector3().setFromMatrixColumn(m, i).dot(new Vector3().setFromMatrixColumn(m, j)),
      ),
    );
  for (const axis of ['x', 'y', 'z', '-x', '-y', '-z'] as const) {
    const c: Constraint = {
      id: id(),
      name: 'aim',
      type: 'aim',
      targetId: target.id,
      enabled: true,
      influence: 1,
      trackAxis: axis,
      upAxis: axis.includes('y') ? 'z' : 'y',
      worldUp: [0, 1, 0],
    };
    owner.constraints = [c];
    const pose = sceneEvaluator(parseProject(p), owner.sceneId)(0),
      world = pose.world.get(owner.id)!;
    const actual = new Vector3()
      .setFromMatrixColumn(world, 'xyz'.indexOf(axis.replace('-', '')))
      .normalize()
      .multiplyScalar(axis.startsWith('-') ? -1 : 1);
    const expected = new Vector3(...target.transform.position)
      .sub(new Vector3(...position(world)))
      .normalize();
    near(actual.toArray(), expected.toArray());
    near(gram(world), gram(rest));
    near(position(world), position(rest));
  }
  target.transform.position = [0, 2, 0];
  const evaluate = sceneEvaluator(p, owner.sceneId);
  near(evaluate(20).world.get(owner.id)!.elements, evaluate(0).world.get(owner.id)!.elements);
  target.transform.position = [0, 0, 0];
  const coincident = sceneEvaluator(p, owner.sceneId)(0);
  assert.match(coincident.warnings[0].message, /重合/);
  near(coincident.world.get(owner.id)!.elements, rest.elements);
  parent.transform.scale[0] = 0;
  assert.match(sceneEvaluator(p, owner.sceneId)(0).warnings[0].message, /不可逆/);
});

test('constraint commands reject active dependency cycles and dangling references atomically; order, mute and duplication persist', () => {
  const p = newProject(),
    a = group(p, 'A'),
    b = group(p, 'B'),
    child = group(p, 'child', a.id);
  a.constraints = [copy(b.id, 'copy-position')];
  b.transform.position = [4, 3, 2];
  const before = JSON.stringify(p);
  for (const targetId of [a.id, child.id, 'missing'])
    assert.throws(() =>
      applyCommands(p, [{ type: 'constraint.put', entityId: a.id, constraint: copy(targetId) }]),
    );
  assert.throws(
    () => applyCommands(p, [{ type: 'constraint.put', entityId: b.id, constraint: copy(a.id) }]),
    /循环.*A|循环.*B/,
  );
  assert.equal(JSON.stringify(p), before);
  const disabled = { ...copy(a.id), enabled: false };
  const muted = applyCommands(p, [
    { type: 'constraint.put', entityId: b.id, constraint: disabled },
  ]).project;
  assert.throws(
    () =>
      applyCommands(muted, [
        { type: 'constraint.put', entityId: b.id, constraint: { ...disabled, enabled: true } },
      ]),
    /循环/,
  );
  assert.throws(() => applyCommands(p, [{ type: 'entity.delete', id: b.id }]), /约束引用/);
  const duplicate = applyCommands(p, [{ type: 'entity.duplicate', id: a.id }]).project.entities.at(
    -1,
  )!;
  assert.equal(duplicate.constraints![0].targetId, b.id);
  assert.notEqual(duplicate.constraints![0].id, a.constraints[0].id);
  const c = group(p, 'C');
  c.transform.position = [-3, 2, 1];
  const last = copy(c.id, 'copy-position');
  a.constraints.push(last);
  near(position(sceneEvaluator(p, a.sceneId)(0).world.get(a.id)!), c.transform.position);
  const moved = applyCommands(p, [
    { type: 'constraint.move', entityId: a.id, id: last.id, direction: -1 },
  ]).project;
  near(position(sceneEvaluator(moved, a.sceneId)(0).world.get(a.id)!), b.transform.position);
});

test('constraint evaluation includes target animation; bake activation disables sources without destroying them', () => {
  const { p, sceneId, targetId, joint1, cameraId } = constraintsFixture();
  const options = {
    start: 0,
    end: 48,
    step: 1,
    interpolation: 'linear' as const,
    rebase: false,
    actionId: null,
  };
  const baked = bakedProject(p, sceneId, options);
  assert.ok(baked.tracks.some((t) => t.entityId === joint1 && t.property === 'quaternion'));
  assert.ok(baked.tracks.some((t) => t.entityId === cameraId && t.property === 'quaternion'));
  assert.ok(baked.project.entities.every((e) => !e.constraints?.some((c) => c.enabled)));
  for (const frame of [0, 6, 12, 24, 47, 48]) {
    const expected = sceneEvaluator(p, sceneId)(frame),
      actual = sceneEvaluator(baked.project, sceneId)(frame);
    for (const e of p.entities)
      near(actual.world.get(e.id)!.elements, expected.world.get(e.id)!.elements, 2e-6);
  }
  const action = { id: id(), name: 'Constraint bake', sceneId };
  const saved = applyCommands(p, [
    { type: 'action.bake', action, options, activate: true },
  ]).project;
  assert.ok(saved.entities.find((e) => e.id === cameraId)!.constraints!.every((c) => !c.enabled));
  assert.ok(p.entities.find((e) => e.id === cameraId)!.constraints!.every((c) => c.enabled));
  const parent = group(p, 'nonuniform');
  parent.transform.scale = [2, 1, 1];
  p.entities.find((e) => e.id === cameraId)!.parentId = parent.id;
  assert.throws(() => bakeAnimation(p, sceneId, options), /剪切/);
  assert.ok(p.animationTracks.some((t) => t.entityId === targetId));
});

test('copy influence follows target layers and their guarded boundaries, with rotation interpolated on the sphere', () => {
  const p = newProject(),
    target = group(p, 'layer target'),
    owner = group(p, 'follower');
  target.transform.position = [4, 2, -2];
  target.transform.rotation = [0, 0, Math.PI / 2];
  target.transform.scale = [3, 2, 1];
  const constraint = copy(target.id);
  constraint.influence = 0.5;
  owner.constraints = [constraint];
  const expected = transformMatrix({
    ...identity(),
    position: [2, 1, -1],
    rotation: [0, 0, Math.PI / 4],
    scale: [2, 1.5, 1],
  });
  near(sceneEvaluator(p, owner.sceneId)(0).world.get(owner.id)!.elements, expected.elements);
  const action = { id: id(), name: 'Target layer', sceneId: owner.sceneId };
  p.animationActions = [action];
  p.animationTracks = [
    {
      id: id(),
      entityId: target.id,
      property: 'position',
      actionId: action.id,
      keys: [{ id: id(), frame: 0, value: [8, 6, 2], interpolation: 'linear' }],
    },
  ];
  p.animationLayers = [
    {
      id: id(),
      name: 'Target window',
      entityId: target.id,
      actionId: action.id,
      enabled: true,
      blend: 'replace',
      weight: 1,
      channels: ['position'],
      start: 2,
      duration: 6,
      sourceIn: 0,
      playback: { rate: 1, rangeStart: 0, rangeEnd: 8, mode: 'hold' },
      fadeIn: 0,
      fadeOut: 0,
    },
  ];
  const evaluate = sceneEvaluator(parseProject(p), owner.sceneId);
  near(position(evaluate(3).world.get(owner.id)!), [4, 3, 1]);
  near(position(evaluate(3, undefined, false).world.get(owner.id)!), [2, 1, -1]);
  const baked = bakedProject(p, owner.sceneId, {
    start: 0,
    end: 10,
    step: 1,
    interpolation: 'linear',
    rebase: false,
    actionId: null,
  });
  assert.ok(baked.stats.guardedBoundaries >= 2);
  for (const frame of [1, 3, 7, 9])
    near(
      sceneEvaluator(baked.project, owner.sceneId)(frame).world.get(owner.id)!.elements,
      evaluate(frame).world.get(owner.id)!.elements,
      2e-6,
    );
});

test('static and baked constraint GLB preserve evaluated camera and skinned vertices in an independent loader', async () => {
  const { p, sceneId, cameraId, meshId } = constraintsFixture();
  assert.throws(() => exportGLB(p, sceneId, 0, new Map(), true), /约束/);
  const options = {
    start: 0,
    end: 48,
    step: 1,
    interpolation: 'linear' as const,
    rebase: false,
    actionId: null,
  };
  const out = exportGLB(p, sceneId, 0, new Map(), true, options);
  const report = await validateBytes(out.bytes);
  assert.equal(report.issues.numErrors, 0, JSON.stringify(report.issues));
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
  const mesh = p.entities.find((e) => e.id === meshId)!,
    g = p.geometries.find((g) => g.id === mesh.geometryId)!;
  for (const frame of [0, 6.25, 12, 24, 36.5, 47]) {
    mixer.setTime(frame / 24);
    loaded.scene.updateMatrixWorld(true);
    skin.skeleton.update();
    const pose = sceneEvaluator(p, sceneId)(frame);
    near(loaded.cameras[0].matrixWorld.elements, pose.world.get(cameraId)!.elements, 0.001);
    const expected = deformGeometry(g, mesh.skin!, pose.world);
    g.triangles
      .flat()
      .forEach((index, i) =>
        near(
          skin!.getVertexPosition(i, new Vector3()).applyMatrix4(skin!.matrixWorld).toArray(),
          expected.positions[index],
          0.003,
        ),
      );
  }
  const still = exportGLB(p, sceneId, 24),
    check = await validateBytes(still.bytes);
  assert.equal(check.issues.numErrors, 0);
  assert.equal(check.issues.numWarnings, 0);
  const imported = applyCommands(newProject(), [(await importGLTF(still.bytes)).command]).project;
  const camera = imported.entities.find((e) => e.name === 'Tracking camera')!;
  near(
    sceneEvaluator(imported, camera.sceneId)(0).world.get(camera.id)!.elements,
    sceneEvaluator(p, sceneId)(24).world.get(cameraId)!.elements,
    2e-6,
  );
});
