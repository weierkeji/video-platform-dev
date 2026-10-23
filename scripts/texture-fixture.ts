import { deflateSync } from 'node:zlib';
// Original deterministic PNG/scene for integrated texture checks, not external artwork.
export function pngPixels(
  width: number,
  height: number,
  pixel: (x: number, y: number) => number[],
) {
  const crc = (bytes: Uint8Array) => {
    let n = 0xffffffff;
    for (const byte of bytes) {
      n ^= byte;
      for (let i = 0; i < 8; i++) n = (n >>> 1) ^ (n & 1 ? 0xedb88320 : 0);
    }
    return (n ^ 0xffffffff) >>> 0;
  };
  const chunk = (kind: string, body: Uint8Array) => {
    const data = Buffer.concat([Buffer.from(kind), body]),
      result = Buffer.alloc(data.length + 8);
    result.writeUInt32BE(body.length, 0);
    data.copy(result, 4);
    result.writeUInt32BE(crc(data), result.length - 4);
    return result;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  const rows = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) rows.set(pixel(x, y), y * (1 + width * 4) + 1 + x * 4);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(rows)),
    chunk('IEND', new Uint8Array()),
  ]);
}
export function textureFixture() {
  const color = pngPixels(32, 32, (x, y) =>
    x < 16
      ? y < 16
        ? [230, 40, 30, 255]
        : [30, 200, 70, 255]
      : y < 16
        ? [30, 70, 230, 255]
        : [240, 200, 40, 128],
  );
  const data = pngPixels(32, 32, (x, y) => [128 + x * 2, 90 + y * 2, 200, 255]);
  const geometry = new Float32Array([
    -1, 1, 0, 0, 0, 1, 1, 0, 0, -1, 0, 0, 0.1, 0.1, 1, 1, 0, 0, 0, 1, 1, 0, 0, -1, 1, 0, 0.9, 0.1,
    1, -1, 0, 0, 0, 1, 1, 0, 0, -1, 1, 1, 0.9, 0.9, -1, -1, 0, 0, 0, 1, 1, 0, 0, -1, 0, 1, 0.1, 0.9,
  ]);
  const buffer = Buffer.concat([
    Buffer.from(geometry.buffer),
    Buffer.from(new Uint16Array([0, 2, 1, 0, 3, 2]).buffer),
  ]);
  const info = (index: number, texCoord = 0) => ({ index, texCoord });
  const document = {
    asset: {
      version: '2.0',
      generator: 'Frameforge texture integration',
      copyright: 'Frameforge contributors; original geometry and pixels, MIT',
    },
    scene: 0,
    scenes: [{ name: 'Texture study', nodes: [0, 1, 2] }],
    nodes: [
      { name: 'Textured panel', mesh: 0, translation: [0, 1, 0] },
      { name: 'Texture camera', camera: 0, translation: [0, 1, 6] },
      {
        name: 'Texture light',
        translation: [1, 3, 4],
        extensions: { KHR_lights_punctual: { light: 0 } },
      },
    ],
    cameras: [{ type: 'perspective', perspective: { yfov: Math.PI / 4, znear: 0.1, zfar: 100 } }],
    meshes: [
      {
        name: 'UV panel',
        primitives: [
          {
            attributes: { POSITION: 0, NORMAL: 1, TANGENT: 2, TEXCOORD_0: 3, TEXCOORD_1: 4 },
            indices: 5,
            material: 0,
          },
        ],
      },
    ],
    materials: [
      {
        name: 'Five maps',
        pbrMetallicRoughness: {
          baseColorFactor: [1, 1, 1, 1],
          metallicFactor: 0.1,
          roughnessFactor: 0.8,
          baseColorTexture: info(0),
          metallicRoughnessTexture: info(1),
        },
        normalTexture: { ...info(1), scale: 0.2 },
        occlusionTexture: { ...info(1, 1), strength: 0.3 },
        emissiveTexture: info(0),
        emissiveFactor: [0.05, 0.05, 0.05],
        alphaMode: 'MASK',
        alphaCutoff: 0.6,
        doubleSided: true,
      },
    ],
    images: [
      { name: 'Four colors', mimeType: 'image/png', uri: 'color.png' },
      { name: 'Channel data', mimeType: 'image/png', uri: 'data.png' },
    ],
    textures: [
      { source: 0, sampler: 0 },
      { source: 1, sampler: 1 },
    ],
    samplers: [
      { wrapS: 10497, wrapT: 33648, magFilter: 9728, minFilter: 9728 },
      { wrapS: 33071, wrapT: 10497, magFilter: 9729, minFilter: 9987 },
    ],
    extensionsUsed: ['KHR_lights_punctual'],
    extensions: { KHR_lights_punctual: { lights: [{ type: 'point', intensity: 40 }] } },
    buffers: [{ byteLength: buffer.length, uri: 'panel.bin' }],
    bufferViews: [
      { buffer: 0, byteLength: geometry.byteLength, byteStride: 56, target: 34962 },
      { buffer: 0, byteOffset: geometry.byteLength, byteLength: 12, target: 34963 },
    ],
    accessors: [
      {
        bufferView: 0,
        byteOffset: 0,
        componentType: 5126,
        count: 4,
        type: 'VEC3',
        min: [-1, -1, 0],
        max: [1, 1, 0],
      },
      { bufferView: 0, byteOffset: 12, componentType: 5126, count: 4, type: 'VEC3' },
      { bufferView: 0, byteOffset: 24, componentType: 5126, count: 4, type: 'VEC4' },
      { bufferView: 0, byteOffset: 40, componentType: 5126, count: 4, type: 'VEC2' },
      { bufferView: 0, byteOffset: 48, componentType: 5126, count: 4, type: 'VEC2' },
      { bufferView: 1, componentType: 5123, count: 6, type: 'SCALAR' },
    ],
  };
  return {
    document,
    files: [
      { name: 'panel.bin', bytes: buffer },
      { name: 'color.png', bytes: color },
      { name: 'data.png', bytes: data },
    ],
  };
}
