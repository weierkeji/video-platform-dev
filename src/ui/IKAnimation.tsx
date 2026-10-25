import { useState } from 'react';
import type { Command } from '../core/commands';
import type { IKChain, IKTrack, Project } from '../core/model';
import { activeIKTracks, evaluatedIK } from '../core/ik-animation';
import { keyHandles, sampleCurve } from '../core/animation';
import { NumberInput } from './Inspector';

export function IKAnimation({
  project,
  chain,
  frame,
  send,
}: {
  project: Project;
  chain: IKChain;
  frame: number;
  send: (commands: Command[], label: string) => void;
}) {
  const [property, setProperty] = useState<IKTrack['property']>('influence');
  const [selection, setSelection] = useState('');
  const track = activeIKTracks(project, chain.joints[0]).find(
    (t) => t.chainId === chain.id && t.property === property,
  );
  const key =
    track?.keys.find((k) => k.id === selection) ||
    track?.keys.find((k) => k.frame === frame) ||
    track?.keys[0];
  const factor = property === 'poleAngle' ? 180 / Math.PI : 1;
  const base = evaluatedIK(project, chain, frame, undefined, false)[property];
  const final = evaluatedIK(project, chain, frame);
  const edit = (patch: Extract<Command, { type: 'ik.key.update' }>['patch']) => {
    if (track && key)
      send([{ type: 'ik.key.update', trackId: track.id, keyId: key.id, patch }], '编辑 IK 关键帧');
  };
  const start = track?.keys[0]?.frame || 0,
    end = Math.max(start + 1, track?.keys.at(-1)?.frame || 1);
  const samples = track?.keys.length
    ? Array.from({ length: 161 }, (_, i) => {
        const time = start + ((end - start) * i) / 160;
        return [time, sampleCurve(track, time)![0] * factor];
      })
    : [];
  const low = Math.min(0, ...samples.map((s) => s[1])),
    high = Math.max(1, ...samples.map((s) => s[1]));
  const x = (f: number) => 12 + (276 * (f - start)) / (end - start);
  const y = (v: number) => 100 - (88 * (v - low)) / (high - low);
  const h = track && key ? keyHandles(track, track.keys.indexOf(key), 0) : undefined;
  return (
    <details className="ik-animation">
      <summary>IK 参数动画</summary>
      <p className="muted">
        使用当前场景动作。根关节的动作层可勾选 IK 控制；层按顺序混合。影响最终限制到
        0…1，极向角连续插值。
      </p>
      <label className="field">
        参数
        <select
          aria-label="IK 动画参数"
          value={property}
          onChange={(e) => {
            setProperty(e.target.value as IKTrack['property']);
            setSelection('');
          }}
        >
          <option value="influence">影响</option>
          <option value="poleAngle">极向角 °</option>
        </select>
      </label>
      <p className="muted" data-ik-evaluated>
        帧 {frame}：最终影响 {final.influence.toFixed(4)}；最终极向角{' '}
        {((final.poleAngle * 180) / Math.PI).toFixed(3)}°。
      </p>
      <button
        onClick={() =>
          send(
            [{ type: 'ik.key.set', chainId: chain.id, property, key: { frame, value: [base] } }],
            '记录 IK 参数关键帧',
          )
        }
      >
        记录当前 IK 参数
      </button>
      {track && key && (
        <>
          <svg
            viewBox="0 0 300 116"
            role="img"
            aria-label="IK 参数曲线"
            style={{ width: '100%', background: '#15212b' }}
          >
            <path
              d={samples.map((s, i) => `${i ? 'L' : 'M'}${x(s[0])},${y(s[1])}`).join(' ')}
              fill="none"
              stroke="#65daca"
              strokeWidth="2"
            />
            {frame >= start && frame <= end && (
              <line x1={x(frame)} x2={x(frame)} y1="8" y2="108" stroke="#f1c46a" />
            )}
            {track.keys.map((k) => (
              <circle
                key={k.id}
                cx={x(k.frame)}
                cy={y(k.value[0] * factor)}
                r={key.id === k.id ? 5 : 3}
                fill="#f1c46a"
                onClick={() => setSelection(k.id)}
              />
            ))}
            <text x="12" y="114" fontSize="9" fill="#abbecb">
              {start} → {end} 帧 · {low.toFixed(2)}…{high.toFixed(2)}
            </text>
          </svg>
          <label className="field">
            关键帧
            <select
              aria-label="IK 关键帧"
              value={key.id}
              onChange={(e) => setSelection(e.target.value)}
            >
              {track.keys.map((k) => (
                <option key={k.id} value={k.id}>
                  {k.frame} 帧 · {(k.value[0] * factor).toFixed(3)}
                </option>
              ))}
            </select>
          </label>
          <NumberInput
            label="IK 键时间"
            value={key.frame}
            min={0}
            max={1e6}
            onChange={(frame) => edit({ frame })}
          />
          <NumberInput
            label={property === 'influence' ? 'IK 键影响' : 'IK 键极向角 °'}
            value={key.value[0] * factor}
            min={property === 'influence' ? 0 : undefined}
            max={property === 'influence' ? 1 : undefined}
            step={property === 'influence' ? 0.05 : 5}
            onChange={(v) => edit({ value: [v / factor] })}
          />
          <label className="field">
            插值
            <select
              aria-label="IK 键插值"
              value={key.interpolation}
              onChange={(e) => edit({ interpolation: e.target.value as typeof key.interpolation })}
            >
              <option value="constant">保持</option>
              <option value="linear">线性</option>
              <option value="smooth">平滑</option>
              <option value="bezier">Bézier</option>
              <option value="cubic">Hermite</option>
            </select>
          </label>
          {key.interpolation === 'cubic' &&
            (['inTangent', 'outTangent'] as const).map((side) => (
              <NumberInput
                key={side}
                label={side === 'inTangent' ? 'IK 入切线/帧' : 'IK 出切线/帧'}
                value={(key[side]?.[0] || 0) * factor}
                onChange={(v) => edit({ [side]: [v / factor] })}
              />
            ))}
          {key.interpolation === 'bezier' && h && (
            <>
              <label className="field">
                手柄
                <select
                  aria-label="IK 手柄模式"
                  value={h.mode}
                  onChange={(e) =>
                    send(
                      [
                        {
                          type: 'key.handles',
                          trackId: track.id,
                          keyId: key.id,
                          axis: 0,
                          mode: e.target.value as typeof h.mode,
                        },
                      ],
                      '编辑 IK 曲线手柄',
                    )
                  }
                >
                  <option value="auto-clamped">自动限幅</option>
                  <option value="vector">矢量</option>
                  <option value="aligned">对齐</option>
                  <option value="free">自由</option>
                </select>
              </label>
              {(['left', 'right'] as const).flatMap((side) =>
                ([0, 1] as const).map((axis) => (
                  <NumberInput
                    key={side + axis}
                    label={`IK ${side === 'left' ? '左' : '右'}手柄${axis ? '数值' : '时间'}`}
                    value={h[side][axis] * (axis ? factor : 1)}
                    onChange={(v) => {
                      const offset: [number, number] = [...h[side]];
                      offset[axis] = v / (axis ? factor : 1);
                      send(
                        [
                          {
                            type: 'key.handle',
                            trackId: track.id,
                            keyId: key.id,
                            axis: 0,
                            side,
                            offset,
                          },
                        ],
                        '编辑 IK 曲线手柄',
                      );
                    }}
                  />
                )),
              )}
            </>
          )}
          <button
            onClick={() =>
              send([{ type: 'key.delete', trackId: track.id, frame: key.frame }], '删除 IK 关键帧')
            }
          >
            删除 IK 关键帧
          </button>
        </>
      )}
      <p className="muted">
        上方参数是无动画时的基础值；记键后在此编辑键值。硬限角在影响大于零时生效，可能造成归零处跳变。曲线显示混合前的原始值。
      </p>
    </details>
  );
}
