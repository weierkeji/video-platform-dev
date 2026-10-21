import { TimelineRenderer } from './timeline';
import { parseProject } from '../core/model';

declare global {
  interface Window {
    studioRender?: (frame: number) => Promise<string>;
    studioReady?: boolean;
    studioError?: string;
  }
}
export async function startExportPage() {
  try {
    const key = new URLSearchParams(location.search).get('job');
    const response = await fetch(`/api/jobs/${encodeURIComponent(key!)}/snapshot`);
    if (!response.ok) throw new Error('无法加载渲染快照');
    const project = parseProject(await response.json());
    const canvas = document.createElement('canvas');
    document.body.replaceChildren(canvas);
    const renderer = new TimelineRenderer(canvas, project);
    window.studioRender = async (frame: number) => {
      await renderer.render(frame);
      return canvas.toDataURL('image/png').split(',')[1];
    };
    window.studioReady = true;
  } catch (e) {
    window.studioError = String(e);
  }
}
