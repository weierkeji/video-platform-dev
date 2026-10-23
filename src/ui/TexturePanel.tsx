import {
  textureBinding,
  textureSlots,
  type Geometry,
  type Project,
  type TextureBinding,
  type TextureSlot,
} from '../core/model';
import type { Command } from '../core/commands';
import { NumberInput } from './Inspector';

const names: Record<TextureSlot, string> = {
  baseColor: '基础色贴图',
  metallicRoughness: '金属粗糙度贴图',
  normal: '法线贴图',
  occlusion: '遮蔽贴图',
  emissive: '自发光贴图',
};
export function TexturePanel({
  project,
  material: m,
  geometry,
  send,
}: {
  project: Project;
  material: Project['materials'][number];
  geometry: Geometry;
  send: (commands: Command[], label: string) => void;
}) {
  const images = project.assets.filter((a) => a.kind === 'image');
  const set = (slot: TextureSlot, value?: TextureBinding) => {
    const textures = { ...m.textures };
    if (value) textures[slot] = value;
    else delete textures[slot];
    send([{ type: 'material.update', id: m.id, patch: { textures } }], `修改${names[slot]}`);
  };
  return (
    <section className="texture-panel">
      <h3>材质贴图</h3>
      <p className="muted">
        图片来自下方素材库。基础色/自发光按 sRGB 采样，其余按线性数值采样；各项与材质因子相乘。UV
        的原点在图片左上。
      </p>
      <div className="button-row">
        {([0, 1] as const).map((channel) => (
          <button
            key={channel}
            disabled={!geometry.triangles.length}
            title="盒式投影会覆盖该通道，并拆分 UV 接缝顶点；形状不变，可撤销"
            onClick={() =>
              send(
                [{ type: 'geometry.uvProject', id: geometry.id, channel }],
                `盒式投影 UV${channel}`,
              )
            }
          >
            生成/覆盖 UV{channel}
          </button>
        ))}
      </div>
      <p className="muted">
        {geometry.uv ? '有 UV0' : '无 UV0'} · {geometry.uv1 ? '有 UV1' : '无 UV1'}
        。盒式投影覆盖对应通道；尚无 UV 岛编辑。
      </p>
      {textureSlots.map((slot) => {
        const binding = m.textures?.[slot],
          asset = images.find((a) => a.id === binding?.assetId);
        const update = (patch: Partial<TextureBinding>) =>
          binding && set(slot, { ...binding, ...patch });
        return (
          <details key={slot} open={Boolean(binding)}>
            <summary>
              {names[slot]}
              {asset ? ` · ${asset.name}` : ''}
            </summary>
            <label className="field">
              图片
              <select
                aria-label={names[slot]}
                value={binding?.assetId || ''}
                onChange={(event) =>
                  set(
                    slot,
                    event.target.value
                      ? {
                          ...(binding || {
                            ...textureBinding(event.target.value),
                            texCoord: geometry.uv ? 0 : 1,
                          }),
                          assetId: event.target.value,
                        }
                      : undefined,
                  )
                }
              >
                <option value="">无贴图</option>
                {images.map((a) => (
                  <option key={a.id} value={a.id} disabled={!geometry.uv && !geometry.uv1}>
                    {a.name}
                  </option>
                ))}
              </select>
            </label>
            {binding && (
              <>
                {asset && (
                  <img
                    className="texture-preview"
                    src={`/api/blobs/${asset.blobId}`}
                    alt={asset.name}
                  />
                )}
                <label className="field">
                  坐标通道
                  <select
                    aria-label={`${names[slot]} UV`}
                    value={binding.texCoord}
                    onChange={(event) => update({ texCoord: Number(event.target.value) as 0 | 1 })}
                  >
                    <option value={0} disabled={!geometry.uv}>
                      UV0
                    </option>
                    <option value={1} disabled={!geometry.uv1}>
                      UV1
                    </option>
                  </select>
                </label>
                {(['wrapS', 'wrapT'] as const).map((field, i) => (
                  <label className="field" key={field}>
                    {i ? '垂直边界' : '水平边界'}
                    <select
                      aria-label={`${names[slot]} ${field}`}
                      value={binding[field]}
                      onChange={(event) => update({ [field]: event.target.value })}
                    >
                      <option value="repeat">重复</option>
                      <option value="clamp">边缘夹取</option>
                      <option value="mirror">镜像重复</option>
                    </select>
                  </label>
                ))}
                <label className="field">
                  放大过滤
                  <select
                    aria-label={`${names[slot]} magFilter`}
                    value={binding.magFilter}
                    onChange={(event) => update({ magFilter: event.target.value as 'linear' })}
                  >
                    <option value="nearest">最近邻</option>
                    <option value="linear">线性</option>
                  </select>
                </label>
                <label className="field">
                  缩小过滤
                  <select
                    aria-label={`${names[slot]} minFilter`}
                    value={binding.minFilter}
                    onChange={(event) => update({ minFilter: event.target.value as 'linear' })}
                  >
                    {[
                      'nearest',
                      'linear',
                      'nearest-mipmap-nearest',
                      'linear-mipmap-nearest',
                      'nearest-mipmap-linear',
                      'linear-mipmap-linear',
                    ].map((filter, i) => (
                      <option key={filter} value={filter}>
                        {
                          [
                            '最近邻',
                            '线性',
                            '最近层/最近采样',
                            '最近层/线性采样',
                            '层间线性/最近采样',
                            '三线性',
                          ][i]
                        }
                      </option>
                    ))}
                  </select>
                </label>
                {(['offset', 'scale'] as const).map((field) => (
                  <div key={field} className="button-row">
                    {([0, 1] as const).map((i) => (
                      <NumberInput
                        key={i}
                        label={`${names[slot]} ${field === 'offset' ? '偏移' : '缩放'} ${i ? 'V' : 'U'}`}
                        value={binding[field][i]}
                        onChange={(v) => {
                          const pair: [number, number] = [...binding[field]];
                          pair[i] = v;
                          update({ [field]: pair });
                        }}
                      />
                    ))}
                  </div>
                ))}
                <NumberInput
                  label={`${names[slot]} 旋转 °`}
                  value={(binding.rotation * 180) / Math.PI}
                  step={1}
                  onChange={(v) => update({ rotation: (v * Math.PI) / 180 })}
                />
                {slot === 'normal' && (
                  <NumberInput
                    label="法线强度"
                    value={m.normalScale ?? 1}
                    onChange={(v) =>
                      send(
                        [{ type: 'material.update', id: m.id, patch: { normalScale: v } }],
                        '修改法线强度',
                      )
                    }
                  />
                )}
                {slot === 'occlusion' && (
                  <NumberInput
                    label="遮蔽强度"
                    value={m.occlusionStrength ?? 1}
                    min={0}
                    max={1}
                    onChange={(v) =>
                      send(
                        [{ type: 'material.update', id: m.id, patch: { occlusionStrength: v } }],
                        '修改遮蔽强度',
                      )
                    }
                  />
                )}
                {slot === 'metallicRoughness' && (
                  <p className="muted">G 通道控制粗糙度，B 通道控制金属度。</p>
                )}
                {slot === 'occlusion' && <p className="muted">R 通道控制间接光遮蔽。</p>}
              </>
            )}
          </details>
        );
      })}
    </section>
  );
}
