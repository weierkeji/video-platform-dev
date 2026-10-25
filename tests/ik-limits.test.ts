import test from 'node:test';
import assert from 'node:assert/strict';
import { Euler, Matrix4, Quaternion, Vector3, AnimationMixer, LoopOnce, SkinnedMesh } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { validateBytes } from 'gltf-validator';
import { exportGLB } from '../src/core/gltf';
import { deformGeometry } from '../src/core/skin';
import { affineParts } from '../src/core/affine';
import { limitAngles, projectJointRotation } from '../src/core/joint-limits';
import { applyCommands } from '../src/core/commands';
import { sceneEvaluator } from '../src/core/constraints';
import { id, identity, parseProject, type IKLimit, type Entity } from '../src/core/model';
import { newProject } from '../src/core/factory';
import { bakedProject } from '../src/core/bake';
import { ikLimitsFixture } from '../scripts/ik-limits-fixture';
globalThis.ProgressEvent ||= class extends Event {
  lengthComputable = false;
  loaded = 0;
  total = 0;
} as typeof ProgressEvent;
const degrees = (v: number) => (v * Math.PI) / 180;
const base: IKLimit = {
  jointId: 'joint',
  enabled: true,
  kind: 'hinge',
  reference: [0, 0, 0, 1],
  axis: [0, 0, 1],
  min: 0,
  max: degrees(90),
  swing: degrees(45),
};
const pos = (m: Matrix4) => new Vector3().setFromMatrixPosition(m);
function setup() {
  let p = newProject();
  const sceneId = p.scenes[0].id;
  const nodes: Entity[] = ['root', 'elbow', 'tip', 'target', 'pole'].map((name, i) => ({
    id: id(),
    name,
    sceneId,
    kind: 'group',
    visible: true,
    parentId: null,
    transform: {
      ...identity(),
      position: (i === 0 ? [0, 0, 0] : i < 3 ? [0, 1, 0] : i === 3 ? [-1, 1, 0] : [0, 0, 3]) as [
        number,
        number,
        number,
      ],
    },
  }));
  nodes[1].parentId = nodes[0].id;
  nodes[2].parentId = nodes[1].id;
  p.entities.push(...nodes);
  p.ikChains = [
    {
      id: id(),
      name: 'limited',
      sceneId,
      joints: nodes.slice(0, 3).map((n) => n.id),
      targetId: nodes[3].id,
      poleId: nodes[4].id,
      enabled: true,
      influence: 1,
      iterations: 64,
      tolerance: 1e-5,
      poleAngle: 0,
      limits: [
        { ...base, jointId: nodes[0].id, min: 0, max: 0 },
        { ...base, jointId: nodes[1].id },
      ],
    },
  ];
  p = parseProject(p);
  return { p, sceneId, nodes, chain: p.ikChains![0] };
}
function assertLimits(p: ReturnType<typeof setup>['p'], frame = 0) {
  const chain = p.ikChains![0],
    pose = sceneEvaluator(p, chain.sceneId)(frame);
  for (const limit of chain.limits!.filter((l) => l.enabled)) {
    const angles = limitAngles(affineParts(pose.local.get(limit.jointId)!)!.rotation, limit);
    assert.ok(
      angles.twist >= limit.min - 1e-8 && angles.twist <= limit.max + 1e-8,
      JSON.stringify(angles),
    );
    assert.ok(
      angles.swing <= (limit.kind === 'hinge' ? 0 : limit.swing) + 1e-7,
      JSON.stringify(angles),
    );
  }
  return pose;
}

test('reference-relative hinge and swing-twist projection enforce signed ranges and quaternion sign equivalence', () => {
  const reference = new Quaternion().setFromEuler(new Euler(0.4, -0.3, 0.6));
  const limit = { ...base, reference: reference.toArray() as IKLimit['reference'] };
  const q = reference
    .clone()
    .multiply(new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), degrees(80)))
    .multiply(new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), degrees(120)));
  const projected = projectJointRotation(q, limit),
    angles = limitAngles(projected, limit);
  assert.ok(Math.abs(angles.twist - degrees(90)) < 1e-8);
  assert.ok(angles.swing < 1e-7);
  const cone = { ...limit, kind: 'cone' as const, min: degrees(-20), max: degrees(30) };
  const projectedCone = projectJointRotation(q, cone),
    measured = limitAngles(projectedCone, cone);
  assert.ok(Math.abs(measured.swing - degrees(45)) < 1e-8);
  assert.ok(Math.abs(measured.twist - degrees(30)) < 1e-8);
  assert.ok(
    projectedCone.angleTo(projectJointRotation(new Quaternion(-q.x, -q.y, -q.z, -q.w), cone)) <
      1e-7,
  );
  const singular = new Quaternion(1, 0, 0, 0);
  assert.ok(projectJointRotation(singular, cone).toArray().every(Number.isFinite));
  assert.ok(projectJointRotation(q, { ...cone, enabled: false }).angleTo(q) < 1e-7);
});

