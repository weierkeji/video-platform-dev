import { Matrix4, Vector3 } from 'three';
import type { Entity, Geometry, Project, Skin, Vec3, VertexInfluences } from './model';
import { sceneEvaluator } from './constraints';
export { transformMatrix } from './constraints';

/** Ordinary intermediate parents and invisible joints participate in evaluation. */
export function worldMatrices(
  p: Project,
  sceneId: string,
  frame?: number,
  actionId?: string | null,
  layers = true,
) {
  return sceneEvaluator(p, sceneId)(frame, actionId, layers).world;
}

export function normalizedInfluences(rows: VertexInfluences[]): VertexInfluences {
  const weights = new Map<number, number>();
  for (const row of rows)
    for (const v of row) weights.set(v.joint, (weights.get(v.joint) || 0) + v.weight);
  const sum = [...weights.values()].reduce((a, b) => a + b, 0);
  if (!(sum > 0) || !Number.isFinite(sum)) throw new Error('顶点权重总和必须为有限正数');
  if (weights.size > 32) throw new Error('合并后的顶点超过 32 个关节影响；请先调整权重');
  return [...weights]
    .sort(([a], [b]) => a - b)
    .map(([joint, weight]) => ({ joint, weight: weight / sum }));
}

export function bindSkin(
  p: Project,
  e: Entity,
  joints: string[],
  method: 'nearest' | 'first',
): Skin {
  if (e.kind !== 'mesh') throw new Error('只能绑定网格对象');
  if (new Set(joints).size !== joints.length || !joints.length)
    throw new Error('请选择不重复的关节');
  const world = worldMatrices(p, e.sceneId),
    meshWorld = world.get(e.id)!;
  const inverseBindMatrices = joints.map((id) => {
    const matrix = world.get(id);
    if (!matrix) throw new Error('关节必须属于网格场景');
    if (Math.abs(matrix.determinant()) < 1e-12) throw new Error('关节基础姿态不可逆，无法绑定');
    const inverse = matrix.clone().invert().multiply(meshWorld).toArray();
    // These are affine TRS products. Remove inverse arithmetic roundoff from
    // the homogeneous row; glTF requires the row to be exactly [0, 0, 0, 1].
    inverse[3] = inverse[7] = inverse[11] = 0;
    inverse[15] = 1;
    return inverse;
  });
  const origins = joints.map((id) => new Vector3().setFromMatrixPosition(world.get(id)!));
  const g = p.geometries.find((g) => g.id === e.geometryId)!;
  const position = new Vector3();
  g.influences = g.positions.map((v) => {
    position.fromArray(v).applyMatrix4(meshWorld);
    let nearest = 0,
      distance = Infinity;
    if (method === 'nearest')
      origins.forEach((origin, i) => {
        const d = position.distanceToSquared(origin);
        if (d < distance) {
          nearest = i;
          distance = d;
        }
      });
    return [{ joint: nearest, weight: 1 }];
  });
  return { joints: [...joints], inverseBindMatrices };
}

/** Produces WORLD geometry; mesh-node TRS is excluded. Directions use the blended
 * linear part, as in conventional glTF LBS, not a deformation-gradient inverse transpose. */
export function deformGeometry(
  g: Geometry,
  skin: Skin,
  world: ReadonlyMap<string, Matrix4>,
): Geometry {
  if (!g.influences) throw new Error('蒙皮网格缺少顶点权重');
  const matrices = skin.joints.map((id, i) => {
    const matrix = world.get(id);
    if (!matrix) throw new Error('蒙皮引用缺失的关节');
    return matrix.clone().multiply(new Matrix4().fromArray(skin.inverseBindMatrices[i])).elements;
  });
  const positions: Vec3[] = [],
    normals: Vec3[] | undefined = g.normals ? [] : undefined,
    tangents: Geometry['tangents'] = g.tangents ? [] : undefined;
  const matrix = new Float64Array(16);
  const direction = (v: readonly number[]): Vec3 => {
    const n = [0, 1, 2].map(
      (j) => matrix[j] * v[0] + matrix[j + 4] * v[1] + matrix[j + 8] * v[2],
    ) as Vec3;
    const length = Math.hypot(...n);
    return length ? (n.map((v) => v / length) as Vec3) : [0, 0, 0];
  };
  for (let i = 0; i < g.positions.length; i++) {
    matrix.fill(0);
    for (const influence of g.influences[i]) {
      const source = matrices[influence.joint];
      if (!source) throw new Error('权重关节索引越界');
      for (let j = 0; j < 16; j++) matrix[j] += source[j] * influence.weight;
    }
    const v = g.positions[i];
    const position = [0, 1, 2].map(
      (j) => matrix[j] * v[0] + matrix[j + 4] * v[1] + matrix[j + 8] * v[2] + matrix[j + 12],
    ) as Vec3;
    if (position.some((v) => !Number.isFinite(v))) throw new Error('蒙皮变形产生非有限位置');
    positions.push(position);
    if (normals) normals.push(direction(g.normals![i]));
    if (tangents) tangents.push([...direction(g.tangents![i]), g.tangents![i][3]]);
  }
  const result = {
    ...g,
    positions,
    ...(normals ? { normals } : {}),
    ...(tangents ? { tangents } : {}),
  };
  delete result.influences;
  return result;
}
