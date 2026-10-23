import { bakedProject, type BakeOptions } from '../core/bake';
import type { Project } from '../core/model';

self.onmessage = (
  event: MessageEvent<{ project: Project; sceneId: string; options: BakeOptions }>,
) => {
  try {
    const { project, sceneId, options } = event.data;
    self.postMessage({ result: bakedProject(project, sceneId, options) });
  } catch (error) {
    self.postMessage({ error: error instanceof Error ? error.message : String(error) });
  }
};
