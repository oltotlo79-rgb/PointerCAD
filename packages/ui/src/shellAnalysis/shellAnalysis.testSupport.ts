import type { CadShellAnalysisResult } from '@pointercad/fem';
import type { AnalysisBoundaryMesh, AnalysisBoundarySource, SolidBody, SubShapeOrigin } from '@pointercad/model';
import type { ShellCadSavedInput } from '@pointercad/model/beam-analysis';

/** Literal result fixture for display/state tests: every number is written here, none comes from the solver.
 * One element whose single integration point has top xx = `top`, yy = 5 and the mirrored bottom; one node with
 * displacement (3, 4, 0) mm and rotation (0, 0, 0.5) rad; reactions (1, 2, 3) and (-1, 0, 0) N. */
export function literalShellResult(geometry: ShellCadSavedInput, faceKey: string, top: number): CadShellAnalysisResult {
  const zero = [0, 0, 0, 0, 0, 0] as const;
  const shell: CadShellAnalysisResult['shell'] = { schema: 'pointercad-shell-tri3-result/1',
    source: { documentId: geometry.source.documentId, revision: 1, meshKey: 'literal' },
    element: { record: 'tr_shell02', className: 'TR_SHELL02', crossSection: 'SimpleCrossSection' }, displacement: [zero],
    reactions: [[1, 2, 3, 0, 0, 0], [-1, 0, 0, 0, 0, 0]],
    checks: { freeResidualRelative: 1e-12, balanceRelative: 1e-13, minimumScaledPivot: 1, refactorizationDifferenceRelative: 0 },
    elements: [], recovery: { status: 'unavailable', code: 'nonplanar', reason: 'literal test fixture' } };
  return { schema: 'pointercad-cad-shell-result/1', saved: geometry,
    source: { documentId: geometry.source.documentId, revision: 1, featureId: geometry.bodyFeatureId, bodyKey: 'literal' },
    midsurface: { offsetMm: 0, shiftMm: [0, 0, 0] }, faces: [],
    elements: [{ element: 0, faceKey, nodes: [0, 1, 2], thicknessMm: geometry.thicknessMm, displacement: [zero, zero, zero],
      points: [{ xyzMm: [0, 0, 0], referenceXyzMm: [0, 0, 0], topMPa: [top, 5, 0, 0, 0, 0], bottomMPa: [-top, -5, 0, 0, 0, 0] }] }],
    nodes: [{ node: 0, xyzMm: [0, 0, 0], referenceXyzMm: [0, 0, 0], faceKeys: [faceKey], displacement: [3, 4, 0, 0, 0, 0.5] }], shell };
}

/** A flat 40 x 30 mm CAD sheet (one planar face, normal +Z) as the recompute would report it: 4 x 3 cells of 10 mm,
 * edges 0 (y=0), 1 (x=40), 2 (y=30), 3 (x=0) and vertices 0 (0,0), 1 (40,0), 2 (40,30), 3 (0,30), all with tracked
 * origins. Same literal layout as the fem cadShellAnalysis test plate (unmoved grid); no solver output is used. */
type Point = readonly [number, number, number];
const NX = 4, NY = 3, LENGTH = 40, WIDTH = 30;
const at = (i: number, j: number): number => j * (NX + 1) + i;
const range = (from: number, to: number): number[] =>
  Array.from({ length: Math.abs(to - from) + 1 }, (_, k) => from + Math.sign(to - from) * k);
const points: Point[] = [];
for (let j = 0; j <= NY; j += 1) for (let i = 0; i <= NX; i += 1) points.push([i * LENGTH / NX, j * WIDTH / NY, 0]);
const triangles: (readonly [number, number, number])[] = [];
for (let j = 0; j < NY; j += 1) for (let i = 0; i < NX; i += 1) {
  const [a, b, c, d] = [at(i, j), at(i + 1, j), at(i + 1, j + 1), at(i, j + 1)];
  triangles.push(...((i + j) % 2 === 0 ? [[a, b, c], [a, c, d]] as const : [[a, b, d], [b, c, d]] as const));
}
const edgeRoles = ['top-front', 'top-right', 'top-back', 'top-left'] as const;
const vertexRoles = ['top-front-left', 'top-front-right', 'top-back-right', 'top-back-left'] as const;
const edgeNodes = [range(0, NX).map(i => at(i, 0)), range(0, NY).map(j => at(NX, j)), range(NX, 0).map(i => at(i, NY)),
  range(NY, 0).map(j => at(0, j))];
