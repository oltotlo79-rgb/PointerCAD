import type { AnalysisBoundaryMesh, SolidBody, SubShapeOrigin } from '@pointercad/model';
import type { CadTetraContext } from '@pointercad/fem';
export const boundaryOptions = { boundary: 'closed' as const, linearDeflection: 0.05, angularDeflection: 0.2 };
const coordinates = [0, 0, 0, 2, 0, 0, 2, 3, 0, 0, 3, 0, 0, 0, 4, 2, 0, 4, 2, 3, 4, 0, 3, 4];
const triangles = [0, 3, 2, 0, 2, 1, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4,
  1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7];
const tags = [0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5];
const roles = ['bottom', 'top', 'front', 'right', 'back', 'left'] as const;
const origins: readonly SubShapeOrigin[] = roles.map(role => ({ version: 1, shapeKind: 'face',
  identity: { kind: 'box-face', featureId: 'box', role } }));
export function context(): CadTetraContext {
  const body: SolidBody = { featureId: 'box', bodyKind: 'solid', isValid: true, volume: 24,
    mesh: { positions: new Float32Array(), normals: new Float32Array(), indices: new Uint32Array(),
      edgePositions: new Float32Array(), triangleCount: 0 }, edges: [], vertices: [], threadMarks: [],
    faces: roles.map((_, index): SolidBody['faces'][number] => ({ index, surfaceKind: 'plane', area: index < 2 ? 6 : 12,
      centroid: [0, 0, 0], axis: [0, 0, 1], radius: null, triangleOffset: index * 2, triangleCount: 2 })),
    origins: { version: 1, state: 'tracked', bindings: origins.map((origin, index) => ({ origin, state: 'unique',
      current: { kind: 'face', index } })) } };
  return { documentId: 'part', revision: 7, body, steps: [{ featureId: 'box', key: 'box:7' }] };
}
export function boundaryMesh(): AnalysisBoundaryMesh {
  return { units: 'mm', boundary: 'closed', coordinates: Float64Array.from(coordinates),
    shells: [{ role: 'outer', triangles: Array.from({ length: 12 }, (_, i) => i) }],
    triangles: Uint32Array.from(triangles), triangleFaces: Uint32Array.from(tags), nodeKinds: new Uint8Array(8).fill(2),
    nodeCount: 8, triangleCount: 12, edges: [], faces: roles.map((_, index) => ({ index, triangleCount: 2,
      reversed: false, seamEdges: 0, degeneratedEdges: 0, collapsedPoleTriangles: 0 })),
    mesher: { done: true, status: 0 }, deflection: { linear: 0.05, angular: 0.2 }, metrics: {
      totalAreaMm2: 52, signedVolumeMm3: 24, minTriangleAreaMm2: 3, maxTriangleAreaMm2: 6,
      minAngleDeg: 30, maxAngleDeg: 90, maxBoundNodeOffsetMm: 0, freeEdges: 0, components: 1 } };
}
