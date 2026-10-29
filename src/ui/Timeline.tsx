import {
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import { type Command } from '../core/commands';
import { type Clip, type Project } from '../core/model';
import { planClipEdit, previewClipEdit, type ClipEdit } from '../core/clip-editing';
import { activeTracks } from '../core/animation';
import { shotAction } from '../core/playback';
import { NumberInput } from './Inspector';
import type { KeySelection } from './CurveEditor';

export function Timeline({
  p,
  frame,
  setFrame,
  playing,
  setPlaying,
  selectedClip,
  selectClip,
  selectedEntity,
  selectedKey,
  selectKey,
  send,
  disabled = false,
}: {
  p: Project;
  frame: number;
  setFrame: (f: number) => void;
  playing: boolean;
  setPlaying: (v: boolean) => void;
  selectedClip: string | null;
  selectClip: (id: string) => void;
  selectedEntity: string | null;
  selectedKey: KeySelection;
  selectKey: (selection: KeySelection) => void;
  send: (c: Command[], label: string) => void;
  disabled?: boolean;
}) {
  const [zoom, setZoom] = useState(1),
    [snap, setSnap] = useState(true),
    [extraChannel, setExtraChannel] = useState(2),
    [message, setMessage] = useState(''),
    [preview, setPreview] = useState<ReturnType<typeof previewClipEdit> | null>(null);
  const root = useRef<HTMLElement>(null);
  const drag = useRef<{
    project: Project;
    clipId: string;
    mode: ClipEdit['mode'];
    pointerId: number;
    x: number;
    y: number;
    pixelsPerFrame: number;
    moved: boolean;
    frame: number;
    viewport: [number, number];
    element: HTMLButtonElement;
    preview: ReturnType<typeof previewClipEdit>;
  } | null>(null);
  const lastChannel = Math.max(extraChannel, ...p.timeline.clips.map((c) => c.channel));
  const channels = Array.from({ length: lastChannel + 1 }, (_, i) => lastChannel - i);
  const cancel = (text = '已取消片段编辑') => {
    const current = drag.current;
    if (!current) return;
    drag.current = null;
    setPreview(null);
    setMessage(text);
    if (current.element.hasPointerCapture(current.pointerId))
      current.element.releasePointerCapture(current.pointerId);
  };
  useEffect(() => {
    const d = drag.current;
    if (
      d &&
      (d.project.id !== p.id ||
        d.project.revision !== p.revision ||
        d.frame !== frame ||
        selectedClip !== d.clipId ||
        disabled)
    )
      cancel();
  }, [p.id, p.revision, frame, selectedClip, disabled]);
  useEffect(() => {
    cancel();
  }, [zoom]);
  useEffect(() => {
    setExtraChannel(2);
    setZoom(1);
    setMessage('');
  }, [p.id]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (!drag.current) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      if (e.key === 'Escape') cancel();
    };
    const blur = () => cancel();
    window.addEventListener('keydown', key, true);
    window.addEventListener('blur', blur);
    window.addEventListener('resize', blur);
    return () => {
      window.removeEventListener('keydown', key, true);
      window.removeEventListener('blur', blur);
      window.removeEventListener('resize', blur);
      drag.current = null;
    };
  }, []);
  const label = (mode: ClipEdit['mode']) =>
    ({ move: '移动片段', trimStart: '裁剪片段起点', trimEnd: '裁剪片段终点' })[mode];
  const begin = (e: ReactPointerEvent<HTMLButtonElement>, clip: Clip, mode: ClipEdit['mode']) => {
    if (disabled || e.button !== 0 || drag.current) return;
    const content = e.currentTarget.closest('.track-content')!.getBoundingClientRect();
    const initial = previewClipEdit(p, clip.id, { mode, delta: 0 });
    e.preventDefault();
    e.stopPropagation();
    setPlaying(false);
    selectClip(clip.id);
    setMessage('');
    e.currentTarget.focus({ preventScroll: true });
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = {
      project: p,
      clipId: clip.id,
      mode,
      pointerId: e.pointerId,
      x: e.clientX,
      y: e.clientY,
      pixelsPerFrame: content.width / p.timeline.duration,
      moved: false,
      frame,
      viewport: [window.innerWidth, window.innerHeight],
      element: e.currentTarget,
      preview: initial,
    };
    setPreview(initial);
  };
  const move = (e: ReactPointerEvent<HTMLButtonElement>) => {
    const d = drag.current;
    if (!d || e.pointerId !== d.pointerId) return;
    if (!d.moved && Math.hypot(e.clientX - d.x, e.clientY - d.y) < 3) return;
    d.moved = true;
    const delta = Math.max(
      -1000000,
      Math.min(1000000, Math.round((e.clientX - d.x) / d.pixelsPerFrame)),
    );
    const track = [...root.current!.querySelectorAll<HTMLElement>('[data-channel]')].find((el) => {
      const r = el.getBoundingClientRect();
      return e.clientY >= r.top && e.clientY < r.bottom;
    });
    const edit: ClipEdit = {
      mode: d.mode,
      delta,
      ...(d.mode === 'move'
        ? { channel: track ? Number(track.dataset.channel) : d.preview.clip.channel }
        : {}),
    };
    d.preview = previewClipEdit(
      d.project,
      d.clipId,
      edit,
      snap !== e.ctrlKey ? { frame: d.frame, threshold: 8 / d.pixelsPerFrame } : undefined,
    );
    setPreview(d.preview);
  };
  const end = (e: ReactPointerEvent<HTMLButtonElement>) => {
    const d = drag.current;
    if (!d || e.pointerId !== d.pointerId) return;
    if (
      d.project.id !== p.id ||
      d.project.revision !== p.revision ||
      d.frame !== frame ||
      d.viewport[0] !== window.innerWidth ||
      d.viewport[1] !== window.innerHeight ||
      Math.abs(
        d.element.closest('.track-content')!.getBoundingClientRect().width / p.timeline.duration -
          d.pixelsPerFrame,
      ) > 1e-8 ||
      disabled ||
      selectedClip !== d.clipId
    ) {
      cancel();
      return;
    }
    move(e);
    drag.current = null;
    setPreview(null);
    if (d.element.hasPointerCapture(d.pointerId)) d.element.releasePointerCapture(d.pointerId);
    if (!d.moved) return;
    if (d.preview.error) {
      setMessage(`未应用：${d.preview.error}`);
      return;
    }
    if (d.preview.changed) {
      send([{ type: 'clip.update', id: d.clipId, patch: d.preview.patch }], label(d.mode));
      setMessage('');
    } else setMessage('片段未改变');
  };
  const keyboard = (
    e: ReactKeyboardEvent<HTMLButtonElement>,
    clip: Clip,
    mode: ClipEdit['mode'],
  ) => {
    if (disabled || drag.current || e.ctrlKey || e.metaKey || e.altKey) return;
    if (
      !['ArrowLeft', 'ArrowRight', ...(mode === 'move' ? ['ArrowUp', 'ArrowDown'] : [])].includes(
        e.key,
      )
    )
      return;
    e.preventDefault();
    e.stopPropagation();
    setPlaying(false);
    selectClip(clip.id);
    const vertical = e.key === 'ArrowUp' || e.key === 'ArrowDown';
    const channel = clip.channel + (e.key === 'ArrowUp' ? 1 : -1);
    if (vertical && (channel < 0 || channel > 31)) {
      setMessage('轨道范围为 1–32');
      return;
    }
    const result = planClipEdit(p, clip.id, {
      mode,
      delta: vertical ? 0 : (e.key === 'ArrowRight' ? 1 : -1) * (e.shiftKey ? 10 : 1),
      ...(vertical ? { channel } : {}),
    });
    if (result.error) setMessage(`未应用：${result.error}`);
    else if (result.changed) {
      send([{ type: 'clip.update', id: clip.id, patch: result.patch }], label(mode));
      setMessage('');
    }
  };
  const gesture = (clip: Clip, mode: ClipEdit['mode']) => ({
    onPointerDown: (e: ReactPointerEvent<HTMLButtonElement>) => begin(e, clip, mode),
    onPointerMove: move,
    onPointerUp: end,
    onPointerCancel: () => cancel(),
    onLostPointerCapture: () => cancel(),
    onKeyDown: (e: ReactKeyboardEvent<HTMLButtonElement>) => keyboard(e, clip, mode),
  });
  const tracks = selectedEntity ? activeTracks(p, selectedEntity) : [];
  const motion = (clip: Project['timeline']['clips'][number]) => {
    if (clip.kind !== 'shot') return '';
    const shot = p.shots.find((s) => s.id === clip.sourceId)!;
    const action =
      p.animationActions?.find((a) => a.id === shotAction(p, shot, clip))?.name || '项目动画';
    return `${action} · ${clip.playback?.rate ?? 1}×${
      clip.playback
        ? ' · ' + { hold: '保持', repeat: '循环', pingpong: '往返' }[clip.playback.mode]
        : ''
    }`;
  };
  return (
    <section className="timeline" ref={root} data-editing={!!preview}>
      <div className="timeline-toolbar">
        <strong>时间轴</strong>
        <button disabled={!!preview} onClick={() => setFrame(0)}>
          ↤
        </button>
        <button
          className="play"
          disabled={!!preview}
          onClick={() => setPlaying(!playing)}
          aria-label={playing ? '暂停' : '播放'}
        >
          {playing ? 'Ⅱ' : '▶'}
        </button>
        <NumberInput
          label="当前帧"
          value={frame}
          step={1}
          min={0}
          max={p.timeline.duration - 1}
          onChange={(v) => setFrame(Math.max(0, Math.min(p.timeline.duration - 1, v)))}
        />
        <span>
          {(frame / p.timeline.fps).toFixed(2)} s /{' '}
          {(p.timeline.duration / p.timeline.fps).toFixed(2)} s
        </span>
        <span className="spacer" />
        <label className="timeline-snap">
          <input
            type="checkbox"
            aria-label="片段吸附"
            checked={snap}
            disabled={!!preview}
            onChange={(e) => setSnap(e.target.checked)}
          />
          吸附
        </label>
        <select
          aria-label="时间轴缩放"
          value={zoom}
          disabled={!!preview}
          onChange={(e) => setZoom(Number(e.target.value))}
        >
          {[1, 2, 4, 8, 16, 32, 64].map((n) => (
            <option key={n} value={n}>
              {n}×
            </option>
          ))}
        </select>
        <button
          disabled={disabled || !!preview || lastChannel >= 31}
          onClick={() => setExtraChannel(lastChannel + 1)}
        >
          增加轨道
        </button>
        <span>
          {p.timeline.fps} FPS · {p.timeline.width} × {p.timeline.height}
        </span>
        <button
          disabled={disabled || !!preview || !selectedClip || !Number.isInteger(frame)}
          onClick={() => send([{ type: 'clip.split', id: selectedClip!, frame }], '切分片段')}
        >
          切分 · K
        </button>
      </div>
      <div className="timeline-edit-status" role="status" data-error={!!preview?.error}>
        {preview
          ? `${preview.error ? '不能应用：' + preview.error + ' · ' : ''}${preview.clip.start}–${preview.clip.start + preview.clip.duration} 帧 · ${preview.clip.duration} 帧 · 源入点 ${Number(preview.clip.sourceIn.toFixed(6))} · 轨道 ${preview.clip.channel + 1}${preview.snapFrame !== undefined ? ' · 吸附 ' + preview.snapFrame : ''}`
          : message ||
            '拖动移动/换轨，两端裁剪；Ctrl 临时切换吸附，Esc 取消。聚焦条带/手柄后方向键微调，Shift 十帧。'}
      </div>
      <div className="timeline-scroll" onScroll={() => cancel('滚动已取消片段编辑')}>
        <div className="timeline-canvas" style={{ width: `${zoom * 100}%` }}>
          <div className="ruler">
            <span>帧</span>
            <input
              aria-label="播放头"
              type="range"
              min={0}
              max={p.timeline.duration - 1}
              value={frame}
              onChange={(e) => setFrame(Number(e.target.value))}
            />
          </div>
          <div className="track-area">
            <div
              className="playhead"
              style={{ left: `calc(94px + (100% - 94px) * ${frame / p.timeline.duration})` }}
            />
            {channels.map((channel) => (
              <div className="timeline-track" key={channel}>
                <div className="track-label">轨道 {channel + 1}</div>
                <div
                  className="track-content"
                  data-channel={channel}
                  onDoubleClick={(e) => {
                    const r = e.currentTarget.getBoundingClientRect();
                    setFrame(
                      Math.max(
                        0,
                        Math.min(
                          p.timeline.duration - 1,
                          Math.floor(((e.clientX - r.left) / r.width) * p.timeline.duration),
                        ),
                      ),
                    );
                  }}
                >
                  {p.timeline.clips
                    .filter((c) => c.channel === channel)
                    .map((c) => (
                      <div
                        key={c.id}
                        className={`clip-shell ${preview?.clip.id === c.id ? 'editing' : ''}`}
                        style={{
                          left: `${(c.start / p.timeline.duration) * 100}%`,
                          width: `${(c.duration / p.timeline.duration) * 100}%`,
                        }}
                      >
                        <button
                          className={`clip ${c.kind} ${selectedClip === c.id ? 'selected' : ''} ${c.muted ? 'muted-clip' : ''}`}
                          style={{ left: 0, width: '100%' }}
                          data-clip-id={c.id}
                          disabled={disabled}
                          {...gesture(c, 'move')}
                          onClick={() => selectClip(c.id)}
                          title={`${c.name} · ${c.start}–${c.start + c.duration} 帧（右开区间）${c.kind === 'shot' ? ' · ' + motion(c) : ''}`}
                        >
                          {c.kind === 'shot' ? '▧' : c.kind === 'audio' ? '♫' : '▣'} {c.name}
                          {c.kind === 'shot' && <span className="clip-motion"> · {motion(c)}</span>}
                          <small>{c.duration} f</small>
                        </button>
                        {(['trimStart', 'trimEnd'] as const).map((mode) => (
                          <button
                            key={mode}
                            className={`clip-trim-handle ${mode}`}
                            aria-label={`${c.name} ${mode === 'trimStart' ? '裁剪起点' : '裁剪终点'}`}
                            data-clip-handle={mode}
                            data-clip={c.id}
                            disabled={disabled}
                            {...gesture(c, mode)}
                          />
                        ))}
                      </div>
                    ))}
                </div>
              </div>
            ))}
            {preview && (
              <>
                <div
                  className={`clip clip-draft ${preview.error ? 'invalid' : ''}`}
                  data-preview-start={preview.clip.start}
                  data-preview-duration={preview.clip.duration}
                  data-preview-source-in={preview.clip.sourceIn}
                  data-preview-channel={preview.clip.channel}
                  style={{
                    top: `${channels.indexOf(preview.clip.channel) * 33 + 3}px`,
                    left: `calc(94px + (100% - 94px) * ${preview.clip.start / p.timeline.duration})`,
                    width: `calc((100% - 94px) * ${Math.max(1, preview.clip.duration) / p.timeline.duration})`,
                  }}
                >
                  {preview.clip.name} · {preview.clip.duration} f
                </div>
                {preview.snapFrame !== undefined && (
                  <div
                    className="clip-snap-line"
                    style={{
                      left: `calc(94px + (100% - 94px) * ${preview.snapFrame / p.timeline.duration})`,
                    }}
                  />
                )}
              </>
            )}
            {tracks.map((t) => (
              <div className="timeline-track key-track" key={t.id}>
                <div className="track-label">
                  {
                    { position: '位置', rotation: '旋转', quaternion: '四元数', scale: '缩放' }[
                      t.property
                    ]
                  }
                </div>
                <div className="track-content">
                  {t.keys.map((k) => (
                    <button
                      key={k.id}
                      className={
                        'keyframe ' +
                        (selectedKey?.some((s) => s.trackId === t.id && s.keyId === k.id)
                          ? 'active'
                          : '')
                      }
                      title={`帧 ${k.frame} · ${k.interpolation}；Shift 增减选择；右键删除`}
                      data-track-id={t.id}
                      data-timeline-key-id={k.id}
                      style={{ left: `${(k.frame / p.timeline.duration) * 100}%` }}
                      onClick={(e) => {
                        const ref = { trackId: t.id, keyId: k.id };
                        selectKey(
                          e.shiftKey
                            ? selectedKey?.some((s) => s.trackId === t.id && s.keyId === k.id)
                              ? selectedKey.filter((s) => s.trackId !== t.id || s.keyId !== k.id)
                              : [...(selectedKey || []), ref]
                            : [ref],
                        );
                      }}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        send([{ type: 'key.delete', trackId: t.id, frame: k.frame }], '删除关键帧');
                      }}
                    >
                      ◆
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
