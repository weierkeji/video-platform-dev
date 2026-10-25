import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { applyCommands, type Command } from '../core/commands';
import { evaluatedBaseTransform } from '../core/evaluate';
import { activeTracks, rotationProperty, quaternionFromEuler } from '../core/animation';
import { ActionPanel } from './ActionPanel';
import { ActionSelect } from './ActionSelect';
import { importOBJ } from '../core/geometry';
import {
  id,
  type Asset,
  type Entity,
  type GenerationJob,
  type Project,
  type Revision,
} from '../core/model';
import { TimelineRenderer } from '../render/timeline';
import { Viewport } from './Viewport';
import { Inspector, download } from './Inspector';
import { Timeline } from './Timeline';
import { CurveEditor, type KeySelection } from './CurveEditor';
import { MeshPanel } from './MeshPanel';
import { convertSelection, sameTopology, type MeshMode, type MeshSelection } from '../core/mesh';
import { WorkflowPanel } from './WorkflowPanel';
import { SceneExchange } from './SceneExchange';
import { RetargetPanel } from './RetargetPanel';
import { ReducePanel } from './ReducePanel';
import { restProject, rigNodes } from '../core/rest-pose';
import { RestPosePanel } from './RestPosePanel';

type Envelope = { project: Project; canUndo: boolean; canRedo: boolean };
type Summary = { id: string; name: string; revision: number };
async function api<T>(
  path: string,
  body?: unknown,
  method = body === undefined ? 'GET' : 'POST',
): Promise<T> {
  const r = await fetch('/api' + path, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Studio-Client': 'frameforge' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const result = await r.json();
  if (!r.ok) throw new Error(result.error || r.statusText);
  return result;
}
export function App() {
  const [envelope, setEnvelope] = useState<Envelope | null>(null),
    [projects, setProjects] = useState<Summary[]>([]),
    [selected, setSelected] = useState<string | null>(null),
    [selectedClip, setSelectedClip] = useState<string | null>(null),
    [selectedKey, setSelectedKey] = useState<KeySelection>(null),
    [meshSelection, setMeshSelection] = useState<MeshSelection | null>(null),
    [meshXray, setMeshXray] = useState(false),
    [sceneId, setSceneId] = useState(''),
    [frame, setFrame] = useState(0),
    [playing, setPlaying] = useState(false),
    [layersPreview, setLayersPreview] = useState(true);
  const [restEditing, setRestEditing] = useState(false),
    [preserveRestShape, setPreserveRestShape] = useState(true);
  const [mode, setMode] = useState<'translate' | 'rotate' | 'scale'>('translate'),
    [view, setView] = useState<'scene' | 'sequence'>('scene'),
    [workspace, setWorkspace] = useState<'studio' | 'curves' | 'workflow'>('studio'),
    [tab, setTab] = useState<'assets' | 'jobs' | 'revisions' | 'commands'>('assets');
  const [busy, setBusy] = useState(false),
    [notice, setNotice] = useState('正在读取项目…'),
    [error, setError] = useState(''),
    [jobs, setJobs] = useState<GenerationJob[]>([]),
    [revisions, setRevisions] = useState<Revision[]>([]),
    [newName, setNewName] = useState(''),
    [newDialog, setNewDialog] = useState(false),
    [exchangeOpen, setExchangeOpen] = useState(false),
    [retargetOpen, setRetargetOpen] = useState(false),
    [reduceOpen, setReduceOpen] = useState(false),
    [commandText, setCommandText] = useState(
      '[\n  { "type": "project.rename", "name": "新作品" }\n]',
    ),
    [review, setReview] = useState('');
  const projectRef = useRef<Project | null>(null),
    locked = useRef(false),
    assetInput = useRef<HTMLInputElement>(null),
    projectInput = useRef<HTMLInputElement>(null),
    objInput = useRef<HTMLInputElement>(null);
  const accept = useCallback((next: Envelope) => {
    const previous = projectRef.current;
    if (previous?.id !== next.project.id) setRestEditing(false);
    setMeshSelection((selection) => {
      if (!selection || previous?.id !== next.project.id) return null;
      const old = previous.geometries.find((g) => g.id === selection.geometryId),
        geometry = next.project.geometries.find((g) => g.id === selection.geometryId);
      if (
        !geometry ||
        !next.project.entities.some(
          (e) => e.id === selection.entityId && e.geometryId === geometry.id,
        )
      )
        return null;
      return old && sameTopology(old, geometry) ? selection : { ...selection, indices: [] };
    });
    projectRef.current = next.project;
    setEnvelope(next);
    setSceneId((s) =>
      next.project.scenes.some((x) => x.id === s) ? s : next.project.scenes[0].id,
    );
    setSelected((s) => (next.project.entities.some((e) => e.id === s) ? s : null));
    setSelectedClip((s) => (next.project.timeline.clips.some((c) => c.id === s) ? s : null));
    setSelectedKey((s) => {
      if (!s?.length || previous?.id !== next.project.id) return null;
      const wanted = new Set(s.map((k) => k.trackId));
      const scenes = new Map(next.project.entities.map((e) => [e.id, e.sceneId]));
      const actions = new Map(
        next.project.scenes.map((scene) => [scene.id, scene.activeActionId || undefined]),
      );
      const keys = new Map(
        next.project.animationTracks
          .filter((t) => wanted.has(t.id) && t.actionId === actions.get(scenes.get(t.entityId)!))
          .map((t) => [t.id, new Set(t.keys.map((k) => k.id))]),
      );
      return s.filter((key) => keys.get(key.trackId)?.has(key.keyId));
    });
    setFrame((f) => Math.min(f, next.project.timeline.duration - 1));
  }, []);
  const refreshList = useCallback(async () => setProjects(await api<Summary[]>('/projects')), []);
  const fail = (e: unknown) => {
    setError(e instanceof Error ? e.message : String(e));
    setNotice('操作未保存');
  };
  const load = useCallback(
    async (projectId: string) => {
      try {
        const next = await api<Envelope>(`/projects/${projectId}`);
        accept(next);
        setNotice(`已保存 · r${next.project.revision}`);
        setError('');
        setPlaying(false);
        localStorage.setItem('frameforge.project', projectId);
      } catch (e) {
        fail(e);
      }
    },
    [accept],
  );
  useEffect(() => {
    void (async () => {
      try {
        const list = await api<Summary[]>('/projects');
        setProjects(list);
        const saved = localStorage.getItem('frameforge.project');
        await load(list.find((p) => p.id === saved)?.id || list[0].id);
      } catch (e) {
        fail(e);
      }
    })();
  }, [load]);
  const send = useCallback(
    async (commands: Command[], label: string, actor: 'user' | 'agent' = 'user') => {
      const p = projectRef.current;
      if (!p) return;
      if (locked.current) {
        setError('上一项操作正在保存，请在保存完成后重试本次操作');
        return;
      }
      locked.current = true;
      setBusy(true);
      setError('');
      setNotice('保存中…');
      try {
        const next = await api<Envelope>(`/projects/${p.id}/commands`, {
          baseRevision: p.revision,
          commands,
          label,
          actor,
        });
        accept(next);
        setNotice(`已保存 · ${label}`);
        await refreshList();
        return next.project;
      } catch (e) {
        fail(e);
      } finally {
        locked.current = false;
        setBusy(false);
      }
    },
    [accept, refreshList],
  );
  const history = useCallback(
    async (action: 'undo' | 'redo' | 'restore', revisionId?: string) => {
      const p = projectRef.current;
      if (!p || locked.current) return;
      locked.current = true;
      setBusy(true);
      setError('');
      try {
        accept(
          await api<Envelope>(`/projects/${p.id}/${action}`, {
            baseRevision: p.revision,
            label: action === 'undo' ? '撤销' : action === 'redo' ? '重做' : '恢复历史版本',
            revisionId,
          }),
        );
        setNotice('历史操作已保存');
      } catch (e) {
        fail(e);
      } finally {
        locked.current = false;
        setBusy(false);
      }
    },
    [accept],
  );
  const transform = useCallback(
    (entityId: string, t: Entity['transform']) => {
      const p = projectRef.current!,
        e = p.entities.find((e) => e.id === entityId)!;
      const commands: Command[] = [];
      const evaluated = evaluatedBaseTransform(p, e, frame),
        base = structuredClone(e.transform);
      for (const property of ['position', 'rotation', 'scale'] as const) {
        if (t[property].every((v, i) => Math.abs(v - evaluated[property][i]) < 1e-7)) continue;
        const target = property === 'rotation' ? rotationProperty(p, e) : property;
        if (activeTracks(p, entityId).some((a) => a.property === target))
          commands.push({
            type: 'key.set',
            entityId,
            property: target,
            key: {
              frame,
              value: target === 'quaternion' ? quaternionFromEuler(t.rotation) : t[property],
            },
          });
        else {
          base[property] = t[property];
          if (property === 'rotation') {
            if (base.quaternion) base.quaternion = quaternionFromEuler(t.rotation);
          }
        }
      }
      commands.unshift({ type: 'entity.update', id: entityId, patch: { transform: base } });
      void send(commands, '变换对象');
    },
    [send, frame],
  );
  useEffect(() => {
    if (!playing || !envelope) return;
    const start = performance.now(),
      initial = frame,
      { fps, duration } = envelope.project.timeline;
    let handle = 0;
    const tick = (now: number) => {
      const f = initial + Math.floor(((now - start) / 1000) * fps);
      if (f >= duration) {
        setFrame(duration - 1);
        setPlaying(false);
        return;
      }
      setFrame(f);
      handle = requestAnimationFrame(tick);
    };
    handle = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(handle);
  }, [playing, envelope?.project.timeline.fps, envelope?.project.timeline.duration]);
  useEffect(() => {
    const listener = (e: KeyboardEvent) => {
      if (exchangeOpen || retargetOpen || reduceOpen || newDialog) return;
      if ((e.target as HTMLElement).closest('input,textarea,select,[contenteditable]')) return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        void history(e.shiftKey ? 'redo' : 'undo');
      } else if (e.code === 'Space') {
        e.preventDefault();
        setPlaying((v) => !v);
      } else if (e.key.toLowerCase() === 'k' && selectedClip) {
        if (Number.isInteger(frame))
          void send([{ type: 'clip.split', id: selectedClip, frame }], '切分片段');
        else setError('片段只能在整帧处切分，请调整播放头');
      } else if (e.key === 'Delete') {
        if (workspace === 'studio' && view === 'scene' && meshSelection) {
          if (meshSelection.indices.length)
            void send(
              [
                {
                  type: 'geometry.delete',
                  id: meshSelection.geometryId,
                  mode: meshSelection.mode,
                  indices: meshSelection.indices,
                },
              ],
              '删除网格组件',
            );
        } else if (workspace === 'curves') {
          if (selectedKey?.length)
            void send([{ type: 'keys.delete', keys: selectedKey }], '删除所选关键帧');
        } else if (selectedClip) void send([{ type: 'clip.delete', id: selectedClip }], '删除片段');
        else if (selected) void send([{ type: 'entity.delete', id: selected }], '删除对象');
      } else if (['g', 'r', 's'].includes(e.key.toLowerCase()))
        setMode(({ g: 'translate', r: 'rotate', s: 'scale' } as const)[e.key.toLowerCase() as 'g']);
      else if (
        workspace === 'studio' &&
        view === 'scene' &&
        meshSelection &&
        ['1', '2', '3'].includes(e.key)
      ) {
        const g = projectRef.current?.geometries.find((g) => g.id === meshSelection.geometryId);
        if (g) {
          const mode = (['vertex', 'edge', 'face'] as const)[Number(e.key) - 1];
          setMeshSelection({
            ...meshSelection,
            mode,
            indices: convertSelection(g, meshSelection.mode, mode, meshSelection.indices),
          });
        }
      }
    };
    window.addEventListener('keydown', listener);
    return () => window.removeEventListener('keydown', listener);
  }, [
    history,
    send,
    selected,
    selectedClip,
    selectedKey,
    workspace,
    view,
    meshSelection,
    frame,
    exchangeOpen,
    retargetOpen,
    reduceOpen,
    newDialog,
  ]);
  const projectId = envelope?.project.id;
  useEffect(() => {
    if (!projectId) return;
    let stopped = false;
    const refresh = async () => {
      try {
        const [j, r] = await Promise.all([
          api<GenerationJob[]>(`/projects/${projectId}/jobs`),
          api<Revision[]>(`/projects/${projectId}/revisions`),
        ]);
        if (!stopped) {
          setJobs(j);
          setRevisions(r);
        }
      } catch (e) {
        if (!stopped) setError(String(e));
      }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 1500);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [projectId, envelope?.project.revision]);
  const submit = async (
    kind: 'render' | 'workflow',
    workflowId?: string,
    outputNodeId?: string,
  ) => {
    const p = projectRef.current!;
    try {
      setError('');
      await api(`/projects/${p.id}/jobs`, {
        baseRevision: p.revision,
        requestKey: id(),
        kind,
        workflowId,
        outputNodeId,
      });
      setTab('jobs');
      setNotice('任务已提交；可继续编辑项目');
    } catch (e) {
      fail(e);
    }
  };
  const select = (id: string) => {
    if (id !== selected) setMeshSelection(null);
    setSelected(id);
    setSelectedClip(null);
    setSelectedKey(null);
  };
  const selectClip = (id: string) => {
    setRestEditing(false);
    const project = projectRef.current,
      selectedClip = project?.timeline.clips.find((c) => c.id === id),
      shot =
        selectedClip?.kind === 'shot'
          ? project?.shots.find((s) => s.id === selectedClip.sourceId)
          : undefined;
    if (shot) setSceneId(shot.sceneId);
    setMeshSelection(null);
    setSelectedClip(id);
    setSelected(null);
    setSelectedKey(null);
  };
  const selectKey = (s: KeySelection) => {
    setMeshSelection(null);
    setSelectedKey(s);
    const active = s?.at(-1);
    if (!active) return;
    const track = projectRef.current?.animationTracks.find((t) => t.id === active.trackId);
    const key = track?.keys.find((k) => k.id === active.keyId);
    if (track && key) {
      setSelected(track.entityId);
      setSelectedClip(null);
      setFrame(Math.min(key.frame, projectRef.current!.timeline.duration - 1));
      setPlaying(false);
    }
  };
  const importAsset = async (file: File) => {
    try {
      const r = await fetch('/api/blobs', {
        method: 'POST',
        headers: {
          'Content-Type': file.type || 'application/octet-stream',
          'X-Studio-Client': 'frameforge',
          'X-File-Name': encodeURIComponent(file.name),
        },
        body: file,
      });
      const asset = await r.json();
      if (!r.ok) throw new Error(asset.error);
      await send([{ type: 'asset.add', asset }], '导入媒体素材');
    } catch (e) {
      fail(e);
    }
  };
  const meshMode = (mode: MeshMode | 'object') => {
    setRestEditing(false);
    if (mode === 'object') {
      setMeshSelection(null);
      return;
    }
    const p = projectRef.current!,
      entity = p.entities.find((e) => e.id === selected),
      g = p.geometries.find((g) => g.id === entity?.geometryId);
    if (!entity || !g) return;
    setPlaying(false);
    setView('scene');
    setWorkspace('studio');
    setMeshSelection({
      entityId: entity.id,
      geometryId: g.id,
      mode,
      indices: meshSelection
        ? convertSelection(g, meshSelection.mode, mode, meshSelection.indices)
        : [],
    });
  };
  const meshSend = async (commands: Command[], label: string, keepFaces = false) => {
    const selection = meshSelection;
    const next = await send(commands, label);
    if (next && keepFaces && selection)
      setMeshSelection((current) =>
        current?.entityId === selection.entityId ? { ...selection, mode: 'face' } : current,
      );
  };
  const addAssetClip = (asset: Asset) => {
    const p = projectRef.current!,
      insertAt = Math.min(p.timeline.duration - 1, Math.round(frame)),
      duration = Math.min(
        p.timeline.duration - insertAt,
        asset.duration
          ? Math.max(1, Math.floor(asset.duration * p.timeline.fps))
          : p.timeline.fps * 3,
      );
    let channel = asset.kind === 'audio' ? 2 : 1;
    while (
      p.timeline.clips.some(
        (c) =>
          c.channel === channel && c.start < insertAt + duration && c.start + c.duration > insertAt,
      )
    )
      channel++;
    void send(
      [
        {
          type: 'clip.add',
          clip: {
            id: id(),
            name: asset.name,
            kind: asset.kind,
            sourceId: asset.id,
            start: insertAt,
            duration,
            sourceIn: 0,
            channel,
            muted: false,
            volume: 1,
            fit: 'contain',
          },
        },
      ],
      '素材加入时间轴',
    );
  };
  const png = async () => {
    try {
      const p = projectRef.current!,
        canvas = document.createElement('canvas'),
        renderer = new TimelineRenderer(canvas, p);
      try {
        await renderer.render(frame);
        const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/png'));
        if (blob) download(`${p.name}-${frame}.png`, blob);
      } finally {
        renderer.dispose();
      }
    } catch (e) {
      fail(e);
    }
  };
  const restActive = restEditing && view === 'scene' && workspace === 'studio';
  const displayedProject = useMemo(
    () => (envelope && restActive ? restProject(envelope.project) : envelope?.project),
    [envelope, restActive],
  );
  if (!envelope)
    return (
      <main className="loading">
        <h1>Frameforge</h1>
        <p>{error || notice}</p>
        <button onClick={() => location.reload()}>重新连接</button>
      </main>
    );
  const p = envelope.project,
    e = p.entities.find((e) => e.id === selected),
    clip = p.timeline.clips.find((c) => c.id === selectedClip),
    scene = p.scenes.find((s) => s.id === sceneId)!;
  return (
    <main className="app">
      <header className="topbar">
        <div className="brand">
          <b>F</b>
          <span>
            FRAMEFORGE<small>创作工作台 · 0.22</small>
          </span>
        </div>
        <select aria-label="切换项目" value={p.id} onChange={(e) => void load(e.target.value)}>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <button onClick={() => setNewDialog(true)}>新建</button>
        <button onClick={() => projectInput.current?.click()}>打开</button>
        <a className="button" href={`/api/projects/${p.id}/export`}>
          保存项目包
        </a>
        <span className="spacer" />
        <span className="save-status">● {busy ? '保存中' : `已保存 r${p.revision}`}</span>
        <button onClick={() => void load(p.id)}>刷新</button>
        <button
          disabled={!envelope.canUndo || busy}
          onClick={() => void history('undo')}
          title="Ctrl+Z"
        >
          ↶
        </button>
        <button
          disabled={!envelope.canRedo || busy}
          onClick={() => void history('redo')}
          title="Ctrl+Shift+Z"
        >
          ↷
        </button>
        <button className="primary" onClick={() => void submit('render')}>
          导出 MP4 ↗
        </button>
      </header>
      <nav className="workspace-nav">
        <button
          className={workspace === 'studio' ? 'active' : ''}
          onClick={() => setWorkspace('studio')}
        >
          制作
        </button>
        <button
          className={workspace === 'curves' ? 'active' : ''}
          onClick={() => setWorkspace('curves')}
        >
          动画曲线
        </button>
        <button
          className={workspace === 'workflow' ? 'active' : ''}
          onClick={() => setWorkspace('workflow')}
        >
          工作流
        </button>
        <span className="divider" />
        <input
          className="project-name"
          aria-label="项目名称"
          key={p.name}
          defaultValue={p.name}
          onBlur={(event) => {
            if (event.target.value !== p.name)
              void send([{ type: 'project.rename', name: event.target.value }], '重命名项目');
          }}
        />
        <span className="spacer" />
        <button
          onClick={() => {
            setSelected(null);
            setSelectedClip(null);
            setSelectedKey(null);
            setMeshSelection(null);
          }}
        >
          项目设置
        </button>
      </nav>
      {error && (
        <div className="error-banner" role="alert">
          <span>{error}</span>
          <button onClick={() => setError('')}>关闭</button>
        </div>
      )}
      <div className="main-grid">
        <aside className="outliner">
          <div className="panel-heading">
            场景结构{' '}
            <button
              onClick={() =>
                void send(
                  [
                    {
                      type: 'scene.add',
                      scene: {
                        id: id(),
                        name: `场景 ${p.scenes.length + 1}`,
                        background: '#19212e',
                        ambient: 0.8,
                      },
                    },
                  ],
                  '添加场景',
                )
              }
            >
              ＋
            </button>
          </div>
          <select
            aria-label="场景"
            value={sceneId}
            onChange={(event) => {
              setSceneId(event.target.value);
              setSelected(null);
              setSelectedKey(null);
              setMeshSelection(null);
            }}
          >
            {p.scenes.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
          <ActionPanel
            project={p}
            sceneId={sceneId}
            onReduce={() => {
              setPlaying(false);
              setReduceOpen(true);
            }}
            send={(commands, label) => {
              setSelectedKey(null);
              void send(commands, label);
            }}
          />
          <div className="add-controls">
            <select
              aria-label="添加对象"
              defaultValue=""
              disabled={busy}
              onChange={(event) => {
                if (event.target.value)
                  void send(
                    [{ type: 'entity.create', kind: event.target.value as 'box', sceneId }],
                    '添加对象',
                  );
                event.target.value = '';
              }}
            >
              <option value="">＋ 添加对象</option>
              <option value="box">立方体</option>
              <option value="sphere">球体</option>
              <option value="plane">平面</option>
              <option value="cylinder">圆柱</option>
              <option value="camera">摄影机</option>
              <option value="light">灯光</option>
              <option value="group">集合</option>
              <option value="joint">关节</option>
            </select>
            <button onClick={() => objInput.current?.click()}>OBJ</button>
            <button
              disabled={busy}
              onClick={() => {
                setPlaying(false);
                setExchangeOpen(true);
              }}
            >
              glTF
            </button>
            <button
              disabled={busy}
              onClick={() => {
                setPlaying(false);
                setRetargetOpen(true);
              }}
            >
              重定向
            </button>
          </div>
          <div className="entity-list">
            {p.entities
              .filter((x) => x.sceneId === sceneId)
              .map((x) => (
                <button
                  key={x.id}
                  className={'entity ' + (x.id === selected ? 'selected' : '')}
                  onClick={() => select(x.id)}
                  style={{ paddingLeft: x.parentId ? 28 : 12 }}
                >
                  <span className={'kind-icon ' + x.kind}>
                    {x.joint ? '●' : { mesh: '◇', camera: '▣', light: '☼', group: '▧' }[x.kind]}
                  </span>
                  <span>{x.name}</span>
                  <small>{x.visible ? '' : '隐藏'}</small>
                </button>
              ))}
          </div>
          <div className="panel-heading">
            镜头{' '}
            <button
              onClick={() => {
                const camera = p.entities.find((e) => e.sceneId === sceneId && e.kind === 'camera');
                if (!camera) {
                  setError('请先在场景中添加摄影机');
                  return;
                }
                void send(
                  [
                    {
                      type: 'shot.add',
                      shot: {
                        id: id(),
                        name: `镜头 ${p.shots.length + 1}`,
                        sceneId,
                        cameraId: camera.id,
                      },
                    },
                  ],
                  '添加镜头',
                );
              }}
            >
              ＋
            </button>
          </div>
          {p.shots.map((s) => (
            <div className="shot-item" key={s.id}>
              <div className="shot-row">
                <span>{s.name}</span>
                <select
                  aria-label={`${s.name} 摄影机`}
                  value={s.cameraId}
                  onChange={(event) =>
                    void send(
                      [{ type: 'shot.update', id: s.id, patch: { cameraId: event.target.value } }],
                      '切换镜头摄影机',
                    )
                  }
                >
                  {p.entities
                    .filter((e) => e.kind === 'camera' && e.sceneId === s.sceneId)
                    .map((e) => (
                      <option key={e.id} value={e.id}>
                        {e.name}
                      </option>
                    ))}
                </select>
                <button
                  title="加入时间轴（吸附最近整帧）"
                  onClick={() => {
                    const insertAt = Math.min(p.timeline.duration - 1, Math.round(frame));
                    let channel = 0;
                    while (
                      p.timeline.clips.some(
                        (c) => c.channel === channel && c.start + c.duration > insertAt,
                      )
                    )
                      channel++;
                    void send(
                      [
                        {
                          type: 'clip.add',
                          clip: {
                            id: id(),
                            name: s.name,
                            kind: 'shot',
                            sourceId: s.id,
                            start: insertAt,
                            duration: p.timeline.duration - insertAt,
                            sourceIn: 0,
                            channel,
                            muted: false,
                            volume: 1,
                            fit: 'contain',
                          },
                        },
                      ],
                      '镜头加入时间轴',
                    );
                  }}
                >
                  ＋
                </button>
              </div>
              <ActionSelect
                project={p}
                sceneId={s.sceneId}
                label={`${s.name} 默认动作`}
                inherit="跟随场景"
                value={s.action}
                onChange={(action) =>
                  void send([{ type: 'shot.update', id: s.id, patch: { action } }], '选择镜头动作')
                }
              />
            </div>
          ))}
          <div className="scene-settings">
            <label>
              环境色{' '}
              <input
                aria-label="环境色"
                type="color"
                value={scene.background}
                onChange={(event) =>
                  void send(
                    [
                      {
                        type: 'scene.update',
                        id: sceneId,
                        patch: { background: event.target.value },
                      },
                    ],
                    '修改场景背景',
                  )
                }
              />
            </label>
          </div>
        </aside>
        <section className="center">
          {workspace === 'studio' ? (
            <>
              <div className="view-toolbar">
                <button
                  disabled={e?.kind !== 'mesh'}
                  className={meshSelection ? 'active' : ''}
                  onClick={() => meshMode(meshSelection ? 'object' : 'vertex')}
                >
                  {meshSelection ? '返回对象' : '编辑网格'}
                </button>
                <div className="segmented">
                  <button
                    className={view === 'scene' ? 'active' : ''}
                    onClick={() => setView('scene')}
                  >
                    三维编辑
                  </button>
                  <button
                    className={view === 'sequence' ? 'active' : ''}
                    onClick={() => setView('sequence')}
                  >
                    成片预览
                  </button>
                </div>
                <div className="segmented">
                  {(['translate', 'rotate', 'scale'] as const).map((m) => (
                    <button
                      key={m}
                      className={mode === m ? 'active' : ''}
                      onClick={() => setMode(m)}
                    >
                      {{ translate: '移动 G', rotate: '旋转 R', scale: '缩放 S' }[m]}
                    </button>
                  ))}
                </div>
                {view === 'scene' && (
                  <label className="check">
                    <input
                      type="checkbox"
                      aria-label="预览动作层"
                      checked={layersPreview}
                      disabled={restActive}
                      onChange={(event) => setLayersPreview(event.target.checked)}
                    />
                    预览动作层
                  </label>
                )}
                {view === 'scene' && (
                  <button
                    className={restActive ? 'active' : ''}
                    aria-pressed={restActive}
                    onClick={() => {
                      setRestEditing(!restActive);
                      setMeshSelection(null);
                      setPlaying(false);
                    }}
                  >
                    基础姿态
                  </button>
                )}
                <span className="spacer" />
                <button onClick={() => void png()}>
                  {restActive ? '导出成片帧 PNG' : '导出当前帧 PNG'}
                </button>
              </div>
              <Viewport
                key={view}
                layersPreview={layersPreview}
                project={displayedProject!}
                restEditing={restActive}
                restEditable={!!e && rigNodes(p, sceneId).has(e.id)}
                sceneId={sceneId}
                frame={frame}
                playing={playing}
                selected={selected}
                select={select}
                mode={mode}
                view={view}
                onTransform={
                  restActive
                    ? (entityId, transform) =>
                        void send(
                          [
                            {
                              type: 'rig.rest.update',
                              updates: [{ entityId, transform }],
                              preserveShape: preserveRestShape,
                            },
                          ],
                          '手柄编辑基础姿态',
                        )
                    : transform
                }
                meshSelection={meshSelection}
                meshXray={meshXray}
                onMeshXray={setMeshXray}
                onMeshSelect={(indices) => setMeshSelection((s) => (s ? { ...s, indices } : s))}
                onMeshTransform={(indices, matrix) =>
                  void meshSend(
                    [
                      {
                        type: 'geometry.transform',
                        id: meshSelection!.geometryId,
                        indices,
                        matrix,
                      },
                    ],
                    '变换网格组件',
                  )
                }
                busy={busy}
                onView={(t) => {
                  const shot = p.shots.find((s) => s.sceneId === sceneId);
                  if (shot) transform(shot.cameraId, t);
                  else setError('此场景尚无镜头');
                }}
              />
            </>
          ) : workspace === 'curves' ? (
            <CurveEditor
              key={`${p.id}/${selected}`}
              project={p}
              entity={e}
              frame={frame}
              selectedKey={selectedKey}
              selectKey={selectKey}
              busy={busy}
              setFrame={(f) => {
                setPlaying(false);
                setFrame(f);
              }}
              send={(c, l) => send(c, l)}
            />
          ) : (
            <WorkflowPanel
              p={p}
              send={(c, l) => void send(c, l)}
              run={(w, output) => void submit('workflow', w, output)}
            />
          )}
        </section>
        <aside className="inspector">
          <fieldset disabled={busy}>
            {restActive ? (
              <RestPosePanel
                project={p}
                entity={e}
                frame={frame}
                preserveShape={preserveRestShape}
                setPreserveShape={setPreserveRestShape}
                send={(c, l) => void send(c, l)}
              />
            ) : meshSelection && workspace === 'studio' && view === 'scene' ? (
              <MeshPanel
                project={p}
                geometry={p.geometries.find((g) => g.id === meshSelection.geometryId)!}
                selection={meshSelection}
                onMode={meshMode}
                onSelect={(indices) => setMeshSelection({ ...meshSelection, indices })}
                send={(c, l, keep) => void meshSend(c, l, keep)}
              />
            ) : (
              <Inspector
                project={p}
                entity={e}
                clip={clip}
                frame={frame}
                send={(c, l) => void send(c, l)}
                transform={transform}
              />
            )}
          </fieldset>
        </aside>
      </div>
      <Timeline
        p={p}
        frame={frame}
        setFrame={(f) => {
          setPlaying(false);
          setFrame(f);
        }}
        playing={playing}
        setPlaying={setPlaying}
        selectedClip={selectedClip}
        selectClip={selectClip}
        selectedEntity={selected}
        selectedKey={selectedKey}
        selectKey={selectKey}
        send={(c, l) => void send(c, l)}
      />
      <section className="library">
        <div className="library-tabs">
          {(['assets', 'jobs', 'revisions', 'commands'] as const).map((t) => (
            <button className={tab === t ? 'active' : ''} key={t} onClick={() => setTab(t)}>
              {{ assets: '素材库', jobs: '任务', revisions: '版本记录', commands: 'Agent 命令' }[t]}{' '}
              {t === 'assets' ? p.assets.length : t === 'jobs' ? jobs.length : ''}
            </button>
          ))}
          <span className="spacer" />
          {tab === 'assets' && (
            <button onClick={() => assetInput.current?.click()}>＋ 导入媒体</button>
          )}
          {tab === 'jobs' && <button onClick={() => void load(p.id)}>同步导出素材</button>}
        </div>
        <div className="library-content">
          {tab === 'assets' &&
            (!p.assets.length ? (
              <div className="empty-assets">
                <span>▧</span>
                <div>
                  把素材带进你的作品<p>导入图片、视频或音频，再添加至同一条制作时间轴。</p>
                </div>
                <button onClick={() => assetInput.current?.click()}>选择文件</button>
              </div>
            ) : (
              <div className="asset-grid">
                {p.assets.map((a) => (
                  <article className="asset-card" key={a.id}>
                    {a.kind === 'image' ? (
                      <img src={`/api/blobs/${a.blobId}`} alt={a.name} />
                    ) : (
                      <div className="asset-symbol">{a.kind === 'audio' ? '♫' : '▶'}</div>
                    )}
                    <div>
                      <strong title={a.name}>{a.name}</strong>
                      <small>
                        {a.kind} · {(a.bytes / 1024).toFixed(0)} KB{' '}
                        {a.duration ? `· ${a.duration.toFixed(1)} s` : ''}
                      </small>
                      <button title="吸附最近整帧" onClick={() => addAssetClip(a)}>
                        加入时间轴
                      </button>
                      <button
                        title="移除素材记录"
                        onClick={() => void send([{ type: 'asset.delete', id: a.id }], '移除素材')}
                      >
                        ×
                      </button>
                    </div>
                  </article>
                ))}
              </div>
            ))}
          {tab === 'jobs' &&
            (!jobs.length ? (
              <p className="muted">尚无任务。导出或执行本地工作流后，真实进度会显示在这里。</p>
            ) : (
              jobs.map((j) => (
                <div className="job-row" key={j.id}>
                  <span className={'job-status ' + j.status}>
                    {
                      {
                        queued: '排队',
                        running: '执行中',
                        succeeded: '完成',
                        failed: '失败',
                        cancelled: '取消',
                        interrupted: '中断',
                      }[j.status]
                    }
                  </span>
                  <span>r{j.projectRevision}</span>
                  <progress
                    max={1}
                    value={j.provider && j.status === 'running' ? undefined : j.progress}
                  />
                  <span className="job-message">{j.message}</span>
                  {j.provider?.taskId && <small title="供应商任务 ID">{j.provider.taskId}</small>}
                  {['queued', 'running'].includes(j.status) && (
                    <button onClick={() => void api(`/jobs/${j.id}/cancel`, {}).catch(fail)}>
                      取消
                    </button>
                  )}
                  {['failed', 'cancelled', 'interrupted'].includes(j.status) &&
                    !(j.provider && j.status === 'interrupted') && (
                      <button
                        onClick={() =>
                          void api(`/jobs/${j.id}/retry`, { requestKey: id() }).catch(fail)
                        }
                      >
                        {j.provider ? '重新生成（新计费）' : '重试原快照'}
                      </button>
                    )}
                  {j.artifact && (
                    <a className="button" href={`/api/jobs/${j.id}/artifact`}>
                      下载 MP4
                    </a>
                  )}
                  {j.provider && j.status === 'interrupted' && (
                    <form
                      onSubmit={(event) => {
                        event.preventDefault();
                        const taskId = String(
                          new FormData(event.currentTarget).get('taskId') || '',
                        ).trim();
                        void api(`/jobs/${j.id}/resume`, taskId ? { taskId } : {}).catch(fail);
                      }}
                    >
                      {!j.provider.taskId && (
                        <input
                          name="taskId"
                          aria-label="恢复供应商任务 ID"
                          placeholder="在供应商控制台核对此次任务 ID"
                          required
                        />
                      )}
                      <button type="submit">恢复查询</button>
                    </form>
                  )}
                </div>
              ))
            ))}
          {tab === 'revisions' &&
            (!revisions.length ? (
              <p className="muted">每次有效编辑自动保存一个可审阅版本。</p>
            ) : (
              revisions.map((r) => (
                <details className="revision-row" key={r.id}>
                  <summary>
                    <b>r{r.number}</b> {r.label}{' '}
                    <small>
                      {r.actor} · {new Date(r.createdAt).toLocaleTimeString()}
                    </small>
                  </summary>
                  <pre>{JSON.stringify(r.command, null, 2)}</pre>
                  <button onClick={() => void history('restore', r.id)}>
                    恢复此版本（可撤销）
                  </button>
                </details>
              ))
            ))}
          {tab === 'commands' && (
            <div className="command-panel">
              <div>
                <p>受限结构化命令。执行前审阅，记录为 Agent 修改，可撤销与恢复。</p>
                <textarea
                  aria-label="Agent 命令 JSON"
                  value={commandText}
                  onChange={(event) => {
                    setCommandText(event.target.value);
                    setReview('');
                  }}
                />
              </div>
              <div>
                <button
                  onClick={() => {
                    try {
                      const result = applyCommands(p, JSON.parse(commandText));
                      setReview(
                        `${result.commands.length} 条命令通过校验；对象 ${p.entities.length} → ${result.project.entities.length}；项目名「${result.project.name}」。执行将创建新版本。`,
                      );
                    } catch (e) {
                      fail(e);
                    }
                  }}
                >
                  校验并预览
                </button>
                <p>{review}</p>
                <button
                  className="primary"
                  disabled={!review || busy}
                  onClick={() => {
                    void send(JSON.parse(commandText), '执行已审阅的 Agent 命令', 'agent');
                    setReview('');
                  }}
                >
                  应用命令
                </button>
                <p className="muted">不执行任意 JavaScript 或系统命令。</p>
              </div>
            </div>
          )}
        </div>
      </section>
      <footer className="statusbar">
        <span>{notice}</span>
        <span>WebGL 实时材质 · ACES · 本地存储</span>
        <span>Seedance 配置见工作流</span>
      </footer>
      <input
        type="file"
        ref={assetInput}
        hidden
        accept="image/png,image/jpeg,image/webp,video/mp4,video/webm,audio/wav,audio/mpeg,audio/ogg"
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) void importAsset(file);
          event.target.value = '';
        }}
      />
      <input
        type="file"
        ref={projectInput}
        hidden
        accept=".ffstudio,.json"
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file)
            void (async () => {
              try {
                accept(await api<Envelope>('/projects/import', JSON.parse(await file.text())));
                await refreshList();
                setNotice('项目包已导入');
              } catch (e) {
                fail(e);
              }
            })();
          event.target.value = '';
        }}
      />
      <input
        type="file"
        ref={objInput}
        hidden
        accept=".obj"
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file)
            void (async () => {
              try {
                const geometry = importOBJ(await file.text());
                geometry.name = file.name.slice(0, 160);
                await send([{ type: 'geometry.import', sceneId, geometry }], '导入 OBJ 网格');
              } catch (e) {
                fail(e);
              }
            })();
          event.target.value = '';
        }}
      />
      {reduceOpen && (
        <ReducePanel
          key={p.id + sceneId}
          project={p}
          sceneId={sceneId}
          busy={busy}
          saveError={error}
          send={send}
          onClose={() => setReduceOpen(false)}
          onActivated={() => {
            setSelectedKey(null);
            setRestEditing(false);
            setView('scene');
            setWorkspace('curves');
            setPlaying(false);
          }}
        />
      )}
      {retargetOpen && (
        <RetargetPanel
          key={p.id}
          project={p}
          busy={busy}
          saveError={error}
          send={send}
          onClose={() => setRetargetOpen(false)}
          onActivated={(s) => {
            setSceneId(s);
            setSelected(null);
            setSelectedClip(null);
            setSelectedKey(null);
            setMeshSelection(null);
            setWorkspace('studio');
            setRestEditing(false);
            setView('scene');
            setPlaying(false);
          }}
        />
      )}
      {exchangeOpen && (
        <SceneExchange
          key={p.id}
          project={p}
          sceneId={sceneId}
          frame={frame}
          busy={busy}
          saveError={error}
          send={send}
          onClose={() => setExchangeOpen(false)}
          onImported={(s) => {
            setSceneId(s);
            setSelected(null);
            setSelectedClip(null);
            setMeshSelection(null);
            setWorkspace('studio');
            setView('scene');
            setPlaying(false);
          }}
        />
      )}
      {newDialog && (
        <div className="modal-backdrop">
          <form
            className="modal"
            onSubmit={(event) => {
              event.preventDefault();
              void (async () => {
                try {
                  const next = await api<Envelope>('/projects', { name: newName || '未命名作品' });
                  accept(next);
                  await refreshList();
                  setNewDialog(false);
                  setNewName('');
                  setNotice('新项目已保存');
                } catch (e) {
                  fail(e);
                }
              })();
            }}
          >
            <h2>新建作品</h2>
            <label>
              项目名称
              <input
                aria-label="新项目名称"
                autoFocus
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
              />
            </label>
            <div className="button-row">
              <button type="button" onClick={() => setNewDialog(false)}>
                取消
              </button>
              <button className="primary" type="submit">
                创建项目
              </button>
            </div>
          </form>
        </div>
      )}
    </main>
  );
}
