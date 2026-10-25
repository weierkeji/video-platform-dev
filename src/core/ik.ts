import { Matrix4, Quaternion, Vector3 } from 'three';
import type { Entity, IKChain } from './model';
import { solveLimitedIK } from './ik-limited';

export function ikPath(entities: Entity[], rootId: string, tipId: string) {
  const byId = new Map(entities.map((e) => [e.id, e]));
  const path: string[] = [];
  let next: string | null = tipId;
  while (next && !path.includes(next) && path.length < 33) {
    path.unshift(next);
    if (next === rootId) {
      if (path.length < 3) throw new Error('IK 至少需要两个骨段和末端节点');
      return path;
    }
    next = byId.get(next)?.parentId || null;
  }
  throw new Error('IK 末端必须是根的后代，链长为 2…32 个骨段');
}

const position = (m: Matrix4) => new Vector3().setFromMatrixPosition(m);
const unit = (v: Vector3, fallback: Vector3) =>
  v.lengthSq() > 1e-24 ? v.normalize() : fallback.clone().normalize();
function perpendicular(axis: Vector3, preferred: Vector3) {
  const result = preferred.clone().addScaledVector(axis, -preferred.dot(axis));
  if (result.lengthSq() > 1e-20) return result.normalize();
  const basis = [new Vector3(1, 0, 0), new Vector3(0, 1, 0), new Vector3(0, 0, 1)].reduce((a, b) =>
    Math.abs(a.dot(axis)) < Math.abs(b.dot(axis)) ? a : b,
  );
  return basis.addScaledVector(axis, -basis.dot(axis)).normalize();
}

/** Independent geometric two-link solution and bounded FABRIK position solver.
 * FABRIK's public algorithm: Aristidou & Lasenby, Graphical Models 73 (2011).
 * No third-party solver code or example assets are included. */
export function solveIKPositions(
  input: Vector3[],
  goal: Vector3,
  pole: Vector3 | undefined,
  options: Pick<IKChain, 'iterations' | 'tolerance' | 'poleAngle'>,
) {
  const points = input.map((v) => v.clone()),
    root = points[0].clone(),
    n = points.length - 1;
  const lengths = input.slice(1).map((v, i) => v.distanceTo(input[i]));
  if (lengths.some((v) => !Number.isFinite(v) || v < 1e-8))
    throw new Error('IK 含零长度或退化骨段；本帧保留输入姿态');
  const total = lengths.reduce((a, b) => a + b, 0),
    longest = Math.max(...lengths),
    inner = Math.max(0, 2 * longest - total),
    distance = root.distanceTo(goal);
  const direction = unit(
    goal.clone().sub(root),
    unit(input[n].clone().sub(root), input[1].clone().sub(root)),
  );
  const bend = perpendicular(direction, (pole || input[1]).clone().sub(root)).applyAxisAngle(
    direction,
    options.poleAngle,
  );
  const reachable = distance <= total + options.tolerance && distance >= inner - options.tolerance;
  let iterations = 0;
  if (n === 2) {
    const d = Math.min(total, Math.max(inner, distance)),
      a = lengths[0],
      b = lengths[1];
    if (d < 1e-12) {
      // At a fully folded equal-length limb the tip gives no plane axis.
      // Keep the pole/input elbow direction; use a deterministic perpendicular
      // only for the otherwise undefined pole-angle rotation.
      const folded = unit((pole || input[1]).clone().sub(root), input[1].clone().sub(root));
      folded.applyAxisAngle(perpendicular(folded, new Vector3()), options.poleAngle);
      points[1].copy(root).addScaledVector(folded, a);
    } else {
      const along = (a * a - b * b + d * d) / (2 * d),
        height = Math.sqrt(Math.max(0, a * a - along * along));
      points[1].copy(root).addScaledVector(direction, along).addScaledVector(bend, height);
    }
    points[2].copy(root).addScaledVector(direction, d);
  } else if (distance >= total || distance < inner) {
    const largest = lengths.indexOf(longest);
    for (let i = 0; i < n; i++)
      points[i + 1]
        .copy(points[i])
        .addScaledVector(direction, lengths[i] * (distance < inner && i !== largest ? -1 : 1));
  } else {
    // Straight configurations need a deterministic bend seed to avoid a collinear
    // fixed point. Seed only positions; every projection restores segment length.
    if (
      points
        .slice(1, -1)
        .every(
          (v) => new Vector3().crossVectors(v.clone().sub(root), direction).length() < total * 1e-6,
        )
    ) {
      let offset = 0;
      for (let i = 1; i < n; i++) {
        offset += lengths[i - 1];
        points[i].addScaledVector(bend, Math.sin((Math.PI * offset) / total) * total * 0.15);
      }
    }
    for (; iterations < options.iterations; ) {
      iterations++;
      points[n].copy(goal);
      for (let i = n - 1; i >= 0; i--) {
        const direction = unit(
          points[i].clone().sub(points[i + 1]),
          input[i].clone().sub(input[i + 1]),
        );
        points[i].copy(points[i + 1]).addScaledVector(direction, lengths[i]);
      }
      points[0].copy(root);
      for (let i = 0; i < n; i++) {
        const direction = unit(
          points[i + 1].clone().sub(points[i]),
          input[i + 1].clone().sub(input[i]),
        );
        points[i + 1].copy(points[i]).addScaledVector(direction, lengths[i]);
      }
      if (pole)
        for (let i = 1; i < n; i++) {
          const axis = points[i + 1].clone().sub(points[i - 1]);
          if (axis.lengthSq() < 1e-20) continue;
          axis.normalize();
          const center = points[i - 1].clone().addScaledVector(
            axis,
            points[i]
              .clone()
              .sub(points[i - 1])
              .dot(axis),
          );
          const radial = points[i].clone().sub(center),
            radius = radial.length();
          if (radius < 1e-10) continue;
          const toPole = perpendicular(axis, pole.clone().sub(center)).applyAxisAngle(
            axis,
            options.poleAngle,
          );
          points[i].copy(center).addScaledVector(toPole, radius);
        }
      if (points[n].distanceTo(goal) <= options.tolerance) break;
    }
  }
  const residual = points[n].distanceTo(goal);
  return {
    points,
    lengths,
    reachable,
    residual,
    iterations,
    converged: residual <= options.tolerance,
  };
}

