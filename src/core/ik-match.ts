import { Euler, Matrix4, Quaternion, Vector3 } from 'three';
import type { Command } from './commands';
import type { Entity, IKChain, Project, Vec3, Vec4 } from './model';
import {
  activeTracks,
  quaternionFromEuler,
  rotationProperty,
  sampleCurve,
  sampleTrack,
  slerp,
} from './animation';
import { activeConstraints, matrixTransform, localBasis, sceneEvaluator } from './constraints';
import { evaluatedBaseTransform, evaluatedTransform } from './evaluate';
import { activeIKTracks, evaluatedIK } from './ik-animation';
import { layerSourceFrame, layerWeight } from './layers';
import { suggestedPole } from './ik';

type Transform = Entity['transform'];
export type MatchOptions = {
  chainId: string;
  frame: number;
  mode: 'fk' | 'ik';
  interpolation: 'constant' | 'linear';
};
const position = (m: Matrix4) => new Vector3().setFromMatrixPosition(m);
const quaternion = (t: Transform) => t.quaternion || quaternionFromEuler(t.rotation);
const qDistance = (a: Vec4, b: Vec4) => 1 - Math.abs(a.reduce((sum, v, i) => sum + v * b[i], 0));
const close = (a: number[], b: number[], tolerance = 1e-7) =>
  a.every((v, i) => Math.abs(v - b[i]) <= tolerance * Math.max(1, Math.abs(v), Math.abs(b[i])));
function inverseSlerp(out: Vec4, target: Vec4, weight: number): Vec4 {
  const dot = out.reduce((sum, v, i) => sum + v * target[i], 0);
  const b = (dot < 0 ? target.map((v) => -v) : target) as Vec4;
  const d = Math.min(1, Math.abs(dot)),
    a = 1 - weight;
  const discriminant = a * a - weight * weight * (1 - d * d);
  if (discriminant >= 0) {
    const length = weight * d + Math.sqrt(discriminant);
    const candidate = out.map((v, i) => (length * v - weight * b[i]) / a) as Vec4;
    if (candidate.reduce((sum, v, i) => sum + v * b[i], 0) > 0.9995)
      return new Quaternion(...candidate).normalize().toArray();
  }
  return new Quaternion(...b)
    .slerp(new Quaternion(...out), 1 / a)
    .normalize()
    .toArray();
}
function inverse(m: Matrix4) {
  if (m.elements.some((v) => !Number.isFinite(v)) || Math.abs(m.determinant()) < 1e-12)
    throw new Error('匹配所需的父级或基础参考不可逆');
  return m.clone().invert();
}

/** Invert this platform's ordered layer operations; no layer is disabled or rewritten. */
function unlayer(p: Project, e: Entity, frame: number, desired: Transform) {
  const result = structuredClone(desired),
    layers = p.animationLayers || [];
  for (let i = layers.length - 1; i >= 0; i--) {
    const layer = layers[i],
      weight = layerWeight(layer, frame);
    if (layer.entityId !== e.id || !weight) continue;
    for (const track of activeTracks(p, e.id, layer.actionId)) {
      const channel = track.property === 'quaternion' ? 'rotation' : track.property;
      if (!layer.channels.includes(channel)) continue;
      const sample = sampleTrack(track, layerSourceFrame(layer, frame));
      if (!sample) continue;
      if (channel === 'rotation') {
        const target =
          track.property === 'quaternion' ? (sample as Vec4) : quaternionFromEuler(sample as Vec3);
        const out = quaternion(result);
        if (layer.blend === 'additive') {
          const delta = new Quaternion(...quaternion(e.transform))
            .invert()
            .multiply(new Quaternion(...target))
            .normalize()
            .toArray();
          result.quaternion = new Quaternion(...out)
            .multiply(new Quaternion(...slerp([0, 0, 0, 1], delta, weight)).invert())
            .normalize()
            .toArray();
        } else if (weight >= 1 - 1e-10) {
          if (qDistance(out, target) > 1e-10)
            throw new Error(`“${e.name}”的全权重替换层阻止旋转匹配，请调整该层`);
          result.quaternion = quaternion(
            evaluatedTransform({ ...p, animationLayers: layers.slice(0, i) }, e, frame),
          );
        } else {
          // Reverse shortest-arc interpolation, then verify through the actual forward evaluator.
          const q = inverseSlerp(out, target, weight);
          if (qDistance(slerp(q, target, weight), out) > 1e-10)
            throw new Error(`“${e.name}”的旋转替换层无法在最短弧内反算匹配`);
          result.quaternion = q;
        }
      } else if (layer.blend === 'additive') {
        result[channel] = result[channel].map(
          (v, axis) => v - weight * (sample[axis] - e.transform[channel][axis]),
        ) as Vec3;
      } else if (weight >= 1 - 1e-10) {
        if (!close(result[channel], sample))
          throw new Error(`“${e.name}”的全权重替换层阻止 ${channel} 匹配，请调整该层`);
        result[channel] = evaluatedTransform(
          { ...p, animationLayers: layers.slice(0, i) },
          e,
          frame,
        )[channel];
      } else
        result[channel] = result[channel].map(
          (v, axis) => (v - weight * sample[axis]) / (1 - weight),
        ) as Vec3;
    }
  }
  return result;
}

