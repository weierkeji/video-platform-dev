import { Box3, Box3Helper, Vector3, LineBasicMaterial } from 'three';
import type { SceneRenderer } from './scene';

/** Editor-only selection marks; never enter project or timeline renderers. */
export class ObjectSelectionOverlay {
  private boxes = new Map<string, Box3Helper>();
  constructor(private renderer: SceneRenderer) {}
  update(ids: string[], active: string | null) {
    const selected = new Set(ids);
    for (const [key, box] of this.boxes)
      if (!selected.has(key)) {
        box.removeFromParent();
        box.geometry.dispose();
        (box.material as LineBasicMaterial).dispose();
        this.boxes.delete(key);
      }
    for (const key of ids) {
      const object = this.renderer.objects.get(key);
      if (!object) continue;
      let box = this.boxes.get(key);
      if (!box) {
        box = new Box3Helper(new Box3());
        const material = box.material as LineBasicMaterial;
        material.depthTest = false;
        material.depthWrite = false;
        box.renderOrder = 8;
        this.boxes.set(key, box);
        this.renderer.scene.add(box);
      }
      (box.material as LineBasicMaterial).color.set(key === active ? '#ffc36a' : '#58c6e8');
      let visible = true,
        ancestor = object.parent;
      while (ancestor) {
        visible &&= ancestor.visible;
        ancestor = ancestor.parent;
      }
      box.visible = object.visible && visible;
      box.box.setFromObject(this.renderer.meshObject(key) || object);
      if (box.box.isEmpty()) {
        const position = new Vector3().setFromMatrixPosition(object.matrixWorld);
        box.box.setFromCenterAndSize(position, new Vector3(0.16, 0.16, 0.16));
      }
      box.updateMatrixWorld(true);
    }
  }
  dispose() {
    this.update([], null);
  }
}
