import { retargetAnimation } from '../core/retarget';
import type { Project, RetargetProfile } from '../core/model';
import type { BakeOptions } from '../core/bake';

self.onmessage = (
  event: MessageEvent<{ project: Project; profile: RetargetProfile; options: BakeOptions }>,
) => {
  try {
    const { project, profile, options } = event.data,
      result = retargetAnimation(project, profile, options);
    self.postMessage({ notes: result.notes });
  } catch (error) {
    self.postMessage({ error: error instanceof Error ? error.message : String(error) });
  }
};
