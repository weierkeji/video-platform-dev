import { Matrix4, Quaternion, Vector3 } from 'three';
import {
  id,
  AnimationTrackSchema,
  RetargetProfileSchema,
  type AnimationAction,
  type AnimationTrack,
  type Project,
  type RetargetProfile,
  type Vec3,
  type Vec4,
} from './model';
import {
  SamplingOptionsSchema as BakeOptionsSchema,
  samplingGrid,
  type SamplingOptions as BakeOptions,
} from './bake';
import { restWorld } from './rest-pose';
import { validateRetargetProfile, retargetSubtree } from './retarget-profile';
import { sceneEvaluator, transformMatrix } from './constraints';
import { affineParts } from './affine';
import { sampleTrack, validateTrack } from './animation';

function parts(matrix: Matrix4, label: string) {
  const result = affineParts(matrix);
  if (
    !result ||
    matrix.elements.some((v) => !Number.isFinite(v)) ||
    Math.abs(matrix.determinant()) < 1e-12
  )
    throw new Error(`${label}包含奇异或非有限变换，无法重定向`);
  return result;
}
function inverse(matrix: Matrix4, label: string) {
  parts(matrix, label);
  return matrix.clone().invert();
}

/** Source motion is measured in the fixed rest parent frame of the source root.
 * Target results are local to its root parent, which remains placement/context.
 * This is reference-relative FK orientation transfer, not an IK contact solver. */
