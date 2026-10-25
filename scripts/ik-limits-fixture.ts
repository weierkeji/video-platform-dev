import { Matrix4, Quaternion, Vector3 } from 'three';
import { ikFixture } from './ik-fixture';
import { applyCommands } from '../src/core/commands';
import { sceneEvaluator } from '../src/core/constraints';
import { id, parseProject, type Vec3 } from '../src/core/model';

/** Original limited sculpture. Target keys come from explicitly authored legal poses. */
export function ikLimitsFixture() {
  const fixture = ikFixture();
  let p = fixture.p;
  p.name = '受限 IK 雕塑';
  p.scenes[0].name = 'Limited reach';
  p = applyCommands(p, [
    {
      type: 'ik.limit.capture',
      chainId: fixture.chainId,
      jointId: fixture.rootJointId,
      frame: 0,
      kind: 'cone',
    },
    {
      type: 'ik.limit.capture',
      chainId: fixture.chainId,
      jointId: fixture.elbowId,
      frame: 0,
      kind: 'hinge',
    },
  ]).project;
  const chain = p.ikChains![0];
  chain.name = 'Limited sculpture';
  chain.iterations = 64;
  chain.limits![0].swing = (65 * Math.PI) / 180;
  chain.limits![0].min = (-35 * Math.PI) / 180;
  chain.limits![0].max = (35 * Math.PI) / 180;
  chain.limits![1].max = (110 * Math.PI) / 180;
  const scope = structuredClone(p);
  scope.ikChains![0].enabled = false;
  const parent = sceneEvaluator(scope, fixture.sceneId)(0).world.get(fixture.root)!;
  const target = (swing: number, twist: number, hinge: number): Vec3 => {
    const rotation = new Quaternion()
      .setFromAxisAngle(new Vector3(0, 0, 1), (swing * Math.PI) / 180)
      .multiply(new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), (twist * Math.PI) / 180));
    const m = parent
      .clone()
      .multiply(new Matrix4().makeRotationFromQuaternion(rotation))
      .multiply(new Matrix4().makeTranslation(0, 1.2, 0))
      .multiply(new Matrix4().makeRotationZ((hinge * Math.PI) / 180))
      .multiply(new Matrix4().makeTranslation(0, 1.2, 0));
    return new Vector3().setFromMatrixPosition(m).toArray();
  };
  p.animationTracks = [
    {
      id: id(),
      entityId: fixture.targetId,
      property: 'position',
      keys: [
        { id: id(), frame: 0, value: target(-35, 15, 30), interpolation: 'linear' },
        { id: id(), frame: 24, value: target(20, -20, 100), interpolation: 'linear' },
        { id: id(), frame: 48, value: target(-10, 10, 60), interpolation: 'linear' },
      ],
    },
  ];
  return { ...fixture, p: parseProject(p) };
}
