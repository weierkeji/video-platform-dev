import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { SceneRenderer } from '../render/scene';
import { TimelineRenderer, TimelineAudio } from '../render/timeline';
import { type Entity, type Project } from '../core/model';
import { transformVertices, type MeshSelection } from '../core/mesh';
import { MeshOverlay, MeshPicker } from '../render/mesh-edit';
import { JointOverlay } from '../render/joints';
import {
  activeConstraints,
  activeIK,
  localBasis,
  matrixTransform,
  sceneEvaluator,
} from '../core/constraints';
import { evaluatedIK } from '../core/ik-animation';
import { evaluatedTransform } from '../core/evaluate';
import { applyCommands } from '../core/commands';
import { identity } from '../core/model';
import {
  objectPivot,
  objectTransformBlock,
  type ObjectPivot,
  type ObjectTransformCommand,
} from '../core/object-transform';
import { ObjectSelectionOverlay } from '../render/object-selection';
import { visibleObjects } from './object-selection';

export type ViewportProps = {
  project: Project;
  sceneId: string;
  frame: number;
  playing: boolean;
  layersPreview: boolean;
  restEditing: boolean;
  restEditable: boolean;
  selected: string | null;
  selectedIds: string[];
  objectPivot: ObjectPivot;
  select: (id: string | null, toggle?: boolean) => void;
  selectObjects: (ids: string[], mode: 'replace' | 'add' | 'remove') => void;
  onGroupTransform: (command: ObjectTransformCommand) => void;
  mode: 'translate' | 'rotate' | 'scale';
  view: 'scene' | 'sequence';
  onTransform: (id: string, transform: Entity['transform']) => void;
  onView: (transform: Entity['transform']) => void;
  meshSelection: MeshSelection | null;
  meshXray: boolean;
  onMeshXray: (value: boolean) => void;
  onMeshSelect: (indices: number[]) => void;
  onMeshTransform: (indices: number[], matrix: number[]) => void;
  busy: boolean;
};
export function Viewport(props: ViewportProps) {
  const host = useRef<HTMLDivElement>(null),
    canvas = useRef<HTMLCanvasElement>(null),
    current = useRef(props),
    engine = useRef<SceneRenderer | null>(null),
    controls = useRef<TransformControls | null>(null),
    camera = useRef<THREE.PerspectiveCamera | null>(null);
  const [error, setError] = useState(''),
    [constraintWarning, setConstraintWarning] = useState(''),
    [loadingTextures, setLoadingTextures] = useState(false),
    [boxTool, setBoxTool] = useState(false),
    [showJoints, setShowJoints] = useState(true),
    [box, setBox] = useState<{ x: number; y: number; width: number; height: number } | null>(null);
  const boxToolRef = useRef(boxTool);
  const jointsRef = useRef(showJoints);
  jointsRef.current = showJoints;
  boxToolRef.current = boxTool;
  current.current = props;
  useEffect(() => {
    if (props.view !== 'scene') return;
    let renderer: SceneRenderer,
      orbit: OrbitControls,
      gizmo: TransformControls,
      animation = 0,
      observer: ResizeObserver;
    try {
      renderer = new SceneRenderer(canvas.current!);
      engine.current = renderer;
      const cam = new THREE.PerspectiveCamera(45, 1, 0.1, 2000);
      camera.current = cam;
      cam.position.set(8, 6, 10);
      cam.lookAt(0, 1, 0);
      orbit = new OrbitControls(cam, canvas.current!);
      orbit.target.set(0, 1, 0);
      orbit.enableDamping = true;
      gizmo = new TransformControls(cam, canvas.current!);
      controls.current = gizmo;
      let overlay: MeshOverlay | undefined, picker: MeshPicker | undefined;
      let joints: JointOverlay | undefined;
      let previousLoading = false,
        previousTextureError = '';
      let lastSelection: MeshSelection | null | undefined,
        lastXray = false;
      const proxy = new THREE.Object3D();
      const selectionMarks = new ObjectSelectionOverlay(renderer);
      let drag: {
        projectId: string;
        revision: number;
        frame: number;
        layersPreview: boolean;
        restEditing: boolean;
        selection: MeshSelection | null;
        world: THREE.Matrix4;
        start: THREE.Matrix4;
        geometry?: Project['geometries'][number];
        indices: number[];
        matrix?: number[];
        changed: boolean;
        entityId?: string;
        parent?: THREE.Matrix4;
        basis?: THREE.Matrix4;
        channel?: Entity['transform'];
        group?: ObjectTransformCommand;
      } | null = null;
      let down: { x: number; y: number; transformed: boolean; box: boolean } | null = null;
      let cancelling = false;
      const cancel = () => {
        const pending = drag;
        drag = null;
        cancelling = true;
        gizmo.reset();
        gizmo.dragging = false;
        gizmo.axis = null;
        if (pending?.geometry && overlay) overlay.preview(pending.geometry.positions, true);
        cancelling = false;
        orbit.enabled = true;
        down = null;
        setBox(null);
      };
      gizmo.addEventListener('dragging-changed', (e) => {
        orbit.enabled = !e.value;
        if (e.value && gizmo.object) {
          if (down) down.transformed = true;
          const p = current.current;
          proxy.updateMatrixWorld(true);
          const attached =
            gizmo.object === proxy && !overlay && p.selectedIds.length === 1
              ? p.project.entities.find((e) => e.id === p.selected && e.parentOffset?.enabled)
              : undefined;
          const object = attached && renderer.objects.get(attached.id);
          drag = {
            projectId: p.project.id,
            revision: p.project.revision,
            frame: p.frame,
            layersPreview: p.layersPreview,
            restEditing: p.restEditing,
            selection: p.meshSelection,
            world:
              overlay?.mesh.matrixWorld.clone() ||
              object?.matrixWorld.clone() ||
              new THREE.Matrix4(),
            start: proxy.matrixWorld.clone(),
            geometry: overlay ? structuredClone(overlay.geometry) : undefined,
            indices: overlay ? [...overlay.vertices] : [],
            changed: false,
            entityId: attached?.id,
            parent: object?.parent?.matrixWorld.clone(),
            basis: attached && localBasis(attached),
            group:
              !overlay && p.selectedIds.length > 1
                ? {
                    type: 'entities.transform',
                    entityIds: [...p.selectedIds],
                    activeId: p.selected!,
                    frame: p.frame,
                    layers: p.layersPreview,
                    pivot: p.objectPivot,
                    delta: identity(),
                  }
                : undefined,
          };
        } else if (!e.value && gizmo.object && !cancelling && drag) {
          const pending = drag;
          drag = null;
          const p = current.current;
          const valid =
            p.project.id === pending.projectId &&
            p.project.revision === pending.revision &&
            p.frame === pending.frame &&
            p.layersPreview === pending.layersPreview &&
            p.restEditing === pending.restEditing &&
            p.meshSelection === pending.selection &&
            (!pending.entityId || p.selected === pending.entityId) &&
            (!pending.group ||
              (p.selectedIds.join('/') === pending.group.entityIds.join('/') &&
                p.objectPivot === pending.group.pivot));
          if (pending.geometry && overlay) {
            overlay.preview(pending.geometry.positions, true);
            if (valid && pending.matrix && pending.changed)
              current.current.onMeshTransform(pending.indices, pending.matrix);
            return;
          }
          if (!valid || !pending.changed) return;
          if (pending.group) {
            current.current.onGroupTransform(pending.group);
            return;
          }
          if (pending.entityId) {
            if (pending.channel) current.current.onTransform(pending.entityId, pending.channel);
            return;
          }
          const o = gizmo.object;
          current.current.onTransform(o.userData.entityId, {
            position: o.position.toArray(),
            rotation: [o.rotation.x, o.rotation.y, o.rotation.z],
            scale: o.scale.toArray(),
          });
        }
      });
      gizmo.addEventListener('objectChange', () => {
        if (!drag || cancelling) return;
        drag.changed = true;
        if (drag.group) {
          try {
            const delta = {
              position: proxy.position
                .clone()
                .sub(new THREE.Vector3().setFromMatrixPosition(drag.start))
                .toArray(),
              rotation: [proxy.rotation.x, proxy.rotation.y, proxy.rotation.z] as [
                number,
                number,
                number,
              ],
              scale: proxy.scale.toArray(),
            };
            const command = { ...drag.group, delta };
            const preview = applyCommands(current.current.project, [command]).project;
            renderer.previewPose(
              sceneEvaluator(preview, current.current.sceneId)(
                command.frame,
                undefined,
                command.layers,
              ),
            );
            drag.group = command;
            setError('');
          } catch (e) {
            cancel();
            setError((e as Error).message);
          }
          return;
        }
        if (drag.entityId) {
          proxy.updateMatrixWorld(true);
          try {
            const parent = drag.parent || new THREE.Matrix4();
            if (Math.abs(parent.determinant()) < 1e-12)
              throw new Error('父级矩阵不可逆，无法编辑频道');
            const local = parent
              .clone()
              .invert()
              .multiply(proxy.matrixWorld)
              .multiply(drag.start.clone().invert())
              .multiply(drag.world);
            const e = current.current.project.entities.find((e) => e.id === drag!.entityId)!;
            const channel = matrixTransform(drag.basis!.clone().invert().multiply(local), e.name);
            if (current.current.mode === 'translate') {
              const authored = evaluatedTransform(
                current.current.project,
                e,
                current.current.frame,
                undefined,
                current.current.layersPreview,
              );
              channel.rotation = authored.rotation;
              channel.quaternion = authored.quaternion;
              channel.scale = authored.scale;
            }
            drag.channel = channel;
            const object = renderer.objects.get(e.id)!;
            object.matrix.copy(local);
            object.matrix.decompose(object.position, object.quaternion, object.scale);
            object.updateMatrixWorld(true);
            setError('');
          } catch (e) {
            cancel();
            setError((e as Error).message);
          }
          return;
        }
        if (!drag.geometry || !overlay) return;
        proxy.updateMatrixWorld(true);
        const matrix = drag.world
          .clone()
          .invert()
          .multiply(proxy.matrixWorld)
          .multiply(drag.start.clone().invert())
          .multiply(drag.world)
          .toArray();
        try {
          const copy = { ...drag.geometry, positions: [...drag.geometry.positions] };
          transformVertices(copy, drag.indices, matrix);
          overlay.preview(copy.positions);
          drag.matrix = matrix;
          setError('');
        } catch (e) {
          cancel();
          setError((e as Error).message);
        }
      });
      const grid = new THREE.GridHelper(30, 30, 0x4e647c, 0x2b3848);
      grid.name = 'editor-grid';
      const sync = () => {
        if (drag) cancel();
        overlay?.dispose();
        joints?.dispose();
        selectionMarks.dispose();
        overlay = undefined;
        gizmo.detach();
        renderer.setProject(current.current.project, current.current.sceneId);
        renderer.scene.add(grid);
        renderer.scene.add(gizmo.getHelper());
        renderer.scene.add(proxy);
        joints = new JointOverlay(current.current.project, renderer);
        picker = new MeshPicker(current.current.project, renderer);
        lastSelection = undefined;
      };
      sync();
      const syncSelection = () => {
        const p = current.current;
        if (renderer.project !== p.project || renderer.sceneId !== p.sceneId) sync();
        if (!gizmo.dragging)
          renderer.evaluate(p.frame, undefined, p.layersPreview, p.meshSelection?.entityId);
        setConstraintWarning(renderer.constraintWarnings.join('；'));
        joints?.update(jointsRef.current && !p.meshSelection, p.selected);
        const selected = p.selected ? renderer.objects.get(p.selected) : undefined;
        if (p.meshSelection !== lastSelection || p.meshXray !== lastXray) {
          overlay?.dispose();
          overlay = undefined;
          gizmo.detach();
          const editMesh = p.meshSelection
            ? renderer.meshObject(p.meshSelection.entityId)
            : undefined;
          if (p.meshSelection && editMesh) {
            const geometry = p.project.geometries.find((g) => g.id === p.meshSelection!.geometryId);
            if (geometry)
              overlay = new MeshOverlay(geometry, editMesh, p.meshSelection, p.meshXray);
          }
          lastSelection = p.meshSelection;
          lastXray = p.meshXray;
        }
        return selected;
      };
      const container = host.current!;
      observer = new ResizeObserver(() => {
        // Ref detachment precedes passive cleanup when changing workspaces.
        if (!container.isConnected) return;
        const r = container.getBoundingClientRect();
        renderer.renderer.setSize(
          Math.max(1, Math.floor(r.width)),
          Math.max(1, Math.floor(r.height)),
          false,
        );
      });
      observer.observe(container);
      const start = (e: PointerEvent) => {
        if (e.button !== 0 || current.current.busy || current.current.playing) return;
        syncSelection();
        canvas.current!.focus();
        down = {
          x: e.clientX,
          y: e.clientY,
          transformed: false,
          box: !current.current.restEditing && boxToolRef.current,
        };
        if (down.box) {
          e.preventDefault();
          e.stopImmediatePropagation();
          orbit.enabled = false;
          canvas.current!.setPointerCapture(e.pointerId);
          const r = canvas.current!.getBoundingClientRect();
          setBox({ x: e.clientX - r.left, y: e.clientY - r.top, width: 0, height: 0 });
        }
      };
      const choose = (indices: number[], event: PointerEvent, box = false) => {
        const selected = new Set(current.current.meshSelection!.indices);
        if (event.ctrlKey || event.metaKey) indices.forEach((i) => selected.delete(i));
        else if (event.shiftKey)
          indices.forEach((i) => {
            if (!box && selected.has(i)) selected.delete(i);
            else selected.add(i);
          });
        else {
          selected.clear();
          indices.forEach((i) => selected.add(i));
        }
        current.current.onMeshSelect([...selected].sort((a, b) => a - b));
      };
      const moveBox = (e: PointerEvent) => {
        if (!down?.box) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        const r = canvas.current!.getBoundingClientRect();
        setBox({
          x: Math.min(down.x, e.clientX) - r.left,
          y: Math.min(down.y, e.clientY) - r.top,
          width: Math.abs(down.x - e.clientX),
          height: Math.abs(down.y - e.clientY),
        });
      };
      const endBox = (e: PointerEvent) => {
        if (!down?.box) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        const r = canvas.current!.getBoundingClientRect();
        syncSelection();
        if (overlay && picker)
          choose(
            picker.select(
              overlay,
              cam,
              r,
              [down.x - r.left, down.y - r.top],
              [e.clientX - r.left, e.clientY - r.top],
            ),
            e,
            true,
          );
        else if (!current.current.meshSelection) {
          const p = current.current,
            ids: string[] = [];
          const left = Math.min(down.x, e.clientX),
            right = Math.max(down.x, e.clientX),
            top = Math.min(down.y, e.clientY),
            bottom = Math.max(down.y, e.clientY);
          for (const key of visibleObjects(p.project, p.sceneId)) {
            const q = new THREE.Vector3()
              .setFromMatrixPosition(renderer.objects.get(key)!.matrixWorld)
              .project(cam);
            const x = r.left + ((q.x + 1) * r.width) / 2,
              y = r.top + ((1 - q.y) * r.height) / 2;
            if (q.z >= -1 && q.z <= 1 && x >= left && x <= right && y >= top && y <= bottom)
              ids.push(key);
          }
          p.selectObjects(ids, e.ctrlKey || e.metaKey ? 'remove' : e.shiftKey ? 'add' : 'replace');
        }
        down = null;
        orbit.enabled = true;
        setBox(null);
        if (canvas.current!.hasPointerCapture(e.pointerId))
          canvas.current!.releasePointerCapture(e.pointerId);
      };
      const pick = (e: PointerEvent) => {
        const started = down;
        down = null;
        if (
          !started ||
          e.button !== 0 ||
          current.current.busy ||
          current.current.playing ||
          started.transformed ||
          Math.hypot(e.clientX - started.x, e.clientY - started.y) > 4 ||
          gizmo.dragging ||
          gizmo.axis
        )
          return;
        const r = canvas.current!.getBoundingClientRect(),
          ray = new THREE.Raycaster();
        syncSelection();
        if (current.current.meshSelection) {
          if (overlay && picker)
            choose(picker.select(overlay, cam, r, [e.clientX - r.left, e.clientY - r.top]), e);
          return;
        }
        ray.setFromCamera(
          new THREE.Vector2(
            ((e.clientX - r.left) / r.width) * 2 - 1,
            (-(e.clientY - r.top) / r.height) * 2 + 1,
          ),
          cam,
        );
        const jointHits = ray.intersectObjects(joints?.pickables() || [], false);
        if (jointHits[0]) {
          current.current.select(
            jointHits[0].object.userData.entityId,
            e.shiftKey || e.ctrlKey || e.metaKey,
          );
          return;
        }
        const hits = ray.intersectObjects(
          renderer.meshes().filter((o) => {
            let current: THREE.Object3D | null = o;
            while (current) {
              if (!current.visible) return false;
              current = current.parent;
            }
            return o instanceof THREE.Mesh;
          }),
          false,
        );
        if (hits[0])
          current.current.select(
            hits[0].object.userData.entityId,
            e.shiftKey || e.ctrlKey || e.metaKey,
          );
        else if (!e.shiftKey && !e.ctrlKey && !e.metaKey) current.current.select(null);
      };
      const keydown = (e: KeyboardEvent) => {
        if (document.querySelector('.modal-backdrop')) return;
        if ((e.target as HTMLElement).closest('input,textarea,select,[contenteditable]')) return;
        if (
          drag &&
          (['Escape', 'Delete', ' ', 'g', 'r', 's', '1', '2', '3'].includes(e.key) ||
            e.ctrlKey ||
            e.metaKey)
        ) {
          e.preventDefault();
          e.stopImmediatePropagation();
          cancel();
        } else if (!current.current.restEditing && e.key.toLowerCase() === 'b') {
          e.preventDefault();
          setBoxTool((v) => !v);
        } else if (down?.box && e.key === 'Escape') {
          e.preventDefault();
          e.stopImmediatePropagation();
          cancel();
        }
      };
      canvas.current!.addEventListener('pointerdown', start, true);
      canvas.current!.addEventListener('pointermove', moveBox, true);
      canvas.current!.addEventListener('pointerup', endBox, true);
      canvas.current!.addEventListener('pointercancel', cancel, true);
      canvas.current!.addEventListener('pointerup', pick);
      window.addEventListener('keydown', keydown, true);
      const loop = () => {
        const p = current.current;
        if (
          drag &&
          (p.project.revision !== drag.revision ||
            p.frame !== drag.frame ||
            p.layersPreview !== drag.layersPreview ||
            p.restEditing !== drag.restEditing ||
            p.meshSelection !== drag.selection ||
            p.playing ||
            (drag.entityId && p.selected !== drag.entityId) ||
            (drag.group &&
              (p.selectedIds.join('/') !== drag.group.entityIds.join('/') ||
                p.objectPivot !== drag.group.pivot)))
        )
          cancel();
        const selected = syncSelection();
        const compensated =
          selected &&
          p.project.entities.some((e) => e.id === p.selected && e.parentOffset?.enabled);
        const group = p.selectedIds.length > 1 && !p.meshSelection && !p.restEditing;
        if (overlay && !gizmo.dragging) {
          proxy.position.copy(overlay.center());
          proxy.quaternion.identity();
          proxy.scale.set(1, 1, 1);
          proxy.updateMatrixWorld(true);
        } else if (group && !gizmo.dragging) {
          const world = new Map(
            p.selectedIds.map((key) => [key, renderer.objects.get(key)!.matrixWorld]),
          );
          proxy.position.copy(objectPivot(world, p.selectedIds, p.selected!, p.objectPivot));
          proxy.quaternion.identity();
          proxy.scale.set(1, 1, 1);
          proxy.updateMatrixWorld(true);
        } else if (compensated && !gizmo.dragging) {
          proxy.position.setFromMatrixPosition(selected.matrixWorld);
          proxy.quaternion.identity();
          proxy.scale.set(1, 1, 1);
          proxy.userData.entityId = p.selected;
          proxy.updateMatrixWorld(true);
        }
        const target = group
          ? objectTransformBlock(p.project, p.selectedIds, p.frame, p.layersPreview)
            ? undefined
            : proxy
          : p.restEditing && !p.restEditable
            ? undefined
            : p.meshSelection
              ? overlay?.vertices.length && Math.abs(overlay.mesh.matrixWorld.determinant()) > 1e-12
                ? proxy
                : undefined
              : activeIK(p.project.ikChains, p.project.ikTracks).some(
                    (chain) =>
                      chain.joints.includes(p.selected || '') &&
                      evaluatedIK(p.project, chain, p.frame, undefined, p.layersPreview).influence >
                        0,
                  ) ||
                  p.project.entities.some(
                    (e) =>
                      e.id === p.selected &&
                      (e.skin || e.restPose?.enabled || activeConstraints(e).length),
                  ) ||
                  (p.layersPreview &&
                    p.project.animationLayers?.some((l) => l.entityId === p.selected && l.enabled))
                ? undefined
                : compensated
                  ? proxy
                  : selected;
        if (target && gizmo.object !== target) gizmo.attach(target);
        else if (!target) gizmo.detach();
        gizmo.enabled =
          !p.busy &&
          !p.playing &&
          !renderer.loading &&
          !renderer.textureError &&
          !(boxToolRef.current && !p.restEditing);
        gizmo.setSpace('world');
        gizmo.setMode(p.mode);
        orbit.update();
        selectionMarks.update(p.meshSelection ? [] : p.selectedIds, p.selected);
        if (renderer.loading !== previousLoading) {
          previousLoading = renderer.loading;
          setLoadingTextures(renderer.loading);
        }
        if (renderer.textureError !== previousTextureError) {
          previousTextureError = renderer.textureError;
          setError(renderer.textureError);
        }
        if (!renderer.loading && !renderer.textureError)
          renderer.render(
            cam,
            renderer.renderer.domElement.width,
            renderer.renderer.domElement.height,
          );
        else renderer.renderer.clear();
        animation = requestAnimationFrame(loop);
      };
      loop();
      return () => {
        cancelAnimationFrame(animation);
        observer.disconnect();
        window.removeEventListener('keydown', keydown, true);
        canvas.current?.removeEventListener('pointerdown', start, true);
        canvas.current?.removeEventListener('pointermove', moveBox, true);
        canvas.current?.removeEventListener('pointerup', endBox, true);
        canvas.current?.removeEventListener('pointercancel', cancel, true);
        canvas.current?.removeEventListener('pointerup', pick);
        overlay?.dispose();
        joints?.dispose();
        selectionMarks.dispose();
        gizmo.detach();
        gizmo.dispose();
        orbit.dispose();
        grid.geometry.dispose();
        (grid.material as THREE.Material).dispose();
        renderer.dispose();
        engine.current = null;
      };
    } catch (e) {
      setError(String(e));
    }
  }, [props.view]);
  useEffect(() => {
    if (props.view !== 'sequence') return;
    setLoadingTextures(false);
    setError('');
    let renderer: TimelineRenderer;
    const audio = new TimelineAudio();
    let cancelled = false,
      animation = 0,
      lastFrame = -1,
      lastProject: Project | null = null;
    try {
      renderer = new TimelineRenderer(canvas.current!, props.project);
    } catch (e) {
      setError(String(e));
      return;
    }
    const loop = async () => {
      const p = current.current;
      if (lastFrame !== p.frame || lastProject !== p.project) {
        renderer.project = p.project;
        lastFrame = p.frame;
        lastProject = p.project;
        try {
          await renderer.render(p.frame);
          setError('');
        } catch (e) {
          if (!cancelled) setError(String(e));
        }
      }
      audio.sync(p.project, p.frame, p.playing);
      if (audio.error && !cancelled) setError(audio.error);
      if (!cancelled) animation = requestAnimationFrame(() => void loop());
    };
    void loop();
    return () => {
      cancelled = true;
      cancelAnimationFrame(animation);
      audio.dispose();
      renderer.dispose();
    };
  }, [props.view]);
  return (
    <div className={'viewport ' + (props.view === 'sequence' ? 'sequence' : '')} ref={host}>
      <canvas
        key={props.view}
        ref={canvas}
        tabIndex={0}
        data-mesh-mode={props.meshSelection?.mode || 'object'}
        data-rest-pose={props.restEditing ? 'true' : 'false'}
        data-selected-objects={props.selectedIds.join(' ')}
        aria-label={props.view === 'scene' ? '三维编辑视图' : '成片预览'}
      />
      {box && (
        <div
          className="mesh-box"
          style={{ left: box.x, top: box.y, width: box.width, height: box.height }}
        />
      )}
      <div className="viewport-tag">
        {props.restEditing
          ? '基础姿态 · 不随动画帧变化 · 导出仍使用动画'
          : props.view === 'scene'
            ? '透视视图 · 米 · Y 向上'
            : '成片预览 · 与后台共用逐帧渲染'}
        <span>
          {props.project.entities.length} 对象 · 帧 {props.frame}
        </span>
      </div>
      {props.view === 'scene' && (
        <div className="view-actions">
          <label>
            <input
              type="checkbox"
              aria-label="显示关节"
              checked={showJoints}
              onChange={(e) => setShowJoints(e.target.checked)}
            />
            显示关节
          </label>
          {!props.restEditing && (
            <button className={boxTool ? 'active' : ''} onClick={() => setBoxTool(!boxTool)}>
              {props.meshSelection ? '框选 · B' : '框选原点 · B'}
            </button>
          )}
          {props.meshSelection && (
            <>
              <label>
                <input
                  type="checkbox"
                  aria-label="穿透选择"
                  checked={props.meshXray}
                  onChange={(e) => props.onMeshXray(e.target.checked)}
                />
                穿透选择
              </label>
            </>
          )}
          <button
            disabled={props.restEditing}
            onClick={() => {
              const cam = camera.current;
              if (cam)
                props.onView({
                  position: cam.position.toArray(),
                  rotation: [cam.rotation.x, cam.rotation.y, cam.rotation.z],
                  scale: [1, 1, 1],
                });
            }}
          >
            将当前视角用于镜头
          </button>
          <span>拖动旋转 · 滚轮缩放 · 右键平移</span>
        </div>
      )}
      {error && (
        <div className="viewport-error" role="alert">
          {error}
        </div>
      )}
      {constraintWarning && props.view === 'scene' && !error && (
        <div className="viewport-error" role="status">
          {constraintWarning}
        </div>
      )}
      {loadingTextures && props.view === 'scene' && (
        <div className="viewport-error" role="status">
          正在加载材质贴图…
        </div>
      )}
    </div>
  );
}
