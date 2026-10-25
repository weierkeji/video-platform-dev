import test from 'node:test';
import assert from 'node:assert/strict';
import { AnimationMixer, LoopOnce, SkinnedMesh, Vector3 } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { validateBytes } from 'gltf-validator';
import { id, parseProject, migrateProject, PROJECT_VERSION, type IKTrack } from '../src/core/model';
import { editTrack, sampleCurve, scalarZeros, validateTrack } from '../src/core/animation';
import { activeIKTracks, evaluatedIK } from '../src/core/ik-animation';
import { sceneEvaluator, drivenEntities } from '../src/core/constraints';
import { actionRange, sourceFrame, shotAction } from '../src/core/playback';
import { applyCommands } from '../src/core/commands';
import { bakedProject } from '../src/core/bake';
import { exportGLB } from '../src/core/gltf';
import { deformGeometry } from '../src/core/skin';
import { ikAnimationFixture } from '../scripts/ik-animation-fixture';
globalThis.ProgressEvent ||= class extends Event {
  lengthComputable = false;
  loaded = 0;
  total = 0;
} as typeof ProgressEvent;
const near = (a: number, b: number, eps = 1e-8) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);
const equalMatrices = (a: number[], b: number[], eps = 1e-8) =>
  a.forEach((v, i) => near(v, b[i], eps));

test('single-component curves share interpolation, cubic tangents and editable Bezier handles without vector padding', () => {
  const { p } = ikAnimationFixture(),
    t = p.ikTracks![0];
  t.keys = [0, 1].map((v) => ({ id: id(), frame: v * 10, value: [v], interpolation: 'linear' }));
  near(sampleCurve(t, 2.5)![0], 0.25);
  t.keys[0].interpolation = 'smooth';
  near(sampleCurve(t, 2.5)![0], 0.15625);
  t.keys[0].interpolation = 'constant';
  near(sampleCurve(t, 9.9)![0], 0);
  editTrack(t, {
    type: 'key.update',
    trackId: t.id,
    keyId: t.keys[0].id,
    patch: { interpolation: 'cubic', outTangent: [0.1] },
  });
  t.keys[1].inTangent = [0.1];
  near(sampleCurve(t, 2.5)![0], 0.25);
  editTrack(t, {
    type: 'key.update',
    trackId: t.id,
    keyId: t.keys[0].id,
    patch: { interpolation: 'bezier' },
  });
  editTrack(t, {
    type: 'key.handle',
    trackId: t.id,
    keyId: t.keys[0].id,
    axis: 0,
    side: 'right',
    offset: [4, -2],
  });
  assert.equal(t.keys[0].handles!.length, 1);
  assert.ok(sampleCurve(t, 2)![0] < 0);
  const zeros = scalarZeros(t);
  assert.ok(zeros.length >= 1);
  for (const f of zeros) near(sampleCurve(t, f)![0], 0);
  assert.throws(
    () =>
      editTrack(t, {
        type: 'key.handles',
        trackId: t.id,
        keyId: t.keys[0].id,
        axis: 1,
        mode: 'free',
      }),
    /分量/,
  );
  assert.throws(() => validateTrack({ ...t, keys: [{ ...t.keys[0], value: [0, 0, 0] }] }), /维度/);
  assert.equal(sampleCurve(t, -1)!.length, 1);
});

test('animated zero influence preserves FK and later activates the compiled chain before all outside readers', () => {
  const { p, sceneId, rootJointId, tipId, followerId } = ikAnimationFixture();
  const frozen = structuredClone(p);
  frozen.ikChains![0].enabled = false;
  const evalScene = sceneEvaluator(p, sceneId),
    fk = sceneEvaluator(frozen, sceneId)(0);
  assert.ok(drivenEntities(p).has(rootJointId));
  for (const joint of p.ikChains![0].joints)
    equalMatrices(evalScene(0).world.get(joint)!.elements, fk.world.get(joint)!.elements);
  assert.equal(evalScene(0).ik.length, 0);
  const full = evalScene(24);
  assert.ok(full.ik[0].appliedResidual < 1e-5);
  equalMatrices(
    full.world.get(tipId)!.elements.slice(12, 15),
    full.world.get(followerId)!.elements.slice(12, 15),
  );
  const repeat = evalScene(0);
  equalMatrices(repeat.world.get(tipId)!.elements, fk.world.get(tipId)!.elements);
  assert.equal(sceneEvaluator(frozen, sceneId)(24).ik.length, 0);
});

