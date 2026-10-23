import test from 'node:test';
import assert from 'node:assert/strict';
import { Matrix4, Vector3, AnimationMixer, LoopOnce, SkinnedMesh } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { validateBytes } from 'gltf-validator';
import { solveIKPositions } from '../src/core/ik';
import { sceneEvaluator, matrixTransform } from '../src/core/constraints';
import { id, parseProject } from '../src/core/model';
import { applyCommands } from '../src/core/commands';
import { bakedProject } from '../src/core/bake';
import { exportGLB, importGLTF } from '../src/core/gltf';
import { deformGeometry } from '../src/core/skin';
import { newProject } from '../src/core/factory';
import { ikFixture } from '../scripts/ik-fixture';

globalThis.ProgressEvent ||= class extends Event {
  lengthComputable = false;
  loaded = 0;
  total = 0;
} as typeof ProgressEvent;
const near = (a: number[], b: number[], tolerance = 1e-7) => {
  assert.equal(a.length, b.length);
  a.forEach((v, i) => assert.ok(Math.abs(v - b[i]) < tolerance, `${i}: ${v} != ${b[i]}`));
};
const position = (m: Matrix4) => new Vector3().setFromMatrixPosition(m);
const options = { iterations: 64, tolerance: 1e-5, poleAngle: 0 };

test('two-segment IK reaches a target with pole and angle, clamps outer/inner reach and handles a folded equal chain', () => {
  const input = [new Vector3(), new Vector3(0, 1, 0), new Vector3(0, 2, 0)],
    target = new Vector3(1, 1, 0);
  const result = solveIKPositions(input, target, new Vector3(0, 0, 3), options);
  near(result.points[2].toArray(), target.toArray());
  assert.ok(result.points[1].z > 0);
  result.lengths.forEach((length, i) =>
    assert.ok(Math.abs(result.points[i].distanceTo(result.points[i + 1]) - length) < 1e-8),
  );
  const flipped = solveIKPositions(input, target, new Vector3(0, 0, 3), {
    ...options,
    poleAngle: Math.PI,
  });
  assert.ok(flipped.points[1].z < 0);
  near(flipped.points[2].toArray(), target.toArray());
  const far = solveIKPositions(input, new Vector3(5, 0, 0), undefined, options);
  assert.equal(far.reachable, false);
  near(far.points[2].toArray(), [2, 0, 0]);
  const short = solveIKPositions(
    [new Vector3(), new Vector3(0, 3, 0), new Vector3(0, 4, 0)],
    new Vector3(0.2, 0, 0),
    undefined,
    options,
  );
  assert.equal(short.reachable, false);
  near(short.points[2].toArray(), [2, 0, 0]);
  const folded = solveIKPositions(input, new Vector3(), new Vector3(1, 0, 0), options);
  near(folded.points[2].toArray(), [0, 0, 0]);
  assert.ok(folded.points[1].length() > 0.99);
  assert.throws(
    () =>
      solveIKPositions(
        [new Vector3(), new Vector3(), new Vector3(0, 1, 0)],
        target,
        undefined,
        options,
      ),
    /退化骨段/,
  );
});

test('bounded multi-segment FABRIK preserves lengths, resolves straight input and reports iteration limits', () => {
  const input = Array.from({ length: 6 }, (_, i) => new Vector3(0, i, 0));
  for (const goal of [new Vector3(2, 2, 0.8), new Vector3(0, 2.8, 0), new Vector3()]) {
    const result = solveIKPositions(input, goal, new Vector3(1, 1, 4), options);
    assert.ok(
      result.residual < 0.001,
      JSON.stringify({ residual: result.residual, iterations: result.iterations }),
    );
    near(result.points[0].toArray(), [0, 0, 0]);
    result.points
      .slice(1)
      .forEach((v, i) => assert.ok(Math.abs(v.distanceTo(result.points[i]) - 1) < 1e-7));
  }
  const limited = solveIKPositions(input, new Vector3(3, 1, 1), undefined, {
    ...options,
    iterations: 1,
    tolerance: 1e-6,
  });
  assert.equal(limited.iterations, 1);
  assert.equal(limited.converged, false);
});

