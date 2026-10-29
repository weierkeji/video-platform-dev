import { skinFixture } from './skin-fixture';
import { id, parseProject, type Asset, type Clip } from '../src/core/model';

/** Original animated sculpture and two excerpts from locally synthesized video. */
export function clipEditingFixture(video: Asset) {
  const f = skinFixture(),
    p = f.p;
  p.name = '剪辑时间与源素材';
  p.assets.push(video);
  p.timeline.duration = 240;
  const base = p.timeline.clips[0];
  base.duration = 96;
  base.name = '底层动画';
  base.playback = { rate: 0.5, rangeStart: 0, rangeEnd: 48, mode: 'repeat' };
  const reverse: Clip = {
    ...base,
    id: id(),
    name: '倒放往返镜头',
    start: 8,
    duration: 20,
    sourceIn: 28.375,
    channel: 2,
    action: { actionId: null },
    playback: { rate: -0.75, rangeStart: 0, rangeEnd: 24, mode: 'pingpong' },
  };
  const a: Clip = {
    id: id(),
    name: '视频前段',
    kind: 'video',
    sourceId: video.id,
    start: 24,
    duration: 24,
    sourceIn: 12,
    channel: 1,
    muted: false,
    volume: 0.75,
    fit: 'cover',
  };
  const b: Clip = { ...a, id: id(), name: '视频后段', start: 72, sourceIn: 0, volume: 0.5 };
  p.timeline.clips.push(a, b, reverse);
  return { ...f, p: parseProject(p), aId: a.id, bId: b.id, reverseId: reverse.id, baseId: base.id };
}