test('parameter actions, shot retiming and explicit IK layer masks use the same scene source frame', () => {
  const { p, sceneId, parameterActionId } = ikAnimationFixture(),
    c = p.ikChains![0];
  assert.deepEqual(actionRange(p, sceneId, parameterActionId), { start: 0, end: 48 });
  assert.equal(activeIKTracks(p, c.joints[0], parameterActionId).length, 1);
  const layer = p.animationLayers![0];
  near(
    evaluatedIK(p, c, 10).poleAngle - evaluatedIK(p, c, 10, null, false).poleAngle,
    sampleCurve(p.ikTracks![2], 44)![0] * 0.125,
  );
  layer.channels = ['position'];
  near(evaluatedIK(p, c, 10).poleAngle, evaluatedIK(p, c, 10, null, false).poleAngle);
  const clip = p.timeline.clips.find((c) => c.kind === 'shot')!,
    shot = p.shots[0];
  clip.action = { actionId: parameterActionId };
  clip.sourceIn = 48;
  clip.playback = { rate: -2, rangeStart: 0, rangeEnd: 48, mode: 'pingpong' };
  near(sourceFrame(clip, clip.start + 6), 36);
  assert.equal(shotAction(p, shot, clip), parameterActionId);
  const mapped = evaluatedIK(p, c, sourceFrame(clip, clip.start + 6), shotAction(p, shot, clip));
  near(mapped.influence, 0);
  near(mapped.poleAngle, sampleCurve(p.ikTracks![2], 36)![0]);
  p.ikTracks![2].keys[1].value = [4 * Math.PI];
  p.ikTracks![2].keys[0].value = [0];
  near(evaluatedIK(p, c, 24, parameterActionId, false).poleAngle, 2 * Math.PI);
});

test('influence clamps after ordered layer mixing and zero bypasses hard joint limits', () => {
  const { p, sceneId, rootJointId } = ikAnimationFixture(),
    chain = p.ikChains![0];
  const t = p.ikTracks![0];
  t.keys = [
    { id: id(), frame: 0, value: [0.5], interpolation: 'cubic', outTangent: [-1] },
    { id: id(), frame: 10, value: [0.5], interpolation: 'linear', inTangent: [1] },
  ];
  p.animationLayers = [];
  near(evaluatedIK(p, chain, 5).influence, 0);
  chain.limits = [
    {
      jointId: rootJointId,
      enabled: true,
      kind: 'hinge',
      reference: [0, 0, 0, 1],
      axis: [0, 0, 1],
      min: 0.2,
      max: 0.2,
      swing: 0,
    },
  ];
  const root = p.entities.find((e) => e.id === rootJointId)!;
  root.transform.rotation = [0, 0, -0.5];
  delete root.transform.quaternion;
  assert.equal(sceneEvaluator(p, sceneId)(5).ik.length, 0);
  const zero = structuredClone(p);
  zero.ikChains![0].enabled = false;
  equalMatrices(
    sceneEvaluator(p, sceneId)(5).local.get(root.id)!.elements,
    sceneEvaluator(zero, sceneId)(5).local.get(root.id)!.elements,
  );
  const before = sceneEvaluator(p, sceneId)(0);
  assert.ok(before.ik[0].limits[0].twist >= 0.2 - 1e-7);
  const roots = scalarZeros(t);
  assert.equal(roots.length, 2);
  const baked = bakedProject(parseProject(p), sceneId, {
    start: 0,
    end: 10,
    step: 2,
    actionId: null,
    rebase: false,
    interpolation: 'linear',
  });
  assert.ok(baked.stats.guardedBoundaries >= 2);
  parseProject(baked.project);
  assert.equal(baked.project.ikTracks?.length, 0);
});

test('dependency validation includes animated zero-valued chains across inactive actions and rejects malformed references atomically', () => {
  const f = ikAnimationFixture(),
    { p, tipId, targetId } = f;
  const copy = structuredClone(p);
  copy.entities.find((e) => e.id === targetId)!.parentId = tipId;
  assert.throws(() => parseProject(copy), /循环/);
  copy.ikChains![0].enabled = false;
  parseProject(copy);
  const bad = structuredClone(p);
  bad.ikTracks![0].entityId = targetId;
  assert.throws(() => parseProject(bad), /根节点/);
  const original = JSON.stringify(p);
  assert.throws(
    () =>
      applyCommands(p, [
        {
          type: 'ik.key.set',
          chainId: f.chainId,
          property: 'influence',
          key: { frame: 2, value: [2] },
        },
      ]),
    /0…1/,
  );
  assert.equal(JSON.stringify(p), original);
  assert.throws(
    () =>
      applyCommands(p, [
        {
          type: 'ik.key.update',
          trackId: p.ikTracks![0].id,
          keyId: p.ikTracks![0].keys[0].id,
          patch: { frame: 12 },
        },
      ]),
    /已有关键帧/,
  );
});

