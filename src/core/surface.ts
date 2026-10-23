import {
  BufferGeometry,
  Color,
  Float32BufferAttribute,
  MeshStandardMaterial,
  DoubleSide,
  FrontSide,
} from 'three';
import type { Geometry, Project, Vec3 } from './model';

export function linearColor(color: string, linear?: Vec3) {
  return linear ? new Color().setRGB(...linear) : new Color(color);
}
export function displayColor(linear: Vec3) {
  return '#' + new Color().setRGB(...linear).getHexString();
}
export function surfaceGeometry(g: Geometry) {
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(g.positions.flat(), 3));
  geometry.setIndex(g.triangles.flat());
  if (g.normals) geometry.setAttribute('normal', new Float32BufferAttribute(g.normals.flat(), 3));
  else geometry.computeVertexNormals();
  if (g.uv) geometry.setAttribute('uv', new Float32BufferAttribute(g.uv.flat(), 2));
  if (g.uv1) geometry.setAttribute('uv1', new Float32BufferAttribute(g.uv1.flat(), 2));
  if (g.tangents)
    geometry.setAttribute('tangent', new Float32BufferAttribute(g.tangents.flat(), 4));
  return geometry;
}
export function surfaceMaterial(m: Project['materials'][number]) {
  const alpha = m.alphaMode || 'OPAQUE';
  return new MeshStandardMaterial({
    color: linearColor(m.color, m.linearColor),
    emissive: new Color().setRGB(...(m.emissive || [0, 0, 0])),
    roughness: m.roughness,
    metalness: m.metalness,
    opacity: alpha === 'OPAQUE' ? 1 : (m.opacity ?? 1),
    transparent: alpha === 'BLEND',
    depthWrite: alpha !== 'BLEND',
    alphaTest: alpha === 'MASK' ? (m.alphaCutoff ?? 0.5) : 0,
    flatShading: m.flatShading ?? true,
    side: (m.doubleSided ?? true) ? DoubleSide : FrontSide,
  });
}
