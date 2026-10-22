import { useEffect, useId, useRef, useState, type PointerEvent } from 'react';
import {
  editTrack,
  keyHandles,
  segmentControls,
  type KeyEdit,
  type Point,
} from '../core/animation';
import { CommandSchema, type Command } from '../core/commands';
import { evaluatedTransform } from '../core/evaluate';
import {
  AnimationTrackSchema,
  id,
  type AnimationTrack,
  type Entity,
  type Project,
  type Vec3,
  type KeyHandles,
} from '../core/model';
import { NumberInput } from './Inspector';

export type KeySelection = { trackId: string; keyId: string } | null;
type Props = {
  project: Project;
  entity?: Entity;
  frame: number;
  selectedKey: KeySelection;
  selectKey: (key: KeySelection) => void;
  setFrame: (frame: number) => void;
  send: (commands: Command[], label: string) => void;
  busy: boolean;
};
type View = { x: number; y: number; width: number; height: number };
type Drag = {
  track: AnimationTrack;
  keyId: string;
  side?: 'left' | 'right';
  start: Point;
  view: View;
  revision: number;
  command?: KeyEdit;
  moved: boolean;
  pan?: boolean;
};
const colors = ['#ef978e', '#8bd7a9', '#83b9ff'];
const labels = { position: '位置', rotation: '旋转', scale: '缩放' };
const clamp = (n: number, min: number, max: number) => Math.max(min, Math.min(max, n));
const display = (n: number) => Number(n.toPrecision(4)).toString();
function fit(track: AnimationTrack | undefined, axis: number, duration: number): View {
  if (!track?.keys.length) return { x: -2, y: -2, width: duration + 4, height: 4 };
  const points = track.keys.map((k) => [k.frame, k.value[axis]]);
  track.keys.forEach((k, i) => {
    const h = keyHandles(track, i, axis);
    if (k.interpolation === 'bezier' && i < track.keys.length - 1)
      points.push([k.frame + h.right[0], k.value[axis] + h.right[1]]);
    if (i > 0 && track.keys[i - 1].interpolation === 'bezier')
      points.push([k.frame + h.left[0], k.value[axis] + h.left[1]]);
  });
  let minX = Infinity,
    maxX = -Infinity,
    minY = Infinity,
    maxY = -Infinity;
  for (const [x, y] of points) {
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
  }
  const width = Math.max(12, maxX - minX),
    height = Math.max(1, maxY - minY);
  return {
    x: minX - width * 0.1,
    y: minY - height * 0.18,
    width: width * 1.2,
    height: height * 1.36,
  };
}