function parameterInput(
  p: Project,
  chain: IKChain,
  frame: number,
  property: 'influence' | 'poleAngle',
  desired: number,
) {
  let value = desired;
  const layers = p.animationLayers || [];
  for (let i = layers.length - 1; i >= 0; i--) {
    const layer = layers[i],
      weight = layerWeight(layer, frame);
    if (layer.entityId !== chain.joints[0] || !layer.channels.includes('ik') || !weight) continue;
    const track = activeIKTracks(p, layer.entityId, layer.actionId).find(
      (t) => t.chainId === chain.id && t.property === property,
    );
    const sample = track && sampleCurve(track, layerSourceFrame(layer, frame))?.[0];
    if (sample === undefined) continue;
    if (layer.blend === 'additive') value -= weight * (sample - chain[property]);
    else if (weight >= 1 - 1e-10) {
      if (Math.abs(value - sample) > 1e-9) throw new Error('全权重 IK 参数层阻止切换，请调整该层');
      value = evaluatedIK({ ...p, animationLayers: layers.slice(0, i) }, chain, frame)[property];
    } else value = (value - weight * sample) / (1 - weight);
  }
  if (!Number.isFinite(value) || (property === 'influence' && (value < -1e-9 || value > 1 + 1e-9)))
    throw new Error('IK 参数层使匹配所需的影响键超出 0…1，请调整层权重或参数');
  return property === 'influence' ? Math.max(0, Math.min(1, value)) : value;
}

/** Choose the equivalent XYZ branch nearest the currently authored channel. */
function nearestEuler(q: Vec4, reference: Vec3): Vec3 {
  const e = new Euler().setFromQuaternion(new Quaternion(...q), 'XYZ');
  const choices = [
    [e.x, e.y, e.z],
    [e.x + Math.PI, Math.PI - e.y, e.z + Math.PI],
  ];
  return choices
    .map(
      (v) =>
        v.map((n, i) => n + Math.round((reference[i] - n) / (2 * Math.PI)) * 2 * Math.PI) as Vec3,
    )
    .sort(
      (a, b) =>
        a.reduce((sum, n, i) => sum + (n - reference[i]) ** 2, 0) -
        b.reduce((sum, n, i) => sum + (n - reference[i]) ** 2, 0),
    )[0];
}

