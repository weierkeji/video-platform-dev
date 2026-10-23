import type { Project, Clip, ShotPlayback } from '../core/model';
import type { Command } from '../core/commands';
import { actionRange, shotAction, sourceFrame } from '../core/playback';
import { ActionSelect } from './ActionSelect';
import { NumberInput } from './Inspector';

export function ShotPlaybackPanel({
  project: p,
  clip,
  frame,
  send,
}: {
  project: Project;
  clip: Clip;
  frame: number;
  send: (commands: Command[], label: string) => void;
}) {
  const shot = p.shots.find((s) => s.id === clip.sourceId)!;
  const actionId = shotAction(p, shot, clip),
    actionName = p.animationActions?.find((a) => a.id === actionId)?.name || '项目动画',
    range = actionRange(p, shot.sceneId, actionId);
  const defaults: ShotPlayback = {
    rate: 1,
    rangeStart: range.start,
    rangeEnd: range.end,
    mode: 'hold',
  };
  const timing = clip.playback || defaults;
  const update = (patch: Partial<Clip>, label = '编辑片段动作调度') =>
    send([{ type: 'clip.update', id: clip.id, patch }], label);
  const playback = (patch: Partial<ShotPlayback>) => update({ playback: { ...timing, ...patch } });
  const inside = frame >= clip.start && frame < clip.start + clip.duration;
  return (
    <section className="shot-playback">
      <h3>镜头动画</h3>
      <ActionSelect
        project={p}
        sceneId={shot.sceneId}
        label="片段动作"
        inherit="跟随镜头"
        value={clip.action}
        onChange={(action) => update({ action })}
      />
      <p className="muted">
        当前使用：{actionName}。摄影机及全部场景对象共用此动作和源时间；场景编辑仍使用场景默认动作。
      </p>
      <label className="check">
        <input
          type="checkbox"
          aria-label="自定义动画播放"
          checked={!!clip.playback}
          onChange={(e) => update({ playback: e.target.checked ? defaults : null })}
        />
        自定义动画播放
      </label>
      {clip.playback && (
        <>
          <NumberInput
            label="动画速度"
            value={timing.rate}
            min={-16}
            max={16}
            onChange={(rate) => playback({ rate })}
          />
          <NumberInput
            label="动作范围起点"
            value={timing.rangeStart}
            min={0}
            max={1e6}
            onChange={(rangeStart) => playback({ rangeStart })}
          />
          <NumberInput
            label="动作范围终点"
            value={timing.rangeEnd}
            min={0}
            max={1e6}
            onChange={(rangeEnd) => playback({ rangeEnd })}
          />
          <label className="field">
            范围外处理
            <select
              aria-label="范围外处理"
              value={timing.mode}
              onChange={(e) => playback({ mode: e.target.value as ShotPlayback['mode'] })}
            >
              <option value="hold">保持端点</option>
              <option value="repeat">循环</option>
              <option value="pingpong">往返</option>
            </select>
          </label>
          <div className="button-row">
            <button
              onClick={() =>
                update({
                  playback: { ...timing, rangeStart: range.start, rangeEnd: range.end },
                  sourceIn: timing.rate < 0 ? range.end : range.start,
                })
              }
            >
              采用动作范围
            </button>
            <button
              onClick={() =>
                update({
                  playback: { ...timing, rate: -Math.abs(timing.rate || 1) },
                  sourceIn: timing.rangeEnd,
                })
              }
            >
              从末尾倒放
            </button>
            <button
              onClick={() =>
                update({
                  playback: { ...timing, rate: Math.abs(timing.rate || 1) },
                  sourceIn: timing.rangeStart,
                })
              }
            >
              从起点正放
            </button>
          </div>
          <p className="muted">
            1 为原速，负数倒放，0
            定格。源入点可为小数或超出范围，用于保留循环相位；修改速度/范围不改变片段时长。循环端点不重复停留，往返在端点转向。
          </p>
        </>
      )}
      <p className="muted">
        {inside
          ? `播放头对应源帧：${Number(sourceFrame(clip, frame).toFixed(4))}`
          : '播放头当前不在此片段内。'}
      </p>
    </section>
  );
}
