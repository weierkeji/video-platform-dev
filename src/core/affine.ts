import { Matrix4, Quaternion, Vector3 } from 'three';

/** QR decomposition retains affine shear. The reflection sign belongs to Z. */
export function affineParts(m: Matrix4) {
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

export function blendAffine(from: Matrix4, to: Matrix4, influence: number) {
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