const vertexNodes = [at(0, 0), at(NX, 0), at(NX, NY), at(0, NY)];

export function sheetBody(featureId: string, bodyKind: 'shell' | 'solid' = 'shell'): SolidBody {
  const faceOrigin: SubShapeOrigin = { version: 1, shapeKind: 'face', identity: { kind: 'box-face', featureId, role: 'top' } };
  const edgeOrigins = edgeRoles.map((role): SubShapeOrigin => ({ version: 1, shapeKind: 'edge', identity: { kind: 'box-edge', featureId, role } }));
  const vertexOrigins = vertexRoles.map((role): SubShapeOrigin => ({ version: 1, shapeKind: 'vertex',
    identity: { kind: 'box-vertex', featureId, role } }));
  return { featureId, bodyKind, isValid: true, volume: 0,
    mesh: { positions: new Float32Array(), normals: new Float32Array(), indices: new Uint32Array(),
      edgePositions: new Float32Array(), triangleCount: 0 }, threadMarks: [],
    faces: [{ index: 0, surfaceKind: 'plane', area: LENGTH * WIDTH, centroid: [LENGTH / 2, WIDTH / 2, 0], axis: [0, 0, 1], radius: null,
      triangleOffset: 0, triangleCount: triangles.length }],
    edges: edgeNodes.map((nodes, index) => {
      const start = points[nodes[0]], end = points[nodes[nodes.length - 1]];
      const length = Math.hypot(end[0] - start[0], end[1] - start[1], end[2] - start[2]);
      return { index, curveKind: 'line' as const, length, start, end, radius: null, segmentOffset: 0, segmentCount: 0,
        midpoint: [(start[0] + end[0]) / 2, (start[1] + end[1]) / 2, 0] as const,
        axis: [(end[0] - start[0]) / length, (end[1] - start[1]) / length, 0] as const };
    }),
    vertices: vertexNodes.map((node, index) => ({ index, position: points[node] })),
    origins: { version: 1, state: 'tracked', bindings: [
      { origin: faceOrigin, state: 'unique' as const, current: { kind: 'face' as const, index: 0 } },
      ...edgeOrigins.map((origin, index) => ({ origin, state: 'unique' as const, current: { kind: 'edge' as const, index } })),
      ...vertexOrigins.map((origin, index) => ({ origin, state: 'unique' as const, current: { kind: 'vertex' as const, index } }))] } };
}

export function sheetBoundary(): AnalysisBoundaryMesh {
  const vertexSet = new Set(vertexNodes), edgeSet = new Set(edgeNodes.flat());
  return { units: 'mm', boundary: 'open', coordinates: Float64Array.from(points.flat()),
    nodeKinds: Uint8Array.from(points.map((_, node) => vertexSet.has(node) ? 0 : edgeSet.has(node) ? 1 : 2)),
    triangles: Uint32Array.from(triangles.flat()), triangleFaces: Uint32Array.from(triangles.map(() => 0)),
    nodeCount: points.length, triangleCount: triangles.length,
    faces: [{ index: 0, triangleCount: triangles.length, reversed: false, seamEdges: 0, degeneratedEdges: 0, collapsedPoleTriangles: 0 }],
    edges: edgeNodes.map((nodes, index) => ({ index, degenerated: false, uses: 1, nodes: [...nodes] })),
    metrics: { totalAreaMm2: LENGTH * WIDTH, signedVolumeMm3: 0, minTriangleAreaMm2: 50, maxTriangleAreaMm2: 50,
      minAngleDeg: 45, maxAngleDeg: 90, maxBoundNodeOffsetMm: 0, freeEdges: 14, components: 1 },
    mesher: { done: true, status: 0 }, deflection: { linear: 0.1, angular: 0.3 } };
}

export function sheetKernel(calls: unknown[] = []): AnalysisBoundarySource {
  return { buildAnalysisSurfaceMesh: request => {
    calls.push(request);
    return Promise.resolve({ kind: 'mesh', bodyKey: request.bodyKey, mesh: sheetBoundary() });
  } };
}
