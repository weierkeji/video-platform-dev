import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { keyEditingFixture } from '../scripts/key-editing-fixture';
import { ikAnimationFixture } from '../scripts/ik-animation-fixture';
import { applyCommands, CommandSchema } from '../src/core/commands';
import { editedKeyTracks, type KeyBatch } from '../src/core/key-editing';
import { id, type Project, type AnimationTrack } from '../src/core/model';
import { sampleTrack, sampleCurve, keyHandles } from '../src/core/animation';
import { Store } from '../server/store';
import { exportGLB } from '../src/core/gltf';
import { AnimationMixer, LoopOnce, Vector3 } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { evaluatedTransform } from '../src/core/evaluate';
import { validateBytes } from 'gltf-validator';

const refs = (p: Project) =>
  [...p.animationTracks, ...(p.ikTracks || [])].flatMap((t) =>
    t.keys.map((k) => ({ trackId: t.id, keyId: k.id })),
  );
const transform = (p: Project, scale = 1, offset = 0, pivot = 0): KeyBatch => ({
  type: 'keys.transform',
  keys: refs(p),
  scale,
  offset,
  pivot,
});
const near = (a: number[], b: number[], epsilon = 1e-9) =>
  a.forEach((v, i) => assert.ok(Math.abs(v - b[i]) < epsilon, `${v} != ${b[i]}`));

test('time transforms are atomic across tracks, retain IDs and preserve Hermite, SLERP and linear motion', () => {
  const { p } = keyEditingFixture(),
    before = structuredClone(p);
  // Offset equals the existing key spacing: sequential key.update would collide.
  const moved = applyCommands(p, [transform(p, 1, 6)]).project;
  assert.deepEqual(
    moved.animationTracks[0].keys.map((k) => k.frame),
    [6, 12, 18, 24],
  );
  assert.deepEqual(p, before);
});

test('positive affine time maps preserve entire sampled curve and derivative units', () => {
  const { p } = keyEditingFixture(),
    before = structuredClone(p);
  const output = applyCommands(p, [transform(p, 2.5, 12, 6)]).project;
  for (let ti = 0; ti < p.animationTracks.length; ti++) {
    const old = p.animationTracks[ti],
      next = output.animationTracks[ti];
    assert.deepEqual(
      next.keys.map((k) => k.id),
      old.keys.map((k) => k.id),
    );
    for (let f = 0; f <= 18; f += 0.125)
      near(sampleTrack(next, 6 + (f - 6) * 2.5 + 12)!, sampleTrack(old, f)!);
  }
  near(
    output.animationTracks[0].keys[0].outTangent!,
    p.animationTracks[0].keys[0].outTangent!.map((v) => v / 2.5),
  );
  assert.deepEqual(p, before);
});

test('partial Bézier groups freeze automatic handles and preserve internal segments, including shortened handles', () => {
  for (const mode of ['auto-clamped', 'vector', 'aligned', 'free'] as const) {
    const { p } = keyEditingFixture(),
      t = p.animationTracks[0];
    t.keys.forEach((k, i) => {
      k.interpolation = 'bezier';
      delete k.inTangent;
      delete k.outTangent;
      k.handles = [0, 1, 2].map((axis) => ({
        mode,
        left: [-8, -(i + 1) * (axis + 1)],
        right: [8, (i + 1) * (axis + 1)],
      })) as NonNullable<typeof k.handles>;
    });
    const output = applyCommands(p, [
      {
        type: 'keys.transform',
        keys: t.keys.slice(1, 3).map((k) => ({ trackId: t.id, keyId: k.id })),
        scale: 0.5,
        offset: 0,
        pivot: 6,
      },
    ]).project;
    const next = output.animationTracks[0];
    for (let f = 6; f <= 12; f += 0.0625)
      near(sampleTrack(next, 6 + (f - 6) * 0.5)!, sampleTrack(t, f)!, 1e-8);
    assert.equal(next.keys[1].handles![0].mode, mode === 'aligned' ? 'aligned' : 'free');
    near(next.keys[1].handles![0].right, [
      keyHandles(t, 1, 0).right[0] * 0.5,
      keyHandles(t, 1, 0).right[1],
    ]);
    assert.deepEqual(next.keys[0], t.keys[0]);
  }
});

