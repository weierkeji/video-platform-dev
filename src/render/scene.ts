import * as THREE from 'three';
import { evaluatedTransform } from '../core/evaluate';
import { activeConstraints, sceneEvaluator } from '../core/constraints';
import { type Entity, type Geometry, type Project } from '../core/model';
import { deformGeometry } from '../core/skin';
import { linearColor, surfaceGeometry, surfaceMaterial } from '../core/surface';
import { TextureBank } from './textures';

export class SceneRenderer {
  renderer: THREE.WebGLRenderer;
  scene = new THREE.Scene();
  objects = new Map<string, THREE.Object3D>();
  private skins = new Map<string, { mesh: THREE.Mesh; source: Geometry; key: string }>();
  meshObject(id: string) {
    const object = this.skins.get(id)?.mesh || this.objects.get(id);
    return object instanceof THREE.Mesh ? object : undefined;
  }
  meshes() {
    return [...this.objects.keys()].flatMap((id) => {
      const m = this.meshObject(id);
      return m ? [m] : [];
    });
  }
  project: Project | null = null;
  sceneId = '';
  loading = false;
  textureError = '';
  constraintWarnings: string[] = [];
  private evaluateScene?: ReturnType<typeof sceneEvaluator>;
  private textures?: TextureBank;
  private pending = Promise.resolve();
  private generation = 0;
  ready() {
    return this.pending;
  }
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
    this.evaluateScene = sceneEvaluator(p, sceneId);
    const generation = this.generation,
      textures = (this.textures = new TextureBank(p, this.renderer.capabilities.maxTextureSize));
    const tasks: Promise<void>[] = [];
    const settings = p.scenes.find((s) => s.id === sceneId);
    if (!settings) throw new Error('场景不存在');
    this.scene.background = new THREE.Color(settings.background);
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x445166, settings.ambient));
    const entities = p.entities.filter((e) => e.sceneId === sceneId),
      byId = new Map(entities.map((e) => [e.id, e]));
    const visible = (e: Entity): boolean =>
      e.visible && (!e.parentId || visible(byId.get(e.parentId)!));
    for (const e of entities) {
      let object: THREE.Object3D;
      if (e.kind === 'mesh') {
        const g = p.geometries.find((g) => g.id === e.geometryId)!,
          m = p.materials.find((m) => m.id === e.materialId)!;
        const geometry = surfaceGeometry(g),
          material = surfaceMaterial(m);
        if (m.flatShading ?? true) geometry.deleteAttribute('tangent');
        object = new THREE.Mesh(geometry, material);
        if (visible(e) && g.triangles.length && Object.keys(m.textures || {}).length)
          tasks.push(textures.apply(material, m));
        object.castShadow = true;
        object.receiveShadow = true;
        if (e.skin) {
          const mesh = object as THREE.Mesh;
          mesh.name = e.name;
          mesh.userData.entityId = e.id;
          mesh.userData.deformed = true;
          mesh.matrixAutoUpdate = false;
          const normal = geometry.getAttribute('normal');
          const source = {
            ...g,
            normals:
              g.normals ||
              Array.from(
                { length: normal.count },
                (_, i) =>
                  [normal.getX(i), normal.getY(i), normal.getZ(i)] as [number, number, number],
              ),
          };
          this.skins.set(e.id, { mesh, source, key: '' });
          this.scene.add(mesh);
          object = new THREE.Group();
        }
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
    this.loading = tasks.length > 0;
    this.pending = Promise.all(tasks)
      .then(() => {
        if (generation === this.generation) this.loading = false;
      })
      .catch((error: unknown) => {
        if (generation === this.generation) {
          this.loading = false;
          this.textureError = error instanceof Error ? error.message : String(error);
          textures.dispose();
        }
        throw error;
      });
    void this.pending.catch(() => {});
  }
  evaluate(frame: number, actionId?: string | null, layers = true, restEntityId?: string) {
    if (!this.project) return;
    const pose = this.evaluateScene!(frame, actionId, layers);
    this.constraintWarnings = pose.warnings.map(
      (w) => `${this.project!.entities.find((e) => e.id === w.entityId)!.name}：${w.message}`,
    );
    for (const e of this.project.entities.filter((e) => e.sceneId === this.sceneId)) {
      const t = evaluatedTransform(this.project, e, frame, actionId, layers),
        o = this.objects.get(e.id)!;
      o.position.fromArray(t.position);
      if (t.quaternion) o.quaternion.fromArray(t.quaternion);
      else o.rotation.set(...t.rotation, 'XYZ');
      o.scale.fromArray(t.scale);
      o.matrixAutoUpdate = !activeConstraints(e).length;
      if (!o.matrixAutoUpdate) {
        o.matrix.copy(pose.local.get(e.id)!);
        o.matrix.decompose(o.position, o.quaternion, o.scale);
      }
    }
    this.scene.updateMatrixWorld(true);
    const world = new Map([...this.objects].map(([id, o]) => [id, o.matrixWorld]));
    for (const [id, entry] of this.skins) {
      const entity = this.project.entities.find((e) => e.id === id)!,
        node = this.objects.get(id)!;
      const rest = restEntityId === id;
      let visible = true;
      for (let o: THREE.Object3D | null = node; o; o = o.parent) visible &&= o.visible;
      entry.mesh.visible = visible;
      entry.mesh.userData.deformed = !rest;
      if (rest) entry.mesh.matrix.copy(node.matrixWorld);
      else entry.mesh.matrix.identity();
      entry.mesh.updateMatrixWorld(true);
      const key = rest
        ? 'rest'
        : entity.skin!.joints.map((id) => world.get(id)!.elements.join(',')).join(';');
      if (key === entry.key) continue;
      entry.key = key;
      const g = rest ? entry.source : deformGeometry(entry.source, entity.skin!, world);
      const geometry = entry.mesh.geometry;
      const positions = geometry.getAttribute('position') as THREE.BufferAttribute;
      g.positions.forEach((v, i) => positions.setXYZ(i, ...v));
      positions.needsUpdate = true;
      if (g.normals) {
        const normals = geometry.getAttribute('normal') as THREE.BufferAttribute;
        g.normals.forEach((v, i) => normals.setXYZ(i, ...v));
        normals.needsUpdate = true;
      }
      if (g.tangents && geometry.hasAttribute('tangent')) {
        const tangents = geometry.getAttribute('tangent') as THREE.BufferAttribute;
        g.tangents.forEach((v, i) => tangents.setXYZW(i, ...v));
        tangents.needsUpdate = true;
      }
      geometry.computeBoundingSphere();
      geometry.computeBoundingBox();
    }
  }
  render(camera: THREE.Camera, width: number, height: number) {
    if (this.textureError) throw new Error(this.textureError);
    if (this.loading) throw new Error('纹理尚未就绪');
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
    this.generation++;
    this.textures?.dispose();
    this.textures = undefined;
    this.loading = false;
    this.textureError = '';
    for (const o of this.objects.values()) {
      if (o instanceof THREE.Mesh) {
        o.geometry.dispose();
        for (const m of Array.isArray(o.material) ? o.material : [o.material]) m.dispose();
      }
      if (o instanceof THREE.Light) o.dispose();
    }
    this.scene.clear();
    for (const { mesh } of this.skins.values()) {
      mesh.geometry.dispose();
      for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) m.dispose();
    }
    this.skins.clear();
    this.objects.clear();
    this.project = null;
    this.sceneId = '';
    this.pending = Promise.resolve();
  }
  dispose() {
    this.clear();
    this.renderer.dispose();
  }
}