test('IK evaluation completes the chain before ordinary followers, camera and branches; random access and partial influence are deterministic', () => {
  const { p, sceneId, tipId, targetId, rootJointId, followerId, chainId } = ikFixture();
  const before = JSON.stringify(p),
    evaluate = sceneEvaluator(p, sceneId);
  for (const frame of [24, 0, 47, 6.25, 24]) {
    const pose = evaluate(frame);
    assert.equal(pose.warnings.length, 0);
    near(
      position(pose.world.get(tipId)!).toArray(),
      position(pose.world.get(targetId)!).toArray(),
      1e-6,
    );
    near(
      position(pose.world.get(followerId)!).toArray(),
      position(pose.world.get(tipId)!).toArray(),
    );
    assert.ok(pose.ik[0].converged);
  }
  assert.equal(JSON.stringify(p), before);
  const chain = p.ikChains![0];
  const partial = applyCommands(p, [
    { type: 'ik.put', chain: { ...chain, influence: 0.5 } },
  ]).project;
  const sample = sceneEvaluator(partial, sceneId)(24);
  assert.ok(sample.ik[0].appliedResidual > sample.ik[0].residual + 0.01);
  near(
    position(sample.world.get(rootJointId)!).toArray(),
    position(evaluate(24).world.get(rootJointId)!).toArray(),
  );
  const muted = applyCommands(p, [{ type: 'ik.put', chain: { ...chain, enabled: false } }]).project;
  assert.equal(sceneEvaluator(muted, sceneId)(24).ik.length, 0);
  assert.equal(chain.id, chainId);
});

test('IK write groups reject feedback, overlap and broken chains atomically, including pole and external constraint dependencies', () => {
  const { p, sceneId, chainId, rootJointId, tipId, targetId, poleId } = ikFixture(),
    chain = p.ikChains![0],
    before = JSON.stringify(p);
  for (const invalid of [
    { ...chain, targetId: tipId },
    { ...chain, poleId: tipId },
    { ...chain, joints: [chain.joints[0], chain.joints[2], chain.joints[1]] },
    { ...chain, targetId: 'missing' },
  ])
    assert.throws(() => applyCommands(p, [{ type: 'ik.put', chain: invalid }]));
  assert.throws(
    () => applyCommands(p, [{ type: 'ik.put', chain: { ...chain, id: id() } }]),
    /共享节点/,
  );
  assert.throws(
    () =>
      applyCommands(p, [{ type: 'entity.update', id: targetId, patch: { parentId: rootJointId } }]),
    /循环/,
  );
  assert.throws(
    () =>
      applyCommands(p, [
        {
          type: 'constraint.put',
          entityId: poleId,
          constraint: {
            id: id(),
            name: 'feedback',
            type: 'copy-position',
            targetId: tipId,
            enabled: true,
            influence: 1,
            targetSpace: 'world',
            ownerSpace: 'world',
          },
        },
      ]),
    /循环/,
  );
  for (const id of [tipId, targetId, poleId])
    assert.throws(() => applyCommands(p, [{ type: 'entity.delete', id }]), /IK 链引用/);
  assert.equal(JSON.stringify(p), before);
  const removed = applyCommands(p, [
    { type: 'ik.delete', id: chainId },
    { type: 'entity.delete', id: targetId },
  ]).project;
  assert.equal(removed.ikChains!.length, 0);
  assert.ok(removed.scenes.some((s) => s.id === sceneId));
});

