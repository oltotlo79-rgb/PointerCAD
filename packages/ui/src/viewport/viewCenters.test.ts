import { quaternionFromAxisAngle, type SolidBody } from '@pointercad/model';
import { describe, expect, it } from 'vitest';
import { buildSolidGeometry } from './buildSolidGeometry.js';
import type { AssemblyGeometryBundle } from './createAssemblyLayer.js';
import { assemblySurfacePoint, boundsCenter, partSurfacePoint, rayPointAtTargetDepth, rayTriangleDistance } from './viewCenters.js';

/* 設計 2-3・B-08d: 押した所の形の上の点(当たった面の三角形と光線の交点)と、当たらない所の拡大の中心。 */

// 一辺 10 の立方体の +Z の面(z = 10)だけを持つ立体。面 0 = 三角形 2 枚。
function topFace(featureId: string, coordinateFrame?: SolidBody['coordinateFrame']): SolidBody {
  return {
    featureId, volume: 1000, isValid: true, threadMarks: [], edges: [], vertices: [],
    faces: [{ index: 0, surfaceKind: 'plane', area: 100, centroid: [5, 5, 10], axis: [0, 0, 1], radius: null, triangleOffset: 0, triangleCount: 2 }],
    mesh: { positions: new Float32Array([0, 0, 10, 10, 0, 10, 10, 10, 10, 0, 10, 10]), normals: new Float32Array(12),
      indices: new Uint32Array([0, 1, 2, 0, 2, 3]), edgePositions: new Float32Array(0), triangleCount: 2 },
    ...(coordinateFrame === undefined ? {} : { coordinateFrame }),
  };
}
const down = { origin: [3, 4, 100] as const, direction: [0, 0, -1] as const };

describe('光線と三角形', () => {
  it('前にある三角形との距離を返し、外れ・後ろ・平行は null', () => {
    expect(rayTriangleDistance([1, 1, 5], [0, 0, -1], [0, 0, 0], [4, 0, 0], [0, 4, 0])).toBeCloseTo(5, 12);
    expect(rayTriangleDistance([3, 3, 5], [0, 0, -1], [0, 0, 0], [4, 0, 0], [0, 4, 0])).toBeNull();
    expect(rayTriangleDistance([1, 1, -5], [0, 0, -1], [0, 0, 0], [4, 0, 0], [0, 4, 0])).toBeNull();
    expect(rayTriangleDistance([1, 1, 5], [1, 0, 0], [0, 0, 0], [4, 0, 0], [0, 4, 0])).toBeNull();
  });
});

describe('押した所の形の上の点', () => {
  it('部品の画面: 当たった面の三角形と光線の交点(局所の原点を足す)', () => {
    const solid = buildSolidGeometry([topFace('body-1'), topFace('far', { space: 'local', origin: [100, 0, 0], maximumFloat32ErrorMm: 0.001 })], null, []);
    expect(partSurfacePoint(solid, { featureId: 'body-1', faceIndex: 0 }, down)).toEqual([3, 4, 10]);
    expect(partSurfacePoint(solid, { featureId: 'far', faceIndex: 0 }, { ...down, origin: [103, 4, 100] })).toEqual([103, 4, 10]);
    expect(partSurfacePoint(solid, { featureId: 'body-1', faceIndex: 0 }, { ...down, origin: [30, 4, 100] })).toBeNull();
    expect(partSurfacePoint(solid, { featureId: 'body-1', faceIndex: 7 }, down)).toBeNull();
  });

  it('組立の画面: 配置の逆で部品の座標へ写して交わり、配置でワールドへ戻す', () => {
    const assembly: AssemblyGeometryBundle = {
      parts: [{ partKey: 'part', bodies: [topFace('body-1')] }],
      // x 軸の周りに 90° 回すと、+Z の面(z = 10)は y = −10 の面になる(x 0〜10、z 0〜10)。そこから (0, 0, 50) へ動かす。
      instances: [{ componentId: 'component-1', partKey: 'part', visible: true, emphasis: 'none',
        placement: { position: [0, 0, 50], rotation: quaternionFromAxisAngle([1, 0, 0], Math.PI / 2) } }],
    };
    const hit = { componentId: 'component-1', partKey: 'part', bodyFeatureId: 'body-1', faceIndex: 0 };
    const point = assemblySurfacePoint(assembly, hit, { origin: [3, -100, 54], direction: [0, 1, 0] });
    expect(point?.[0]).toBeCloseTo(3, 9);
    expect(point?.[1]).toBeCloseTo(-10, 9);
    expect(point?.[2]).toBeCloseTo(54, 9);
    expect(assemblySurfacePoint(assembly, { ...hit, componentId: 'other' }, down)).toBeNull();
  });
});

describe('当たらない所の拡大の中心と、選んだ物の中心', () => {
  it('注視点を通り視線に垂直な面と光線の交点。平行なら null', () => {
    expect(rayPointAtTargetDepth({ origin: [2, 3, 50], direction: [0, 0, -1] }, [0, 0, 7], [0, 0, -1])).toEqual([2, 3, 7]);
    expect(rayPointAtTargetDepth({ origin: [2, 3, 50], direction: [1, 0, 0] }, [0, 0, 7], [0, 0, -1])).toBeNull();
    expect(boundsCenter({ min: [0, -2, 4], max: [10, 2, 8] })).toEqual([5, 0, 6]);
  });
});