test('STEP, smooth and quaternion Hermite use the same time map without normalizing tangent vectors', () => {
  const { p } = keyEditingFixture();
  p.animationTracks[0].keys[0].interpolation = 'constant';
  p.animationTracks[0].keys[1].interpolation = 'smooth';
  const q = p.animationTracks[1];
  q.keys.forEach((k) => {
    k.interpolation = 'cubic';
    k.inTangent = [0.03, 0.01, 0, 0.002];
    k.outTangent = [-0.01, 0.02, 0.003, 0];
  });
  const out = applyCommands(p, [transform(p, 0.75, 2)]).project;
  for (const f of [0, 1, 5.999999, 6, 7.125, 11.999, 12, 17.5, 18])
    p.animationTracks.forEach((t, i) =>
      near(sampleTrack(t, f)!, sampleTrack(out.animationTracks[i], f * 0.75 + 2)!),
    );
});

test('collisions, invalid references, frame limits, precision collapse and tangent overflow reject the entire group', () => {
  const { p } = keyEditingFixture(),
    before = structuredClone(p),
    t = p.animationTracks[0];
  const commands: unknown[] = [
    { ...transform(p), keys: [{ trackId: t.id, keyId: t.keys[0].id }], offset: 6 },
    transform(p, 1, -1),
    transform(p, 1, 1e6),
    transform(p, 2, 3, 6),
    { ...transform(p), keys: [...refs(p), refs(p)[0]] },
    { ...transform(p), keys: [...refs(p), { trackId: t.id, keyId: 'missing' }] },
    { ...transform(p), scale: 0 },
    { ...transform(p), scale: -1 },
    { ...transform(p), scale: Infinity },
    { ...transform(p), overwrite: true },
  ];
  for (const c of commands) {
    assert.throws(() => applyCommands(p, [c]));
    assert.deepEqual(p, before);
  }
  const tiny = structuredClone(p);
  tiny.animationTracks[0].keys[1].frame = 1e-12;
  assert.throws(() => applyCommands(tiny, [transform(tiny, 1, 999900)]), /精度不足/);
  const overflow = structuredClone(p);
  overflow.animationTracks[0].keys[0].outTangent = [1000, 0, 0];
  assert.throws(() => applyCommands(overflow, [transform(overflow, 1e-6)]));
  assert.equal(CommandSchema.safeParse({ type: 'keys.delete', keys: [] }).success, false);
});

test('duplicate groups use supplied stable IDs; delete repairs cubic boundaries and removes empty tracks atomically', () => {
  const { p } = keyEditingFixture();
  const command = {
    ...transform(p, 1.5, 30),
    type: 'keys.duplicate' as const,
    keys: refs(p).map((k) => ({ ...k, newId: id() })),
  };
  const next = applyCommands(p, [command]).project;
  p.animationTracks.forEach((t, ti) => {
    assert.deepEqual(next.animationTracks[ti].keys.slice(0, 4), t.keys);
    for (let f = 0; f <= 18; f += 0.25)
      near(sampleTrack(t, f)!, sampleTrack(next.animationTracks[ti], f * 1.5 + 30)!);
  });
  const copies = command.keys.map((k) => ({ trackId: k.trackId, keyId: k.newId }));
  assert.deepEqual(
    applyCommands(next, [{ type: 'keys.delete', keys: copies }]).project.animationTracks,
    p.animationTracks,
  );
  assert.equal(
    applyCommands(p, [{ type: 'keys.delete', keys: refs(p) }]).project.animationTracks.length,
    0,
  );
  assert.throws(
    () =>
      applyCommands(p, [{ ...command, keys: command.keys.map((k) => ({ ...k, newId: 'same' })) }]),
    /ID/,
  );
  assert.throws(() => applyCommands(p, [{ ...command, offset: 0, scale: 1 }]), /目标帧/);
});

test('IK scalar and transform selections share atomic affine editing and sampled curve behavior', () => {
  const f = ikAnimationFixture(),
    p = f.p;
  const next = applyCommands(p, [transform(p, 1.5, 4)]).project;
  assert.ok(p.ikTracks!.length);
  p.ikTracks!.forEach((t, i) => {
    for (let f = 0; f < 48; f += 0.5)
      near(sampleCurve(t, f)!, sampleCurve(next.ikTracks![i], f * 1.5 + 4)!, 1e-8);
  });
});