test('nonuniform and reflected ancestry retains world segment lengths; shear is explicit and degenerate segments preserve incoming pose', () => {
  const { p, sceneId, root } = ikFixture(),
    chain = p.ikChains![0];
  p.entities.find((e) => e.id === root)!.transform.scale = [1.8, 0.8, -1.2];
  const muted = structuredClone(p);
  muted.ikChains![0].enabled = false;
  const original = sceneEvaluator(muted, sceneId)(12),
    solved = sceneEvaluator(p, sceneId)(12);
  for (let i = 0; i < chain.joints.length - 1; i++) {
    const a = chain.joints[i],
      b = chain.joints[i + 1];
    assert.ok(
      Math.abs(
        position(original.world.get(a)!).distanceTo(position(original.world.get(b)!)) -
          position(solved.world.get(a)!).distanceTo(position(solved.world.get(b)!)),
      ) < 1e-6,
    );
  }
  assert.throws(() => matrixTransform(solved.local.get(chain.joints[0])!, 'root'), /剪切/);
  const degenerate = structuredClone(p);
  degenerate.entities.find((e) => e.id === chain.joints[1])!.transform.position = [0, 0, 0];
  assert.match(
    sceneEvaluator(degenerate, sceneId)(0).warnings.find((w) => w.constraintId === chain.id)!
      .message,
    /退化骨段/,
  );
});

test('IK baking preserves all solved joints and disables the source chain; static and animated GLB agree with an independent loader', async () => {
  const { p, sceneId, meshId, cameraId } = ikFixture();
  const options = {
    start: 0,
    end: 48,
    step: 0.5,
    interpolation: 'linear' as const,
    rebase: false,
    actionId: null,
  };
  const baked = bakedProject(p, sceneId, options);
  assert.ok(baked.project.ikChains!.every((c) => !c.enabled));
  for (const frame of [0, 12, 24, 47]) {
    const original = sceneEvaluator(p, sceneId)(frame),
      restored = sceneEvaluator(baked.project, sceneId)(frame);
    for (const id of p.ikChains![0].joints)
      near(restored.world.get(id)!.elements, original.world.get(id)!.elements, 3e-6);
  }
  assert.throws(() => exportGLB(p, sceneId, 0, new Map(), true), /约束|IK/);
  const onlyIK = structuredClone(p);
  onlyIK.entities.forEach((e) => e.constraints?.forEach((c) => (c.enabled = false)));
  assert.throws(() => exportGLB(onlyIK, sceneId, 0, new Map(), true), /无法保存 IK/);
  const output = exportGLB(p, sceneId, 0, new Map(), true, options),
    report = await validateBytes(output.bytes);
  assert.equal(report.issues.numErrors, 0, JSON.stringify(report.issues));
  assert.equal(report.issues.numWarnings, 0);
  const loaded = await new GLTFLoader().parseAsync(Uint8Array.from(output.bytes).buffer, '');
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
    geometry = p.geometries.find((g) => g.id === mesh.geometryId)!;
  for (const frame of [0, 6.25, 12, 24, 36.5, 47]) {
    mixer.setTime(frame / 24);
    loaded.scene.updateMatrixWorld(true);
    skin.skeleton.update();
    const pose = sceneEvaluator(p, sceneId)(frame),
      expected = deformGeometry(geometry, mesh.skin!, pose.world);
    near(loaded.cameras[0].matrixWorld.elements, pose.world.get(cameraId)!.elements, 0.001);
    geometry.triangles
      .flat()
      .forEach((index, i) =>
        near(
          skin!.getVertexPosition(i, new Vector3()).applyMatrix4(skin!.matrixWorld).toArray(),
          expected.positions[index],
          0.002,
        ),
      );
  }
  const still = exportGLB(p, sceneId, 24);
  const check = await validateBytes(still.bytes);
  assert.equal(check.issues.numErrors, 0);
  assert.equal(check.issues.numWarnings, 0);
  const restored = applyCommands(newProject(), [(await importGLTF(still.bytes)).command]).project;
  const camera = restored.entities.find((e) => e.name === 'IK camera')!;
  near(
    sceneEvaluator(restored, camera.sceneId)(0).world.get(camera.id)!.elements,
    sceneEvaluator(p, sceneId)(24).world.get(cameraId)!.elements,
    2e-6,
  );
  const saved = applyCommands(p, [
    {
      type: 'action.bake',
      action: { id: id(), name: 'IK bake', sceneId },
      options,
      activate: true,
    },
  ]).project;
  assert.equal(saved.ikChains![0].enabled, false);
  assert.equal(p.ikChains![0].enabled, true);
  parseProject(saved);
});
