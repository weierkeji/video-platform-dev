import * as THREE from 'three';
import { activeClips, sourceFrame } from '../core/evaluate';
import { type Asset, type Project } from '../core/model';
import { SceneRenderer } from './scene';
import { fitRect } from '../core/media';

const timeout = <T>(p: Promise<T>, ms: number) =>
  new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('媒体加载超时')), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
export class TimelineRenderer {
  scene = new SceneRenderer();
  media = new Map<string, HTMLImageElement | HTMLVideoElement>();
  ctx: CanvasRenderingContext2D;
  constructor(
    public canvas: HTMLCanvasElement,
    public project: Project,
  ) {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D 不可用');
    this.ctx = ctx;
  }
  async load(asset: Asset) {
    if (this.media.has(asset.id)) return this.media.get(asset.id)!;
    const url = `/api/blobs/${asset.blobId}`;
    let element: HTMLImageElement | HTMLVideoElement;
    if (asset.kind === 'image') {
      const img = new Image();
      img.src = url;
      await timeout(img.decode(), 15000);
      element = img;
    } else {
      const video = document.createElement('video');
      video.muted = true;
      video.preload = 'auto';
      video.src = url;
      await timeout(
        new Promise<void>((resolve, reject) => {
          video.onloadeddata = () => resolve();
          video.onerror = () => reject(new Error(`无法解码视频：${asset.name}`));
        }),
        15000,
      );
      element = video;
    }
    this.media.set(asset.id, element);
    return element;
  }
  async render(frame: number) {
    const p = this.project,
      { width, height } = p.timeline;
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
    }
    this.ctx.fillStyle = '#000000';
    this.ctx.fillRect(0, 0, width, height);
    for (const clip of activeClips(p, frame)) {
      if (clip.kind === 'audio') continue;
      let source: CanvasImageSource;
      if (clip.kind === 'shot') {
        const shot = p.shots.find((s) => s.id === clip.sourceId)!;
        this.scene.setProject(p, shot.sceneId);
        this.scene.evaluate(sourceFrame(clip, frame));
        this.scene.render(this.scene.objects.get(shot.cameraId) as THREE.Camera, width, height);
        source = this.scene.renderer.domElement;
      } else {
        const asset = p.assets.find((a) => a.id === clip.sourceId)!;
        const media = await this.load(asset);
        if (media instanceof HTMLVideoElement) {
          const t = Math.min(
            sourceFrame(clip, frame) / p.timeline.fps,
            Math.max(0, media.duration - 0.001),
          );
          if (Math.abs(media.currentTime - t) > 0.0001) {
            await timeout(
              new Promise<void>((resolve, reject) => {
                media.onseeked = () => resolve();
                media.onerror = () => reject(new Error('视频定位失败'));
                media.currentTime = t;
              }),
              10000,
            );
          }
        }
        source = media;
      }
      const sourceWidth =
        source instanceof HTMLVideoElement
          ? source.videoWidth
          : source instanceof HTMLImageElement
            ? source.naturalWidth
            : width;
      const sourceHeight =
        source instanceof HTMLVideoElement
          ? source.videoHeight
          : source instanceof HTMLImageElement
            ? source.naturalHeight
            : height;
      const rect = fitRect(sourceWidth, sourceHeight, width, height, clip.fit);
      this.ctx.drawImage(
        source,
        rect.sx,
        rect.sy,
        rect.sw,
        rect.sh,
        rect.dx,
        rect.dy,
        rect.dw,
        rect.dh,
      );
    }
  }
  dispose() {
    this.scene.dispose();
    for (const m of this.media.values())
      if (m instanceof HTMLVideoElement) {
        m.pause();
        m.removeAttribute('src');
        m.load();
      }
    this.media.clear();
  }
}

export class TimelineAudio {
  context: AudioContext;
  output: GainNode;
  error = '';
  media = new Map<
    string,
    {
      audio: HTMLAudioElement;
      source: MediaElementAudioSourceNode;
      gain: GainNode;
      pending: boolean;
      blobId: string;
    }
  >();
  private disposed = false;
  private unlock = () => {
    if (this.context.state === 'suspended') void this.context.resume().catch((e) => this.report(e));
  };
  constructor() {
    this.context = new AudioContext({ sampleRate: 48000 });
    this.output = this.context.createGain();
    this.output.connect(this.context.destination);
    document.addEventListener('pointerdown', this.unlock);
    document.addEventListener('keydown', this.unlock);
  }
  private report(error: unknown) {
    if (this.disposed || (error instanceof DOMException && error.name === 'AbortError')) return;
    this.error =
      error instanceof DOMException && error.name === 'NotAllowedError'
        ? '浏览器暂停了音频；请点击播放启用声音'
        : `音频预览失败：${String(error)}`;
  }
  private release(key: string) {
    const entry = this.media.get(key);
    if (!entry) return;
    entry.audio.pause();
    entry.audio.removeAttribute('src');
    entry.audio.load();
    entry.source.disconnect();
    entry.gain.disconnect();
    this.media.delete(key);
  }
  sync(p: Project, frame: number, playing: boolean) {
    if (this.disposed) return;
    if (playing) this.unlock();
    const active = new Set<string>();
    for (const c of activeClips(p, frame).filter(
      (c) => (c.kind === 'audio' || c.kind === 'video') && c.volume > 0,
    )) {
      const asset = p.assets.find((a) => a.id === c.sourceId)!;
      if (asset.hasAudio === false) continue;
      active.add(c.id);
      let entry = this.media.get(c.id);
      if (entry && entry.blobId !== asset.blobId) {
        this.release(c.id);
        entry = undefined;
      }
      if (!entry) {
        const audio = new Audio(`/api/blobs/${asset.blobId}`),
          source = this.context.createMediaElementSource(audio),
          gain = this.context.createGain();
        source.connect(gain);
        gain.connect(this.output);
        audio.onerror = () => this.report(new Error(`无法解码 ${asset.name}`));
        entry = { audio, source, gain, pending: false, blobId: asset.blobId };
        this.media.set(c.id, entry);
      }
      const { audio, gain } = entry;
      const time = sourceFrame(c, frame) / p.timeline.fps;
      if (
        ((!playing || audio.paused) && Math.abs(audio.currentTime - time) > 0.001) ||
        Math.abs(audio.currentTime - time) > 0.15
      )
        audio.currentTime = time;
      gain.gain.setValueAtTime(c.volume, this.context.currentTime);
      if (playing) {
        if (audio.paused && !entry.pending) {
          entry.pending = true;
          const current = entry;
          void audio
            .play()
            .then(() => {
              this.error = '';
            })
            .catch((e) => this.report(e))
            .finally(() => {
              current.pending = false;
            });
        }
      } else audio.pause();
    }
    for (const key of this.media.keys()) if (!active.has(key)) this.release(key);
  }
  dispose() {
    this.disposed = true;
    document.removeEventListener('pointerdown', this.unlock);
    document.removeEventListener('keydown', this.unlock);
    for (const key of this.media.keys()) this.release(key);
    this.output.disconnect();
    void this.context.close().catch(() => {});
  }
}