export function retargetAnimation(
  p: Project,
  profile: RetargetProfile,
  input: BakeOptions,
  action?: AnimationAction,
) {
  profile = RetargetProfileSchema.parse(profile);
  const { source, target } = validateRetargetProfile(p, profile),
    sourceScene = source[0].sceneId,
    targetScene = target[0].sceneId,
    options = BakeOptionsSchema.parse(input);
  action ||= { id: id(), name: `${profile.name} · 动作`, sceneId: targetScene };
  if (action.sceneId !== targetScene) throw new Error('重定向输出动作必须属于目标场景');
  if (options.end - options.start < 1e-6) throw new Error('重定向终点必须大于起点至少 0.000001 帧');
  if (
    options.actionId &&
    !p.animationActions?.some((a) => a.id === options.actionId && a.sceneId === sourceScene)
  )
    throw new Error('重定向基础动作必须属于源场景');
  const { grid, guarded, offset } = samplingGrid(p, sourceScene, options);
  if (
    grid.length * 4 * (p.entities.filter((e) => e.sceneId === sourceScene).length + target.length) >
    2000000
  )
    throw new Error('重定向超过 200 万次节点采样预算；请缩短范围、增大步长或简化源场景');
  if (target.length * 3 * grid.length > 200000)
    throw new Error('重定向输出超过 20 万键；请缩短区间、增大步长或选择较小目标子树');
  // Stored rig reference poses survive activation of baked actions. Disabling
  // their animation offset must not silently change a reusable profile's basis.
  const referenceProject = {
    ...p,
    entities: p.entities.map((e) => ({
      ...e,
      restPose: e.restPose && { ...e.restPose, enabled: true },
    })),
  };
  const sourceRest = restWorld(referenceProject, sourceScene),
    targetRest = restWorld(referenceProject, targetScene);
  const sourceFrame = source[0].parentId ? sourceRest.get(source[0].parentId)! : new Matrix4(),
    targetFrame = target[0].parentId ? targetRest.get(target[0].parentId)! : new Matrix4(),
    sourceInverse = inverse(sourceFrame, '源根基础父级'),
    targetInverse = inverse(targetFrame, '目标根基础父级');
  const sourceReference = new Map(
    profile.mappings.map((m) => [
      m.sourceId,
      parts(sourceInverse.clone().multiply(sourceRest.get(m.sourceId)!), '源基础姿态'),
    ]),
  );
  const targetReference = new Map(
    target.map((e) => [
      e.id,
      parts(targetInverse.clone().multiply(targetRest.get(e.id)!), '目标基础姿态'),
    ]),
  );
  const mapped = new Map(profile.mappings.map((m) => [m.targetId, m.sourceId])),
    alignment = new Quaternion().fromArray(profile.alignment).normalize(),
    alignmentInverse = alignment.clone().invert(),
    evaluate = sceneEvaluator(p, sourceScene);
  const plans = target.map((entity) => {
    const rest = parts(
      transformMatrix(entity.restPose?.transform || entity.transform),
      entity.name,
    );
    const tracks: AnimationTrack[] = (['position', 'quaternion', 'scale'] as const).map(
      (property) => ({
        id: id(),
        entityId: entity.id,
        actionId: action!.id,
        property,
        keys: [],
      }),
    );
    return { entity, rest, tracks };
  });
  function sample(frame: number) {
    const pose = evaluate(frame, options.actionId);
    if (pose.warnings.length)
      throw new Error(`源姿态在 ${frame} 帧存在求值诊断：${pose.warnings[0].message}`);
    const world = new Map<string, Matrix4>();
    return plans.map(({ entity, rest }) => {
      const parent = entity.id === target[0].id ? new Matrix4() : world.get(entity.parentId!)!,
        sourceId = mapped.get(entity.id);
      let q = rest.rotation.clone();
      const position = rest.position.clone(),
        scale = new Vector3().fromArray(rest.upper);
      if (sourceId) {
        const sourcePose = parts(
            sourceInverse.clone().multiply(pose.world.get(sourceId)!),
            `源 ${sourceId} 帧 ${frame}`,
          ),
          reference = sourceReference.get(sourceId)!;
        const desired = alignment
          .clone()
          .multiply(sourcePose.rotation)
          .multiply(reference.rotation.clone().invert())
          .multiply(alignmentInverse)
          .multiply(targetReference.get(entity.id)!.rotation);
        // QR, rather than inverse(parent quaternion), accounts for anisotropic
        // and reflected parents. Canonical local scale has positive X/Y.
        q = parts(
          inverse(parent, entity.name).multiply(new Matrix4().makeRotationFromQuaternion(desired)),
          entity.name,
        ).rotation;
        if (entity.id === target[0].id && profile.rootMotion === 'scaled')
          position.add(
            sourcePose.position
              .clone()
              .sub(reference.position)
              .applyQuaternion(alignment)
              .multiplyScalar(profile.motionScale),
          );
      }
      const matrix = new Matrix4().compose(position, q, scale);
      world.set(entity.id, parent.clone().multiply(matrix));
      return [position.toArray() as Vec3, q.toArray() as Vec4, scale.toArray() as Vec3];
    });
  }
  for (const point of grid) {
    const values = sample(point.source);
    plans.forEach((plan, i) =>
      plan.tracks.forEach((track, channel) => {
        let value = values[i][channel];
        if (
          channel === 1 &&
          track.keys.length &&
          value.reduce((sum, v, k) => sum + v * track.keys.at(-1)!.value[k], 0) < 0
        )
          value = value.map((v) => -v) as Vec4;
        track.keys.push({
          id: id(),
          frame: point.frame,
          value,
          interpolation: options.interpolation,
        });
      }),
    );
  }
  const tracks = plans.flatMap((plan) => plan.tracks);
  for (const track of tracks) {
    AnimationTrackSchema.parse(track);
    validateTrack(track);
  }
  // Probe the encoded action against the continuous transfer, separately for
  // guarded jumps. These are local-channel errors, not end-effector guarantees.
  const smooth = { position: 0, rotationDegrees: 0 },
    boundary = { ...smooth };
  let probes = 0;
  for (let i = 0; i < grid.length - 1; i++)
    for (const fraction of [0.25, 0.5, 0.75]) {
      const frame = grid[i].frame + (grid[i + 1].frame - grid[i].frame) * fraction,
        actual = sample(frame + offset),
        error = grid[i].boundaryAfter ? boundary : smooth;
      plans.forEach((plan, k) => {
        probes++;
        const pos = sampleTrack(plan.tracks[0], frame)!,
          q = sampleTrack(plan.tracks[1], frame)!;
        error.position = Math.max(
          error.position,
          ...pos.map((v, j) => Math.abs(v - actual[k][0][j])),
        );
        const dot = Math.min(1, Math.abs(q.reduce((sum, v, j) => sum + v * actual[k][1][j], 0)));
        error.rotationDegrees = Math.max(
          error.rotationDegrees,
          (2 * Math.acos(dot) * 180) / Math.PI,
        );
      });
    }
  const stats = {
    samples: grid.length,
    tracks: tracks.length,
    keys: tracks.length * grid.length,
    guarded,
    probes,
    smooth,
    boundary,
    mapped: mapped.size,
    entities: target.length,
  };
  const notes = [
    `${mapped.size} 个映射 / ${target.length} 个目标节点；${stats.samples} 次采样，${stats.keys} 个关键帧。`,
    `四分点局部误差：平滑段位置 ${smooth.position.toPrecision(3)} m、旋转 ${smooth.rotationDegrees.toPrecision(3)}°；跳变邻域 ${boundary.position.toPrecision(3)} m / ${boundary.rotationDegrees.toPrecision(3)}°。`,
    `保留 ${guarded} 个跳变边界；步长控制采样精度，误差不是连续时间或末端接触保证。`,
    '保留目标基础局部位移与缩放；未映射节点保持基础局部姿态。仅根位移可按比例转移，不转移骨骼伸缩，不修正脚底或手部接触。',
  ];
  return { action, tracks, stats, notes };
}

/** Mutates only a transaction/preview draft; original channels and bindings survive. */
export function activateRetarget(p: Project, profile: RetargetProfile, action: AnimationAction) {
  const targets = new Set(retargetSubtree(p, profile.targetRootId).map((e) => e.id));
  for (const chain of p.ikChains || []) {
    if (!chain.joints.some((joint) => targets.has(joint))) continue;
    if (!chain.joints.every((joint) => targets.has(joint)))
      throw new Error('目标子树只包含 IK 链的一部分；请选择包含整条链的根或先移除该 IK');
    chain.enabled = false;
  }
  for (const entity of p.entities)
    if (targets.has(entity.id)) {
      if (entity.restPose) entity.restPose.enabled = false;
      for (const constraint of entity.constraints || []) constraint.enabled = false;
    }
  for (const layer of p.animationLayers || [])
    if (targets.has(layer.entityId)) layer.enabled = false;
  p.scenes.find((s) => s.id === action.sceneId)!.activeActionId = action.id;
}