test('raw overshoot survives additive mixing until the final clamp and replace layers override it in order', () => {
  const { p, parameterActionId } = ikAnimationFixture(),
    c = p.ikChains![0],
    t = p.ikTracks![0];
  t.keys = [
    { id: id(), frame: 0, value: [0.5], interpolation: 'cubic', outTangent: [-1] },
    { id: id(), frame: 10, value: [0.5], interpolation: 'linear', inTangent: [1] },
  ];
  p.ikTracks!.push({
    id: id(),
    entityId: c.joints[0],
    chainId: c.id,
    actionId: parameterActionId,
    property: 'influence',
    keys: [{ id: id(), frame: 0, value: [1], interpolation: 'linear' }],
  });
  const layer = p.animationLayers![0];
  layer.start = 0;
  layer.fadeIn = 0;
  layer.fadeOut = 0;
  layer.weight = 1;
  near(sampleCurve(t, 5)![0], -2);
  near(evaluatedIK(p, c, 5).influence, 0);
  p.animationLayers!.push({ ...structuredClone(layer), id: id(), blend: 'replace' });
  near(evaluatedIK(parseProject(p), c, 5).influence, 1);
  const tangent: IKTrack = {
    ...structuredClone(t),
    keys: [
      { id: id(), frame: 0, value: [0.25], interpolation: 'cubic', outTangent: [-0.1] },
      { id: id(), frame: 10, value: [0.25], interpolation: 'linear', inTangent: [0.1] },
    ],
  };
  assert.deepEqual(scalarZeros(tangent), [5]);
});

test('parameter command lifecycle preserves key IDs and action copies, and cascades chain/action deletion', () => {
  const f = ikAnimationFixture();
  let p = f.p;
  const keyId = p.ikTracks![0].keys[0].id;
  p = applyCommands(p, [
    {
      type: 'ik.key.set',
      chainId: f.chainId,
      property: 'influence',
      key: { frame: 0, value: [0.3] },
    },
  ]).project;
  assert.equal(p.ikTracks![0].keys[0].id, keyId);
  const action = { id: id(), name: 'copy', sceneId: f.sceneId };
  p = applyCommands(p, [{ type: 'action.add', action, copyFrom: null }]).project;
  assert.equal(activeIKTracks(p, f.rootJointId).length, 2);
  assert.notEqual(activeIKTracks(p, f.rootJointId)[0].keys[0].id, keyId);
  p = applyCommands(p, [{ type: 'action.delete', id: action.id }]).project;
  assert.ok(p.ikTracks!.every((t) => t.actionId !== action.id));
  p = applyCommands(p, [{ type: 'ik.delete', id: f.chainId }]).project;
  assert.equal(p.ikTracks!.length, 0);
  const legacy = { ...f.p, schemaVersion: 14 };
  delete legacy.ikTracks;
  assert.deepEqual(migrateProject(legacy), { ...legacy, schemaVersion: PROJECT_VERSION });
});

test('independent GLTFLoader matches animated influence and pole layers at baked samples including zero influence', async () => {
  const { p, sceneId, meshId, cameraId } = ikAnimationFixture();
  assert.throws(() => exportGLB(p, sceneId, 0, new Map(), true), /烘焙/);
  const exported = exportGLB(p, sceneId, 0, new Map(), true, {
    start: 0,
    end: 48,
    step: 0.25,
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
  for (const frame of [0, 6.25, 12, 24, 36.5, 47]) {
    mixer.setTime(frame / 24);
    loaded.scene.updateMatrixWorld(true);
    skin.skeleton.update();
    const pose = sceneEvaluator(p, sceneId)(frame),
      expected = deformGeometry(geometry, mesh.skin!, pose.world);
    equalMatrices(loaded.cameras[0].matrixWorld.elements, pose.world.get(cameraId)!.elements, 1e-5);
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