test('SQLite history records one operation for a whole selection, survives restart and rejects failed writes', () => {
  const parent = resolve(tmpdir()),
    directory = mkdtempSync(join(parent, 'frameforge-keys-'));
  let store = new Store(directory);
  try {
    const { p } = keyEditingFixture(),
      created = store.create(p).project;
    const moved = store.change(
      p.id,
      created.revision,
      [transform(p, 1, 6)],
      'agent',
      'group move',
    ).project;
    assert.throws(() =>
      store.change(p.id, moved.revision, [transform(moved, 1, -100)], 'agent', 'invalid'),
    );
    assert.equal(store.get(p.id).project.revision, moved.revision);
    store.close();
    store = new Store(directory);
    assert.deepEqual(store.get(p.id).project.animationTracks, moved.animationTracks);
    const undone = store.change(p.id, moved.revision, undefined, 'user', 'undo', 'undo').project;
    assert.deepEqual(undone.animationTracks, p.animationTracks);
    const redone = store.change(p.id, undone.revision, undefined, 'user', 'redo', 'redo').project;
    assert.deepEqual(redone.animationTracks, moved.animationTracks);
  } finally {
    store.close();
    assert.ok(resolve(directory).startsWith(parent + sep));
    rmSync(directory, { recursive: true, force: true });
  }
});

test('native GLB retains retimed Hermite and quaternion motion in an independent animation mixer', async () => {
  const f = keyEditingFixture(),
    p = applyCommands(f.p, [transform(f.p, 1.5, 3)]).project;
  const out = exportGLB(p, f.sceneId, 0, new Map(), true);
  const report = await validateBytes(out.bytes);
  assert.equal(report.issues.numErrors, 0);
  assert.equal(report.issues.numWarnings, 0);
  const loaded = await new GLTFLoader().parseAsync(Uint8Array.from(out.bytes).buffer, '');
  const mixer = new AnimationMixer(loaded.scene),
    action = mixer.clipAction(loaded.animations[0]);
  action.setLoop(LoopOnce, 1);
  action.clampWhenFinished = true;
  action.play();
  const mesh = loaded.scene.getObjectByName('节奏方块')!;
  assert.ok(mesh);
  const entity = p.entities.find((e) => e.id === f.entityId)!;
  for (const frame of [3, 7.125, 12, 19.5, 21, 27, 30]) {
    mixer.setTime(frame / p.timeline.fps);
    loaded.scene.updateMatrixWorld(true);
    const expected = evaluatedTransform(p, entity, frame);
    near(mesh.position.toArray(), expected.position, 1e-6);
    near(mesh.scale.toArray(), expected.scale, 1e-6);
    near(mesh.quaternion.toArray(), expected.quaternion!, 1e-6);
    assert.ok(
      new Vector3()
        .setFromMatrixPosition(mesh.matrixWorld)
        .distanceTo(new Vector3(...expected.position)) < 1e-6,
    );
  }
});

test('duplicate limits and a late invalid track cannot partially apply a group', () => {
  const { p } = keyEditingFixture(),
    t = p.animationTracks[0];
  t.keys = Array.from({ length: 10000 }, (_, i) => ({
    id: id(),
    frame: i,
    value: [i / 10000, 0, 0],
    interpolation: 'linear',
  }));
  const before = structuredClone(p);
  assert.throws(() =>
    editedKeyTracks(p, {
      type: 'keys.duplicate',
      keys: [{ trackId: t.id, keyId: t.keys[0].id, newId: id() }],
      scale: 1,
      offset: 20000,
      pivot: 0,
    }),
  );
  const keys = [
    { trackId: p.animationTracks[1].id, keyId: p.animationTracks[1].keys[0].id },
    { trackId: t.id, keyId: t.keys[0].id },
  ];
  assert.throws(
    () => applyCommands(p, [{ type: 'keys.transform', keys, scale: 1, offset: 1, pivot: 0 }]),
    /目标帧/,
  );
  assert.deepEqual(p, before);
});

test('batch edits preserve unrelated empty channels and do not modify another action', () => {
  const { p, cameraId } = keyEditingFixture();
  const empty: AnimationTrack = { id: id(), entityId: cameraId, property: 'position', keys: [] };
  const command = transform(p, 1, 6);
  p.animationTracks.push(empty);
  const action = { id: id(), sceneId: p.scenes[0].id, name: 'Other action' };
  p.animationActions = [action];
  const other = { ...structuredClone(p.animationTracks[0]), id: id(), actionId: action.id };
  p.animationTracks.push(other);
  const next = applyCommands(p, [command]).project;
  assert.deepEqual(
    next.animationTracks.find((t) => t.id === empty.id),
    empty,
  );
  assert.deepEqual(
    next.animationTracks.find((t) => t.id === other.id),
    other,
  );
});
