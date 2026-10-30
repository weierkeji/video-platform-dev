import { createHash } from 'node:crypto';
import { newProject } from '../src/core/factory';
import { id, parseProject, type Vec3 } from '../src/core/model';
import { pngPixels } from './texture-fixture';

/** Original C-section sculpture. Front/back are concave 8-gons; sides are quads. */
export function objFixture() {
  const boundary = [
    [0, 0],
    [3, 0],
    [3, 1],
    [1, 1],
    [1, 2],
    [3, 2],
    [3, 3],
    [0, 3],
  ];
  const positions = [0.35, -0.35].flatMap((z) =>
    boundary.map(([x, y]) => [x - 1.5, y + 0.1, z] as Vec3),
  );
  const faces = [
    Array.from({ length: 8 }, (_, i) => i),
    Array.from({ length: 8 }, (_, i) => 15 - i),
    ...boundary.map((_, i) => [i, i + 8, ((i + 1) % 8) + 8, (i + 1) % 8]),
  ];
  const lines = [
    '# Original Frameforge concave sculpture',
    'o concave-sculpture',
    'mtllib optional.mtl',
    ...positions.map((p) => `v ${p.join(' ')}`),
  ];
  const normals: Vec3[] = [
    [0, 0.2, 1],
    [0, 0, -1],
    ...boundary.map(([x, y], i) => {
      const [nx, ny] = boundary[(i + 1) % 8];
      return [ny - y, x - nx, 0] as Vec3;
    }),
  ];
  faces.forEach((face, i) =>
    face.forEach((v, j) => {
      const [x, y] = positions[v];
      const uv =
        i < 2
          ? [(x + 1.5) / 3, (y - 0.1) / 3]
          : [
              [0, 0],
              [1, 0],
              [1, 1],
              [0, 1],
            ][j];
      lines.push(`vt ${uv.join(' ')}`);
    }),
  );
  lines.push(...normals.map((n) => `vn ${n.join(' ')}`), 's off', 'usemtl ceramic');
  let uv = 1;
  faces.forEach((face, i) => {
    lines.push('f ' + face.map((v) => `${v - 16}/${uv++}/${i + 1}`).join(' '));
  });
  const p = newProject('凹面陶瓷雕塑');
  p.entities[0].visible = false;
  const camera = p.entities.find((e) => e.kind === 'camera')!;
  camera.transform.position = [0, 1.6, 8];
  camera.transform.rotation = [0, 0, 0];
  p.timeline.width = 480;
  p.timeline.height = 270;
  p.timeline.duration = 24;
  p.timeline.clips[0].duration = 24;
  const pixels = pngPixels(32, 32, (x, y) =>
    (Math.floor(x / 4) + Math.floor(y / 4)) % 2 ? [244, 197, 91, 255] : [27, 148, 170, 255],
  );
  const asset = {
    id: id(),
    name: '原创釉色方格.png',
    kind: 'image' as const,
    mime: 'image/png' as const,
    blobId: createHash('sha256').update(pixels).digest('hex'),
    bytes: pixels.length,
    width: 32,
    height: 32,
  };
  p.assets.push(asset);
  return {
    p: parseProject(p),
    obj: lines.join('\n') + '\n',
    assetId: asset.id,
    blobs: [{ id: asset.blobId, mime: asset.mime, base64: pixels.toString('base64') }],
  };
}
