// Original asymmetric bar and motion data, shared by integrated checks and editable examples.
export function animationExchangeFixture() {
  const parts: Uint8Array[] = [],
    views: { buffer: number; byteOffset: number; byteLength: number; target?: number }[] = [];
  const accessors: {
    bufferView: number;
    componentType: number;
    count: number;
    type: string;
    min?: number[];
    max?: number[];
  }[] = [];
  let length = 0;
  const add = (
    values: number[],
    width: number,
    kind: 'geometry' | 'index' | 'time' | 'animation',
  ) => {
    const data = kind === 'index' ? new Uint16Array(values) : new Float32Array(values),
      bytes = new Uint8Array(data.buffer),
      padded = new Uint8Array(Math.ceil(bytes.length / 4) * 4);
    padded.set(bytes);
    views.push({
      buffer: 0,
      byteOffset: length,
      byteLength: bytes.length,
      ...(kind === 'geometry' || kind === 'index'
        ? { target: kind === 'index' ? 34963 : 34962 }
        : {}),
    });
    parts.push(padded);
    length += padded.length;
    const bounds =
      kind === 'time' || kind === 'geometry'
        ? {
            min: Array.from({ length: width }, (_, i) =>
              Math.min(...values.filter((_, j) => j % width === i)),
            ),
            max: Array.from({ length: width }, (_, i) =>
              Math.max(...values.filter((_, j) => j % width === i)),
            ),
          }
        : {};
    accessors.push({
      bufferView: views.length - 1,
      componentType: kind === 'index' ? 5123 : 5126,
      count: values.length / width,
      type: width === 1 ? 'SCALAR' : `VEC${width}`,
      ...bounds,
    });
    return accessors.length - 1;
  };
  const position = add(
    [
      -0.8, -0.22, -0.2, 0.8, -0.22, -0.2, 0.8, 0.22, -0.2, -0.8, 0.22, -0.2, -0.8, -0.22, 0.2, 0.8,
      -0.22, 0.2, 0.8, 0.22, 0.2, -0.8, 0.22, 0.2,
    ],
    3,
    'geometry',
  );
  const indices = add(
    [
      0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 3, 7, 6, 3, 6, 2, 0, 4, 7, 0, 7, 3, 1,
      2, 6, 1, 6, 5,
    ],
    1,
    'index',
  );
  const time = add([0, 0.35, 1.1], 1, 'time'),
    shortTime = add([0, 1.1], 1, 'time');
  const path = add(
    [0, 0, 0, -1, 1, 0, 2, 3, 0, 2, 0, 0, 0, 1.8, 0, 2, -1, 0, 1, 0, 0, 1.2, 1, 0, 0, 0, 0],
    3,
    'animation',
  );
  const rotation = add(
    [
      0,
      0,
      0,
      1,
      0,
      0,
      Math.sin(Math.PI / 3),
      Math.cos(Math.PI / 3),
      0,
      0,
      Math.sin((2 * Math.PI) / 3),
      Math.cos((2 * Math.PI) / 3),
    ],
    4,
    'animation',
  );
  const hold = add([1, 1, 0, -1, 1, 0], 3, 'animation');
  const cubicRotation = add(
    [0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0, -1, 0, 0, 1, 0, 0, 0, 0, 0],
    4,
    'animation',
  );
  const scale = add([1, 0.7, 1, 1, 1.3, 1], 3, 'animation');
  const buffer = Buffer.concat(parts.map((p) => Buffer.from(p)));
  const document = {
    asset: {
      version: '2.0',
      generator: 'Frameforge original animation exchange',
      copyright: 'Frameforge contributors; original geometry and motion, MIT',
    },
    scene: 0,
    scenes: [
      { name: 'Animation exchange', nodes: [0, 2, 3] },
      { name: 'Shared motion', nodes: [0] },
    ],
    nodes: [
      { name: 'Motion root', children: [1], translation: [-1, 1, 0] },
      { name: 'Animated bar', mesh: 0, rotation: [0, 0, 0, 1] },
      { name: 'Motion camera', camera: 0, translation: [0, 1, 7] },
      {
        name: 'Motion light',
        translation: [2, 4, 5],
        extensions: { KHR_lights_punctual: { light: 0 } },
      },
    ],
    meshes: [
      {
        name: 'Motion bar',
        primitives: [{ attributes: { POSITION: position }, indices, material: 0 }],
      },
    ],
    materials: [
      {
        name: 'Motion red',
        pbrMetallicRoughness: {
          baseColorFactor: [0.7, 0.07, 0.025, 1],
          metallicFactor: 0.05,
          roughnessFactor: 0.7,
        },
      },
    ],
    cameras: [{ type: 'perspective', perspective: { yfov: Math.PI / 4, znear: 0.1, zfar: 100 } }],
    extensionsUsed: ['KHR_lights_punctual'],
    extensions: { KHR_lights_punctual: { lights: [{ type: 'point', intensity: 100 }] } },
    buffers: [
      {
        byteLength: buffer.length,
        uri: 'data:application/octet-stream;base64,' + buffer.toString('base64'),
      },
    ],
    bufferViews: views,
    accessors,
    animations: [
      {
        name: 'Arc and turn',
        channels: [
          { sampler: 0, target: { node: 0, path: 'translation' } },
          { sampler: 1, target: { node: 1, path: 'rotation' } },
        ],
        samplers: [
          { input: time, output: path, interpolation: 'CUBICSPLINE' },
          { input: time, output: rotation, interpolation: 'LINEAR' },
        ],
      },
      {
        name: 'Hold and tilt',
        channels: [
          { sampler: 0, target: { node: 0, path: 'translation' } },
          { sampler: 1, target: { node: 1, path: 'rotation' } },
          { sampler: 2, target: { node: 1, path: 'scale' } },
        ],
        samplers: [
          { input: shortTime, output: hold, interpolation: 'STEP' },
          { input: shortTime, output: cubicRotation, interpolation: 'CUBICSPLINE' },
          { input: shortTime, output: scale, interpolation: 'LINEAR' },
        ],
      },
    ],
  };
  return document;
}
