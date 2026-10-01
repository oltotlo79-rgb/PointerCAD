import * as THREE from 'three';

import { REGION_THRESHOLD, type ViewCubeRegion } from './viewCubeMath.js';

/** A small, flat bevel: 44 triangles for the complete cube, without lights or shadows. */
export const VIEW_CUBE_BEVEL = 0.12;
export const ATLAS_COLUMNS = 4;
export const ATLAS_ROWS = 2;

/** Local Y-up faces, in BoxGeometry order. The scene rotates them to Z-up. */
const FACE_BASES = [
  [[1, 0, 0], [0, 0, -1], [0, 1, 0]],
  [[-1, 0, 0], [0, 0, 1], [0, 1, 0]],
  // After the X +90-degree rotation, the upper label points up toward back +Y.
  [[0, 1, 0], [1, 0, 0], [0, 0, -1]],
  // Viewed from below, the lower label points up toward front -Y.
  [[0, -1, 0], [1, 0, 0], [0, 0, 1]],
  [[0, 0, 1], [1, 0, 0], [0, 1, 0]],
  [[0, 0, -1], [-1, 0, 0], [0, 1, 0]],
] as const;

/** All faces and bevels share one texture and one draw call. */
export function createViewCubeGeometry(): THREE.BufferGeometry {
  const positions: number[] = [];
  const uvs: number[] = [];
  const shades: number[] = [];
  const inner = 1 - VIEW_CUBE_BEVEL;
  const light = new THREE.Vector3(-0.2, 0.85, 0.48).normalize();

  function polygon(points: THREE.Vector3[], tile: number): void {
    const normal = points[1].clone().sub(points[0]).cross(points[2].clone().sub(points[0]));
    if (normal.dot(points[0]) < 0) {
      points.reverse();
      normal.negate();
    }
    // Bake the bevel's orientation into the same mesh; no lights or extra draws.
    const shade = tile < 6 ? 1 : 0.82 + 0.18 * Math.max(0, normal.normalize().dot(light));
    const corners = [[0, 0], [1, 0], [1, 1], [0, 1]] as const;
    for (let triangle = 1; triangle < points.length - 1; triangle += 1) {
      for (const index of [0, triangle, triangle + 1]) {
        positions.push(...points[index].toArray());
        shades.push(shade, shade, shade);
        const [u, v] = corners[index];
        // Inset UVs by one texel to keep neighbouring atlas tiles out of filtering.
        const inset = 1 / 256;
        uvs.push(
          ((tile % ATLAS_COLUMNS) + inset + u * (1 - 2 * inset)) / ATLAS_COLUMNS,
          1 - (Math.floor(tile / ATLAS_COLUMNS) + 1 - inset - v * (1 - 2 * inset)) / ATLAS_ROWS,
        );
      }
    }
  }

  for (const [index, [normal, u, v]] of FACE_BASES.entries()) {
    polygon([[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([x, y]) =>
      new THREE.Vector3(...normal)
        .addScaledVector(new THREE.Vector3(...u), x * inner)
        .addScaledVector(new THREE.Vector3(...v), y * inner)), index);
  }
  for (const [a, b, along] of [[0, 1, 2], [0, 2, 1], [1, 2, 0]]) {
    for (const signA of [-1, 1]) {
      for (const signB of [-1, 1]) {
        polygon([[1, inner, -inner], [inner, 1, -inner], [inner, 1, inner], [1, inner, inner]]
          .map(([x, y, z]) => new THREE.Vector3()
            .setComponent(a, signA * x).setComponent(b, signB * y).setComponent(along, z)), 6);
      }
    }
  }
  for (const x of [-1, 1]) {
    for (const y of [-1, 1]) {
      for (const z of [-1, 1]) {
        polygon([
          new THREE.Vector3(x, y * inner, z * inner),
          new THREE.Vector3(x * inner, y, z * inner),
          new THREE.Vector3(x * inner, y * inner, z),
        ], 6);
      }
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(shades, 3));
  geometry.computeVertexNormals();
  return geometry;
}

/** Clip the visible bevelled surface to the existing 26 hit regions, in world Z-up. */
export function createRegionGeometry(
  cube: THREE.BufferGeometry,
  region: ViewCubeRegion,
): THREE.BufferGeometry {
  const positions = cube.getAttribute('position');
  const output: number[] = [];
  const rotation = new THREE.Matrix4().makeRotationX(Math.PI / 2);
  const planes: THREE.Plane[] = [];
  for (const [axis, sign] of [region.x, region.y, region.z].entries()) {
    const direction = new THREE.Vector3().setComponent(axis, 1);
    if (sign >= 0) planes.push(new THREE.Plane(direction.clone(), sign === 0 ? REGION_THRESHOLD : -REGION_THRESHOLD));
    if (sign <= 0) planes.push(new THREE.Plane(direction.negate(), sign === 0 ? REGION_THRESHOLD : -REGION_THRESHOLD));
  }
  for (let start = 0; start < positions.count; start += 3) {
    let polygon = [0, 1, 2].map(offset => new THREE.Vector3().fromBufferAttribute(positions, start + offset).applyMatrix4(rotation));
    for (const plane of planes) {
      const clipped: THREE.Vector3[] = [];
      for (const [index, current] of polygon.entries()) {
        const next = polygon[(index + 1) % polygon.length];
        const from = plane.distanceToPoint(current), to = plane.distanceToPoint(next);
        if (from >= 0) clipped.push(current);
        if ((from >= 0) !== (to >= 0)) clipped.push(current.clone().lerp(next, from / (from - to)));
      }
      polygon = clipped;
    }
    for (let index = 1; index < polygon.length - 1; index += 1) {
      for (const point of [polygon[0], polygon[index], polygon[index + 1]]) {
        output.push(...point.clone().multiplyScalar(1.006).toArray());
      }
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(output, 3));
  return geometry;
}
