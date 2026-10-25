import { useState } from 'react';
import { editedKeyTracks, type KeyRef, type KeyBatch } from '../core/key-editing';
import { id, type Project } from '../core/model';
import type { Command } from '../core/commands';
import { NumberInput } from './Inspector';

export function KeyBatchTools({
  project,
  keys,
  frame,
  busy,
  send,
  selectKeys,
}: {
  project: Project;
  keys: KeyRef[];
  frame: number;
  busy: boolean;
  send: (commands: Command[], label: string) => Promise<Project | undefined>;
  selectKeys: (keys: KeyRef[]) => void;
}) {
  const [offset, setOffset] = useState(1),
    [scale, setScale] = useState(1);
  const [pivotMode, setPivotMode] = useState('first'),
    [customPivot, setCustomPivot] = useState(0);
  const [error, setError] = useState('');
  const refs = new Map<string, Set<string>>();
  for (const key of keys) {
    const ids = refs.get(key.trackId) || new Set<string>();
    ids.add(key.keyId);
    refs.set(key.trackId, ids);
  }
  const frames = [...project.animationTracks, ...(project.ikTracks || [])]
    .filter((t) => refs.has(t.id))
    .flatMap((t) => t.keys.filter((k) => refs.get(t.id)!.has(k.id)).map((k) => k.frame));
  let low = Infinity,
    high = -Infinity;
  for (const f of frames) {
    low = Math.min(low, f);
    high = Math.max(high, f);
  }
  const pivot =
    pivotMode === 'first'
      ? frames.length
        ? low
        : 0
      : pivotMode === 'center'
        ? frames.length
          ? (low + high) / 2
          : 0
        : pivotMode === 'playhead'
          ? frame
          : customPivot;
  const apply = async (type: KeyBatch['type']) => {
    setError('');
    const command: KeyBatch =
      type === 'keys.delete'
        ? { type, keys }
        : type === 'keys.duplicate'
          ? { type, keys: keys.map((k) => ({ ...k, newId: id() })), pivot, scale, offset }
          : { type, keys, pivot, scale, offset };
    try {
      editedKeyTracks(project, command);
      const result = await send(
        [command],
        type === 'keys.delete'
          ? '删除所选关键帧'
          : type === 'keys.duplicate'
            ? '复制所选关键帧'
            : '批量调整关键帧时间',
      );
      if (result && command.type === 'keys.duplicate')
        selectKeys(command.keys.map((k) => ({ trackId: k.trackId, keyId: k.newId })));
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <div className="key-batch-tools">
      <fieldset className="curve-fields" disabled={busy || !keys.length}>
        <strong data-key-selection-count={keys.length}>
          已选 {keys.length} 键 · {new Set(keys.map((k) => k.trackId)).size} 轨
        </strong>
        <NumberInput
          label="批量时间偏移 帧"
          value={offset}
          onChange={setOffset}
          precision={8}
          min={-1e6}
          max={1e6}
        />
        <NumberInput
          label="批量时间倍率"
          value={scale}
          onChange={setScale}
          precision={8}
          min={1e-6}
          max={1e6}
        />
        <label className="field">
          时间枢轴
          <select
            aria-label="时间枢轴"
            value={pivotMode}
            onChange={(e) => setPivotMode(e.target.value)}
          >
            <option value="first">所选首帧</option>
            <option value="center">所选范围中心</option>
            <option value="playhead">播放头</option>
            <option value="custom">指定帧</option>
          </select>
        </label>
        {pivotMode === 'custom' && (
          <NumberInput
            label="指定时间枢轴 帧"
            value={customPivot}
            onChange={setCustomPivot}
            precision={8}
            min={0}
            max={1e6}
          />
        )}
        <button onClick={() => void apply('keys.transform')}>应用时间变换</button>
        <button onClick={() => void apply('keys.duplicate')}>复制所选键</button>
        <button className="danger" onClick={() => void apply('keys.delete')}>
          删除所选键
        </button>
      </fieldset>
      <p className="curve-hint">
        新时间 = 枢轴 +（原时间 − 枢轴）× 正倍率 + 偏移。复制也使用此变换。Bézier
        自动手柄固定为自由手柄，Hermite
        切线随倍率调整；与未选键之间的曲线会改变。冲突或越界时整组不提交。
      </p>
      {error && (
        <p className="curve-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