test('limited CCD locks the root, reaches a hinge target and keeps limits when target is blocked', () => {
  const { p, nodes, sceneId } = setup(),
    source = JSON.stringify(p);
  const reached = assertLimits(p);
  assert.equal(reached.ik[0].method, 'limited-ccd');
  assert.ok(reached.ik[0].residual < 1e-5, JSON.stringify(reached.ik));
  assert.ok(pos(reached.world.get(nodes[2].id)!).distanceTo(new Vector3(-1, 1, 0)) < 1e-5);
  const blocked = structuredClone(p);
  blocked.entities.find((e) => e.id === nodes[3].id)!.transform.position = [1, 1, 0];
  const pose = assertLimits(blocked);
  assert.equal(pose.ik[0].converged, false);
  assert.equal(pose.ik[0].reachable, null);
  assert.ok(pose.ik[0].residual > 0.5);
  assert.match(pose.warnings[0].message, /未收敛不等于目标不可达/);
  const evaluated = sceneEvaluator(p, sceneId);
  evaluated(30);
  assert.deepEqual(
    evaluated(0).world.get(nodes[2].id)!.elements,
    reached.world.get(nodes[2].id)!.elements,
  );
  assert.equal(JSON.stringify(p), source);
});

test('limits apply after partial influence and preserve local offsets under rotated nonuniform reflected ancestors', () => {
  const { p, nodes, chain } = setup();
  const parent: Entity = {
    id: id(),
    sceneId: chain.sceneId,
    name: 'affine parent',
    kind: 'group',
    visible: true,
    parentId: null,
    transform: { ...identity(), scale: [1.8, 0.7, -1.3], rotation: [0.2, -0.4, 0.3] },
  };
  p.entities.push(parent);
  p.entities.find((e) => e.id === nodes[0].id)!.parentId = parent.id;
  p.entities.find((e) => e.id === nodes[1].id)!.transform.rotation = [0.2, 0, -0.8];
  p.ikChains![0].influence = 0.2;
  const pose = assertLimits(p);
  for (const id of chain.joints) {
    const original = p.entities.find((e) => e.id === id)!;
    assert.ok(
      pos(pose.local.get(id)!).distanceTo(new Vector3(...original.transform.position)) < 1e-9,
    );
    assert.ok(pose.world.get(id)!.elements.every(Number.isFinite));
  }
  const muted = structuredClone(p);
  muted.ikChains![0].influence = 0;
  const input = sceneEvaluator(muted, chain.sceneId)(0);
  assert.ok(
    limitAngles(affineParts(input.local.get(nodes[1].id)!)!.rotation, chain.limits![1]).twist < 0,
  );
});

test('limit capture excludes its own IK and validates axes, ranges, membership and duplicate references atomically', () => {
  const { p, nodes, chain } = setup();
  p.ikChains![0].limits = [];
  const saved = applyCommands(p, [
    { type: 'ik.limit.capture', chainId: chain.id, jointId: nodes[1].id, frame: 0 },
  ]).project;
  assert.deepEqual(saved.ikChains![0].limits![0].reference, [0, 0, 0, 1]);
  const limit = saved.ikChains![0].limits![0],
    before = JSON.stringify(saved);
  for (const invalid of [
    { ...limit, axis: [0, 0, 0] },
    { ...limit, reference: [0, 0, 0, 0] },
    { ...limit, min: 1, max: 0 },
    { ...limit, jointId: nodes[2].id },
  ])
    assert.throws(() =>
      applyCommands(saved, [
        { type: 'ik.put', chain: { ...saved.ikChains![0], limits: [invalid as IKLimit] } },
      ]),
    );
  assert.throws(() =>
    applyCommands(saved, [
      { type: 'ik.put', chain: { ...saved.ikChains![0], limits: [limit, limit] } },
    ]),
  );
  assert.equal(JSON.stringify(saved), before);
  assert.equal(p.ikChains![0].limits!.length, 0);
});

