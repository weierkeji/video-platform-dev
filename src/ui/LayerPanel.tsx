import { id, type AnimationLayer, type Entity, type Project } from '../core/model';
import type { Command } from '../core/commands';
import { actionRange } from '../core/playback';
import { layerWeight, layerSourceFrame } from '../core/layers';
import { NumberInput } from './Inspector';

export function LayerPanel({
  project: p,
  entity,
  frame,
  send,
}: {
  project: Project;
  entity: Entity;
  frame: number;
  send: (commands: Command[], label: string) => void;
}) {
  const layers = (p.animationLayers || []).filter((l) => l.entityId === entity.id);
  const actions = (p.animationActions || []).filter((a) => a.sceneId === entity.sceneId);
  const add = () => {
    const actionId = p.scenes.find((s) => s.id === entity.sceneId)?.activeActionId || null;
    const range = actionRange(p, entity.sceneId, actionId);
    send(
      [
        {
          type: 'layer.add',
          layer: {
            id: id(),
            name: `动作层 ${layers.length + 1}`,
            entityId: entity.id,
            actionId,
            enabled: true,
            blend: 'replace',
            weight: 1,
            channels: ['position', 'rotation', 'scale'],
            start: 0,
            duration: p.timeline.duration,
            sourceIn: range.start,
            playback: { rate: 1, rangeStart: range.start, rangeEnd: range.end, mode: 'hold' },
            fadeIn: 0,
            fadeOut: 0,
          },
        },
      ],
      '添加对象动作层',
    );
  };
  return (
    <section className="layer-panel" aria-label="对象动作层">
      <h3>对象动作层</h3>
      <p className="muted">
        从上往下依次混合到场景动作。只影响此对象已写键的通道；时间使用镜头映射后的场景帧。
      </p>
      <button disabled={layers.length >= 64} onClick={add}>
        添加动作层
      </button>
      {layers.map((layer, index) => {
        const update = (patch: Partial<AnimationLayer>) =>
          send([{ type: 'layer.update', id: layer.id, patch }], '编辑对象动作层');
        const timing = (patch: Partial<AnimationLayer['playback']>) =>
          update({ playback: { ...layer.playback, ...patch } });
        return (
          <details className="animation-layer" key={layer.id} data-layer-id={layer.id}>
            <summary>
              {index + 1}. {layer.name} ·{' '}
              {layer.enabled ? `${Math.round(layerWeight(layer, frame) * 100)}%` : '已禁用'}
            </summary>
            <label className="field">
              层名称
              <input
                aria-label="层名称"
                key={layer.name}
                defaultValue={layer.name}
                maxLength={160}
                onBlur={(e) => {
                  if (e.target.value && e.target.value !== layer.name)
                    update({ name: e.target.value });
                }}
              />
            </label>
            <label className="check">
              <input
                type="checkbox"
                aria-label="启用动作层"
                checked={layer.enabled}
                onChange={(e) => update({ enabled: e.target.checked })}
              />
              启用动作层
            </label>
            <label className="field">
              层动作
              <select
                aria-label="层动作"
                value={layer.actionId || ''}
                onChange={(e) => update({ actionId: e.target.value || null })}
              >
                <option value="">项目动画</option>
                {actions.map((a) => (
                  <option value={a.id} key={a.id}>
                    {a.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              混合方式
              <select
                aria-label="混合方式"
                value={layer.blend}
                onChange={(e) => update({ blend: e.target.value as AnimationLayer['blend'] })}
              >
                <option value="replace">按权重替换</option>
                <option value="additive">基础姿态增量</option>
              </select>
            </label>
            <NumberInput
              label="层权重"
              min={0}
              max={1}
              step={0.05}
              value={layer.weight}
              onChange={(weight) => update({ weight })}
            />
            <div className="button-row">
              {(['position', 'rotation', 'scale'] as const).map((channel) => (
                <label className="check" key={channel}>
                  <input
                    type="checkbox"
                    aria-label={`层${{ position: '位置', rotation: '旋转', scale: '缩放' }[channel]}`}
                    checked={layer.channels.includes(channel)}
                    disabled={layer.channels.length === 1 && layer.channels.includes(channel)}
                    onChange={(e) =>
                      update({
                        channels: e.target.checked
                          ? [...layer.channels, channel]
                          : layer.channels.filter((c) => c !== channel),
                      })
                    }
                  />
                  {{ position: '位置', rotation: '旋转', scale: '缩放' }[channel]}
                </label>
              ))}
            </div>
            <NumberInput
              label="层起点"
              min={0}
              value={layer.start}
              onChange={(start) => update({ start })}
            />
            <NumberInput
              label="层时长"
              min={1e-6}
              value={layer.duration}
              onChange={(duration) => update({ duration })}
            />
            <NumberInput
              label="淡入帧数"
              min={0}
              value={layer.fadeIn}
              onChange={(fadeIn) => update({ fadeIn })}
            />
            <NumberInput
              label="淡出帧数"
              min={0}
              value={layer.fadeOut}
              onChange={(fadeOut) => update({ fadeOut })}
            />
            <NumberInput
              label="层源入点"
              value={layer.sourceIn}
              onChange={(sourceIn) => update({ sourceIn })}
            />
            <NumberInput
              label="层速度"
              min={-16}
              max={16}
              value={layer.playback.rate}
              onChange={(rate) => timing({ rate })}
            />
            <NumberInput
              label="层源范围起点"
              min={0}
              value={layer.playback.rangeStart}
              onChange={(rangeStart) => timing({ rangeStart })}
            />
            <NumberInput
              label="层源范围终点"
              min={0}
              value={layer.playback.rangeEnd}
              onChange={(rangeEnd) => timing({ rangeEnd })}
            />
            <label className="field">
              层范围外处理
              <select
                aria-label="层范围外处理"
                value={layer.playback.mode}
                onChange={(e) =>
                  timing({ mode: e.target.value as AnimationLayer['playback']['mode'] })
                }
              >
                <option value="hold">保持端点</option>
                <option value="repeat">循环</option>
                <option value="pingpong">往返</option>
              </select>
            </label>
            <button
              onClick={() => {
                const range = actionRange(p, entity.sceneId, layer.actionId);
                update({
                  playback: { ...layer.playback, rangeStart: range.start, rangeEnd: range.end },
                  sourceIn: layer.playback.rate < 0 ? range.end : range.start,
                });
              }}
            >
              采用层动作范围
            </button>
            <p className="muted">
              当前源帧 {layerSourceFrame(layer, frame).toFixed(3)}；有效权重{' '}
              {layerWeight(layer, frame).toFixed(3)}。窗口外无影响。
            </p>
            <div className="button-row">
              <button
                disabled={!index}
                onClick={() =>
                  send([{ type: 'layer.move', id: layer.id, direction: -1 }], '前移动作层')
                }
              >
                先混合
              </button>
              <button
                disabled={index === layers.length - 1}
                onClick={() =>
                  send([{ type: 'layer.move', id: layer.id, direction: 1 }], '后移动作层')
                }
              >
                后混合
              </button>
              <button onClick={() => send([{ type: 'layer.delete', id: layer.id }], '删除动作层')}>
                删除层
              </button>
            </div>
          </details>
        );
      })}
      {!!layers.length && (
        <p className="muted">
          替换层淡入可从之前的混合结果过渡；权重不归一化。增量的位置和缩放使用基础姿态差值，旋转叠加局部四元数差值。编辑源动作请先关闭“预览动作层”，再选择场景动画动作；导出始终包含启用的层。
        </p>
      )}
    </section>
  );
}