/** Solve in world space, then reconstruct local affine matrices without dropping
 * shear from nonuniform ancestry. The tip retains its incoming local orientation. */
export function solveIK(
  chain: IKChain,
  entities: ReadonlyMap<string, Entity>,
  local: ReadonlyMap<string, Matrix4>,
  world: ReadonlyMap<string, Matrix4>,
) {
  const input = chain.joints.map((id) => world.get(id)!);
  const result = solveIKPositions(
    input.map(position),
    position(world.get(chain.targetId)!),
    chain.poleId ? position(world.get(chain.poleId)!) : undefined,
    chain,
  );
  const matrices = new Map<string, Matrix4>(),
    solvedWorld = new Map<string, Matrix4>();
  for (let i = 0; i < chain.joints.length - 1; i++) {
    const id = chain.joints[i],
      entity = entities.get(id)!;
    const before = position(input[i + 1])
        .sub(position(input[i]))
        .normalize(),
      after = result.points[i + 1].clone().sub(result.points[i]).normalize();
    const rotation = new Quaternion().setFromUnitVectors(before, after);
    const desired = new Matrix4()
      .makeRotationFromQuaternion(rotation)
      .multiply(input[i].clone().setPosition(0, 0, 0))
      .setPosition(result.points[i]);
    const parent = entity.parentId
      ? solvedWorld.get(entity.parentId) || world.get(entity.parentId)!
      : new Matrix4();
    if (Math.abs(parent.determinant()) < 1e-12)
      throw new Error('IK 父级矩阵不可逆；本帧保留输入姿态');
    const matrix = parent.clone().invert().multiply(desired);
    if (matrix.elements.some((v) => !Number.isFinite(v)))
      throw new Error('IK 产生非有限矩阵；本帧保留输入姿态');
    matrices.set(id, matrix);
    solvedWorld.set(id, desired);
  }
  matrices.set(chain.joints.at(-1)!, local.get(chain.joints.at(-1)!)!.clone());
  if (chain.limits?.some((l) => l.enabled)) {
    const root = entities.get(chain.joints[0])!;
    return solveLimitedIK(
      chain,
      local,
      root.parentId ? world.get(root.parentId)! : new Matrix4(),
      position(world.get(chain.targetId)!),
      matrices,
    );
  }
  return {
    ...result,
    matrices,
    method: chain.joints.length === 3 ? 'geometric' : 'fabrik',
    stop: result.converged ? 'converged' : result.reachable ? 'iteration-limit' : 'unreachable',
  };
}

export function suggestedPole(points: Vector3[]) {
  const root = points[0],
    tip = points.at(-1)!,
    axis = unit(tip.clone().sub(root), points[1].clone().sub(root));
  return root
    .clone()
    .lerp(tip, 0.5)
    .addScaledVector(
      perpendicular(axis, points[1].clone().sub(root)),
      points.slice(1).reduce((sum, v, i) => sum + v.distanceTo(points[i]), 0) * 0.7,
    );
}
