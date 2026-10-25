import { z } from 'zod';
import {
  AnimationTrackSchema,
  IKTrackSchema,
  type Project,
  type AnimationTrack,
  type IKTrack,
} from './model';
import { keyHandles, prepareCubic, validateTrack, type CurveKey } from './animation';

const ID = z.string().min(1).max(80);
export const KeyRefSchema = z.object({ trackId: ID, keyId: ID }).strict();
export type KeyRef = z.infer<typeof KeyRefSchema>;
const timeTransform = {
  pivot: z.number().finite().min(0).max(1e6),
  scale: z.number().finite().min(1e-6).max(1e6),
  offset: z.number().finite().min(-1e6).max(1e6),
};
export const TransformKeysSchema = z
  .object({
    type: z.literal('keys.transform'),
    keys: z.array(KeyRefSchema).min(1).max(200000),
    ...timeTransform,
  })
  .strict();
export const DuplicateKeysSchema = z
  .object({
    type: z.literal('keys.duplicate'),
    keys: z
      .array(KeyRefSchema.extend({ newId: ID }))
      .min(1)
      .max(200000),
    ...timeTransform,
  })
  .strict();
export const DeleteKeysSchema = z
  .object({
    type: z.literal('keys.delete'),
    keys: z.array(KeyRefSchema).min(1).max(200000),
  })
  .strict();
export const KeyBatchSchema = z.discriminatedUnion('type', [
  TransformKeysSchema,
  DuplicateKeysSchema,
  DeleteKeysSchema,
]);
export type KeyBatch = z.infer<typeof KeyBatchSchema>;
type Track = AnimationTrack | IKTrack;

/** Pure, shared by drag preview and command execution. Validate the final group,
 * never an intermediate per-key position, and never mutate the source project. */
export function editedKeyTracks(
  p: Pick<Project, 'animationTracks' | 'ikTracks'>,
  input: KeyBatch,
): Map<string, Track> {
  const command = KeyBatchSchema.parse(input);
  const tracks = new Map<string, Track>(
    [...p.animationTracks, ...(p.ikTracks || [])].map((t) => [t.id, t]),
  );
  const groups = new Map<string, Map<string, string | undefined>>();
  const ids =
    command.type === 'keys.duplicate'
      ? new Set([...tracks.values()].flatMap((t) => t.keys.map((k) => k.id)))
      : undefined;
  for (const ref of command.keys) {
    if (!tracks.has(ref.trackId)) throw new Error('所选动画轨道已不存在');
    const group = groups.get(ref.trackId) || new Map<string, string | undefined>();
    if (group.has(ref.keyId)) throw new Error('同一关键帧不能重复选择');
    const newId = 'newId' in ref ? ref.newId : undefined;
    if (newId && ids) {
      if (ids.has(newId)) throw new Error('复制关键帧的新 ID 已存在');
      ids.add(newId);
    }
    group.set(ref.keyId, newId);
    groups.set(ref.trackId, group);
  }
  const result = new Map<string, Track>();
  for (const [trackId, group] of groups) {
    const source = tracks.get(trackId)!;
    const known = new Set(source.keys.map((k) => k.id));
    if ([...group.keys()].some((keyId) => !known.has(keyId))) throw new Error('所选关键帧已不存在');
    const copy = structuredClone(source);
    if (command.type === 'keys.delete') {
      copy.keys = copy.keys.filter((k) => !group.has(k.id)) as Track['keys'];
    } else {
      const changed: CurveKey[] = [];
      source.keys.forEach((key, index) => {
        if (!group.has(key.id)) return;
        const next: CurveKey = structuredClone(key);
        if (command.type === 'keys.duplicate') next.id = group.get(key.id)!;
        next.frame =
          command.scale === 1
            ? key.frame + command.offset
            : command.pivot + (key.frame - command.pivot) * command.scale + command.offset;
        if (!Number.isFinite(next.frame) || next.frame < 0 || next.frame > 1e6)
          throw new Error('批量编辑后的关键帧必须位于 0…1000000 帧；整组未提交');
        if (command.type === 'keys.duplicate' || command.scale !== 1 || command.offset !== 0) {
          // Capture automatic tangents before moving a partial selection. Internal
          // Bézier segments then retain their shape under the time affine map.
          if (
            source.property !== 'quaternion' &&
            (key.handles ||
              key.interpolation === 'bezier' ||
              source.keys[index - 1]?.interpolation === 'bezier')
          ) {
            next.handles = key.value.map((_, axis) => {
              const h = keyHandles(source, index, axis);
              return {
                mode: h.mode === 'aligned' ? 'aligned' : 'free',
                left: [h.left[0] * command.scale, h.left[1]],
                right: [h.right[0] * command.scale, h.right[1]],
              };
            });
          }
          if (key.inTangent) next.inTangent = key.inTangent.map((v) => v / command.scale);
          if (key.outTangent) next.outTangent = key.outTangent.map((v) => v / command.scale);
        }
        changed.push(next);
      });
      copy.keys = [
        ...copy.keys.filter((k) => command.type === 'keys.duplicate' || !group.has(k.id)),
        ...changed,
      ].sort((a, b) => a.frame - b.frame) as Track['keys'];
      for (let i = 1; i < copy.keys.length; i++)
        if (copy.keys[i].frame <= copy.keys[i - 1].frame)
          throw new Error('目标帧已有关键帧或时间精度不足；整组未提交，未覆盖原关键帧');
    }
    prepareCubic(copy);
    if ('chainId' in copy) IKTrackSchema.parse(copy);
    else AnimationTrackSchema.parse(copy);
    validateTrack(copy);
    result.set(trackId, copy);
  }
  return result;
}

export function editKeys(p: Project, command: KeyBatch) {
  const changed = editedKeyTracks(p, command);
  p.animationTracks = p.animationTracks
    .map((t) => (changed.get(t.id) || t) as AnimationTrack)
    .filter((t) => !changed.has(t.id) || t.keys.length);
  if (p.ikTracks)
    p.ikTracks = p.ikTracks
      .map((t) => (changed.get(t.id) || t) as IKTrack)
      .filter((t) => !changed.has(t.id) || t.keys.length);
}
