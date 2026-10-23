import * as THREE from 'three';
import type { Project } from '../core/model';
import type { SceneRenderer } from './scene';

/** Editor helpers only. They are never added to timeline/PNG/MP4 renderers. */
export class JointOverlay {
  root = new THREE.Group();
  private dots = new Map<string, THREE.Mesh>();
  private links: { child: string; parent: string; line: THREE.Line }[] = [];
  private geometry = new THREE.SphereGeometry(0.075, 10, 8);
  private material = new THREE.MeshBasicMaterial({
    color: '#71d5e6',
    depthTest: false,
    depthWrite: false,
  });
  private targetMaterial = new THREE.MeshBasicMaterial({
    color: '#f5a35e',
    depthTest: false,
    depthWrite: false,
  });
  private poleMaterial = new THREE.MeshBasicMaterial({
    color: '#c68dea',
    depthTest: false,
    depthWrite: false,
  });
  private lineMaterial = new THREE.LineBasicMaterial({
    color: '#8db6d2',
    depthTest: false,
    depthWrite: false,
  });
  constructor(
    p: Project,
    private renderer: SceneRenderer,
  ) {
    const ids = new Set(
      p.entities.filter((e) => e.sceneId === renderer.sceneId && e.joint).map((e) => e.id),
    );
    for (const e of p.entities)
      if (e.sceneId === renderer.sceneId) e.skin?.joints.forEach((id) => ids.add(id));
    const targets = new Set<string>(),
      poles = new Set<string>();
    for (const chain of p.ikChains || [])
      if (chain.sceneId === renderer.sceneId) {
        chain.joints.forEach((id) => ids.add(id));
        targets.add(chain.targetId);
        ids.add(chain.targetId);
        if (chain.poleId) {
          poles.add(chain.poleId);
          ids.add(chain.poleId);
        }
      }
    const entities = new Map(p.entities.map((e) => [e.id, e]));
    for (const id of ids) {
      const dot = new THREE.Mesh(
        this.geometry,
        targets.has(id) ? this.targetMaterial : poles.has(id) ? this.poleMaterial : this.material,
      );
      dot.userData.entityId = id;
      dot.renderOrder = 10;
      this.dots.set(id, dot);
      this.root.add(dot);
      let parent = entities.get(id)?.parentId;
      while (parent && !ids.has(parent)) parent = entities.get(parent)?.parentId;
      if (parent) {
        const geometry = new THREE.BufferGeometry().setFromPoints([
          new THREE.Vector3(),
          new THREE.Vector3(),
        ]);
        const line = new THREE.Line(geometry, this.lineMaterial);
        line.renderOrder = 9;
        this.links.push({ child: id, parent, line });
        this.root.add(line);
      }
    }
    renderer.scene.add(this.root);
  }
  update(visible: boolean, selected: string | null) {
    this.root.visible = visible;
    if (!visible) return;
    for (const [id, dot] of this.dots) {
      dot.position.setFromMatrixPosition(this.renderer.objects.get(id)!.matrixWorld);
      dot.scale.setScalar(id === selected ? 1.5 : 1);
    }
    for (const { child, parent, line } of this.links) {
      const attr = line.geometry.getAttribute('position') as THREE.BufferAttribute;
      attr.setXYZ(0, ...this.dots.get(child)!.position.toArray());
      attr.setXYZ(1, ...this.dots.get(parent)!.position.toArray());
      attr.needsUpdate = true;
      line.geometry.computeBoundingSphere();
    }
    this.root.updateMatrixWorld(true);
  }
  pickables() {
    return this.root.visible ? [...this.dots.values()] : [];
  }
  dispose() {
    this.root.removeFromParent();
    this.geometry.dispose();
    this.material.dispose();
    this.targetMaterial.dispose();
    this.poleMaterial.dispose();
    this.lineMaterial.dispose();
    this.links.forEach(({ line }) => line.geometry.dispose());
  }
}
