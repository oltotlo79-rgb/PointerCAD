import type { SolidBody, SolidEdgeEntry, Vec3, WeldBodyLookup } from '@pointercad/model';

/** 当たりの判定に使う、平らな面 1 枚(四角形)とその 4 辺だけのボディ(部品座標、実カーネルの結果と同じ形)。 */
export function planeBody(corners: readonly [Vec3, Vec3, Vec3, Vec3], normal: Vec3): SolidBody {
  const edges = corners.map((start, index): SolidEdgeEntry => {
    const end = corners[(index + 1) % 4] ?? start;
    const length = Math.hypot(end[0] - start[0], end[1] - start[1], end[2] - start[2]);
    return { index, curveKind: 'line', length, start, end, radius: null, segmentOffset: 0, segmentCount: 0,
      midpoint: [(start[0] + end[0]) / 2, (start[1] + end[1]) / 2, (start[2] + end[2]) / 2],
      axis: [(end[0] - start[0]) / length, (end[1] - start[1]) / length, (end[2] - start[2]) / length] };
  });
  return {
    featureId: 'extrude-1', volume: 1, isValid: true, vertices: [], threadMarks: [], edges,
    mesh: { positions: new Float32Array(corners.flat()), normals: new Float32Array(12), indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
      edgePositions: new Float32Array(0), triangleCount: 2 },
    faces: [{ index: 0, surfaceKind: 'plane', area: 1, axis: normal, radius: null, triangleOffset: 0, triangleCount: 2,
      centroid: [(corners[0][0] + corners[2][0]) / 2, (corners[0][1] + corners[2][1]) / 2, (corners[0][2] + corners[2][2]) / 2] }],
  };
}

/** 立板(部品 standing)の側面 y=8(x 0〜100、z 0〜50)と底板(部品 base)の上面 z=10(x 0〜100、y 0〜60)。 */
export const TEE_PLANE_BODIES: WeldBodyLookup = (component) => component.source.kind !== 'part' ? null
  : component.source.partRef === 'standing' ? [planeBody([[0, 8, 0], [100, 8, 0], [100, 8, 50], [0, 8, 50]], [0, 1, 0])]
    : component.source.partRef === 'base' ? [planeBody([[0, 0, 10], [100, 0, 10], [100, 60, 10], [0, 60, 10]], [0, 0, 1])] : null;
