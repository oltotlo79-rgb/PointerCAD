import type { SolidBody, Vec3 } from '@pointercad/model';
import { describe, expect, it } from 'vitest';
import { bodyFor } from '../store/testing/createTestStore.js';
import { faceScreenRect } from './faceScreenRect.js';
import { subShapeElementId } from './subShapeSelection.js';

/**
 * 板のボディ。面 0 は上面(局所の x 0〜40・y 0〜30・z 10、三角形 2 枚)、面 1 は三角形の無い面、面 2 は範囲が表の外の面。
 * 局所の座標の原点は世界の (100, 0, 0)。
 */
function plate(): SolidBody {
  return {
    ...bodyFor('extrude-1'),
    mesh: {
      positions: new Float32Array([0, 0, 10, 40, 0, 10, 40, 30, 10, 0, 30, 10]),
      normals: new Float32Array(12),
      indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
      edgePositions: new Float32Array(6),
      triangleCount: 2,
    },
    faces: [
      { index: 0, surfaceKind: 'plane', area: 1200, centroid: [20, 15, 10], axis: [0, 0, 1], radius: null,
        triangleOffset: 0, triangleCount: 2 },
      { index: 1, surfaceKind: 'plane', area: 0, centroid: [0, 0, 0], axis: [0, 0, 1], radius: null,
        triangleOffset: 2, triangleCount: 0 },
      { index: 2, surfaceKind: 'plane', area: 0, centroid: [0, 0, 0], axis: [0, 0, 1], radius: null,
        triangleOffset: 1, triangleCount: 5 },
    ],
    coordinateFrame: { space: 'local', origin: [100, 0, 0], maximumFloat32ErrorMm: 0.01, maximumLiveMeshBytes: 1000 },
  };
}

/** 世界の x・y をそのまま画素の 2 倍へ写す(z は見ない)。 */
const project = (point: Vec3): readonly [number, number] => [point[0] * 2, point[1] * 2];

describe('選んだ面が画面に写る外形の箱(M-10 ①)', () => {
  it('面の三角形の頂点を、局所の原点を足してから写し、囲む箱を返す', () => {
    expect(faceScreenRect([plate()], subShapeElementId('extrude-1', 'face', 0), project))
      .toEqual({ left: 200, top: 0, right: 280, bottom: 60 });
  });

  it('面でない id・無いボディや面・三角形の無い面・範囲が表の外の面・写せない点がある面は null', () => {
    const bodies = [plate()];
    expect(faceScreenRect(bodies, subShapeElementId('extrude-1', 'edge', 0), project)).toBeNull();
    expect(faceScreenRect(bodies, 'extrude-1', project)).toBeNull();
    expect(faceScreenRect(bodies, subShapeElementId('other-1', 'face', 0), project)).toBeNull();
    expect(faceScreenRect(bodies, subShapeElementId('extrude-1', 'face', 9), project)).toBeNull();
    expect(faceScreenRect(bodies, subShapeElementId('extrude-1', 'face', 1), project)).toBeNull();
    expect(faceScreenRect(bodies, subShapeElementId('extrude-1', 'face', 2), project)).toBeNull();
    expect(faceScreenRect(bodies, subShapeElementId('extrude-1', 'face', 0), () => null)).toBeNull();
  });
});
