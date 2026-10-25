import { ikFixture } from './ik-fixture';
import { applyCommands, type Command } from '../src/core/commands';
import { id } from '../src/core/model';
import { evaluatedBaseTransform } from '../src/core/evaluate';

/** Original sculpture alternating target control and directly authored joint motion. */
export function ikMatchFixture() {
  const f = ikFixture();
  let p = f.p;
  p.name = 'FK IK 姿态接续';
  p.scenes[0].name = 'Matched controls';
  const joint = p.entities.find((e) => e.id === f.elbowId)!;
  p = applyCommands(p, [
    {
      type: 'rig.rest.update',
      preserveShape: true,
      updates: [
        { entityId: joint.id, transform: { ...joint.transform, rotation: [0.1, -0.15, 0.2] } },
      ],
    },
  ]).project;
  const chain = p.ikChains![0];
  const start: Command[] = chain.joints.flatMap((entityId) => {
    const e = p.entities.find((e) => e.id === entityId)!;
    return (['position', 'rotation', 'scale'] as const).map(
      (property): Command => ({
        type: 'key.set',
        entityId,
        property,
        key: { frame: 0, value: e.transform[property], interpolation: 'constant' },
      }),
    );
  });
  start.push({
    type: 'ik.key.set',
    chainId: chain.id,
    property: 'influence',
    key: { frame: 0, value: [1], interpolation: 'constant' },
  });
  start.push({
    type: 'key.set',
    entityId: f.poleId,
    property: 'position',
    key: {
      frame: 0,
      value: p.entities.find((e) => e.id === f.poleId)!.transform.position,
      interpolation: 'constant',
    },
  });
  p = applyCommands(p, start).project;
  p = applyCommands(p, [
    { type: 'ik.match', chainId: chain.id, frame: 12, mode: 'fk', interpolation: 'linear' },
  ]).project;
  const t = evaluatedBaseTransform(p, p.entities.find((e) => e.id === f.elbowId)!, 12);
  p = applyCommands(p, [
    {
      type: 'ik.key.set',
      chainId: chain.id,
      property: 'influence',
      key: { frame: 12, value: [0], interpolation: 'constant' },
    },
    {
      type: 'key.set',
      entityId: f.elbowId,
      property: 'rotation',
      key: {
        frame: 24,
        value: [t.rotation[0] + 0.25, t.rotation[1] - 0.1, t.rotation[2] + 0.3],
        interpolation: 'constant',
      },
    },
  ]).project;
  p = applyCommands(p, [
    { type: 'ik.match', chainId: chain.id, frame: 36, mode: 'ik', interpolation: 'linear' },
  ]).project;
  p = applyCommands(p, [
    {
      type: 'ik.key.set',
      chainId: chain.id,
      property: 'influence',
      key: { frame: 36, value: [1], interpolation: 'constant' },
    },
  ]).project;
  // Keep source identity independent from future imports and bakes.
  p.name += ' ' + id().slice(0, 6);
  return { ...f, p };
}