export function CurveEditor(props: Props) {
  return props.entity ? (
    <Editor {...props} entity={props.entity} />
  ) : (
    <div className="curve-empty">
      <h2>动画曲线</h2>
      <p>从场景结构选择对象，编辑位置、旋转或缩放动画。</p>
    </div>
  );
}
function Editor({
  project: p,
  entity,
  frame,
  selectedKey,
  selectKey,
  setFrame,
  send,
  busy,
}: Props & { entity: Entity }) {
  const [property, setProperty] = useState<AnimationTrack['property']>('position');
  const [axis, setAxis] = useState(0),
    [view, setView] = useState<View | null>(null);
  const [preview, setPreview] = useState<AnimationTrack | null>(null),
    [error, setError] = useState('');
  const svg = useRef<SVGSVGElement>(null),
    drag = useRef<Drag | null>(null),
    clipId = useId();
  const current = p.animationTracks.find(
    (t) => t.entityId === entity.id && t.property === property,
  );
  const track = preview || current;
  const v = view || fit(track, axis, p.timeline.duration);
  const selected =
    track?.id === selectedKey?.trackId
      ? track?.keys.find((k) => k.id === selectedKey?.keyId)
      : undefined;
  const selectedIndex = selected && track ? track.keys.indexOf(selected) : -1;
  const handles = selectedIndex >= 0 && track ? keyHandles(track, selectedIndex, axis) : undefined;
  const unit = property === 'rotation' ? 180 / Math.PI : 1;
  const suffix = property === 'rotation' ? '°' : property === 'position' ? 'm' : '倍';
  const x = (f: number) => 60 + ((f - v.x) / v.width) * 720;
  const y = (value: number) => 290 - ((value - v.y) / v.height) * 274;
  const xy = (point: Point) => `${x(point[0])},${y(point[1])}`;
  const cancel = () => {
    drag.current = null;
    setPreview(null);
    setError('');
  };
  useEffect(() => {
    const t = p.animationTracks.find(
      (t) => t.id === selectedKey?.trackId && t.entityId === entity.id,
    );
    if (t && t.property !== property) {
      setProperty(t.property);
      setView(null);
      setPreview(null);
      drag.current = null;
    }
  }, [selectedKey?.trackId]);
  useEffect(() => {
    if (drag.current && drag.current.revision !== p.revision) {
      cancel();
      setError('项目已更新，此次尚未提交的拖动已取消');
    }
  }, [p.revision]);
  const localPoint = (event: PointerEvent): Point => {
    const r = svg.current!.getBoundingClientRect();
    return [((event.clientX - r.left) / r.width) * 800, ((event.clientY - r.top) / r.height) * 320];
  };
  const commit = (command: KeyEdit) => {
    setError('');
    send([command], command.type === 'key.update' ? '编辑关键帧' : '编辑曲线手柄');
  };
  const update = (patch: Extract<KeyEdit, { type: 'key.update' }>['patch']) => {
    if (current && selected)
      commit({ type: 'key.update', trackId: current.id, keyId: selected.id, patch });
  };
  const handle = (side: 'left' | 'right', offset: Point) => {
    if (current && selected)
      commit({ type: 'key.handle', trackId: current.id, keyId: selected.id, axis, side, offset });
  };
  const begin = (event: PointerEvent, keyId: string, side?: 'left' | 'right') => {
    if (busy || event.button !== 0 || !current) return;
    event.stopPropagation();
    event.preventDefault();
    svg.current!.focus();
    svg.current!.setPointerCapture(event.pointerId);
    selectKey({ trackId: current.id, keyId });
    setView(v);
    setError('');
    drag.current = {
      track: structuredClone(current),
      keyId,
      side,
      start: localPoint(event),
      view: v,
      revision: p.revision,
      moved: false,
    };
  };
  const move = (event: PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const point = localPoint(event),
      dx = ((point[0] - d.start[0]) / 720) * d.view.width,
      dy = (-(point[1] - d.start[1]) / 274) * d.view.height;
    if (Math.hypot(point[0] - d.start[0], point[1] - d.start[1]) < 2 && !d.moved) return;
    d.moved = true;
    if (d.pan) {
      setView({ ...d.view, x: d.view.x - dx, y: d.view.y - dy });
      return;
    }
    const index = d.track.keys.findIndex((k) => k.id === d.keyId),
      key = d.track.keys[index];
    let command: KeyEdit;
    if (d.side) {
      const offset = keyHandles(d.track, index, axis)[d.side];
      command = {
        type: 'key.handle',
        trackId: d.track.id,
        keyId: key.id,
        axis,
        side: d.side,
        offset: [
          clamp(offset[0] + dx, d.side === 'left' ? -1e7 : 0, d.side === 'left' ? 0 : 1e7),
          clamp(offset[1] + dy, -1e7, 1e7),
        ],
      };
    } else {
      const value = [...key.value] as Vec3;
      value[axis] = clamp(value[axis] + dy, -1e7, 1e7);
      command = {
        type: 'key.update',
        trackId: d.track.id,
        keyId: key.id,
        patch: { frame: clamp(Math.round(key.frame + dx), 0, 1e6), value },
      };
    }
    try {
      CommandSchema.parse(command);
      const copy = structuredClone(d.track);
      editTrack(copy, command);
      AnimationTrackSchema.parse(copy);
      if (property === 'scale' && copy.keys.some((k) => k.value.some((n) => Math.abs(n) < 0.00001)))
        throw new Error('缩放关键帧不能为零');
      setPreview(copy);
      d.command = command;
      setError('');
    } catch (e) {
      setError((e as Error).message);
      d.command = undefined;
      setPreview(null);
    }
  };
  const finish = (event: PointerEvent) => {
    const d = drag.current;
    drag.current = null;
    setPreview(null);
    if (svg.current?.hasPointerCapture(event.pointerId))
      svg.current.releasePointerCapture(event.pointerId);
    if (d?.command && d.moved && d.revision === p.revision) commit(d.command);
  };
  const curve = (component: number) => {
    if (!track?.keys.length) return '';
    const keys = track.keys,
      first = keys[0],
      last = keys.at(-1)!;
    let path = `M${xy([v.x, first.value[component]])} L${xy([first.frame, first.value[component]])}`;
    keys.slice(0, -1).forEach((a, i) => {
      const b = keys[i + 1];
      if (b.frame < v.x || a.frame > v.x + v.width) {
        path += `M${xy([b.frame, b.value[component]])}`;
        return;
      }
      if (a.interpolation === 'bezier') {
        const points = segmentControls(track, i, component);
        path += `C${xy(points[1])} ${xy(points[2])} ${xy(points[3])}`;
      } else if (a.interpolation === 'smooth') {
        const third = (b.frame - a.frame) / 3;
        path += `C${xy([a.frame + third, a.value[component]])} ${xy([b.frame - third, b.value[component]])} ${xy([b.frame, b.value[component]])}`;
      } else if (a.interpolation === 'constant')
        path += `L${xy([b.frame, a.value[component]])} L${xy([b.frame, b.value[component]])}`;
      else path += `L${xy([b.frame, b.value[component]])}`;
    });
    return path + `L${xy([Math.max(v.x + v.width, last.frame), last.value[component]])}`;
  };
  const zoom = (factor: number) =>
    setView({
      x: v.x + (v.width * (1 - factor)) / 2,
      y: v.y + (v.height * (1 - factor)) / 2,
      width: clamp(v.width * factor, 1, 2e6),
      height: clamp(v.height * factor, 1e-6, 4e7),
    });
  return (
    <div
      className="curve-editor"
      onKeyDown={(event) => {
        if (drag.current && ['Escape', 'Delete', 'z', 'Z', ' '].includes(event.key)) {
          event.preventDefault();
          event.stopPropagation();
          cancel();
        }
      }}
    >
      <div className="curve-toolbar">
        <strong>{entity.name}</strong>
        <select
          aria-label="动画属性"
          value={property}
          onChange={(event) => {
            cancel();
            setProperty(event.target.value as AnimationTrack['property']);
            selectKey(null);
            setView(null);
          }}
        >
          {Object.entries(labels).map(([key, label]) => (
            <option key={key} value={key}>
              {label}
            </option>
          ))}
        </select>
        <div className="segmented">
          {colors.map((color, i) => (
            <button
              key={i}
              aria-label={`曲线 ${'XYZ'[i]}`}
              className={i === axis ? 'active' : ''}
              style={{ color }}
              onClick={() => {
                cancel();
                setAxis(i);
                setView(null);
              }}
            >
              {'XYZ'[i]}
            </button>
          ))}
        </div>
        <button
          disabled={busy}
          onClick={() =>
            send(
              [
                {
                  type: 'key.set',
                  entityId: entity.id,
                  property,
                  key: { id: id(), frame, value: evaluatedTransform(p, entity, frame)[property] },
                },
              ],
              '记录动画关键帧',
            )
          }
        >
          记录当前帧
        </button>
        <span className="spacer" />
        <button onClick={() => setView(fit(current, axis, p.timeline.duration))}>适配曲线</button>
        <button aria-label="放大曲线" onClick={() => zoom(0.7)}>
          ＋
        </button>
        <button aria-label="缩小曲线" onClick={() => zoom(1 / 0.7)}>
          －
        </button>
      </div>
      <svg
        ref={svg}
        className="curve-canvas"
        viewBox="0 0 800 320"
        preserveAspectRatio="none"
        tabIndex={0}
        role="img"
        aria-label="动画曲线图"
        onPointerDown={(event) => {
          if (event.button !== 0 || busy) return;
          event.currentTarget.focus();
          if (event.shiftKey) {
            event.currentTarget.setPointerCapture(event.pointerId);
            drag.current = {
              track: current || { id: '', entityId: entity.id, property, keys: [] },
              keyId: '',
              start: localPoint(event),
              view: v,
              revision: p.revision,
              moved: false,
              pan: true,
            };
          } else {
            const point = localPoint(event);
            setFrame(
              clamp(
                Math.round(v.x + ((point[0] - 60) / 720) * v.width),
                0,
                p.timeline.duration - 1,
              ),
            );
          }
        }}
        onPointerMove={move}
        onPointerUp={finish}
        onPointerCancel={cancel}
        onLostPointerCapture={() => {
          if (drag.current) cancel();
        }}
      >
        <defs>
          <clipPath id={clipId}>
            <rect x="60" y="16" width="720" height="274" />
          </clipPath>
        </defs>
        {Array.from({ length: 9 }, (_, i) => (
          <g key={i} className="curve-grid">
            <line x1={60 + i * 90} x2={60 + i * 90} y1="16" y2="290" />
            <text x={60 + i * 90} y="309" textAnchor="middle">
              {display(v.x + (v.width * i) / 8)}
            </text>
          </g>
        ))}
        {Array.from({ length: 6 }, (_, i) => (
          <g key={i} className="curve-grid">
            <line x1="60" x2="780" y1={16 + i * 54.8} y2={16 + i * 54.8} />
            <text x="53" y={20 + i * 54.8} textAnchor="end">
              {display((v.y + v.height * (1 - i / 5)) * unit)}
            </text>
          </g>
        ))}
        <text x="8" y="12" className="curve-unit">
          {suffix}
        </text>
        <g clipPath={`url(#${clipId})`}>
          <line className="curve-playhead" x1={x(frame)} x2={x(frame)} y1="16" y2="290" />
          {colors.map((color, i) => (
            <path
              key={i}
              d={curve(i)}
              fill="none"
              stroke={color}
              strokeWidth={i === axis ? 2 : 1}
              opacity={i === axis ? 1 : 0.25}
              pointerEvents="none"
            />
          ))}
          {selected &&
            handles &&
            (['left', 'right'] as const).map((side) => {
              const enabled =
                side === 'right'
                  ? selected.interpolation === 'bezier' && selectedIndex < track!.keys.length - 1
                  : selectedIndex > 0 && track!.keys[selectedIndex - 1].interpolation === 'bezier';
              if (!enabled) return null;
              const hx = x(selected.frame + handles[side][0]),
                hy = y(selected.value[axis] + handles[side][1]);
              return (
                <g key={side}>
                  <line
                    x1={x(selected.frame)}
                    y1={y(selected.value[axis])}
                    x2={hx}
                    y2={hy}
                    stroke={colors[axis]}
                    strokeDasharray="4 3"
                  />
                  <rect
                    data-handle={side}
                    aria-label={side === 'left' ? '左曲线手柄' : '右曲线手柄'}
                    x={hx - 5}
                    y={hy - 5}
                    width="10"
                    height="10"
                    fill="#15202c"
                    stroke={colors[axis]}
                    className="curve-point"
                    onPointerDown={(event) => begin(event, selected.id, side)}
                  />
                </g>
              );
            })}
          {track?.keys
            .filter((k) => k.frame >= v.x && k.frame <= v.x + v.width)
            .map((k) => (
              <circle
                key={k.id}
                data-key-id={k.id}
                aria-label={`关键帧 ${k.frame}`}
                cx={x(k.frame)}
                cy={y(k.value[axis])}
                r={selected?.id === k.id ? 6 : 4.5}
                fill={selected?.id === k.id ? '#fff0c4' : colors[axis]}
                stroke="#18212d"
                className="curve-point"
                onPointerDown={(event) => begin(event, k.id)}
              />
            ))}
        </g>
      </svg>
      <div className="curve-hint">
        拖动圆点调整时间和值；拖动方块调整手柄；Shift + 拖动空白处平移。松开提交，Esc 取消。
      </div>
      <fieldset disabled={busy || !!preview} className="curve-fields">
        {selected && handles ? (
          <>
            <NumberInput
              label="关键帧时间"
              value={selected.frame}
              step={1}
              min={0}
              max={1e6}
              onChange={(f) => update({ frame: f })}
            />
            <NumberInput
              label={`关键帧 ${'XYZ'[axis]}（${suffix}）`}
              value={selected.value[axis] * unit}
              onChange={(n) => {
                const value = [...selected.value] as Vec3;
                value[axis] = n / unit;
                update({ value });
              }}
            />
            <label className="field">
              段插值
              <select
                aria-label="曲线插值"
                value={selected.interpolation}
                onChange={(event) => update({ interpolation: event.target.value as 'bezier' })}
              >
                <option value="constant">保持</option>
                <option value="linear">线性</option>
                <option value="smooth">平滑</option>
                <option value="bezier">Bézier</option>
              </select>
            </label>
            <label className="field">
              {'XYZ'[axis]} 手柄
              <select
                aria-label="手柄类型"
                value={handles.mode}
                onChange={(event) =>
                  commit({
                    type: 'key.handles',
                    trackId: track!.id,
                    keyId: selected.id,
                    axis,
                    mode: event.target.value as KeyHandles[0]['mode'],
                  })
                }
              >
                <option value="auto-clamped">自动限幅</option>
                <option value="vector">向量</option>
                <option value="aligned">对齐</option>
                <option value="free">自由</option>
              </select>
            </label>
            <button
              className="danger"
              onClick={() =>
                send(
                  [{ type: 'key.delete', trackId: track!.id, frame: selected.frame }],
                  '删除关键帧',
                )
              }
            >
              删除关键帧
            </button>
            <div className="curve-handle-fields">
              {(['left', 'right'] as const).map((side) => (
                <div key={side}>
                  <NumberInput
                    label={`${side === 'left' ? '左' : '右'}手柄 Δ帧`}
                    value={handles[side][0]}
                    onChange={(n) => handle(side, [n, handles[side][1]])}
                  />
                  <NumberInput
                    label={`${side === 'left' ? '左' : '右'}手柄 Δ值`}
                    value={handles[side][1] * unit}
                    onChange={(n) => handle(side, [handles[side][0], n / unit])}
                  />
                </div>
              ))}
              <span className="muted">
                插值应用于此帧之后的段。时间与插值按 XYZ 成组；手柄按轴编辑。
              </span>
            </div>
          </>
        ) : (
          <p className="muted">
            {track?.keys.length
              ? '选择图中的关键帧以编辑插值和手柄。'
              : '当前属性没有关键帧。先记录当前帧，再移动播放头并修改对象属性。'}
          </p>
        )}
      </fieldset>
      {error && (
        <p className="curve-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
