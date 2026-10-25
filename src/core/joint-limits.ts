import { Matrix4, Quaternion, Vector3 } from 'three';
import { affineParts } from './affine';
import type { IKLimit } from './model';

const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v));

/** q = reference * swing * twist. Axes live in the stored reference frame. */
export function limitAngles(rotation: Quaternion, limit: IKLimit) {
  const relative = new Quaternion(...limit.reference)
    .normalize()
    .invert()
    .multiply(rotation)
    .normalize();
  // A canonical hemisphere makes q and -q choose the same signed angle at pi.
  const sign =
    relative.w < -1e-12 ||
    (Math.abs(relative.w) <= 1e-12 &&
      [relative.x, relative.y, relative.z].find((v) => Math.abs(v) > 1e-12)! < 0)
      ? -1
      : 1;
  relative.set(relative.x * sign, relative.y * sign, relative.z * sign, relative.w * sign);
  const axis = new Vector3(...limit.axis).normalize();
  const projection = new Vector3(relative.x, relative.y, relative.z).dot(axis);
  const twist = new Quaternion(
    axis.x * projection,
    axis.y * projection,
    axis.z * projection,
    relative.w,
  );
  // At 180 degrees of swing the twist is undefined; choose zero deterministically.
  if (twist.lengthSq() < 1e-20) twist.identity();
  else twist.normalize();
  let angle = 2 * Math.atan2(new Vector3(twist.x, twist.y, twist.z).dot(axis), twist.w);
  if (angle > Math.PI) angle -= 2 * Math.PI;
  if (angle < -Math.PI) angle += 2 * Math.PI;
  const swing = relative.clone().multiply(twist.clone().invert()).normalize();
  if (swing.w < 0) swing.set(-swing.x, -swing.y, -swing.z, -swing.w);
  const swingAngle = 2 * Math.acos(clamp(swing.w, -1, 1));
  return { twist: angle, swing: swingAngle, swingRotation: swing, axis };
}

export function projectJointRotation(rotation: Quaternion, limit?: IKLimit) {
  if (!limit?.enabled) return rotation.clone();
  const angles = limitAngles(rotation, limit);
  const swing = limit.kind === 'hinge' ? new Quaternion() : angles.swingRotation.clone();
  if (limit.kind === 'cone' && angles.swing > limit.swing && angles.swing > 1e-12)
    swing.slerpQuaternions(new Quaternion(), angles.swingRotation, limit.swing / angles.swing);
  return new Quaternion(...limit.reference)
    .normalize()
    .multiply(swing)
    .multiply(
      new Quaternion().setFromAxisAngle(angles.axis, clamp(angles.twist, limit.min, limit.max)),
    )
    .normalize();
}

export function withAffineRotation(matrix: Matrix4, rotation: Quaternion) {
  const parts = affineParts(matrix);
  if (!parts) throw new Error('受限 IK 的局部矩阵退化；本帧保留输入姿态');
  const u = parts.upper;
  return new Matrix4()
    .makeRotationFromQuaternion(rotation)
    .multiply(new Matrix4().set(u[0], u[3], u[4], 0, 0, u[1], u[5], 0, 0, 0, u[2], 0, 0, 0, 0, 1))
    .setPosition(parts.position);
}

export function projectJointMatrix(matrix: Matrix4, limit?: IKLimit) {
  if (!limit?.enabled) return matrix;
  const parts = affineParts(matrix);
  if (!parts) throw new Error('受限 IK 的局部矩阵退化；本帧保留输入姿态');
  return withAffineRotation(matrix, projectJointRotation(parts.rotation, limit));
}
