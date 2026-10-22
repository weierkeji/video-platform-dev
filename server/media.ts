import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { ffprobePath } from './runtime';
import { AUDIO_SAMPLE_RATE, audioSegment, audibleClips } from '../src/core/media';
import type { Project } from '../src/core/model';

type MediaStream = {
  index: number;
  codec_type: string;
  channels?: number;
  width?: number;
  height?: number;
  start_time?: string;
  duration?: string;
};
export type MediaProbe = {
  streams: MediaStream[];
  format: { start_time?: string; duration?: string };
};
const execute = promisify(execFile);
export async function probeMedia(path: string, signal?: AbortSignal): Promise<MediaProbe> {
  const { stdout } = await execute(
    ffprobePath(),
    ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', path],
    { timeout: 20000, maxBuffer: 1024 * 1024, windowsHide: true, signal },
  );
  return JSON.parse(stdout);
}
export function audioOffset(probe: MediaProbe) {
  const audio = probe.streams.find((s) => s.codec_type === 'audio');
  const seconds = (value: string | undefined) =>
    Number.isFinite(Number(value)) ? Number(value) : 0;
  return audio ? seconds(audio.start_time) - seconds(probe.format.start_time) : 0;
}

/** Probe actual files, including v1 assets without stream metadata. Never invent a silent track. */
export async function audioMix(project: Project, directory: string, signal?: AbortSignal) {
  const probes = new Map<string, MediaProbe>();
  const inputs: string[] = [],
    filters: string[] = [],
    labels: string[] = [];
  for (const clip of audibleClips(project)) {
    signal?.throwIfAborted();
    const asset = project.assets.find((a) => a.id === clip.sourceId)!;
    const path = join(directory, 'blobs', asset.blobId);
    let probe = probes.get(asset.blobId);
    if (!probe) {
      probe = await probeMedia(path, signal);
      probes.set(asset.blobId, probe);
    }
    const stream = probe.streams.find((s) => s.codec_type === 'audio');
    if (!stream) continue;
    const segment = audioSegment(clip, project.timeline.fps, audioOffset(probe));
    if (!segment || segment.samples <= 0) continue;
    inputs.push('-i', path);
    const index = labels.length,
      label = `a${index}`;
    // Input zero is the rendered image sequence; audio inputs begin at one.
    const stereo = stream.channels === 1 ? 'pan=stereo|c0=c0|c1=c0,' : '';
    filters.push(
      `[${index + 1}:a:0]aresample=${AUDIO_SAMPLE_RATE},${stereo}aformat=sample_fmts=fltp:channel_layouts=stereo,asetpts=N/SR/TB,atrim=start_sample=${segment.trimStart}:end_sample=${segment.trimStart + segment.samples},asetpts=N/SR/TB,volume=${segment.gain},adelay=${segment.delay}S:all=1[${label}]`,
    );
    labels.push(`[${label}]`);
  }
  if (labels.length)
    filters.push(
      `${labels.join('')}amix=inputs=${labels.length}:duration=longest:normalize=0,apad,asetpts=N/SR/TB[audio]`,
    );
  return { inputs, filter: filters.join(';'), hasAudio: labels.length > 0 };
}