export function planIKMatch(p: Project, options: MatchOptions) {
  const { frame, mode, interpolation } = options,
    chain = p.ikChains?.find((c) => c.id === options.chainId);
  if (!chain) throw new Error('IK 链不存在');
  if (!chain.enabled) throw new Error('请先启用 IK 链；零影响可使用 FK 匹配');
  const source = sceneEvaluator(p, chain.sceneId)(frame),
    byId = new Map(p.entities.map((e) => [e.id, e]));
  if (evaluatedIK(p, chain, frame).influence > 0 && !source.ik.some((s) => s.chainId === chain.id))
    throw new Error('当前 IK 求解失败，不能把回退姿态用于匹配');
  const expected = new Map(chain.joints.map((id) => [id, source.world.get(id)!.clone()]));
  const controls = new Map<string, Matrix4>();
  if (mode === 'ik') {
    controls.set(
      chain.targetId,
      source.world
        .get(chain.targetId)!
        .clone()
        .setPosition(position(expected.get(chain.joints.at(-1)!)!)),
    );
    if (chain.poleId) {
      if (chain.poleId === chain.targetId) throw new Error('匹配需要不同的目标和极向对象');
      const points = [...expected.values()].map(position);
      // A folded two-link limb has no root-to-tip axis. Its elbow supplies the radial direction.
      const pole =
        points[0].distanceTo(points.at(-1)!) < 1e-10
          ? points[1].clone().sub(points[0]).multiplyScalar(1.4).add(points[0])
          : suggestedPole(points);
      controls.set(chain.poleId, source.world.get(chain.poleId)!.clone().setPosition(pole));
    }
  }
  const desiredWorld = new Map([...expected, ...controls]);
  const parentWorld = (id: string): Matrix4 => {
    if (desiredWorld.has(id)) return desiredWorld.get(id)!;
    const e = byId.get(id)!;
    const m = (e.parentId ? parentWorld(e.parentId) : new Matrix4())
      .clone()
      .multiply(source.local.get(id)!);
    desiredWorld.set(id, m);
    return m;
  };
  const without = {
    ...p,
    ikChains: p.ikChains!.map((c) => (c.id === chain.id ? { ...c, enabled: false } : c)),
  };
  const inputPose = sceneEvaluator(without, chain.sceneId)(frame);
  const commands: Command[] = [];
  for (const [id, desired] of [...expected, ...controls]) {
    const e = byId.get(id)!;
    if (source.warnings.some((w) => w.entityId === id && w.constraintId !== chain.id))
      throw new Error(`“${e.name}”有求值诊断，请先处理后匹配`);
    const local = inverse(e.parentId ? parentWorld(e.parentId) : new Matrix4()).multiply(desired);
    let channel: Transform;
    if (activeConstraints(e).length) {
      if (!close(local.elements, inputPose.local.get(id)!.elements, 1e-9))
        throw new Error(`“${e.name}”的普通约束阻止原频道匹配，请调整约束或烘焙；本次没有修改`);
      channel = evaluatedBaseTransform(p, e, frame);
    } else
      channel = unlayer(
        p,
        e,
        frame,
        matrixTransform(inverse(localBasis(e)).multiply(local), e.name),
      );
    const base = evaluatedBaseTransform(p, e, frame),
      rotation = rotationProperty(p, e);
    const q = quaternion(channel),
      old = quaternion(base);
    if (q.reduce((sum, v, i) => sum + v * old[i], 0) < 0)
      channel.quaternion = q.map((v) => -v) as Vec4;
    else channel.quaternion = q;
    channel.rotation = nearestEuler(channel.quaternion, base.rotation);
    const properties = controls.has(id)
      ? (['position'] as const)
      : (['position', rotation, 'scale'] as const);
    for (const property of properties) {
      const previous = activeTracks(p, id)
        .find((t) => t.property === property)
        ?.keys.find((k) => k.frame === frame);
      commands.push({
        type: 'key.set',
        entityId: id,
        property,
        key: {
          frame,
          value: channel[property]!,
          interpolation: previous?.interpolation || interpolation,
        },
      });
    }
  }
  for (const [property, desired] of (mode === 'ik'
    ? [
        ['influence', 1],
        ['poleAngle', 0],
      ]
    : [['influence', 0]]) as ['influence' | 'poleAngle', number][]) {
    const previous = activeIKTracks(p, chain.joints[0])
      .find((t) => t.chainId === chain.id && t.property === property)
      ?.keys.find((k) => k.frame === frame);
    commands.push({
      type: 'ik.key.set',
      chainId: chain.id,
      property,
      key: {
        frame,
        value: [parameterInput(p, chain, frame, property, desired)],
        interpolation: previous?.interpolation || interpolation,
      },
    });
  }
  return { commands, expected, controls, sceneId: chain.sceneId, options };
}

/** Transaction gate: verify full joint matrices, including orientation/scale, not just the tip. */
export function verifyIKMatch(p: Project, plan: ReturnType<typeof planIKMatch>) {
  const { frame, mode, chainId } = plan.options,
    pose = sceneEvaluator(p, plan.sceneId)(frame);
  const chain = p.ikChains!.find((c) => c.id === chainId)!;
  if (Math.abs(evaluatedIK(p, chain, frame).influence - (mode === 'ik' ? 1 : 0)) > 1e-8)
    throw new Error('参数层或动作自引用阻止 IK 影响切换，本次匹配未保存');
  if (
    mode === 'ik' &&
    (!pose.ik.some((s) => s.chainId === chainId && s.converged) ||
      pose.warnings.some((w) => w.constraintId === chainId))
  )
    throw new Error('匹配后的 IK 未达到容差，请检查限角、退化骨段和极向');
  for (const [id, expected] of plan.expected) {
    const actual = pose.world.get(id)!;
    const error = position(expected).distanceTo(position(actual));
    const linear = [0, 1, 2, 4, 5, 6, 8, 9, 10].every(
      (i) =>
        Math.abs(expected.elements[i] - actual.elements[i]) <=
        1e-6 * Math.max(1, Math.abs(expected.elements[i])),
    );
    if (!Number.isFinite(error) || error > 1e-5 || !linear)
      throw new Error(
        `“${p.entities.find((e) => e.id === id)!.name}”匹配后仍有姿态偏差，位置差 ${error.toPrecision(4)} 米；限角、极向、动作层或局部剪切可能无法表达该姿态，本次没有修改`,
      );
  }
  for (const [id, expected] of plan.controls)
    if (position(expected).distanceTo(position(pose.world.get(id)!)) > 1e-5)
      throw new Error('控制器受父级、动作层或约束影响，无法达到匹配位置，本次没有修改');
  return pose;
}
