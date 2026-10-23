import { useRef, useState } from 'react';
import { applyCommands, type Command } from '../core/commands';
import { exportGLBWithAssets, importGLTF, type GLTFImport } from '../core/gltf';
import type { Project } from '../core/model';
import { download } from './Inspector';
import { BakePanel } from './BakePanel';

export function SceneExchange({
  project,
  sceneId,
  frame,
  busy,
  saveError,
  send,
  onImported,
  onClose,
}: {
  project: Project;
  sceneId: string;
  frame: number;
  busy: boolean;
  saveError: string;
  send: (commands: Command[], label: string) => Promise<Project | undefined>;
  onImported: (sceneId: string) => void;
  onClose: () => void;
}) {
  const [result, setResult] = useState<GLTFImport | null>(null),
    [error, setError] = useState(''),
    [reading, setReading] = useState(false),
    [exportNotes, setExportNotes] = useState<string[]>([]);
  const input = useRef<HTMLInputElement>(null);
  const folder = useRef<HTMLInputElement>(null);
  const prepare = async (files: File[]) => {
    if (!files.length) return;
    setReading(true);
    setResult(null);
    setError('');
    try {
      if (files.reduce((n, f) => n + f.size, 0) > 50 * 1024 * 1024)
        throw new Error('所选文件合计超过 50 MB');
      const mains = files.filter((f) => /\.(glb|gltf)$/i.test(f.name));
      if (mains.length !== 1)
        throw new Error('每次选择一个 glTF/GLB 及其资源，或只含一个 glTF/GLB 的文件夹');
      const mainPath = mains[0].webkitRelativePath || mains[0].name,
        prefix = mainPath.slice(0, mainPath.lastIndexOf('/') + 1);
      const data = await Promise.all(
        files
          .filter((f) => !prefix || f.webkitRelativePath.startsWith(prefix))
          .map(async (f) => ({
            name: (f.webkitRelativePath || f.name).slice(prefix.length),
            bytes: new Uint8Array(await f.arrayBuffer()),
          })),
      );
      const next = await importGLTF(
        data.find((f) => f.name === mains[0].name)!.bytes,
        data,
        project.timeline.fps,
      );
      for (const entry of next.images) {
        const bitmap = await createImageBitmap(
          new Blob([Uint8Array.from(entry.bytes)], { type: entry.asset.mime }),
          { imageOrientation: 'none', premultiplyAlpha: 'none', colorSpaceConversion: 'none' },
        );
        bitmap.close();
      }
      applyCommands(project, [next.command]);
      setResult(next);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setReading(false);
    }
  };
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
          导入 GLB 或 glTF 2.0 场景与变换动画，保留层级、三角网格、法线/切线、UV0/UV1、PBR
          贴图与采样设置、 材质、有限远透视摄影机与点光源/平行光。
        </p>
        <p className="muted">
          支持 PNG/JPEG/WebP 图片、五类基础贴图和 UV
          变换。动画保留非整帧时间、四元数、STEP/LINEAR/CUBICSPLINE；支持关节、逆绑定矩阵及每顶点最多
          32 个线性混合影响。顶点色、形态键、聚光灯等仍未接入。
          选择文件时需包含同目录资源；资源在子目录时请选择整个文件夹。合计上限 50 MB。
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
            void prepare(files);
          }}
        />
        <input
          type="file"
          multiple
          hidden
          aria-label="选择 glTF 文件夹"
          ref={(el) => {
            folder.current = el;
            el?.setAttribute('webkitdirectory', '');
          }}
          onChange={(event) => {
            const files = Array.from(event.target.files || []);
            event.target.value = '';
            void prepare(files);
          }}
        />
        <button disabled={reading || busy} onClick={() => input.current?.click()}>
          {reading ? '正在读取…' : '选择 glTF / GLB 文件'}
        </button>
        <button disabled={reading || busy} onClick={() => folder.current?.click()}>
          选择资源文件夹
        </button>
        {(error || saveError) && (
          <p role="alert" className="error-banner">
            {error || saveError}
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
            <p>{result.images.length} 张图片将加入同一素材库；材质引用这些图片。</p>
            <p>
              {result.command.animationActions?.length || 0} 个动作 ·{' '}
              {result.command.animationTracks?.length || 0}{' '}
              条动画轨道，可在场景的动画动作菜单中选择。
            </p>
            <p>
              {result.command.entities.filter((e) => e.skin).length}{' '}
              个蒙皮网格，导入后可继续编辑关节和顶点权重。
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
                  setReading(true);
                  setError('');
                  try {
                    const uploaded = new Set<string>();
                    for (const entry of result.images) {
                      if (uploaded.has(entry.asset.blobId)) continue;
                      const response = await fetch('/api/blobs', {
                        method: 'POST',
                        headers: {
                          'Content-Type': entry.asset.mime,
                          'X-Studio-Client': 'frameforge',
                          'X-File-Name': encodeURIComponent(entry.asset.name),
                        },
                        body: new Blob([Uint8Array.from(entry.bytes)], { type: entry.asset.mime }),
                      });
                      const savedAsset = await response.json();
                      if (!response.ok) throw new Error(savedAsset.error || '纹理上传失败');
                      if (
                        savedAsset.blobId !== entry.asset.blobId ||
                        savedAsset.bytes !== entry.asset.bytes ||
                        savedAsset.mime !== entry.asset.mime
                      )
                        throw new Error('上传纹理与导入内容不匹配');
                      uploaded.add(entry.asset.blobId);
                    }
                    const saved = await send([result.command], '导入 glTF 场景');
                    if (saved) {
                      onImported(result.defaultSceneId);
                      onClose();
                    }
                  } catch (e) {
                    setError(e instanceof Error ? e.message : String(e));
                  } finally {
                    setReading(false);
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
          当前帧 GLB 保存可见对象的静态姿态和材质；动画 GLB 另外保存变换动作。
          当前帧包含动作层结果；原始动画 GLB 需禁用层，混合动画可在下方指定范围烘焙。
          时间轴、背景、环境光、阴影和工作流不包含在内；完整作品请使用项目包。
        </p>
        {[false, true].map((animated) => (
          <button
            key={String(animated)}
            disabled={busy || reading}
            onClick={async () => {
              setReading(true);
              try {
                const out = await exportGLBWithAssets(
                  project,
                  sceneId,
                  frame,
                  async (asset) => {
                    const response = await fetch(`/api/blobs/${asset.blobId}`, {
                      signal: AbortSignal.timeout(15000),
                    });
                    if (!response.ok) throw new Error(`无法读取纹理：${asset.name}`);
                    return new Uint8Array(await response.arrayBuffer());
                  },
                  animated,
                );
                setError('');
                setExportNotes(out.notes);
                download(
                  `${out.sceneName}-${animated ? 'animations' : `frame-${frame}`}.glb`,
                  new Blob([out.bytes], { type: 'model/gltf-binary' }),
                );
              } catch (e) {
                setError(e instanceof Error ? e.message : String(e));
              } finally {
                setReading(false);
              }
            }}
          >
            {animated ? '导出动画 GLB' : '导出当前帧 GLB'}
          </button>
        ))}
        <p className="muted">
          动画 GLB 保存本场景全部动作。兼容曲线保留插值；欧拉角、混合保持段和非线性时间 Bézier
          按项目帧率及原键时间采样，帧间可能有差异。完整曲线和镜头时间轴请保存项目包。
        </p>
        {exportNotes.length > 0 && (
          <ul role="status">
            {exportNotes.map((note) => (
              <li key={note}>{note}</li>
            ))}
          </ul>
        )}
        <BakePanel
          project={project}
          sceneId={sceneId}
          frame={frame}
          disabled={busy || reading}
          setReading={setReading}
          onError={setError}
          send={send}
        />
        <div className="button-row">
          <button disabled={busy || reading} onClick={onClose}>
            关闭
          </button>
        </div>
      </section>
    </div>
  );
}
