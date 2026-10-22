import type { Clip, Project } from './model';

export type ImageRect = {
  sx: number;
  sy: number;
  sw: number;
  sh: number;
  dx: number;
  dy: number;
  dw: number;
  dh: number;
};

/** Pixels stay centered. Contain exposes lower tracks; cover crops the source. */
export function fitRect(
  sourceWidth: number,
  sourceHeight: number,
  width: number,
  height: number,
  fit: Clip['fit'],
): ImageRect {
  if (![sourceWidth, sourceHeight, width, height].every((v) => Number.isFinite(v) && v > 0))
    throw new Error('媒体画幅尺寸无效');
  const rect = {
    sx: 0,
    sy: 0,
    sw: sourceWidth,
    sh: sourceHeight,
    dx: 0,
    dy: 0,
    dw: width,
    dh: height,
  };
  if (fit === 'contain') {
    const scale = Math.min(width / sourceWidth, height / sourceHeight);
    rect.dw = sourceWidth * scale;
    rect.dh = sourceHeight * scale;
    rect.dx = (width - rect.dw) / 2;
    rect.dy = (height - rect.dh) / 2;
  } else if (fit === 'cover') {
    const scale = Math.max(width / sourceWidth, height / sourceHeight);
    rect.sw = width / scale;
    rect.sh = height / scale;
    rect.sx = (sourceWidth - rect.sw) / 2;
    rect.sy = (sourceHeight - rect.sh) / 2;
  }
  return rect;
}

export const AUDIO_SAMPLE_RATE = 48000;
export function audibleClips(project: Project) {
  return project.timeline.clips.filter(
    (clip) => !clip.muted && clip.volume > 0 && (clip.kind === 'audio' || clip.kind === 'video'),
  );
}

/** Round boundaries, not each duration independently, to avoid drift on fractional frame/sample ratios. */
export function audioSegment(
  clip: Clip,
  fps: number,
  audioStart = 0,
  sampleRate = AUDIO_SAMPLE_RATE,
) {
  const inTime = clip.sourceIn / fps;
  const missingStart = Math.max(0, audioStart - inTime);
  const available = clip.duration / fps - missingStart;
  if (available <= 0) return null;
  const delay = Math.round((clip.start / fps + missingStart) * sampleRate);
  const end = Math.round(((clip.start + clip.duration) / fps) * sampleRate);
  return {
    trimStart: Math.max(0, Math.round((inTime - audioStart) * sampleRate)),
    samples: end - delay,
    delay,
    gain: clip.volume,
  };
}
