import { Box3, Matrix4, Ray, Vector3 } from 'three';
import type { Geometry } from '../core/model';

type Node = { box: Box3; faces?: number[]; left?: Node; right?: Node };
/** Median-split triangle bounds for interactive selection, independent of scene rendering. */
export class MeshTree {
  private root: Node;
  constructor(private geometry: Geometry) {
    const centers = geometry.triangles.map((t) =>
      new Vector3().fromArray(
        t.map((_, axis) => t.reduce((s, i) => s + geometry.positions[i][axis], 0) / 3),
      ),
    );
    const build = (faces: number[], depth: number): Node => {
      const box = new Box3(),
        p = new Vector3();
      for (const face of faces)
        for (const v of geometry.triangles[face])
          box.expandByPoint(p.fromArray(geometry.positions[v]));
      if (faces.length <= 12 || depth >= 32) return { box, faces };
      const span = box.getSize(new Vector3()).toArray(),
        axis = span.indexOf(Math.max(...span));
      faces.sort((a, b) => centers[a].getComponent(axis) - centers[b].getComponent(axis));
      const middle = faces.length >> 1;
      return {
        box,
        left: build(faces.slice(0, middle), depth + 1),
        right: build(faces.slice(middle), depth + 1),
      };
    };
    this.root = build(
      geometry.triangles.map((_, i) => i),
      0,
    );
  }
  intersect(worldRay: Ray, matrix: Matrix4) {
    if (Math.abs(matrix.determinant()) < 1e-12) return null;
    const ray = worldRay.clone().applyMatrix4(matrix.clone().invert());
    const a = new Vector3(),
      b = new Vector3(),
      c = new Vector3(),
      intersection = new Vector3(),
      boundHit = new Vector3();
    let distance = Infinity,
      face = -1;
    const point = new Vector3();
    const visit = (node: Node) => {
      if (
        !ray.intersectBox(node.box, boundHit) ||
        (!node.box.containsPoint(ray.origin) && boundHit.distanceToSquared(ray.origin) > distance)
      )
        return;
      if (node.faces)
        for (const i of node.faces) {
          const t = this.geometry.triangles[i];
          if (
            ray.intersectTriangle(
              a.fromArray(this.geometry.positions[t[0]]),
              b.fromArray(this.geometry.positions[t[1]]),
              c.fromArray(this.geometry.positions[t[2]]),
              false,
              intersection,
            )
          ) {
            const d = intersection.distanceToSquared(ray.origin);
            if (d < distance) {
              distance = d;
              face = i;
              point.copy(intersection);
            }
          }
        }
      else {
        visit(node.left!);
        visit(node.right!);
      }
    };
    if (!this.root.box.isEmpty()) visit(this.root);
    if (face < 0) return null;
    point.applyMatrix4(matrix);
    return { face, point, distance: point.distanceTo(worldRay.origin) };
  }
}
