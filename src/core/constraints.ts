import { affineParts, blendAffine } from './affine';
import { Euler, Matrix4, Quaternion, Vector3 } from 'three';
import type { Constraint, Entity, IKChain, IKTrack, Project, Vec3, Vec4 } from './model';
import { evaluatedIK } from './ik-animation';
import { evaluatedTransform } from './evaluate';
import { solveIK } from './ik';
import { limitAngles, projectJointMatrix } from './joint-limits';

export const activeConstraints = (e: Entity) =>
  (e.constraints || []).filter((c) => c.enabled && c.influence > 0);

export const activeIK = (chains: IKChain[] = [], tracks: IKTrack[] = []) =>
  chains.filter(
    (c) =>
      c.enabled &&
      (c.influence > 0 ||
        tracks.some((t) => t.chainId === c.id && t.property === 'influence' && t.keys.length)),
  );
export function drivenEntities(p: Project, sceneId?: string) {
  return new Set([
    ...p.entities
      .filter(
        (e) =>
          (!sceneId || e.sceneId === sceneId) &&
          (activeConstraints(e).length || e.restPose?.enabled || e.parentOffset?.enabled),
      )
      .map((e) => e.id),
    ...activeIK(p.ikChains, p.ikTracks)
      .filter((c) => !sceneId || c.sceneId === sceneId)
      .flatMap((c) => c.joints),
  ]);
}
type EvaluationUnit = { id: string; name: string; entities: Entity[]; chain?: IKChain };
function sortedUnits(units: EvaluationUnit[], input: Map<string, Set<string>>) {
  const byId = new Map(units.map((u) => [u.id, u]));
  const dependencies = new Map([...input].map(([id, deps]) => [id, new Set(deps)]));
  const followers = new Map<string, string[]>();
  for (const [id, deps] of dependencies)
    for (const target of deps) {
      if (!byId.has(target)) throw new Error('对象依赖不存在');
      const list = followers.get(target) || [];
      list.push(id);
      followers.set(target, list);
    }
  const ready = units.filter((u) => !dependencies.get(u.id)!.size).map((u) => u.id);
  const order: EvaluationUnit[] = [];
  for (let i = 0; i < ready.length; i++) {
    const id = ready[i];
    order.push(byId.get(id)!);
    for (const child of followers.get(id) || []) {
      const deps = dependencies.get(child)!;
      deps.delete(id);
      if (!deps.size) ready.push(child);
    }
  }
  if (order.length !== units.length) {
    let next = units.find((u) => dependencies.get(u.id)!.size)!.id;
    const path: string[] = [];
    while (!path.includes(next)) {
      path.push(next);
      next = [...dependencies.get(next)!][0];
    }
    const cycle = [...path.slice(path.indexOf(next)), next].map((id) => byId.get(id)!.name);
    throw new Error(`对象约束/父级/IK 依赖存在循环：${cycle.join(' → ')}`);
  }
  return order;
}

