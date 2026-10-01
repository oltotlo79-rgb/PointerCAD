import * as THREE from 'three';
import { describe, expect, it } from 'vitest';

import { createRegionGeometry, createViewCubeGeometry, VIEW_CUBE_BEVEL } from './viewCubeGeometry.js';
import { regionFromLocalPoint } from './viewCubeMath.js';

describe('view cube bevel and hover surfaces', () => {
  it('is closed, outward-facing and uses only 44 triangles and one material', () => {
    const geometry = createViewCubeGeometry();
    const positions = geometry.getAttribute('position');
    expect(positions.count / 3).toBe(44);
    expect(geometry.groups).toHaveLength(0);
    const edges = new Map<string, number>();
    const key = (point: THREE.Vector3): string => point.toArray().map(value => value.toFixed(5)).join(',');
    for (let index = 0; index < positions.count; index += 3) {
      const points = [0, 1, 2].map(offset => new THREE.Vector3().fromBufferAttribute(positions, index + offset));
      const normal = points[1].clone().sub(points[0]).cross(points[2].clone().sub(points[0]));
      expect(normal.length()).toBeGreaterThan(0);
      expect(normal.dot(points[0])).toBeGreaterThan(0);
      for (let edge = 0; edge < 3; edge += 1) {
        const edgeKey = [key(points[edge]), key(points[(edge + 1) % 3])].sort().join('|');
        edges.set(edgeKey, (edges.get(edgeKey) ?? 0) + 1);
      }
    }
    expect([...edges.values()].every(count => count === 2)).toBe(true);
    geometry.computeBoundingBox();
    expect(geometry.boundingBox?.min.toArray()).toEqual([-1, -1, -1]);
    expect(geometry.boundingBox?.max.toArray()).toEqual([1, 1, 1]);
    geometry.dispose();
  });

  it('maps all six labels upright to their own atlas tile, including front -Y after rotation', () => {
    const geometry = createViewCubeGeometry();
    const uv = geometry.getAttribute('uv');
    const positions = geometry.getAttribute('position');
    const world = new THREE.Matrix4().makeRotationX(Math.PI / 2);
    for (let face = 0; face < 6; face += 1) {
      for (let vertex = 0; vertex < 6; vertex += 1) {
        const index = face * 6 + vertex;
        expect(Math.floor(uv.getX(index) * 4)).toBe(face % 4);
        expect(Math.floor((1 - uv.getY(index)) * 2)).toBe(Math.floor(face / 4));
      }
      // First edge of each quad points toward the right of its label.
      expect(uv.getX(face * 6 + 1)).toBeGreaterThan(uv.getX(face * 6));
      expect(uv.getY(face * 6 + 2)).toBeGreaterThan(uv.getY(face * 6 + 1));
    }
    const front = new THREE.Vector3().fromBufferAttribute(positions, 4 * 6).applyMatrix4(world);
    expect(front.y).toBeCloseTo(-1, 7);
    expect(front.z).toBeCloseTo(-(1 - VIEW_CUBE_BEVEL), 7);
    geometry.dispose();
  });

  it('keeps every hover vertex inside its original face, edge or corner region', () => {
    const cube = createViewCubeGeometry();
    let count = 0;
    for (const x of [-1, 0, 1] as const) {
      for (const y of [-1, 0, 1] as const) {
        for (const z of [-1, 0, 1] as const) {
          if (x === 0 && y === 0 && z === 0) continue;
          const region = { x, y, z };
          const geometry = createRegionGeometry(cube, region);
          const positions = geometry.getAttribute('position');
          expect(positions.count).toBeGreaterThan(0);
          for (let index = 0; index < positions.count; index += 1) {
            const point = new THREE.Vector3().fromBufferAttribute(positions, index).divideScalar(1.006);
            for (const [axis, sign] of [x, y, z].entries()) {
              const coordinate = point.getComponent(axis);
              if (sign === 0) expect(Math.abs(coordinate)).toBeLessThanOrEqual(0.500001);
              else expect(coordinate * sign).toBeGreaterThanOrEqual(0.499999);
              expect(Math.abs(coordinate)).toBeLessThanOrEqual(1.000001);
            }
          }
          // Its interior still resolves through the unmodified hit classifier.
          expect(regionFromLocalPoint([x, y, z])).toEqual(region);
          geometry.dispose();
          count += 1;
        }
      }
    }
    expect(count).toBe(26);
    cube.dispose();
  });

  it.each([
    { face: 2, name: 'upper', upY: 1, normalZ: 1 },
    { face: 3, name: 'lower', upY: -1, normalZ: -1 },
  ])('points the $name label up along world Y=$upY without mirroring', ({ face, upY, normalZ }) => {
    const geometry = createViewCubeGeometry();
    const positions = geometry.getAttribute('position');
    const uv = geometry.getAttribute('uv');
    const rotation = new THREE.Matrix4().makeRotationX(Math.PI / 2);
    const first = face * 6;
    // CanvasTexture.flipY makes increasing V point to the top of the glyph.
    expect(uv.getX(first + 1)).toBeGreaterThan(uv.getX(first));
    expect(uv.getY(first + 1)).toBe(uv.getY(first));
    expect(uv.getX(first + 2)).toBe(uv.getX(first + 1));
    expect(uv.getY(first + 2)).toBeGreaterThan(uv.getY(first + 1));
    const bottomLeft = new THREE.Vector3().fromBufferAttribute(positions, first).applyMatrix4(rotation);
    const bottomRight = new THREE.Vector3().fromBufferAttribute(positions, first + 1).applyMatrix4(rotation);
    const topRight = new THREE.Vector3().fromBufferAttribute(positions, first + 2).applyMatrix4(rotation);
    const right = bottomRight.clone().sub(bottomLeft).normalize();
    const up = topRight.clone().sub(bottomRight).normalize();
    expect(up.x).toBeCloseTo(0, 12);
    expect(up.y).toBeCloseTo(upY, 12);
    expect(up.z).toBeCloseTo(0, 12);
    expect(right.x).toBeCloseTo(1, 12);
    expect(right.y).toBeCloseTo(0, 12);
    expect(right.z).toBeCloseTo(0, 12);
    expect(right.cross(up).z).toBeCloseTo(normalZ, 12);
    expect(topRight.z).toBeCloseTo(normalZ, 12);
    geometry.dispose();
  });

  it('bakes directional bevel shading without adding triangles or materials', () => {
    const geometry = createViewCubeGeometry();
    const colors = geometry.getAttribute('color');
    expect(colors.count).toBe(132);
    for (let index = 0; index < 36; index += 1) expect(colors.getX(index)).toBe(1);
    const shades = Array.from({ length: colors.count - 36 }, (_value, index) => colors.getX(index + 36));
    expect(Math.max(...shades) - Math.min(...shades)).toBeGreaterThan(0.1);
    expect(Math.min(...shades)).toBeGreaterThan(0.8);
    expect(Math.max(...shades)).toBeLessThan(1);
    geometry.dispose();
  });
});
