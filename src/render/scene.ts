import * as THREE from 'three';
import { evaluatedTransform } from '../core/evaluate';
import { type Project } from '../core/model';
import { linearColor, surfaceGeometry, surfaceMaterial } from '../core/surface';

export class SceneRenderer {
  renderer: THREE.WebGLRenderer;
  scene = new THREE.Scene();
  objects = new Map<string, THREE.Object3D>();
  project: Project | null = null;
  sceneId = '';
  constructor(canvas?: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      preserveDrawingBuffer: true,
      alpha: false,
    });
    this.renderer.setPixelRatio(1);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  }
  setProject(p: Project, sceneId: string) {
    if (this.project === p && this.sceneId === sceneId) return;
    this.clear();
    this.project = p;
    this.sceneId = sceneId;
    const settings = p.scenes.find((s) => s.id === sceneId);
    if (!settings) throw new Error('场景不存在');
    this.scene.background = new THREE.Color(settings.background);
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x445166, settings.ambient));
    for (const e of p.entities.filter((e) => e.sceneId === sceneId)) {
      let object: THREE.Object3D;
      if (e.kind === 'mesh') {
        const g = p.geometries.find((g) => g.id === e.geometryId)!,
          m = p.materials.find((m) => m.id === e.materialId)!;
        object = new THREE.Mesh(surfaceGeometry(g), surfaceMaterial(m));
        object.castShadow = true;
        object.receiveShadow = true;
      } else if (e.kind === 'camera')
        object = new THREE.PerspectiveCamera(
          e.camera!.fov,
          e.camera!.aspect || 1,
          e.camera!.near,
          e.camera!.far,
        );
      else if (e.kind === 'light') {
        object =
          e.light!.kind === 'point'
            ? new THREE.PointLight(
                linearColor(e.light!.color, e.light!.linearColor),
                e.light!.intensity,
                e.light!.range || 0,
              )
            : new THREE.DirectionalLight(
                linearColor(e.light!.color, e.light!.linearColor),
                e.light!.intensity,
              );
        const light = object as THREE.PointLight | THREE.DirectionalLight;
        if (light instanceof THREE.DirectionalLight && e.light!.direction === 'local-negative-z') {
          light.target.position.set(0, 0, -1);
          light.add(light.target);
        }
        light.castShadow = true;
        light.shadow.bias = -0.0002;
        light.shadow.normalBias = 0.04;
        light.shadow.mapSize.set(1024, 1024);
      } else object = new THREE.Group();
      object.name = e.name;
      object.userData.entityId = e.id;
      object.visible = e.visible;
      this.objects.set(e.id, object);
    }
    for (const e of p.entities.filter((e) => e.sceneId === sceneId)) {
      const object = this.objects.get(e.id)!;
      (e.parentId ? this.objects.get(e.parentId)! : this.scene).add(object);
    }
  }
  evaluate(frame: number) {
    if (!this.project) return;
    for (const e of this.project.entities.filter((e) => e.sceneId === this.sceneId)) {
      const t = evaluatedTransform(this.project, e, frame),
        o = this.objects.get(e.id)!;
      o.position.fromArray(t.position);
      o.rotation.set(...t.rotation, 'XYZ');
      o.scale.fromArray(t.scale);
    }
    this.scene.updateMatrixWorld(true);
  }
  render(camera: THREE.Camera, width: number, height: number) {
    if (this.renderer.domElement.width !== width || this.renderer.domElement.height !== height)
      this.renderer.setSize(width, height, false);
    if (camera instanceof THREE.PerspectiveCamera) {
      const entity = this.project?.entities.find((e) => e.id === camera.userData.entityId);
      camera.aspect = entity?.camera?.aspect || width / height;
      camera.updateProjectionMatrix();
    }
    this.renderer.render(this.scene, camera);
  }
  clear() {
    for (const o of this.objects.values()) {
      if (o instanceof THREE.Mesh) {
        o.geometry.dispose();
        for (const m of Array.isArray(o.material) ? o.material : [o.material]) m.dispose();
      }
      if (o instanceof THREE.Light) o.dispose();
    }
    this.scene.clear();
    this.objects.clear();
  }
  dispose() {
    this.clear();
    this.renderer.dispose();
  }
}