/** Chain members are one write group. Every outside reader waits for its final pose. */
export function dependencyOrder(
  entities: Entity[],
  chains: IKChain[] = [],
  tracks: IKTrack[] = [],
) {
  const byId = new Map(entities.map((e) => [e.id, e]));
  const dependencies = new Map<string, Set<string>>();
  for (const e of entities) {
    for (const c of e.constraints || []) {
      const target = byId.get(c.targetId);
      if (!target || target.sceneId !== e.sceneId) throw new Error('约束目标必须属于同一场景');
      if (target.id === e.id) throw new Error('约束不能引用对象自身');
      if (
        c.type === 'aim' &&
        (c.trackAxis.replace('-', '') === c.upAxis || Math.hypot(...c.worldUp) < 1e-8)
      )
        throw new Error('朝向轴和向上轴必须不同，世界向上向量不能为零');
    }
    const deps = new Set([
      ...(e.parentId ? [e.parentId] : []),
      ...activeConstraints(e).map((c) => c.targetId),
    ]);
    dependencies.set(e.id, deps);
  }
  const plain = entities.map((e) => ({ id: e.id, name: e.name, entities: [e] }));
  const order = sortedUnits(plain, dependencies);
  for (const chain of chains) {
    if (new Set(chain.joints).size !== chain.joints.length) throw new Error('IK 链节点不能重复');
    for (const id of [...chain.joints, chain.targetId, ...(chain.poleId ? [chain.poleId] : [])])
      if (byId.get(id)?.sceneId !== chain.sceneId)
        throw new Error('IK 链、目标与极向对象必须属于同一场景');
    for (let i = 1; i < chain.joints.length; i++)
      if (byId.get(chain.joints[i])!.parentId !== chain.joints[i - 1])
        throw new Error('IK 链必须沿直接父子关系连续排列');
    const seen = new Set<string>();
    for (const limit of chain.limits || []) {
      if (!chain.joints.slice(0, -1).includes(limit.jointId) || seen.has(limit.jointId))
        throw new Error('IK 限角必须唯一引用链内非末端节点');
      seen.add(limit.jointId);
      if (limit.min > limit.max) throw new Error('IK 限角下限不能大于上限');
      if (Math.hypot(...limit.axis) < 1e-8 || Math.hypot(...limit.reference) < 1e-8)
        throw new Error('IK 限角轴和参考四元数不能为零');
    }
  }
  const active = activeIK(chains, tracks);
  if (!active.length) return order;
  const membership = new Map<string, IKChain>();
  for (const chain of active)
    for (const id of chain.joints) {
      if (membership.has(id)) throw new Error('启用的 IK 链不能共享节点；请停用重叠链');
      membership.set(id, chain);
    }
  const units = new Map<string, EvaluationUnit>(),
    grouped = new Map<string, Set<string>>();
  const unitId = (id: string) => membership.get(id)?.id || id;
  for (const e of entities) {
    const chain = membership.get(e.id),
      id = unitId(e.id);
    if (!units.has(id)) {
      units.set(
        id,
        chain
          ? {
              id,
              name: `IK ${chain.name}`,
              entities: chain.joints.map((id) => byId.get(id)!),
              chain,
            }
          : { id, name: e.name, entities: [e] },
      );
      grouped.set(id, new Set());
    }
    for (const dep of dependencies.get(e.id)!)
      if (unitId(dep) !== id) grouped.get(id)!.add(unitId(dep));
  }
  for (const chain of active) {
    const deps = grouped.get(chain.id)!;
    deps.add(unitId(chain.targetId));
    if (chain.poleId) deps.add(unitId(chain.poleId));
  }
  return sortedUnits([...units.values()], grouped);
}

export function transformMatrix(t: Entity['transform']) {
  return new Matrix4().compose(
    new Vector3(...t.position),
    t.quaternion
      ? new Quaternion(...t.quaternion)
      : new Quaternion().setFromEuler(new Euler(...t.rotation, 'XYZ')),
    new Vector3(...t.scale),
  );
}

/** Preserve authored channel coordinates while editing their rest basis. */
export function restDelta(e: Entity) {
  if (!e.restPose?.enabled) return new Matrix4();
  const reference = transformMatrix(e.restPose.reference);
  if (Math.abs(reference.determinant()) < 1e-12) throw new Error('基础姿态的频道参考不可逆');
  return transformMatrix(e.restPose.transform).multiply(reference.invert());
}

/** Physical parent-relative local = attachment basis × rest delta × authored channels. */
export const parentBasis = (e: Entity) =>
  e.parentOffset?.enabled ? new Matrix4().fromArray(e.parentOffset.matrix) : new Matrix4();
export const localBasis = (e: Entity) => parentBasis(e).multiply(restDelta(e));

