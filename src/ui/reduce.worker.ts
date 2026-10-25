import { reduceAction, type ReduceOptions } from '../core/reduce-curves';
import type { Project } from '../core/model';

self.onmessage = (
  event: MessageEvent<{ project: Project; sceneId: string; options: ReduceOptions }>,
) => {
  try {
    const { project, sceneId, options } = event.data,
      result = reduceAction(project, sceneId, options);
    self.postMessage({ result: { stats: result.stats, notes: result.notes } });
  } catch (error) {
    self.postMessage({ error: error instanceof Error ? error.message : String(error) });
  }
};
