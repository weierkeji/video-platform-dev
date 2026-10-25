import { useState } from 'react';
import type { Command } from '../core/commands';
import type { IKChain, Project } from '../core/model';

export function IKMatch({
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
  const [interpolation, setInterpolation] = useState<'constant' | 'linear'>('constant');
  const actionId = project.scenes.find((s) => s.id === chain.sceneId)?.activeActionId;
  const action = project.animationActions?.find((a) => a.id === actionId)?.name || '项目动画';
  const match = (mode: 'fk' | 'ik') =>
    send(
      [{ type: 'ik.match', chainId: chain.id, frame, mode, interpolation }],
      mode === 'fk' ? '匹配到 FK 并记键' : '匹配到 IK 并记键',
    );
  return (
    <details className="ik-match" open>
      <summary>FK / IK 姿态匹配</summary>
      <p className="muted">
        在场景帧 {frame} 保持当前可见关节姿态，把键写入“{action}”。FK 记录关节输入与零影响；IK
        同时放置目标/极向并记录全影响。
      </p>
      <label className="field">
        新键插值
        <select
          aria-label="匹配新键插值"
          value={interpolation}
          onChange={(e) => setInterpolation(e.target.value as typeof interpolation)}
        >
          <option value="constant">保持</option>
          <option value="linear">线性</option>
        </select>
      </label>
      <button disabled={!chain.enabled} onClick={() => match('fk')}>
        匹配到 FK 并记键
      </button>
      <button disabled={!chain.enabled} onClick={() => match('ik')}>
        匹配到 IK 并记键
      </button>
      <p className="muted">
        使用当前场景动作和完整动作层，不受视口“预览动作层”开关影响。IK
        匹配也记录关节输入，以保留扭转；极向角记为零。已有同帧键保留插值。
      </p>
      <p className="muted">
        只核对当前帧，新增键可能改变相邻区间；首次影响键也会影响首尾范围。限角、全权重覆盖层、约束或多段极向可能无法保持姿态，失败时整批不保存。基础姿态、绑定与权重不变。
      </p>
    </details>
  );
}
