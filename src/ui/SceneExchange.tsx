import { useRef, useState } from 'react';
import { applyCommands, type Command } from '../core/commands';
import { exportGLB, importGLTF, type GLTFImport } from '../core/gltf';
import type { Project } from '../core/model';
import { download } from './Inspector';

export function SceneExchange({
  project,
  sceneId,
  frame,
  busy,
  send,
  onImported,
  onClose,
}: {
  project: Project;
  sceneId: string;
  frame: number;
  busy: boolean;
  send: (commands: Command[], label: string) => Promise<Project | undefined>;
  onImported: (sceneId: string) => void;
  onClose: () => void;
}) {
  const [result, setResult] = useState<GLTFImport | null>(null),
    [error, setError] = useState(''),
    [reading, setReading] = useState(false),
    [exportNotes, setExportNotes] = useState<string[]>([]);
  const input = useRef<HTMLInputElement>(null);
  return (
    <div className="modal-backdrop">
      <section
        className="modal exchange-modal"
        role="dialog"
        aria-label="glTF 场景交换"
        aria-modal="true"
      >
        <h2>glTF 场景交换</h2>
        <p>
          导入 GLB 或 glTF 2.0 静态场景，保留层级、三角网格、法线、UV0、基础 PBR
          材质、有限远透视摄影机与点光源/平行光。
        </p>
        <p className="muted">
          动画、纹理、顶点色、骨骼、形态键、聚光灯及其他扩展尚未接入，遇到这些内容会说明原因。外部
          .bin 须与 .gltf 同目录并一起选择；导入合计上限 50 MB。
        </p>
        <input
          ref={input}
          type="file"
          multiple
          hidden
          aria-label="选择 glTF 文件"
          onChange={(event) => {
            const files = Array.from(event.target.files || []);
            event.target.value = '';
            if (!files.length) return;
            setReading(true);
            setResult(null);
            setError('');
            void (async () => {
              try {
                if (files.reduce((n, f) => n + f.size, 0) > 50 * 1024 * 1024)
                  throw new Error('所选文件合计超过 50 MB');
                const mains = files.filter((f) => /\.(glb|gltf)$/i.test(f.name));
                if (mains.length !== 1)
                  throw new Error('每次请选择一个 .gltf 或 .glb，以及它引用的 .bin 文件');
                const data = await Promise.all(
                  files.map(async (f) => ({
                    name: f.name,
                    bytes: new Uint8Array(await f.arrayBuffer()),
                  })),
                );
                const next = importGLTF(data.find((f) => f.name === mains[0].name)!.bytes, data);
                applyCommands(project, [next.command]);
                setResult(next);
              } catch (e) {
                setError(e instanceof Error ? e.message : String(e));
              } finally {
                setReading(false);
              }
            })();
          }}
        />
        <button disabled={reading || busy} onClick={() => input.current?.click()}>
          {reading ? '正在读取…' : '选择 glTF / GLB 文件'}
        </button>
        {error && (
          <p role="alert" className="error-banner">
            {error}
          </p>
        )}
        {result && (
          <div className="exchange-review">
            <h3>
              将新增 {result.command.scenes.length} 个场景 · {result.command.entities.length} 个对象
            </h3>
            <p>
              {result.command.geometries.length} 个几何体 · {result.command.materials.length}{' '}
              个材质。现有场景保留；导入作为一次可撤销操作保存。
            </p>
            <ul>
              {result.notes.map((note) => (
                <li key={note}>{note}</li>
              ))}
            </ul>
            <button
              className="primary"
              disabled={busy || reading}
              onClick={() => {
                void (async () => {
                  const saved = await send([result.command], '导入 glTF 场景');
                  if (saved) {
                    onImported(result.defaultSceneId);
                    onClose();
                  }
                })();
              }}
            >
              导入这些场景
            </button>
          </div>
        )}
        <h3>导出当前场景 · 帧 {frame}</h3>
        <p className="muted">
          GLB
          保存当前帧的可见对象和材质。动画曲线、时间轴、背景、环境光、阴影和工作流不包含在内；完整作品请使用项目包。
        </p>
        <button
          disabled={busy || reading}
          onClick={() => {
            try {
              const out = exportGLB(project, sceneId, frame);
              setError('');
              setExportNotes(out.notes);
              download(
                `${out.sceneName}-frame-${frame}.glb`,
                new Blob([out.bytes], { type: 'model/gltf-binary' }),
              );
            } catch (e) {
              setError(e instanceof Error ? e.message : String(e));
            }
          }}
        >
          导出当前帧 GLB
        </button>
        {exportNotes.length > 0 && (
          <ul role="status">
            {exportNotes.map((note) => (
              <li key={note}>{note}</li>
            ))}
          </ul>
        )}
        <div className="button-row">
          <button disabled={busy} onClick={onClose}>
            关闭
          </button>
        </div>
      </section>
    </div>
  );
}