test('baked constrained joints reproduce sampled poses and retain limits disabled with the source chain', () => {
  const { p, nodes, sceneId } = setup();
  p.animationTracks.push({
    id: id(),
    entityId: nodes[3].id,
    property: 'position',
    keys: [
      { id: id(), frame: 0, value: [-1, 1, 0], interpolation: 'linear' },
      { id: id(), frame: 12, value: [-0.5, 1.8, 0.2], interpolation: 'linear' },
    ],
  });
  const baked = bakedProject(p, sceneId, {
    start: 0,
    end: 12,
    step: 0.5,
    actionId: null,
    rebase: false,
    interpolation: 'linear',
  });
  assert.deepEqual(baked.project.ikChains![0].limits, p.ikChains![0].limits);
  assert.equal(baked.project.ikChains![0].enabled, false);
  for (const frame of [0, 3, 6, 12]) {
    const a = assertLimits(p, frame),
      b = sceneEvaluator(baked.project, sceneId)(frame);
    for (const id of p.ikChains![0].joints)
      a.world
        .get(id)!
        .elements.forEach((v, i) => assert.ok(Math.abs(v - b.world.get(id)!.elements[i]) < 2e-6));
  }
});

test('three-segment limited CCD actually iterates toward a reachable legal pose', () => {
  const { p, nodes, chain } = setup();
  const tip: Entity = {
    id: id(),
    name: 'last',
    kind: 'group',
    sceneId: chain.sceneId,
    parentId: nodes[2].id,
    visible: true,
    transform: { ...identity(), position: [0, 1, 0] },
  };
  p.entities.push(tip);
  chain.joints.push(tip.id);
  chain.limits!.push({ ...base, jointId: nodes[2].id });
  p.entities.find((e) => e.id === nodes[3].id)!.transform.position = [
    -1.5,
    1 + Math.sqrt(3) / 2,
    0,
  ];
  const pose = assertLimits(p);
  assert.ok(pose.ik[0].iterations > 0);
  assert.ok(pose.ik[0].residual < 0.001, JSON.stringify(pose.ik));
});

test('feasible one-sided hinge initialization avoids the straight-chain stationary point throughout authored motion', () => {
  const { p } = ikLimitsFixture();
  for (const frame of [0, 6.25, 12, 24, 36.5, 47]) {
    const pose = assertLimits(p, frame);
    assert.ok(pose.ik[0].residual < 1e-5, JSON.stringify({ frame, ...pose.ik[0] }));
  }
});

test('independent GLTFLoader reproduces constrained camera matrices and skinned vertices at baked samples', async () => {
  const { p, sceneId, meshId, cameraId } = ikLimitsFixture();
  const exported = exportGLB(p, sceneId, 0, new Map(), true, {
    start: 0,
    end: 48,
    step: 0.5,
    actionId: null,
    rebase: false,
    interpolation: 'linear',
  });
  const report = await validateBytes(exported.bytes);
  assert.equal(report.issues.numErrors, 0);
  assert.equal(report.issues.numWarnings, 0);
  const loaded = await new GLTFLoader().parseAsync(Uint8Array.from(exported.bytes).buffer, '');
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
  for (const frame of [0, 12, 24, 36.5, 47]) {
    mixer.setTime(frame / 24);
    loaded.scene.updateMatrixWorld(true);
    skin.skeleton.update();
    const pose = assertLimits(p, frame),
      expected = deformGeometry(geometry, mesh.skin!, pose.world);
    loaded.cameras[0].matrixWorld.elements.forEach((v, i) =>
      assert.ok(Math.abs(v - pose.world.get(cameraId)!.elements[i]) < 1e-5),
    );
    geometry.triangles.flat().forEach((index, i) =>
      assert.ok(
        skin!
          .getVertexPosition(i, new Vector3())
          .applyMatrix4(skin!.matrixWorld)
          .distanceTo(new Vector3(...expected.positions[index])) < 1e-5,
      ),
    );
  }
});
