import { Euler, Matrix4, Quaternion, Vector3 } from 'three';
import type { Constraint, Entity, Project, Vec3, Vec4 } from './model';
import { evaluatedTransform } from './evaluate';

export const activeConstraints = (e: Entity) =>
  (e.constraints || []).filter((c) => c.enabled && c.influence > 0);

/** Object-level dependency graph. Geometry deformation never feeds transforms. */
export function dependencyOrder(entities: Entity[]) {
  const byId = new Map(entities.map((e) => [e.id, e]));
  const dependencies = new Map<string, Set<string>>();
  const followers = new Map<string, string[]>();
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
    for (const target of deps) {
      if (!byId.has(target)) throw new Error('对象依赖不存在');
      followers.set(target, [...(followers.get(target) || []), e.id]);
    }
  }
  const ready = entities.filter((e) => !dependencies.get(e.id)!.size).map((e) => e.id);
  const order: Entity[] = [];
  for (let i = 0; i < ready.length; i++) {
    const id = ready[i];
    order.push(byId.get(id)!);
    for (const child of followers.get(id) || []) {
      const deps = dependencies.get(child)!;
      deps.delete(id);
      if (!deps.size) ready.push(child);
    }
  }
  if (order.length !== entities.length) {
    let next = entities.find((e) => dependencies.get(e.id)!.size)!.id;
    const path: string[] = [];
    while (!path.includes(next)) {
      path.push(next);
      next = [...dependencies.get(next)!][0];
    }
    const cycle = [...path.slice(path.indexOf(next)), next].map((id) => byId.get(id)!.name);
    throw new Error(`对象约束/父级依赖存在循环：${cycle.join(' → ')}`);
  }
  return order;
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

/** QR decomposition retains affine shear. The reflection sign belongs to Z. */
function affineParts(m: Matrix4) {
  const x = new Vector3().setFromMatrixColumn(m, 0),
    y = new Vector3().setFromMatrixColumn(m, 1),
    z = new Vector3().setFromMatrixColumn(m, 2);
  const sx = x.length();
  if (sx < 1e-12) return null;
  x.divideScalar(sx);
  const xy = x.dot(y);
  y.addScaledVector(x, -xy);
  const sy = y.length();
  if (sy < 1e-12) return null;
  y.divideScalar(sy);
  const basisZ = new Vector3().crossVectors(x, y),
    sz = basisZ.dot(z);
  if (Math.abs(sz) < 1e-12) return null;
  return {
    position: new Vector3().setFromMatrixPosition(m),
    rotation: new Quaternion()
      .setFromRotationMatrix(new Matrix4().makeBasis(x, y, basisZ))
      .normalize(),
    upper: [sx, sy, sz, xy, x.dot(z), y.dot(z)],
  };
}

function blendAffine(from: Matrix4, to: Matrix4, influence: number) {
  if (influence === 1) return to.clone();
  const a = affineParts(from),
    b = affineParts(to);
  if (!a || !b) throw new Error('部分影响的复制变换遇到退化矩阵；该约束本帧未应用');
  const u = a.upper.map((v, i) => v + (b.upper[i] - v) * influence);
  return new Matrix4()
    .makeRotationFromQuaternion(a.rotation.slerp(b.rotation, influence))
    .multiply(new Matrix4().set(u[0], u[3], u[4], 0, 0, u[1], u[5], 0, 0, 0, u[2], 0, 0, 0, 0, 1))
    .setPosition(a.position.lerp(b.position, influence));
}

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
      `对象“${label}”的约束产生局部剪切，TRS 动作/GLB 无法保真表达；请调整父级非均匀缩放或约束空间，项目与影片仍保留实际结果`,
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
  const order = dependencyOrder(p.entities.filter((e) => e.sceneId === sceneId));
  return (frame?: number, actionId?: string | null, layers = true) => {
    const local = new Map<string, Matrix4>(),
      world = new Map<string, Matrix4>();
    const warnings: { entityId: string; constraintId: string; message: string }[] = [];
    for (const e of order) {
      const parent = e.parentId ? world.get(e.parentId)! : new Matrix4();
      let matrix = transformMatrix(
        frame === undefined ? e.transform : evaluatedTransform(p, e, frame, actionId, layers),
      );
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
    return { local, world, warnings };
  };
}
