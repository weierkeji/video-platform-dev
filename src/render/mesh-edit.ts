import * as THREE from 'three';
import { meshEdges, selectedVertices, vertexCenter, type MeshSelection } from '../core/mesh';
import type { Geometry, Project, Vec3 } from '../core/model';
import { MeshTree } from './mesh-spatial';
import type { SceneRenderer } from './scene';

const visible = (o: THREE.Object3D): boolean => o.visible && (!o.parent || visible(o.parent));
export class MeshOverlay {
  root = new THREE.Group();
  edges: [number, number][];
  vertices: number[];
  constructor(
    public geometry: Geometry,
    public mesh: THREE.Mesh,
    public selection: MeshSelection,
    public xray: boolean,
  ) {
    this.edges = meshEdges(geometry);
    this.vertices = selectedVertices(geometry, selection.mode, selection.indices, this.edges);
    this.root.name = 'editor-mesh-selection';
    mesh.add(this.root);
    this.redraw();
  }
  center() {
    return new THREE.Vector3()
      .fromArray(vertexCenter(this.geometry, this.vertices))
      .applyMatrix4(this.mesh.matrixWorld);
  }
  redraw(positions = this.geometry.positions) {
    this.clear();
    const depthTest = !this.xray;
    const lines = (edges: [number, number][], color: number) => {
      if (!edges.length) return;
      const g = new THREE.BufferGeometry().setFromPoints(
        edges.flatMap((e) => e.map((i) => new THREE.Vector3().fromArray(positions[i]))),
      );
      const o = new THREE.LineSegments(
        g,
        new THREE.LineBasicMaterial({
          color,
          depthTest,
          depthWrite: false,
          transparent: true,
          opacity: 0.9,
        }),
      );
      o.renderOrder = 2;
      this.root.add(o);
    };
    const dots = (points: Vec3[], color: number, size: number) => {
      if (!points.length) return;
      const g = new THREE.BufferGeometry().setFromPoints(
        points.map((p) => new THREE.Vector3().fromArray(p)),
      );
      const o = new THREE.Points(
        g,
        new THREE.PointsMaterial({
          color,
          size,
          sizeAttenuation: false,
          depthTest,
          depthWrite: false,
        }),
      );
      o.renderOrder = 3;
      this.root.add(o);
    };
    lines(this.edges, 0x718798);
    if (this.selection.mode === 'vertex') {
      dots(positions, 0xb8c8d8, 5);
      dots(
        this.vertices.map((i) => positions[i]),
        0xffbd70,
        9,
      );
    }
    if (this.selection.mode === 'edge')
      lines(
        this.selection.indices.map((i) => this.edges[i]),
        0xffbd70,
      );
    if (this.selection.mode === 'face') {
      dots(
        this.geometry.triangles.map(
          (t) => [0, 1, 2].map((axis) => t.reduce((s, i) => s + positions[i][axis], 0) / 3) as Vec3,
        ),
        0xb8c8d8,
        5,
      );
      const g = new THREE.BufferGeometry().setFromPoints(
        this.selection.indices.flatMap((i) =>
          this.geometry.triangles[i].map((v) => new THREE.Vector3().fromArray(positions[v])),
        ),
      );
      const m = new THREE.MeshBasicMaterial({
        color: 0xffb057,
        transparent: true,
        opacity: 0.45,
        side: THREE.DoubleSide,
        depthTest,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: -2,
        polygonOffsetUnits: -2,
      });
      const o = new THREE.Mesh(g, m);
      o.renderOrder = 1;
      this.root.add(o);
    }
  }
  preview(positions: Vec3[], restoreNormals = false) {
    const attribute = this.mesh.geometry.getAttribute('position') as THREE.BufferAttribute;
    positions.forEach((p, i) => attribute.setXYZ(i, ...p));
    attribute.needsUpdate = true;
    if ((restoreNormals || positions === this.geometry.positions) && this.geometry.normals)
      this.mesh.geometry.setAttribute(
        'normal',
        new THREE.Float32BufferAttribute(this.geometry.normals.flat(), 3),
      );
    else this.mesh.geometry.computeVertexNormals();
    if (
      (restoreNormals || positions === this.geometry.positions) &&
      this.geometry.tangents &&
      !(this.mesh.material as THREE.MeshStandardMaterial).flatShading
    )
      this.mesh.geometry.setAttribute(
        'tangent',
        new THREE.Float32BufferAttribute(this.geometry.tangents.flat(), 4),
      );
    else this.mesh.geometry.deleteAttribute('tangent');
    for (const material of Array.isArray(this.mesh.material)
      ? this.mesh.material
      : [this.mesh.material])
      material.needsUpdate = true;
    this.mesh.geometry.computeBoundingSphere();
    this.mesh.geometry.computeBoundingBox();
    this.redraw(positions);
  }
  clear() {
    for (const child of this.root.children) {
      const o = child as THREE.Mesh;
      o.geometry.dispose();
      for (const m of Array.isArray(o.material) ? o.material : [o.material]) m.dispose();
    }
    this.root.clear();
  }
  dispose() {
    this.clear();
    this.root.removeFromParent();
  }
}

