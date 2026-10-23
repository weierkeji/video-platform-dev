import { useState } from 'react';
import { Euler, Matrix4, Quaternion, Vector3 } from 'three';
import type { Command } from '../core/commands';
import {
  meshEdges,
  selectedVertices,
  vertexCenter,
  type MeshMode,
  type MeshSelection,
} from '../core/mesh';
import type { Geometry, Project, Vec3 } from '../core/model';
import { exportOBJ } from '../core/geometry';
import { download, VectorInput } from './Inspector';

export function MeshPanel({
  project,
  geometry: g,
  selection,
  onMode,
  onSelect,
  send,
}: {
  project: Project;
  geometry: Geometry;
  selection: MeshSelection;
  onMode: (mode: MeshMode | 'object') => void;
  onSelect: (indices: number[]) => void;
  send: (commands: Command[], label: string, keepFaces?: boolean) => void;
}) {
  const [rotation, setRotation] = useState<Vec3>([0, 0, 0]),
    [scale, setScale] = useState<Vec3>([1, 1, 1]),
    [offset, setOffset] = useState<Vec3>([0, 0.5, 0]);
  const edges = meshEdges(g),
    vertices = selectedVertices(g, selection.mode, selection.indices, edges),
    center = vertexCenter(g, vertices);
  const count =
    selection.mode === 'vertex'
      ? g.positions.length
      : selection.mode === 'edge'
        ? edges.length
        : g.triangles.length;
  const apply = (matrix: Matrix4, label: string) =>
    send(
      [{ type: 'geometry.transform', id: g.id, indices: vertices, matrix: matrix.toArray() }],
      label,
    );
  return (
    <>
      <div className="panel-heading">
        网格组件 <button onClick={() => onMode('object')}>完成编辑</button>
      </div>
      <div className="inspector-body mesh-panel">
        {g.normals && <p className="muted">修改网格会重算导入法线；撤销可恢复。</p>}
        {g.uv && (
          <p className="muted">
            UV0 随顶点保留。挤出复制 UV，合并保留目标点 UV；新侧面尚未自动展开。
          </p>
        )}
        <div className="segmented">
          {(['vertex', 'edge', 'face'] as const).map((mode, i) => (
            <button
              key={mode}
              className={selection.mode === mode ? 'active' : ''}
              onClick={() => onMode(mode)}
              aria-label={`选择${['顶点', '边', '面'][i]}模式`}
            >
              {['点', '边', '面'][i]} · {i + 1}
            </button>
          ))}
        </div>
        <p className="mesh-selection-status" role="status">
          已选 {selection.indices.length} / {count}{' '}
          {selection.mode === 'vertex' ? '点' : selection.mode === 'edge' ? '边' : '面'} ·{' '}
          {vertices.length} 顶点
        </p>
        <div className="button-row">
          <button onClick={() => onSelect(Array.from({ length: count }, (_, i) => i))}>全选</button>
          <button onClick={() => onSelect([])}>清空选择</button>
          <button
            onClick={() => {
              const selected = new Set(selection.indices);
              onSelect(Array.from({ length: count }, (_, i) => i).filter((i) => !selected.has(i)));
            }}
          >
            反选
          </button>
        </div>
        <p className="muted">
          单击选择，Shift 单击切换；框选默认替换，Shift 添加，Ctrl
          移除。手柄使用世界轴；下方数值使用网格局部坐标。
        </p>
        {project.entities.filter((e) => e.geometryId === g.id).length > 1 && (
          <p className="muted">此网格被多个对象引用，几何编辑将同步影响这些对象。</p>
        )}
        <fieldset disabled={!vertices.length}>
          <h3>选中顶点的平均位置</h3>
          <VectorInput
            label="选中中心"
            value={center}
            onChange={(value) =>
              apply(
                new Matrix4().makeTranslation(...(value.map((v, i) => v - center[i]) as Vec3)),
                '移动网格组件',
              )
            }
          />
          <h3>围绕选中中心变换</h3>
          <VectorInput label="组件旋转 °" value={rotation} onChange={setRotation} />
          <VectorInput label="组件缩放" value={scale} onChange={setScale} />
          <button
            onClick={() => {
              const matrix = new Matrix4()
                .compose(
                  new Vector3(...center),
                  new Quaternion().setFromEuler(
                    new Euler(...(rotation.map((v) => (v * Math.PI) / 180) as Vec3), 'XYZ'),
                  ),
                  new Vector3(...scale),
                )
                .multiply(new Matrix4().makeTranslation(...(center.map((v) => -v) as Vec3)));
              apply(matrix, '旋转缩放网格组件');
            }}
          >
            应用旋转缩放
          </button>
          <p className="muted">
            以上数值每次点击都会再次应用。移动/旋转/缩放也可通过视口 G/R/S 手柄完成；Esc 取消拖动。
          </p>
          <h3>拓扑操作</h3>
          {selection.mode === 'face' && (
            <>
              <VectorInput label="区域挤出位移" value={offset} onChange={setOffset} />
              <button
                onClick={() =>
                  send(
                    [
                      {
                        type: 'geometry.extrudeRegion',
                        id: g.id,
                        faces: selection.indices,
                        offset,
                      },
                    ],
                    '挤出选中区域',
                    true,
                  )
                }
              >
                挤出选中区域
              </button>
            </>
          )}
          <button
            disabled={vertices.length < 2}
            onClick={() =>
              send([{ type: 'geometry.merge', id: g.id, indices: vertices }], '合并选中顶点')
            }
          >
            合并到选中中心
          </button>
          <button
            className="danger"
            onClick={() =>
              send(
                [
                  {
                    type: 'geometry.delete',
                    id: g.id,
                    mode: selection.mode,
                    indices: selection.indices,
                  },
                ],
                '删除网格组件',
              )
            }
          >
            {selection.mode === 'vertex'
              ? '删除点及关联面'
              : selection.mode === 'edge'
                ? '删除边及相邻面'
                : '仅删除选中面'}
          </button>
        </fieldset>
        <p className="muted">
          面为三角面；边由面推导。删面保留顶点，删空组件仍保留对象；拓扑变化后选择会清空，区域挤出保留顶面选择。
        </p>
        <button onClick={() => send([{ type: 'geometry.subdivide', id: g.id }], '线性细分网格')}>
          线性细分整个网格
        </button>
        <button onClick={() => download(`${g.name}.obj`, exportOBJ(g), 'text/plain')}>
          导出局部网格 OBJ
        </button>
      </div>
    </>
  );
}
