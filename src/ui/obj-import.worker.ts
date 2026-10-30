import { parseOBJ } from '../core/obj';
self.onmessage = async (event: MessageEvent<File>) => {
  try {
    if (event.data.size > 20_000_000) throw new Error('OBJ 超出 20 MB 限制');
    self.postMessage({ result: parseOBJ(await event.data.text()) });
  } catch (e) {
    self.postMessage({ error: (e as Error).message });
  }
};
