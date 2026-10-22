import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { SceneRenderer } from '../render/scene';
import { TimelineRenderer, TimelineAudio } from '../render/timeline';
import { type Entity, type Project } from '../core/model';

export type ViewportProps = {
  project: Project;
  sceneId: string;
  frame: number;
  playing: boolean;
  selected: string | null;
  select: (id: string) => void;
  mode: 'translate' | 'rotate' | 'scale';
  view: 'scene' | 'sequence';
  onTransform: (id: string, transform: Entity['transform']) => void;
  onView: (transform: Entity['transform']) => void;
};
export function Viewport(props: ViewportProps) {
  const host = useRef<HTMLDivElement>(null),
    canvas = useRef<HTMLCanvasElement>(null),
    current = useRef(props),
    engine = useRef<SceneRenderer | null>(null),
    controls = useRef<TransformControls | null>(null),
    camera = useRef<THREE.PerspectiveCamera | null>(null);
  const [error, setError] = useState('');
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
      gizmo.addEventListener('dragging-changed', (e) => {
        orbit.enabled = !e.value;
        if (!e.value && gizmo.object) {
          const o = gizmo.object;
          current.current.onTransform(o.userData.entityId, {
            position: o.position.toArray(),
            rotation: [o.rotation.x, o.rotation.y, o.rotation.z],
            scale: o.scale.toArray(),
          });
        }
      });
      const grid = new THREE.GridHelper(30, 30, 0x4e647c, 0x2b3848);
      grid.name = 'editor-grid';
      const sync = () => {
        renderer.setProject(current.current.project, current.current.sceneId);
        renderer.scene.add(grid);
        renderer.scene.add(gizmo.getHelper());
      };
      sync();
      observer = new ResizeObserver(() => {
        const r = host.current!.getBoundingClientRect();
        renderer.renderer.setSize(
          Math.max(1, Math.floor(r.width)),
          Math.max(1, Math.floor(r.height)),
          false,
        );
      });
      observer.observe(host.current!);
      let down = [0, 0];
      const start = (e: PointerEvent) => {
        down = [e.clientX, e.clientY];
      };
      const pick = (e: PointerEvent) => {
        if (
          Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 4 ||
          gizmo.dragging ||
          gizmo.axis
        )
          return;
        const r = canvas.current!.getBoundingClientRect(),
          ray = new THREE.Raycaster();
        ray.setFromCamera(
          new THREE.Vector2(
            ((e.clientX - r.left) / r.width) * 2 - 1,
            (-(e.clientY - r.top) / r.height) * 2 + 1,
          ),
          cam,
        );
        const hits = ray.intersectObjects(
          [...renderer.objects.values()].filter((o) => o instanceof THREE.Mesh),
          false,
        );
        if (hits[0]) current.current.select(hits[0].object.userData.entityId);
      };
      canvas.current!.addEventListener('pointerdown', start);
      canvas.current!.addEventListener('pointerup', pick);
      const loop = () => {
        const p = current.current;
        if (renderer.project !== p.project || renderer.sceneId !== p.sceneId) sync();
        if (!gizmo.dragging) renderer.evaluate(p.frame);
        const selected = p.selected ? renderer.objects.get(p.selected) : undefined;
        if (selected && gizmo.object !== selected) gizmo.attach(selected);
        else if (!selected) gizmo.detach();
        gizmo.setMode(p.mode);
        orbit.update();
        renderer.render(
          cam,
          renderer.renderer.domElement.width,
          renderer.renderer.domElement.height,
        );
        animation = requestAnimationFrame(loop);
      };
      loop();
      return () => {
        cancelAnimationFrame(animation);
        observer.disconnect();
        canvas.current?.removeEventListener('pointerdown', start);
        canvas.current?.removeEventListener('pointerup', pick);
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
        aria-label={props.view === 'scene' ? '三维编辑视图' : '成片预览'}
      />
      <div className="viewport-tag">
        {props.view === 'scene' ? '透视视图 · 米 · Y 向上' : '成片预览 · 与后台共用逐帧渲染'}
        <span>
          {props.project.entities.length} 对象 · 帧 {props.frame}
        </span>
      </div>
      {props.view === 'scene' && (
        <div className="view-actions">
          <button
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
    </div>
  );
}
