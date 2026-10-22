import { id, identity, parseProject, type Project } from './model';
import { primitive } from './geometry';

export function newProject(name = '未命名作品'): Project {
  const sceneId = id(),
    cameraId = id(),
    meshId = id(),
    materialId = id(),
    shotId = id(),
    timelineNode = id(),
    renderNode = id();
  const geometry = primitive('box');
  const p: Project = {
    format: 'frameforge-project',
    schemaVersion: 3,
    id: id(),
    name,
    revision: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    conventions: {
      units: 'metres',
      coordinates: 'right-handed-y-up',
      rotation: 'euler-xyz-radians',
      color: 'srgb-input-linear-working-aces-output',
      time: 'integer-frames-zero-based-half-open',
    },
    scenes: [{ id: sceneId, name: '主场景', background: '#19212e', ambient: 0.8 }],
    entities: [
      {
        id: meshId,
        name: '立方体',
        kind: 'mesh',
        sceneId,
        parentId: null,
        geometryId: geometry.id,
        materialId,
        visible: true,
        transform: { ...identity(), position: [0, 1, 0] },
      },
      {
        id: cameraId,
        name: '摄影机',
        kind: 'camera',
        sceneId,
        parentId: null,
        visible: true,
        transform: {
          ...identity(),
          position: [6, 4, 8],
          rotation: [-Math.atan2(3, 8), Math.atan2(6, Math.hypot(3, 8)), 0],
        },
        camera: { fov: 45, near: 0.1, far: 1000 },
      },
      {
        id: id(),
        name: '主光',
        kind: 'light',
        sceneId,
        parentId: null,
        visible: true,
        transform: { ...identity(), position: [4, 7, 3] },
        light: { kind: 'point', color: '#fff0dc', intensity: 120 },
      },
    ],
    geometries: [geometry],
    materials: [
      { id: materialId, name: '珊瑚橙', color: '#ef8859', roughness: 0.4, metalness: 0.15 },
    ],
    animationTracks: [],
    assets: [],
    shots: [{ id: shotId, name: '镜头 01', sceneId, cameraId }],
    timeline: {
      id: id(),
      fps: 24,
      duration: 120,
      width: 960,
      height: 540,
      clips: [
        {
          id: id(),
          name: '镜头 01',
          kind: 'shot',
          sourceId: shotId,
          start: 0,
          duration: 120,
          sourceIn: 0,
          channel: 0,
          muted: false,
          volume: 1,
          fit: 'contain',
        },
      ],
    },
    workflows: [
      {
        id: id(),
        name: '时间轴成片',
        nodes: [
          { id: timelineNode, name: '项目时间轴', kind: 'timeline', x: 24, y: 50 },
          { id: renderNode, name: '渲染 MP4', kind: 'render', x: 280, y: 50 },
        ],
        edges: [{ from: timelineNode, to: renderNode }],
      },
    ],
    artifacts: [],
  };
  return parseProject(p);
}
