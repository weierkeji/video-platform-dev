import * as THREE from 'three';
import { activeClips, sourceFrame } from '../core/evaluate';
import { type Asset, type Project } from '../core/model';
import { SceneRenderer } from './scene';

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
      // All visual strips occupy the output rectangle. Higher channels cover lower ones.
      this.ctx.drawImage(source, 0, 0, width, height);
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
  media = new Map<string, HTMLAudioElement>();
  sync(p: Project, frame: number, playing: boolean) {
    const active = new Set<string>();
    for (const c of activeClips(p, frame).filter((c) => c.kind === 'audio' || c.kind === 'video')) {
      active.add(c.id);
      let audio = this.media.get(c.id);
      if (!audio) {
        audio = new Audio(`/api/blobs/${p.assets.find((a) => a.id === c.sourceId)!.blobId}`);
        this.media.set(c.id, audio);
      }
      const time = sourceFrame(c, frame) / p.timeline.fps;
      if (Math.abs(audio.currentTime - time) > 0.15) audio.currentTime = time;
      audio.volume = Math.min(1, c.volume);
      if (playing) {
        void audio.play().catch(() => {});
      } else audio.pause();
    }
    for (const [key, audio] of this.media) if (!active.has(key) || !playing) audio.pause();
  }
  dispose() {
    for (const audio of this.media.values()) {
      audio.pause();
      audio.removeAttribute('src');
      audio.load();
    }
    this.media.clear();
  }
}
