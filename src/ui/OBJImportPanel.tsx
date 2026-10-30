import { useEffect, useState } from 'react';
import type { OBJImport } from '../core/obj';
import type { Command } from '../core/commands';
import type { Project } from '../core/model';

export function OBJImportPanel({
  file,
  sceneId,
  busy,
  saveError,
  send,
  onClose,
  onImported,
}: {
  file: File;
  sceneId: string;
  busy: boolean;
  saveError: string;
  send: (commands: Command[], label: string) => Promise<Project | undefined>;
  onClose: () => void;
  onImported: (entityId: string) => void;
}) {
  const [result, setResult] = useState<OBJImport>(),
    [error, setError] = useState('');
  useEffect(() => {
    const worker = new Worker(new URL('./obj-import.worker.ts', import.meta.url), {
      type: 'module',
    });
    let active = true;
    worker.onmessage = (event: MessageEvent<{ result?: OBJImport; error?: string }>) => {
      if (!active) return;
      setResult(event.data.result);
      setError(event.data.error || '');
      worker.terminate();
    };
    worker.onerror = () => {
      if (active) setError('OBJ 解析失败，请重新选择文件');
      worker.terminate();
    };
    worker.postMessage(file);
    return () => {
      active = false;
      worker.terminate();
    };
  }, [file]);
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', keydown);
    return () => window.removeEventListener('keydown', keydown);
  }, [busy, onClose]);
  return (
    <div className="modal-backdrop">
      <section
        className="modal exchange-modal"
        role="dialog"
        aria-modal="true"
        aria-label="导入 OBJ 网格"
      >
        <div className="panel-heading">
          <h2>导入 OBJ 网格</h2>
          <button disabled={busy} onClick={onClose}>
            取消
          </button>
        </div>
        <p>{file.name}</p>
        <p>按米制、Y 轴向上导入到当前场景。多边形转为可编辑三角面，保留 UV 和法线。</p>
        {!result && !error && <p role="status">正在解析网格…</p>}
        {result && (
          <>
            <p role="status">
              {result.sourceVertices} 个源顶点 · {result.polygons} 个原始面 →{' '}
              {result.geometry.positions.length} 个顶点 / {result.geometry.triangles.length}{' '}
              个三角面；接缝新增 {result.splitVertices} 个顶点。
            </p>
            {!!result.warnings.length && (
              <ul>
                {result.warnings.map((warning) => (
                  <li key={warning}>{warning}</li>
                ))}
              </ul>
            )}
          </>
        )}
        {(error || saveError) && <p role="alert">{error || saveError}</p>}
        <button
          className="primary"
          disabled={busy || !result || !!error}
          onClick={async () => {
            if (!result) return;
            const geometry = { ...result.geometry, name: file.name.slice(0, 160) };
            const project = await send(
              [{ type: 'geometry.import', sceneId, geometry }],
              '导入 OBJ 网格',
            );
            const entity = project?.entities.find((e) => e.geometryId === geometry.id);
            if (entity) onImported(entity.id);
          }}
        >
          导入到当前场景
        </button>
      </section>
    </div>
  );
}
