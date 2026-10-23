import { useState } from 'react';
import { evaluatedTransform } from '../core/evaluate';
import { type Command } from '../core/commands';
import { type Clip, type Entity, type Project, type Vec3 } from '../core/model';
import { exportOBJ } from '../core/geometry';
import { displayColor } from '../core/surface';

export function download(name: string, body: Blob | string, type = 'application/json') {
  const url = URL.createObjectURL(body instanceof Blob ? body : new Blob([body], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export function NumberInput({
  label,
  value,
  onChange,
  step = 0.1,
  min,
  max,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
  step?: number;
  min?: number;
  max?: number;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      <input
        aria-label={label}
        type="number"
        step={step}
        min={min}
        max={max}
        key={String(value)}
        defaultValue={Number(value.toFixed(4))}
        onBlur={(e) => {
          if (e.target.value === String(Number(value.toFixed(4)))) return;
          const v = Number(e.target.value);
          if (Number.isFinite(v) && v !== value) onChange(v);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur();
        }}
      />
    </label>
  );
}
export function VectorInput({
  label,
  value,
  onChange,
}: {
  label: string;
  value: Vec3;
  onChange: (v: Vec3) => void;
}) {
  return (
    <div className="vector">
      <span>{label}</span>
      <div>
        {value.map((v, i) => (
          <NumberInput
            key={i}
            label={`${label} ${'XYZ'[i]}`}
            value={v}
            onChange={(n) => {
              const next = [...value] as Vec3;
              next[i] = n;
              onChange(next);
            }}
          />
        ))}
      </div>
    </div>
  );
}

export function Inspector({
  project: p,
  entity,
  clip,
  frame,
  send,
  transform,
}: {
  project: Project;
  entity?: Entity;
  clip?: Clip;
  frame: number;
  send: (c: Command[], label: string) => void;
  transform: (id: string, t: Entity['transform']) => void;
}) {
  const [vertex, setVertex] = useState(0),
    [face, setFace] = useState(0),
    [distance, setDistance] = useState(0.5);
  if (clip)
    return (
      <>
        <div className="panel-heading">
          片段属性 <small>{clip.kind}</small>
        </div>
        <div className="inspector-body" key={clip.id}>
          <label className="field">
            名称
            <input
              defaultValue={clip.name}
              onBlur={(e) => {
                if (e.target.value !== clip.name)
                  send(
                    [{ type: 'clip.update', id: clip.id, patch: { name: e.target.value } }],
                    '重命名片段',
                  );
              }}
            />
          </label>
          <NumberInput
            label="起始帧"
            value={clip.start}
            min={0}
            step={1}
            onChange={(v) =>
              send([{ type: 'clip.update', id: clip.id, patch: { start: v } }], '移动片段')
            }
          />
          <NumberInput
            label="时长（帧）"
            value={clip.duration}
            min={1}
            step={1}
            onChange={(v) =>
              send([{ type: 'clip.update', id: clip.id, patch: { duration: v } }], '裁剪片段')
            }
          />
          <NumberInput
            label="源入点"
            value={clip.sourceIn}
            min={0}
            step={1}
            onChange={(v) =>
              send([{ type: 'clip.update', id: clip.id, patch: { sourceIn: v } }], '调整素材入点')
            }
          />
          <NumberInput
            label="轨道"
            value={clip.channel}
            min={0}
            max={31}
            step={1}
            onChange={(v) =>
              send([{ type: 'clip.update', id: clip.id, patch: { channel: v } }], '更换轨道')
            }
          />
          {['audio', 'video'].includes(clip.kind) && (
            <NumberInput
              label="音量"
              value={clip.volume}
              min={0}
              max={2}
              onChange={(v) =>
                send([{ type: 'clip.update', id: clip.id, patch: { volume: v } }], '调整音量')
              }
            />
          )}
          {clip.kind !== 'audio' && (
            <label className="field">
              画幅适配
              <select
                aria-label="画幅适配"
                value={clip.fit}
                onChange={(event) =>
                  send(
                    [
                      {
                        type: 'clip.update',
                        id: clip.id,
                        patch: { fit: event.target.value as Clip['fit'] },
                      },
                    ],
                    '修改画幅适配',
                  )
                }
              >
                <option value="contain">完整显示（保留比例）</option>
                <option value="cover">填满画幅（居中裁切）</option>
                <option value="stretch">拉伸至画幅</option>
              </select>
            </label>
          )}
          {clip.kind === 'video' && (
            <p className="muted">
              原声随视频入点和切分同步。音量 0 仅关闭原声；禁用片段会同时关闭画面。
            </p>
          )}
          <label className="check">
            <input
              type="checkbox"
              checked={clip.muted}
              onChange={(e) =>
                send(
                  [{ type: 'clip.update', id: clip.id, patch: { muted: e.target.checked } }],
                  '切换片段静音',
                )
              }
            />
            禁用片段
          </label>
          <button
            onClick={() => send([{ type: 'clip.split', id: clip.id, frame }], '在播放头处切分')}
          >
            在帧 {frame} 切分
          </button>
          <button
            className="danger"
            onClick={() => send([{ type: 'clip.delete', id: clip.id }], '删除片段')}
          >
            删除片段
          </button>
        </div>
      </>
    );
  if (!entity)
    return (
      <>
        <div className="panel-heading">项目设置</div>
        <div className="inspector-body">
          <p className="muted">选择对象或片段以编辑属性。</p>
          <NumberInput
            label="帧率"
            value={p.timeline.fps}
            step={1}
            onChange={(v) => send([{ type: 'timeline.update', patch: { fps: v } }], '修改帧率')}
          />
          <NumberInput
            label="总帧数"
            value={p.timeline.duration}
            step={1}
            onChange={(v) =>
              send([{ type: 'timeline.update', patch: { duration: v } }], '修改项目时长')
            }
          />
          <NumberInput
            label="输出宽度"
            value={p.timeline.width}
            step={2}
            onChange={(v) =>
              send([{ type: 'timeline.update', patch: { width: v } }], '修改输出尺寸')
            }
          />
          <NumberInput
            label="输出高度"
            value={p.timeline.height}
            step={2}
            onChange={(v) =>
              send([{ type: 'timeline.update', patch: { height: v } }], '修改输出尺寸')
            }
          />
          <p className="muted">帧从 0 开始；片段结束帧不包含在内。改变帧率保留帧位置。</p>
        </div>
      </>
    );
  const e = entity,
    t = evaluatedTransform(p, e, frame),
    g = p.geometries.find((g) => g.id === e.geometryId),
    m = p.materials.find((m) => m.id === e.materialId);
  return (
    <>
      <div className="panel-heading">
        对象属性 <small>{e.kind}</small>
      </div>
      <div className="inspector-body" key={e.id}>
        <label className="field">
          名称
          <input
            key={e.name}
            defaultValue={e.name}
            onBlur={(event) => {
              if (event.target.value !== e.name)
                send(
                  [{ type: 'entity.update', id: e.id, patch: { name: event.target.value } }],
                  '重命名对象',
                );
            }}
          />
        </label>
        <label className="field">
          父对象
          <select
            value={e.parentId || ''}
            onChange={(event) =>
              send(
                [
                  {
                    type: 'entity.update',
                    id: e.id,
                    patch: { parentId: event.target.value || null },
                  },
                ],
                '调整对象层级',
              )
            }
          >
            <option value="">场景根节点</option>
            {p.entities
              .filter((x) => x.id !== e.id && x.sceneId === e.sceneId)
              .map((x) => (
                <option key={x.id} value={x.id}>
                  {x.name}
                </option>
              ))}
          </select>
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={e.visible}
            onChange={(event) =>
              send(
                [{ type: 'entity.update', id: e.id, patch: { visible: event.target.checked } }],
                '切换对象可见性',
              )
            }
          />
          显示对象
        </label>
        <h3>变换</h3>
        <VectorInput
          label="位置"
          value={t.position}
          onChange={(v) => transform(e.id, { ...t, position: v })}
        />
        <VectorInput
          label="旋转 °"
          value={t.rotation.map((v) => (v * 180) / Math.PI) as Vec3}
          onChange={(v) =>
            transform(e.id, { ...t, rotation: v.map((n) => (n * Math.PI) / 180) as Vec3 })
          }
        />
        <VectorInput
          label="缩放"
          value={t.scale}
          onChange={(v) => transform(e.id, { ...t, scale: v })}
        />
        <button
          onClick={() =>
            send(
              (['position', 'rotation', 'scale'] as const).map((property) => ({
                type: 'key.set',
                entityId: e.id,
                property,
                key: { frame, value: t[property] },
              })),
              `记录帧 ${frame} 的变换`,
            )
          }
        >
          ◇ 记录当前变换关键帧
        </button>
        {p.animationTracks.some((a) => a.entityId === e.id) && (
          <p className="muted">已有动画属性的修改会更新当前帧关键帧。</p>
        )}
        {p.animationTracks
          .filter((a) => a.entityId === e.id)
          .map((track) => {
            const key = track.keys.find((k) => k.frame === frame);
            return key ? (
              <label className="field" key={track.id}>
                {{ position: '位置', rotation: '旋转', scale: '缩放' }[track.property]} 插值
                <select
                  aria-label={`${track.property} 插值`}
                  value={key.interpolation}
                  onChange={(event) =>
                    send(
                      [
                        {
                          type: 'key.set',
                          entityId: e.id,
                          property: track.property,
                          key: { ...key, interpolation: event.target.value as 'linear' },
                        },
                      ],
                      '修改关键帧插值',
                    )
                  }
                >
                  <option value="linear">线性</option>
                  <option value="constant">保持</option>
                  <option value="smooth">平滑（smoothstep）</option>
                  <option value="bezier">Bézier 曲线</option>
                </select>
              </label>
            ) : null;
          })}
        {m && (
          <>
            <h3>表面材质</h3>
            <label className="field">
              基础色
              <input
                aria-label="基础色"
                type="color"
                value={m.linearColor ? displayColor(m.linearColor) : m.color}
                onChange={(event) =>
                  send(
                    [{ type: 'material.update', id: m.id, patch: { color: event.target.value } }],
                    '修改材质颜色',
                  )
                }
              />
            </label>
            <NumberInput
              label="粗糙度"
              value={m.roughness}
              step={0.05}
              min={0}
              max={1}
              onChange={(v) =>
                send([{ type: 'material.update', id: m.id, patch: { roughness: v } }], '修改材质')
              }
            />
            <label className="field">
              表面着色
              <select
                aria-label="表面着色"
                value={(m.flatShading ?? true) ? 'flat' : 'smooth'}
                onChange={(event) =>
                  send(
                    [
                      {
                        type: 'material.update',
                        id: m.id,
                        patch: { flatShading: event.target.value === 'flat' },
                      },
                    ],
                    '修改表面着色',
                  )
                }
              >
                <option value="flat">平面</option>
                <option value="smooth">顶点法线</option>
              </select>
            </label>
            <label className="check">
              <input
                type="checkbox"
                aria-label="双面材质"
                checked={m.doubleSided ?? true}
                onChange={(event) =>
                  send(
                    [
                      {
                        type: 'material.update',
                        id: m.id,
                        patch: { doubleSided: event.target.checked },
                      },
                    ],
                    '修改材质双面',
                  )
                }
              />
              双面材质
            </label>
            <label className="field">
              透明模式
              <select
                aria-label="透明模式"
                value={m.alphaMode || 'OPAQUE'}
                onChange={(event) =>
                  send(
                    [
                      {
                        type: 'material.update',
                        id: m.id,
                        patch: { alphaMode: event.target.value as 'OPAQUE' },
                      },
                    ],
                    '修改透明模式',
                  )
                }
              >
                <option value="OPAQUE">不透明</option>
                <option value="MASK">阈值裁切</option>
                <option value="BLEND">透明混合</option>
              </select>
            </label>
            <NumberInput
              label="不透明度"
              value={m.opacity ?? 1}
              min={0}
              max={1}
              step={0.05}
              onChange={(v) =>
                send([{ type: 'material.update', id: m.id, patch: { opacity: v } }], '修改不透明度')
              }
            />
            {m.alphaMode === 'MASK' && (
              <NumberInput
                label="裁切阈值"
                value={m.alphaCutoff ?? 0.5}
                min={0}
                max={1}
                step={0.05}
                onChange={(v) =>
                  send(
                    [{ type: 'material.update', id: m.id, patch: { alphaCutoff: v } }],
                    '修改裁切阈值',
                  )
                }
              />
            )}
            <VectorInput
              label="自发光（线性）"
              value={m.emissive || [0, 0, 0]}
              onChange={(v) =>
                send([{ type: 'material.update', id: m.id, patch: { emissive: v } }], '修改自发光')
              }
            />
            <p className="muted">
              透明混合采用实时排序；复杂交叠不保证顺序无关透明。自发光不会照亮其他对象。
            </p>
            <NumberInput
              label="金属度"
              value={m.metalness}
              step={0.05}
              min={0}
              max={1}
              onChange={(v) =>
                send([{ type: 'material.update', id: m.id, patch: { metalness: v } }], '修改材质')
              }
            />
          </>
        )}
        {e.camera && (
          <>
            <h3>摄影机</h3>
            {e.camera.aspect && (
              <p className="muted">
                导入摄影机固定投影宽高比：{e.camera.aspect.toFixed(4)}。输出画幅仍由项目设置决定。
              </p>
            )}
            <NumberInput
              label="垂直视角 °"
              value={e.camera.fov}
              step={1}
              onChange={(v) =>
                send(
                  [
                    {
                      type: 'entity.update',
                      id: e.id,
                      patch: { camera: { ...e.camera!, fov: v } },
                    },
                  ],
                  '修改镜头视角',
                )
              }
            />
          </>
        )}
        {e.light && (
          <>
            <h3>灯光</h3>
            {e.light.direction && (
              <p className="muted">光线沿对象局部 −Z 方向；旋转对象可改变照射方向。</p>
            )}
            <label className="field">
              类型
              <select
                value={e.light.kind}
                onChange={(event) =>
                  send(
                    [
                      {
                        type: 'entity.update',
                        id: e.id,
                        patch: { light: { ...e.light!, kind: event.target.value as 'point' } },
                      },
                    ],
                    '更换灯光类型',
                  )
                }
              >
                <option value="point">点光源</option>
                <option value="directional">平行光</option>
              </select>
            </label>
            <NumberInput
              label="光强"
              value={e.light.intensity}
              step={10}
              onChange={(v) =>
                send(
                  [
                    {
                      type: 'entity.update',
                      id: e.id,
                      patch: { light: { ...e.light!, intensity: v } },
                    },
                  ],
                  '修改光强',
                )
              }
            />
          </>
        )}
        {g && (
          <>
            <h3>
              网格编辑{' '}
              <small>
                {g.positions.length} 顶点 / {g.triangles.length} 面
              </small>
            </h3>
            {g.normals && (
              <p className="muted">
                已保留导入法线；修改顶点或拓扑会重新计算法线。撤销可恢复原法线。
              </p>
            )}
            {g.positions.length > 0 ? (
              <NumberInput
                label="顶点索引"
                value={vertex}
                min={0}
                max={g.positions.length - 1}
                step={1}
                onChange={setVertex}
              />
            ) : (
              <p className="muted">网格没有顶点。可撤销删除，或返回对象操作。</p>
            )}
            {g.positions[vertex] && (
              <VectorInput
                label="顶点位置"
                value={g.positions[vertex]}
                onChange={(v) =>
                  send(
                    [{ type: 'geometry.vertex', id: g.id, index: vertex, position: v }],
                    '移动网格顶点',
                  )
                }
              />
            )}
            {g.triangles.length > 0 && (
              <>
                <NumberInput
                  label="面索引"
                  value={face}
                  min={0}
                  max={g.triangles.length - 1}
                  step={1}
                  onChange={setFace}
                />
                <NumberInput label="挤出距离" value={distance} onChange={setDistance} />
                <div className="button-row">
                  <button
                    onClick={() =>
                      send([{ type: 'geometry.extrude', id: g.id, face, distance }], '挤出三角面')
                    }
                  >
                    挤出面
                  </button>
                  <button
                    onClick={() => send([{ type: 'geometry.subdivide', id: g.id }], '细分网格')}
                  >
                    线性细分
                  </button>
                </div>
              </>
            )}
            <button onClick={() => download(`${e.name}.obj`, exportOBJ(g), 'text/plain')}>
              导出局部网格 OBJ
            </button>
          </>
        )}
        <div className="button-row">
          <button onClick={() => send([{ type: 'entity.duplicate', id: e.id }], '复制对象')}>
            复制
          </button>
          <button
            className="danger"
            onClick={() => send([{ type: 'entity.delete', id: e.id }], '删除对象及子对象')}
          >
            删除
          </button>
        </div>
      </div>
    </>
  );
}
