import { type Command } from '../core/commands';
import { type Project } from '../core/model';
import { activeTracks } from '../core/animation';
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
}) {
  const channels = [...new Set([0, 1, 2, ...p.timeline.clips.map((c) => c.channel)])].sort(
    (a, b) => b - a,
  );
  const tracks = selectedEntity ? activeTracks(p, selectedEntity) : [];
  return (
    <section className="timeline">
      <div className="timeline-toolbar">
        <strong>时间轴</strong>
        <button onClick={() => setFrame(0)}>↤</button>
        <button
          className="play"
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
        <span>
          {p.timeline.fps} FPS · {p.timeline.width} × {p.timeline.height}
        </span>
        <button
          disabled={!selectedClip || !Number.isInteger(frame)}
          onClick={() => send([{ type: 'clip.split', id: selectedClip!, frame }], '切分片段')}
        >
          切分 · K
        </button>
      </div>
      <div className="timeline-scroll">
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
                onDoubleClick={(e) => {
                  const r = e.currentTarget.getBoundingClientRect();
                  setFrame(Math.floor(((e.clientX - r.left) / r.width) * p.timeline.duration));
                }}
              >
                {p.timeline.clips
                  .filter((c) => c.channel === channel)
                  .map((c) => (
                    <button
                      key={c.id}
                      className={`clip ${c.kind} ${selectedClip === c.id ? 'selected' : ''} ${c.muted ? 'muted-clip' : ''}`}
                      style={{
                        left: `${(c.start / p.timeline.duration) * 100}%`,
                        width: `${(c.duration / p.timeline.duration) * 100}%`,
                      }}
                      onClick={() => selectClip(c.id)}
                      title={`${c.name} · ${c.start}–${c.start + c.duration} 帧（右开区间）`}
                    >
                      {c.kind === 'shot' ? '▧' : c.kind === 'audio' ? '♫' : '▣'} {c.name}
                      <small>{c.duration} f</small>
                    </button>
                  ))}
              </div>
            </div>
          ))}
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
                      (selectedKey?.trackId === t.id && selectedKey.keyId === k.id ? 'active' : '')
                    }
                    title={`帧 ${k.frame} · ${k.interpolation}；右键删除`}
                    style={{ left: `${(k.frame / p.timeline.duration) * 100}%` }}
                    onClick={() => selectKey({ trackId: t.id, keyId: k.id })}
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
    </section>
  );
}