const axes = { x: new Vector3(1, 0, 0), y: new Vector3(0, 1, 0), z: new Vector3(0, 0, 1) };
function projectedUp(forward: Vector3, up: Vector3) {
  const projected = up.clone().addScaledVector(forward, -up.dot(forward));
  if (projected.lengthSq() < 1e-16) {
    const fallback = Object.values(axes).reduce((best, v) =>
      Math.abs(v.dot(forward)) < Math.abs(best.dot(forward)) ? v : best,
    );
    return fallback.clone().addScaledVector(forward, -fallback.dot(forward)).normalize();
  }
  return projected.normalize();
}
function aim(matrix: Matrix4, target: Matrix4, c: Extract<Constraint, { type: 'aim' }>) {
  const position = new Vector3().setFromMatrixPosition(matrix);
  const forward = new Vector3().setFromMatrixPosition(target).sub(position);
  if (forward.lengthSq() < 1e-16) throw new Error('朝向目标与对象重合；该约束本帧未应用');
  forward.normalize();
  const axis = c.trackAxis.replace('-', '') as keyof typeof axes;
  const oldForward = new Vector3()
    .setFromMatrixColumn(matrix, 'xyz'.indexOf(axis))
    .multiplyScalar(c.trackAxis.startsWith('-') ? -1 : 1);
  const oldUp = new Vector3().setFromMatrixColumn(matrix, 'xyz'.indexOf(c.upAxis));
  if (
    oldForward.lengthSq() < 1e-24 ||
    oldUp.lengthSq() < 1e-24 ||
    new Vector3().crossVectors(oldForward, oldUp).lengthSq() < 1e-24
  )
    throw new Error('朝向轴退化；该约束本帧未应用');
  oldForward.normalize();
  const fromUp = projectedUp(oldForward, oldUp.normalize()),
    toUp = projectedUp(forward, new Vector3(...c.worldUp).normalize());
  const from = new Matrix4().makeBasis(
      oldForward,
      fromUp,
      new Vector3().crossVectors(oldForward, fromUp),
    ),
    to = new Matrix4().makeBasis(forward, toUp, new Vector3().crossVectors(forward, toUp));
  const rotation = new Quaternion()
    .setFromRotationMatrix(to.multiply(from.transpose()))
    .normalize();
  const delta = new Quaternion().slerp(rotation, c.influence);
  return new Matrix4()
    .makeRotationFromQuaternion(delta)
    .multiply(matrix.clone().setPosition(0, 0, 0))
    .setPosition(position);
}

export function matrixTransform(m: Matrix4, label: string): Entity['transform'] {
  const parts = affineParts(m);
  if (!parts) throw new Error(`对象“${label}”的局部矩阵退化，无法保存为 TRS；请调整缩放或约束`);
  const [sx, sy, sz, xy, xz, yz] = parts.upper;
  if (
    Math.max(Math.abs(xy), Math.abs(xz), Math.abs(yz)) >
    1e-7 * Math.max(1, Math.abs(sx), Math.abs(sy), Math.abs(sz))
  )
    throw new Error(
      `对象“${label}”的局部变换包含剪切，TRS 动作/GLB 无法保真表达；请调整父级非均匀缩放或驱动设置，项目与影片仍保留实际结果`,
    );
  return {
    position: parts.position.toArray() as Vec3,
    quaternion: parts.rotation.toArray() as Vec4,
    rotation: new Euler().setFromQuaternion(parts.rotation, 'XYZ').toArray().slice(0, 3) as Vec3,
    scale: [sx, sy, sz],
  };
}

