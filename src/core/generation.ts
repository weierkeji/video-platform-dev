import { z } from 'zod';

export const GenerationOptionsSchema = z
  .object({
    model: z
      .string()
      .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,159}$/)
      .optional(),
    profile: z
      .enum(['1.0-pro', '1.0-pro-fast', '2.0', '2.0-fast', '2.0-mini', '2.5'])
      .default('2.0'),
    duration: z.number().int().min(2).max(30).default(5),
    resolution: z.enum(['480p', '720p', '1080p', '4k']).default('720p'),
    ratio: z.enum(['16:9', '4:3', '1:1', '3:4', '9:16', '21:9', 'adaptive']).default('16:9'),
    seed: z.number().int().min(-1).max(2147483647).default(-1),
    generateAudio: z.boolean().default(true),
    watermark: z.boolean().default(true),
    firstFrameId: z.string().uuid().optional(),
    lastFrameId: z.string().uuid().optional(),
  })
  .strict();
export type GenerationOptions = z.infer<typeof GenerationOptionsSchema>;
export const GenerationRequestSchema = GenerationOptionsSchema.extend({
  model: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,159}$/),
  prompt: z.string().trim().min(1).max(5000),
}).strict();
export type GenerationRequest = z.infer<typeof GenerationRequestSchema>;

export function validateGeneration(input: unknown): GenerationRequest {
  const r = GenerationRequestSchema.parse(input);
  const v1 = r.profile.startsWith('1.0');
  const maximum = r.profile === '2.5' ? 30 : v1 ? 12 : 15;
  if (r.duration < (v1 ? 2 : 4) || r.duration > maximum)
    throw new Error(`此模型系列时长应为 ${v1 ? 2 : 4}–${maximum} 秒`);
  if (r.resolution === '4k' && r.profile !== '2.0') throw new Error('此模型系列不支持 4k');
  if (r.resolution === '1080p' && ['2.0-fast', '2.0-mini'].includes(r.profile))
    throw new Error('此模型系列最高支持 720p');
  if (r.lastFrameId && (!r.firstFrameId || r.profile === '1.0-pro-fast'))
    throw new Error('尾帧需要首帧及支持首尾帧的模型');
  if (r.firstFrameId && r.profile === '2.5' && r.ratio !== 'adaptive')
    throw new Error('Seedance 2.5 首帧/首尾帧任务要求自适应画幅');
  if (v1 && !r.firstFrameId && r.ratio === 'adaptive')
    throw new Error('Seedance 1.0 文生视频需要指定画幅');
  return r;
}

export type ProviderStatus = {
  id: 'seedance';
  status: 'missing-credentials' | 'disabled' | 'configured';
  message: string;
  defaultModel: string;
};
