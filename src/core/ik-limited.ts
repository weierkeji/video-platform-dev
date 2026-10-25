import { Matrix4, Quaternion, Vector3 } from 'three';
import type { IKChain } from './model';
import { affineParts } from './affine';
import { projectJointRotation, withAffineRotation } from './joint-limits';

/** Bounded projected cyclic coordinate descent in local joint coordinates.
 * CCD is a published general method (Kenwright, Journal of Graphics Tools 2012).
 * This implementation, reference-frame limits and line search are independent. */
export function solveLimitedIK(
  chain: IKChain,
  local: ReadonlyMap<string, Matrix4>,
  parentWorld: Matrix4,
  goal: Vector3,
  seed: ReadonlyMap<string, Matrix4>,
) {
  const ids = chain.joints,
    n = ids.length - 1;
  const source = ids.map((id) => local.get(id)!),
    parts = source.map((m) => affineParts(m));
  if (parts.some((p) => !p)) throw new Error('受限 IK 局部矩阵退化；本帧保留输入姿态');
  if (Math.abs(parentWorld.determinant()) < 1e-12)
    throw new Error('受限 IK 父级不可逆；本帧保留输入姿态');
  const limits = ids.map((id) => chain.limits?.find((l) => l.enabled && l.jointId === id));
  let rotations = parts.map((p, i) => projectJointRotation(p!.rotation, limits[i]));
  let matrices: Matrix4[] = [],
    world: Matrix4[] = [];
  const forward = () => {
    matrices = source.map((m, i) => (i === n ? m.clone() : withAffineRotation(m, rotations[i])));
    world = [];
    for (let i = 0; i <= n; i++)
      world.push((i ? world[i - 1] : parentWorld).clone().multiply(matrices[i]));
  };
  const residual = () => new Vector3().setFromMatrixPosition(world[n]).distanceTo(goal);
  forward();
  let error = residual();
  const original = rotations.map((q) => q.clone());
  rotations = ids.map((id, i) =>
    projectJointRotation(affineParts(seed.get(id)!)?.rotation || parts[i]!.rotation, limits[i]),
  );
  forward();
  if (residual() > error + 1e-12) {
    rotations = original;
    forward();
  } else error = residual();
  // A straight chain with a one-sided hinge is a CCD stationary point. Explore
  // a bounded set of feasible bends, align the root, then keep the best start.
  // This is stateless initialization, not an unbounded restart or convergence claim.
  let initialBest = rotations.map((q) => q.clone()),
    initialError = error;
  const starts = [0.25, 0.5, 0.75].map((fraction) =>
    original.map((q, i) => {
      const limit = limits[i];
      return limit?.kind === 'hinge'
        ? new Quaternion(...limit.reference)
            .normalize()
            .multiply(
              new Quaternion().setFromAxisAngle(
                new Vector3(...limit.axis).normalize(),
                limit.min + (limit.max - limit.min) * fraction,
              ),
            )
        : q.clone();
    }),
  );
  if (n === 2 && limits[1]?.kind === 'hinge') {
    const a = new Vector3()
      .setFromMatrixPosition(world[0])
      .distanceTo(new Vector3().setFromMatrixPosition(world[1]));
    const b = new Vector3()
      .setFromMatrixPosition(world[1])
      .distanceTo(new Vector3().setFromMatrixPosition(world[2]));
    const d = new Vector3().setFromMatrixPosition(world[0]).distanceTo(goal);
    const angle = Math.acos(Math.max(-1, Math.min(1, (d * d - a * a - b * b) / (2 * a * b))));
    for (const sign of [-1, 1]) {
      const candidate = original.map((q) => q.clone()),
        limit = limits[1]!;
      candidate[1] = projectJointRotation(
        new Quaternion(...limit.reference)
          .normalize()
          .multiply(
            new Quaternion().setFromAxisAngle(new Vector3(...limit.axis).normalize(), angle * sign),
          ),
        limit,
      );
      starts.push(candidate);
    }
  }
  for (const start of starts) {
    rotations = start;
    forward();
    const inverse = parentWorld.clone().invert(),
      origin = parts[0]!.position;
    const a = new Vector3().setFromMatrixPosition(world[n]).applyMatrix4(inverse).sub(origin);
    const b = goal.clone().applyMatrix4(inverse).sub(origin);
    if (a.lengthSq() > 1e-20 && b.lengthSq() > 1e-20) {
      rotations[0] = projectJointRotation(
        new Quaternion().setFromUnitVectors(a.normalize(), b.normalize()).multiply(rotations[0]),
        limits[0],
      );
      forward();
    }
    const e = residual();
    if (e < initialError - 1e-12) {
      initialError = e;
      initialBest = rotations.map((q) => q.clone());
    }
  }
  rotations = initialBest;
  forward();
  error = initialError;
  let iterations = 0,
    stop = 'iteration-limit';
  if (error <= chain.tolerance) stop = 'converged';
  for (; iterations < chain.iterations && stop !== 'converged'; ) {
    iterations++;
    const previous = error;
    // The suffix maps the tip origin into the coordinate system of this joint.
    let suffix = new Matrix4().copy(matrices[n]);
    for (let i = n - 1; i >= 0; i--) {
      const parent = i ? world[i - 1] : parentWorld;
      if (Math.abs(parent.determinant()) < 1e-12)
        throw new Error('受限 IK 祖先不可逆；本帧保留输入姿态');
      const inverse = parent.clone().invert(),
        origin = parts[i]!.position;
      const tipParent = new Vector3()
        .setFromMatrixPosition(world[n])
        .applyMatrix4(inverse)
        .sub(origin);
      const goalParent = goal.clone().applyMatrix4(inverse).sub(origin);
      const current = rotations[i].clone(),
        limit = limits[i];
      const tipLocal = new Vector3().setFromMatrixPosition(suffix);
      let best = current,
        bestError = error;
      const consider = (candidate: Quaternion) => {
        const q = projectJointRotation(candidate, limit);
        const tip = tipLocal
          .clone()
          .applyMatrix4(withAffineRotation(source[i], q))
          .applyMatrix4(parent);
        const e = tip.distanceTo(goal);
        if (Number.isFinite(e) && e < bestError - 1e-12) {
          best = q;
          bestError = e;
        }
      };
      if (tipParent.lengthSq() > 1e-20 && goalParent.lengthSq() > 1e-20) {
        let delta: Quaternion;
        if (limit?.kind === 'hinge') {
          const axis = new Vector3(...limit.axis)
            .normalize()
            .applyQuaternion(new Quaternion(...limit.reference).normalize());
          const a = tipParent.clone().addScaledVector(axis, -tipParent.dot(axis));
          const b = goalParent.clone().addScaledVector(axis, -goalParent.dot(axis));
          const angle = Math.atan2(axis.dot(new Vector3().crossVectors(a, b)), a.dot(b));
          delta = new Quaternion().setFromAxisAngle(axis, angle);
        } else
          delta = new Quaternion().setFromUnitVectors(
            tipParent.clone().normalize(),
            goalParent.clone().normalize(),
          );
        for (const amount of [1, 0.5, 0.25, 0.125])
          consider(new Quaternion().slerp(delta, amount).multiply(current));
      }
      // Projected CCD can stick at a cone edge. Small feasible coordinate trials
      // also provide descent when the parent metric is nonuniform or reflected.
      const step = Math.max(0.002, 0.25 * Math.pow(0.92, iterations - 1));
      const axes =
        limit?.kind === 'hinge'
          ? [
              new Vector3(...limit.axis)
                .normalize()
                .applyQuaternion(new Quaternion(...limit.reference).normalize()),
            ]
          : [new Vector3(1, 0, 0), new Vector3(0, 1, 0), new Vector3(0, 0, 1)];
      for (const axis of axes)
        for (const angle of [-step, step])
          consider(new Quaternion().setFromAxisAngle(axis, angle).multiply(current));
      if (best !== current) {
        rotations[i] = best;
        matrices[i] = withAffineRotation(source[i], best);
        error = bestError;
        for (let j = i; j <= n; j++)
          world[j] = (j ? world[j - 1] : parentWorld).clone().multiply(matrices[j]);
      }
      suffix = matrices[i].clone().multiply(suffix);
    }
    error = residual();
    if (error <= chain.tolerance) stop = 'converged';
    else if (previous - error <= Math.max(1e-12, chain.tolerance * 1e-5)) {
      stop = 'stalled';
      break;
    }
  }
  return {
    matrices: new Map(ids.map((id, i) => [id, matrices[i]])),
    residual: error,
    iterations,
    converged: error <= chain.tolerance,
    reachable: error <= chain.tolerance ? true : null,
    method: 'limited-ccd',
    stop,
  };
}