/** One compiler per immutable project/scene, one deterministic evaluation per frame. */
export function sceneEvaluator(p: Project, sceneId: string) {
  const entities = p.entities.filter((e) => e.sceneId === sceneId),
    byId = new Map(entities.map((e) => [e.id, e]));
  const order = dependencyOrder(
    entities,
    p.ikChains?.filter((c) => c.sceneId === sceneId),
    p.ikTracks,
  );
  const driven = drivenEntities(p, sceneId);
  const restMatrices = new Map(
    entities
      .filter((e) => e.restPose?.enabled || e.parentOffset?.enabled)
      .map((e) => [e.id, localBasis(e)]),
  );
  return (frame?: number, actionId?: string | null, layers = true) => {
    const local = new Map<string, Matrix4>(),
      world = new Map<string, Matrix4>();
    const warnings: { entityId: string; constraintId: string; message: string }[] = [];
    const ik: {
      chainId: string;
      residual: number;
      appliedResidual: number;
      iterations: number;
      reachable: boolean | null;
      converged: boolean;
      method: string;
      stop: string;
      limits: { jointId: string; swing: number; twist: number }[];
    }[] = [];
    for (const unit of order) {
      for (const e of unit.entities) {
        const parent = e.parentId ? world.get(e.parentId)! : new Matrix4();
        let matrix = transformMatrix(
          frame === undefined ? e.transform : evaluatedTransform(p, e, frame, actionId, layers),
        );
        if (restMatrices.has(e.id)) matrix.premultiply(restMatrices.get(e.id)!);
        for (const c of activeConstraints(e)) {
          try {
            const worldSpace = c.type === 'aim' || c.ownerSpace === 'world';
            if (worldSpace && Math.abs(parent.determinant()) < 1e-12)
              throw new Error('父级矩阵不可逆；世界空间约束本帧未应用');
            const input = worldSpace ? parent.clone().multiply(matrix) : matrix;
            let output: Matrix4;
            if (c.type === 'aim') output = aim(input, world.get(c.targetId)!, c);
            else {
              const target = (c.targetSpace === 'world' ? world : local).get(c.targetId)!;
              output =
                c.type === 'copy-position'
                  ? input
                      .clone()
                      .setPosition(
                        new Vector3()
                          .setFromMatrixPosition(input)
                          .lerp(new Vector3().setFromMatrixPosition(target), c.influence),
                      )
                  : blendAffine(input, target, c.influence);
            }
            const candidate = worldSpace ? parent.clone().invert().multiply(output) : output;
            if (candidate.elements.some((v) => !Number.isFinite(v)))
              throw new Error('约束产生非有限矩阵；该约束本帧未应用');
            matrix = candidate;
          } catch (error) {
            warnings.push({
              entityId: e.id,
              constraintId: c.id,
              message: error instanceof Error ? error.message : String(error),
            });
          }
        }
        local.set(e.id, matrix);
        world.set(e.id, parent.clone().multiply(matrix));
      }
      if (unit.chain) {
        const chain =
          frame === undefined ? unit.chain : evaluatedIK(p, unit.chain, frame, actionId, layers);
        if (chain.influence <= 0) continue;
        try {
          const solution = solveIK(chain, byId, local, world);
          const changedLocal = new Map<string, Matrix4>(),
            changedWorld = new Map<string, Matrix4>();
          for (const e of unit.entities) {
            const matrix = projectJointMatrix(
              blendAffine(local.get(e.id)!, solution.matrices.get(e.id)!, chain.influence),
              chain.limits?.find((l) => l.jointId === e.id),
            );
            const parent = e.parentId
              ? changedWorld.get(e.parentId) || world.get(e.parentId)!
              : new Matrix4();
            if (matrix.elements.some((v) => !Number.isFinite(v)))
              throw new Error('IK 混合产生非有限矩阵；本帧保留输入姿态');
            const candidateWorld = parent.clone().multiply(matrix);
            if (candidateWorld.elements.some((v) => !Number.isFinite(v)))
              throw new Error('IK 世界矩阵非有限；本帧保留输入姿态');
            changedLocal.set(e.id, matrix);
            changedWorld.set(e.id, candidateWorld);
          }
          changedLocal.forEach((m, id) => local.set(id, m));
          changedWorld.forEach((m, id) => world.set(id, m));
          const appliedResidual = new Vector3()
            .setFromMatrixPosition(world.get(chain.joints.at(-1)!)!)
            .distanceTo(new Vector3().setFromMatrixPosition(world.get(chain.targetId)!));
          ik.push({
            chainId: chain.id,
            residual: solution.residual,
            appliedResidual,
            iterations: solution.iterations,
            reachable: solution.reachable,
            converged: solution.converged,
            method: solution.method,
            stop: solution.stop,
            limits: (chain.limits || [])
              .filter((l) => l.enabled)
              .map((l) => {
                const angles = limitAngles(affineParts(local.get(l.jointId)!)!.rotation, l);
                return { jointId: l.jointId, swing: angles.swing, twist: angles.twist };
              }),
          });
          if (!solution.converged)
            warnings.push({
              entityId: chain.joints[0],
              constraintId: chain.id,
              message: `IK“${chain.name}”${solution.reachable === false ? '目标超出可达范围' : solution.stop === 'stalled' ? '受限求解停止改善' : '已达迭代上限'}，求解末端误差 ${solution.residual.toPrecision(4)} 米${solution.reachable === null ? '；未收敛不等于目标不可达' : ''}`,
            });
        } catch (error) {
          warnings.push({
            entityId: chain.joints[0],
            constraintId: chain.id,
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }
    return { local, world, warnings, driven, ik };
  };
}