export class MeshPicker {
  private trees = new Map<string, MeshTree>();
  constructor(
    private project: Project,
    private renderer: Pick<SceneRenderer, 'objects'>,
  ) {}
  private hit(ray: THREE.Ray, mesh: THREE.Mesh) {
    const e = this.project.entities.find((e) => e.id === mesh.userData.entityId)!;
    if (!e?.geometryId) return null;
    let tree = this.trees.get(e.geometryId);
    if (!tree) {
      tree = new MeshTree(this.project.geometries.find((g) => g.id === e.geometryId)!);
      this.trees.set(e.geometryId, tree);
    }
    return tree.intersect(ray, mesh.matrixWorld);
  }
  private occluded(point: THREE.Vector3, camera: THREE.Camera) {
    const ndc = point.clone().project(camera);
    const origin = new THREE.Vector3(ndc.x, ndc.y, -1).unproject(camera),
      distance = point.distanceTo(origin);
    const ray = new THREE.Ray(origin, point.clone().sub(origin).normalize());
    for (const o of this.renderer.objects.values())
      if (o instanceof THREE.Mesh && visible(o)) {
        const hit = this.hit(ray, o);
        if (hit && hit.distance < distance - Math.max(0.0001, distance * 1e-5)) return true;
      }
    return false;
  }
  select(
    overlay: MeshOverlay,
    camera: THREE.Camera,
    rect: DOMRect,
    from: [number, number],
    to?: [number, number],
  ) {
    if (!visible(overlay.mesh)) return [];
    const project = (p: THREE.Vector3) => {
      const ndc = p.clone().project(camera);
      return { x: ((ndc.x + 1) / 2) * rect.width, y: ((1 - ndc.y) / 2) * rect.height, z: ndc.z };
    };
    const world = overlay.geometry.positions.map((p) =>
      new THREE.Vector3().fromArray(p).applyMatrix4(overlay.mesh.matrixWorld),
    );
    const points = world.map(project),
      mode = overlay.selection.mode;
    const candidates: {
      index: number;
      point: THREE.Vector3;
      screen: ReturnType<typeof project>;
      distance: number;
    }[] = [];
    const inBox = (p: { x: number; y: number }) =>
      !!to &&
      p.x >= Math.min(from[0], to[0]) &&
      p.x <= Math.max(from[0], to[0]) &&
      p.y >= Math.min(from[1], to[1]) &&
      p.y <= Math.max(from[1], to[1]);
    const add = (index: number, point: THREE.Vector3, screen = project(point), radius = 10) => {
      if (screen.z < -1 || screen.z > 1) return;
      const distance = Math.hypot(screen.x - from[0], screen.y - from[1]);
      if (to ? inBox(screen) : distance <= radius)
        candidates.push({ index, point, screen, distance });
    };
    if (mode === 'vertex') world.forEach((p, i) => add(i, p, points[i]));
    else if (mode === 'edge')
      overlay.edges.forEach(([a, b], i) => {
        if (to) {
          add(i, world[a].clone().lerp(world[b], 0.5));
          return;
        }
        const pa = points[a],
          pb = points[b],
          dx = pb.x - pa.x,
          dy = pb.y - pa.y;
        if (pa.z < -1 || pb.z < -1 || pa.z > 1 || pb.z > 1) return;
        const t = Math.max(
          0,
          Math.min(1, ((from[0] - pa.x) * dx + (from[1] - pa.y) * dy) / (dx * dx + dy * dy || 1)),
        );
        const wa = -world[a].clone().applyMatrix4(camera.matrixWorldInverse).z,
          wb = -world[b].clone().applyMatrix4(camera.matrixWorldInverse).z;
        const alpha = (t * wa) / ((1 - t) * wb + t * wa);
        add(
          i,
          world[a].clone().lerp(world[b], alpha),
          { x: pa.x + dx * t, y: pa.y + dy * t, z: pa.z + (pb.z - pa.z) * t },
          8,
        );
      });
    else if (!to && !overlay.xray) {
      const ray = new THREE.Raycaster();
      ray.setFromCamera(
        new THREE.Vector2((from[0] / rect.width) * 2 - 1, 1 - (from[1] / rect.height) * 2),
        camera,
      );
      ray.ray.origin
        .set((from[0] / rect.width) * 2 - 1, 1 - (from[1] / rect.height) * 2, -1)
        .unproject(camera);
      const hit = this.hit(ray.ray, overlay.mesh);
      return hit &&
        project(hit.point).z <= 1 &&
        project(hit.point).z >= -1 &&
        !this.occluded(hit.point, camera)
        ? [hit.face]
        : [];
    } else
      overlay.geometry.triangles.forEach((t, i) =>
        add(
          i,
          world[t[0]]
            .clone()
            .add(world[t[1]])
            .add(world[t[2]])
            .multiplyScalar(1 / 3),
        ),
      );
    candidates.sort((a, b) => a.distance - b.distance || a.screen.z - b.screen.z);
    const selected: number[] = [];
    for (const c of candidates)
      if (overlay.xray || !this.occluded(c.point, camera)) {
        selected.push(c.index);
        if (!to) break;
      }
    return selected;
  }
}
