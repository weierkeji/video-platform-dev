import { useEffect, useRef, useState } from 'react';
import { Euler, Quaternion } from 'three';
import { id, type Entity, type Project, type RetargetProfile, type Vec3 } from '../core/model';
import type { Command } from '../core/commands';
import type { SamplingOptions as BakeOptions } from '../core/bake';
import { rigNodes } from '../core/rest-pose';
import { retargetSubtree } from '../core/retarget-profile';
import { quaternionFromEuler } from '../core/animation';
import { NumberInput } from './Inspector';

const fresh = (): RetargetProfile => ({
  id: id(),
  name: '骨架动作映射',
  sourceRootId: '',
  targetRootId: '',
  mappings: [],
  rootMotion: 'scaled',
  motionScale: 1,
  alignment: [0, 0, 0, 1],
});

export function RetargetPanel({
  project,
  busy,
  saveError,
  send,
  onClose,
  onActivated,
}: {
  project: Project;
  busy: boolean;
  saveError: string;
  send: (commands: Command[], label: string) => Promise<Project | undefined>;
  onClose: () => void;
  onActivated: (sceneId: string) => void;
}) {
  const [profile, setProfile] = useState<RetargetProfile>(() =>
    structuredClone(project.retargetProfiles?.[0] || fresh()),
  );
  const source = project.entities.find((e) => e.id === profile.sourceRootId),
    target = project.entities.find((e) => e.id === profile.targetRootId);
  const [options, setOptions] = useState<BakeOptions>({
    start: 0,
    end: project.timeline.duration,
    step: 1,
    interpolation: 'linear',
    rebase: false,
    actionId: project.scenes.find((s) => s.id === source?.sceneId)?.activeActionId || null,
  });
  const [name, setName] = useState('重定向动作'),
    [activate, setActivate] = useState(true),
    [working, setWorking] = useState(false),
    [error, setError] = useState(''),
    [notes, setNotes] = useState<{ revision: number; items: string[] }>({
      revision: project.revision,
      items: [],
    });
  const cancel = useRef<(() => void) | null>(null);
  useEffect(() => () => cancel.current?.(), []);
  useEffect(() => setNotes({ revision: project.revision, items: [] }), [profile, options]);
  const eligible = new Set(project.scenes.flatMap((s) => [...rigNodes(project, s.id)]));
  const nodes = project.entities.filter((e) => eligible.has(e.id)),
    sourceNodes = source
      ? retargetSubtree(project, source.id).filter((e) => eligible.has(e.id))
      : [],
    targetNodes = target
      ? retargetSubtree(project, target.id).filter((e) => eligible.has(e.id))
      : [];
  const saved = project.retargetProfiles?.find((p) => p.id === profile.id),
    dirty = JSON.stringify(saved) !== JSON.stringify(profile);
  function nodeLabel(node: Entity, choices: Entity[]) {
    if (choices.filter((e) => e.name === node.name).length < 2) return node.name;
    const path = [node.name];
    let parent = project.entities.find((e) => e.id === node.parentId);
    while (parent) {
      path.unshift(parent.name);
      parent = project.entities.find((e) => e.id === parent!.parentId);
    }
    return `${path.join(' / ')} [${node.id.slice(0, 8)}]`;
  }
  const update = (patch: Partial<RetargetProfile>) => setProfile((p) => ({ ...p, ...patch }));
  const updateOptions = (patch: Partial<BakeOptions>) => setOptions((o) => ({ ...o, ...patch }));
  function choose(next: RetargetProfile) {
    setProfile(structuredClone(next));
    const scene = project.entities.find((e) => e.id === next.sourceRootId)?.sceneId;
    updateOptions({ actionId: project.scenes.find((s) => s.id === scene)?.activeActionId || null });
    setError('');
  }
  function root(key: 'sourceRootId' | 'targetRootId', value: string) {
    const next = { ...profile, [key]: value, mappings: [] as RetargetProfile['mappings'] };
    if (next.sourceRootId && next.targetRootId)
      next.mappings = [{ sourceId: next.sourceRootId, targetId: next.targetRootId }];
    choose(next);
  }
  async function analyze(): Promise<string[]> {
    return new Promise((resolve, reject) => {
      const worker = new Worker(new URL('./retarget.worker.ts', import.meta.url), {
        type: 'module',
      });
      const finish = () => {
        worker.terminate();
        clearTimeout(timeout);
        cancel.current = null;
      };
      const timeout = setTimeout(() => {
        finish();
        reject(new Error('计算超过 60 秒；请缩短范围或增大步长'));
      }, 60000);
      cancel.current = () => {
        finish();
        reject(new Error('已取消重定向计算'));
      };
      worker.onmessage = (event: MessageEvent<{ notes?: string[]; error?: string }>) => {
        finish();
        if (event.data.notes) resolve(event.data.notes);
        else reject(new Error(event.data.error || '重定向计算失败'));
      };
      worker.onerror = (event) => {
        finish();
        reject(new Error(event.message));
      };
      worker.postMessage({ project, profile, options });
    });
  }
  async function run(mode: 'analyze' | 'bake') {
    setWorking(true);
    setError('');
    try {
      const result = await analyze();
      if (mode === 'bake') {
        const action = { id: id(), name, sceneId: target!.sceneId };
        const next = await send(
          [
            { type: 'retarget.put', profile },
            { type: 'retarget.bake', profileId: profile.id, action, options, activate },
          ],
          '保存映射并生成重定向动作',
        );
        if (!next) return;
        if (activate) onActivated(action.sceneId);
        setNotes({
          revision: next.revision,
          items: [...result, `已保存“${name}”。原动作、映射与绑定保留；可撤销整个操作。`],
        });
      } else setNotes({ revision: project.revision, items: result });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setWorking(false);
    }
  }
  const angles = new Euler().setFromQuaternion(
    new Quaternion().fromArray(profile.alignment),
    'XYZ',
  );
  return (
    <div className="modal-backdrop">
      <section
        className="modal exchange-modal retarget-panel"
        role="dialog"
        aria-modal="true"
        aria-label="骨架动作重定向"
      >
        <div className="panel-heading">
          <h2>骨架动作重定向</h2>
          <button disabled={busy} onClick={onClose}>
            关闭
          </button>
        </div>
        <p className="muted">
          按各自基础姿态转换旋转，保留目标骨长与局部缩放。映射可跨场景、名称和层级；不会自动修正脚底接触或分配扭转。
        </p>
        <fieldset disabled={busy || working}>
          <label className="field">
            已存映射
            <select
              aria-label="已存重定向映射"
              value={saved ? profile.id : ''}
              onChange={(e) =>
                choose(project.retargetProfiles?.find((p) => p.id === e.target.value) || fresh())
              }
            >
              <option value="">新映射</option>
              {project.retargetProfiles?.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            映射名称
            <input
              aria-label="重定向映射名称"
              maxLength={160}
              value={profile.name}
              onChange={(e) => update({ name: e.target.value })}
            />
          </label>
          <div className="bake-range">
            {(['sourceRootId', 'targetRootId'] as const).map((key, i) => (
              <label className="field" key={key}>
                {i ? '目标根' : '源根'}
                <select
                  aria-label={i ? '重定向目标根' : '重定向源根'}
                  value={profile[key]}
                  onChange={(e) => root(key, e.target.value)}
                >
                  <option value="">选择骨架根节点</option>
                  {nodes.map((e) => (
                    <option key={e.id} value={e.id}>
                      {project.scenes.find((s) => s.id === e.sceneId)?.name} / {nodeLabel(e, nodes)}
                    </option>
                  ))}
                </select>
              </label>
            ))}
          </div>
          <p className="muted">
            改变根节点会清空对应关系。根到根固定映射；其余节点可保留基础局部姿态。参考使用已保存的基础姿态（含已停用偏移）；无记录时使用对象变换。
          </p>
          <button
            disabled={!source || !target}
            onClick={() => {
              const mappings = [{ sourceId: source!.id, targetId: target!.id }];
              for (const node of targetNodes.filter((e) => e.id !== target!.id)) {
                const matches = sourceNodes.filter((s) => s.name === node.name);
                if (matches.length === 1)
                  mappings.push({ sourceId: matches[0].id, targetId: node.id });
              }
              update({ mappings });
            }}
          >
            按唯一同名填写（替换对应关系）
          </button>
          <div className="retarget-mapping">
            {targetNodes.map((node) => (
              <label className="field" key={node.id}>
                {nodeLabel(node, targetNodes)}
                <select
                  aria-label={`重定向对应 ${nodeLabel(node, targetNodes)}`}
                  disabled={node.id === profile.targetRootId}
                  value={profile.mappings.find((m) => m.targetId === node.id)?.sourceId || ''}
                  onChange={(e) =>
                    update({
                      mappings: [
                        ...profile.mappings.filter((m) => m.targetId !== node.id),
                        ...(e.target.value
                          ? [{ sourceId: e.target.value, targetId: node.id }]
                          : []),
                      ],
                    })
                  }
                >
                  <option value="">保持基础局部姿态</option>
                  {sourceNodes.map((s) => (
                    <option key={s.id} value={s.id}>
                      {nodeLabel(s, sourceNodes)}
                    </option>
                  ))}
                </select>
              </label>
            ))}
          </div>
          <div className="bake-range">
            <label className="field">
              根位移
              <select
                aria-label="重定向根位移"
                value={profile.rootMotion}
                onChange={(e) => update({ rootMotion: e.target.value as 'scaled' | 'none' })}
              >
                <option value="scaled">转移并缩放</option>
                <option value="none">保持目标基础位置</option>
              </select>
            </label>
            <NumberInput
              label="根位移比例"
              value={profile.motionScale}
              min={0.001}
              max={1000}
              onChange={(motionScale) => update({ motionScale })}
            />
          </div>
          <div className="bake-range">
            {(['X', 'Y', 'Z'] as const).map((axis, i) => (
              <NumberInput
                key={axis}
                label={`方向对齐 ${axis}°`}
                value={([angles.x, angles.y, angles.z][i] * 180) / Math.PI}
                onChange={(value) => {
                  const v = [angles.x, angles.y, angles.z] as Vec3;
                  v[i] = (value * Math.PI) / 180;
                  update({ alignment: quaternionFromEuler(v) });
                }}
              />
            ))}
          </div>
          <p className="muted">
            方向对齐旋转作用于源动作变化，不修改目标基础姿态。源位移相对于源根的基础父级；目标父级继续决定目标角色在场景中的摆放。
          </p>
          <button
            onClick={async () => {
              const next = await send([{ type: 'retarget.put', profile }], '保存重定向映射');
              if (next)
                setNotes({
                  revision: next.revision,
                  items: ['映射已保存。修改映射不会改变已生成的动作。'],
                });
            }}
          >
            保存映射
          </button>{' '}
          <button
            disabled={!saved}
            onClick={async () => {
              if (await send([{ type: 'retarget.delete', id: profile.id }], '删除重定向映射'))
                choose(fresh());
            }}
          >
            删除映射
          </button>
          <span className="muted"> {dirty ? '映射尚未保存' : '映射已保存'}</span>
          <h3>输出到新动作</h3>
          <label className="field">
            源基础动作
            <select
              aria-label="重定向源动作"
              value={options.actionId || ''}
              onChange={(e) => updateOptions({ actionId: e.target.value || null })}
            >
              <option value="">项目动画</option>
              {project.animationActions
                ?.filter((a) => a.sceneId === source?.sceneId)
                .map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
            </select>
          </label>
          <p className="muted">
            采样源场景启用的动作层、约束和
            IK；忽略视口临时预览开关。目标根的整个子树写入完整变换，未映射子节点保持基础局部姿态。
          </p>
          <div className="bake-range">
            {(['start', 'end', 'step'] as const).map((key, i) => (
              <NumberInput
                key={key}
                label={['重定向起点', '重定向终点', '重定向步长'][i]}
                value={options[key]}
                min={key === 'step' ? 0.01 : 0}
                max={key === 'step' ? 120 : 1e6}
                onChange={(v) => updateOptions({ [key]: v })}
              />
            ))}
          </div>
          <label className="field">
            插值
            <select
              aria-label="重定向插值"
              value={options.interpolation}
              onChange={(e) =>
                updateOptions({ interpolation: e.target.value as 'linear' | 'constant' })
              }
            >
              <option value="linear">线性 / 四元数球面</option>
              <option value="constant">保持</option>
            </select>
          </label>
          <label>
            <input
              type="checkbox"
              checked={options.rebase}
              onChange={(e) => updateOptions({ rebase: e.target.checked })}
            />{' '}
            输出从第 0 帧开始
          </label>
          <label className="field">
            新动作名称
            <input
              aria-label="重定向新动作名称"
              value={name}
              maxLength={160}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <label>
            <input
              type="checkbox"
              checked={activate}
              onChange={(e) => setActivate(e.target.checked)}
            />{' '}
            设为目标场景默认动作并停用目标子树的基础偏移、层、约束及 IK
          </label>
          <p className="muted">
            源数据和蒙皮绑定保留。场景默认动作切换会影响场景其他对象的基础动作；镜头或片段指定的动作仍优先。若只保存，请先停用目标子树的上述驱动再使用该动作，避免重复变换。
          </p>
          <div className="button-row">
            <button onClick={() => void run('analyze')}>计算重定向误差</button>
            <button onClick={() => void run('bake')}>生成重定向动作</button>
          </div>
        </fieldset>
        {working && <button onClick={() => cancel.current?.()}>取消重定向计算</button>}
        {(error || saveError) && (
          <p role="alert" className="error">
            {error || saveError}
          </p>
        )}
        <div aria-live="polite">
          {(notes.revision === project.revision ? notes.items : []).map((note) => (
            <p key={note}>{note}</p>
          ))}
        </div>
      </section>
    </div>
  );
}
