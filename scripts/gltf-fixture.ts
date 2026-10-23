import { Euler, Quaternion } from 'three';
// Original small scene authored for exchange integration. No third-party model or textures.
export function gltfFixture() {
  const positions = [
    [1, 0, 0],
    [-1, 0, 0],
    [0, 1, 0],
    [0, -1, 0],
    [0, 0, 1],
    [0, 0, -1],
  ];
  const indices = [2, 4, 0, 2, 1, 4, 2, 5, 1, 2, 0, 5, 3, 0, 4, 3, 4, 1, 3, 1, 5, 3, 5, 0];
  const buffer = new Uint8Array(6 * 32 + indices.length * 2),
    view = new DataView(buffer.buffer);
  positions.forEach((p, i) => {
    [...p, ...p, i / 5, i % 2].forEach((v, j) => view.setFloat32(i * 32 + j * 4, v, true));
  });
  indices.forEach((v, i) => view.setUint16(192 + i * 2, v, true));
  return {
    asset: {
      version: '2.0',
      generator: 'Frameforge original exchange scene',
      copyright: 'Frameforge contributors; original geometry, MIT',
    },
    scene: 0,
    scenes: [
      { name: 'Exchange study', nodes: [0, 3, 4, 5] },
      { name: 'Shared alternative', nodes: [0] },
    ],
    nodes: [
      {
        name: 'Imported assembly',
        children: [1, 2],
        translation: [0, 1.2, 0],
        rotation: [0, Math.sin(0.2), 0, Math.cos(0.2)],
        scale: [1.1, 0.9, 1.3],
      },
      { name: 'First instance', mesh: 0, translation: [-1.4, 0, 0] },
      { name: 'Second instance', mesh: 0, translation: [1.4, 0, 0], scale: [0.8, 1.2, 0.8] },
      {
        name: 'Imported camera',
        camera: 0,
        translation: [6, 4, 8],
        rotation: new Quaternion()
          .setFromEuler(new Euler(-Math.atan2(3, 8), Math.atan2(6, Math.hypot(3, 8)), 0))
          .toArray(),
      },
      {
        name: 'Imported point',
        translation: [4, 7, 3],
        extensions: { KHR_lights_punctual: { light: 0 } },
      },
      {
        name: 'Imported sun',
        rotation: [-Math.sin(0.4), 0, 0, Math.cos(0.4)],
        extensions: { KHR_lights_punctual: { light: 1 } },
      },
    ],
    meshes: [
      {
        name: 'Smooth octahedron',
        primitives: [
          { attributes: { POSITION: 0, NORMAL: 1, TEXCOORD_0: 2 }, indices: 3, material: 0 },
        ],
      },
    ],
    materials: [
      {
        name: 'Linear copper',
        pbrMetallicRoughness: {
          baseColorFactor: [0.72, 0.18, 0.04321, 0.7],
          metallicFactor: 0.15,
          roughnessFactor: 0.42,
        },
        emissiveFactor: [0.025, 0.005, 0],
        alphaMode: 'BLEND',
        doubleSided: true,
      },
    ],
    cameras: [{ type: 'perspective', perspective: { yfov: Math.PI / 4, znear: 0.1, zfar: 1000 } }],
    extensionsUsed: ['KHR_lights_punctual'],
    extensions: {
      KHR_lights_punctual: {
        lights: [
          { type: 'point', color: [1, 0.9, 0.8], intensity: 80, range: 25 },
          { type: 'directional', color: [0.4, 0.6, 1], intensity: 1.2 },
        ],
      },
    },
    buffers: [
      {
        byteLength: buffer.length,
        uri: 'data:application/octet-stream;base64,' + Buffer.from(buffer).toString('base64'),
      },
    ],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: 192, byteStride: 32, target: 34962 },
      { buffer: 0, byteOffset: 192, byteLength: indices.length * 2, target: 34963 },
    ],
    accessors: [
      {
        bufferView: 0,
        byteOffset: 0,
        componentType: 5126,
        count: 6,
        type: 'VEC3',
        min: [-1, -1, -1],
        max: [1, 1, 1],
      },
      { bufferView: 0, byteOffset: 12, componentType: 5126, count: 6, type: 'VEC3' },
      { bufferView: 0, byteOffset: 24, componentType: 5126, count: 6, type: 'VEC2' },
      { bufferView: 1, byteOffset: 0, componentType: 5123, count: indices.length, type: 'SCALAR' },
    ],
  };
}
