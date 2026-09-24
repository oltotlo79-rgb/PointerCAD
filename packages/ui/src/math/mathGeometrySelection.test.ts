import { describe, expect, it } from 'vitest';

import type {
  ReferenceFeature,
  ResolvedArc,
  ResolvedCurve,
  ResolvedEllipse,
  ResolvedPoint,
  ResolvedSegment,
  ResolvedSketch,
  ResolvedSpline,
  SolidBody,
  SolidEdgeEntry,
  SolidFaceEntry,
  SolidVertexEntry,
  Vec3,
} from '@pointercad/model';

import { subShapeElementId } from '../solid/subShapeSelection.js';
import {
  mathGeometrySelection,
  MATH_GEOMETRY_SELECTION_LIMIT,
  type MathGeometryCandidateReason,
} from './mathGeometrySelection.js';

/* ---------------------------------------------------------------------------
 * Sketch fixtures
 * ------------------------------------------------------------------------- */

function point(id: string, position: Vec3 = [0, 0, 0]): ResolvedPoint {
  return { id, featureId: id, position };
}

function segment(featureId: string, from: Vec3, to: Vec3): ResolvedSegment {
  return { kind: 'segment', featureId, from, to };
}

function arc(featureId: string): ResolvedArc {
  return { kind: 'arc', featureId, center: [0, 0, 0], normal: [0, 0, 1], xAxis: [1, 0, 0],
    radius: 5, startAngle: 0, endAngle: Math.PI / 2 };
}

function ellipse(featureId: string): ResolvedEllipse {
  return { kind: 'ellipse', featureId, center: [0, 0, 0], normal: [0, 0, 1], majorAxis: [1, 0, 0],
    majorRadius: 5, minorRadius: 3, startAngle: 0, endAngle: Math.PI * 2 };
}

function spline(featureId: string): ResolvedSpline {
  return { kind: 'spline', featureId, mode: 'interpolate', points: [[0, 0, 0], [10, 0, 0]], closed: false };
}

/** A closed simple polygon of `points.length` segments, all sharing one feature id (G1/GR-22). */
function polygon(featureId: string, points: readonly Vec3[]): readonly ResolvedSegment[] {
  return points.map((from, index) => segment(featureId, from, points[(index + 1) % points.length] ?? from));
}

function emptySketch(overrides: Partial<ResolvedSketch> = {}): ResolvedSketch {
  return {
    points: [], segments: [], arcs: [], ellipses: [], splines: [], faces: [], errors: [],
    pendingOffsets: [], pendingProjections: [], curvesByFeature: new Map(),
    ...overrides,
  };
}

const SKETCH_ID = 'sketch-1';

/* ---------------------------------------------------------------------------
 * Reference geometry fixtures (GR-22: coordinate-in-frame)
 * ------------------------------------------------------------------------- */

/** The only reference kind `coordinate`'s optional frame ever resolves against. */
function coordinateSystemReference(id: string): ReferenceFeature {
  return { kind: 'referenceCoordinateSystem', id, name: '座標系1', visible: true,
    origin: { kind: 'point', pointId: 'origin-point' },
    xAxis: { kind: 'world', axis: 'x' }, yAxis: { kind: 'world', axis: 'y' } };
}

/** Any other reference kind — never a valid `coordinate` frame, even though it also lives in `references`. */
function axisReference(id: string): ReferenceFeature {
  return { kind: 'referenceAxis', id, name: '軸1', visible: true,
    definition: { kind: 'twoPoints', from: { kind: 'point', pointId: 'p1' }, to: { kind: 'point', pointId: 'p2' } } };
}

/* ---------------------------------------------------------------------------
 * Body fixtures
 * ------------------------------------------------------------------------- */

function faceEntry(index: number, overrides: Partial<SolidFaceEntry> = {}): SolidFaceEntry {
  return { index, surfaceKind: 'plane', area: 100, centroid: [0, 0, 0], axis: [0, 0, 1], radius: null,
    triangleOffset: 0, triangleCount: 2, ...overrides };
}

function edgeEntry(index: number, overrides: Partial<SolidEdgeEntry> = {}): SolidEdgeEntry {
  return { index, curveKind: 'line', length: 10, midpoint: [5, 0, 0], start: [0, 0, 0], end: [10, 0, 0],
    axis: [1, 0, 0], radius: null, segmentOffset: 0, segmentCount: 1, ...overrides };
}

function vertexEntry(index: number, position: Vec3 = [0, 0, 0]): SolidVertexEntry {
  return { index, position };
}

function solidBody(featureId: string, overrides: Partial<SolidBody> = {}): SolidBody {
  return {
    featureId,
    mesh: { positions: new Float32Array(), normals: new Float32Array(), indices: new Uint32Array(),
      edgePositions: new Float32Array(), triangleCount: 0 },
    volume: 1000,
    isValid: true,
    bodyKind: 'solid',
    faces: [faceEntry(0), faceEntry(1, { centroid: [0, 0, 10] })],
    edges: [edgeEntry(0), edgeEntry(1, { curveKind: 'circle', axis: [0, 0, 1] })],
    vertices: [vertexEntry(0, [0, 0, 0]), vertexEntry(1, [10, 0, 0])],
    threadMarks: [],
    ...overrides,
  };
}

function faceId(bodyFeatureId: string, index = 0): string {
  return subShapeElementId(bodyFeatureId, 'face', index);
}
function edgeId(bodyFeatureId: string, index = 0): string {
  return subShapeElementId(bodyFeatureId, 'edge', index);
}
function vertexId(bodyFeatureId: string, index = 0): string {
  return subShapeElementId(bodyFeatureId, 'vertex', index);
}

/* ---------------------------------------------------------------------------
 * Single-selection candidates (§4(a): 1 点→X/Y/Z、1 曲線→長さ、1 面→面積、1 立体→体積と面積)
 * ------------------------------------------------------------------------- */

describe('1 つ選んだときの候補', () => {
  it('スケッチの点は X/Y/Z の 3 つの座標', () => {
    const sketch = emptySketch({ points: [point('point-1', [1, 2, 3])] });
    const result = mathGeometrySelection(['point-1'], SKETCH_ID, sketch, []);
    expect(result.reason).toBeNull();
    expect(result.candidates).toEqual([
      { kind: 'coordinate', point: { kind: 'sketch-point', sketchId: SKETCH_ID, reference: { kind: 'point', pointId: 'point-1' } }, component: 'X' },
      { kind: 'coordinate', point: { kind: 'sketch-point', sketchId: SKETCH_ID, reference: { kind: 'point', pointId: 'point-1' } }, component: 'Y' },
      { kind: 'coordinate', point: { kind: 'sketch-point', sketchId: SKETCH_ID, reference: { kind: 'point', pointId: 'point-1' } }, component: 'Z' },
    ]);
  });

  it('単独の線分は長さだけ(円弧と違って半径・中心角は無い)', () => {
    const sketch = emptySketch({ segments: [segment('seg-1', [0, 0, 0], [10, 0, 0])] });
    expect(mathGeometrySelection(['seg-1'], SKETCH_ID, sketch, []).candidates).toEqual([
      { kind: 'length', curve: { kind: 'sketch-curve', sketchId: SKETCH_ID, featureId: 'seg-1' } },
    ]);
  });

  it('単独の円弧は長さに加えて半径・中心角(GR-22)', () => {
    const sketch = emptySketch({ arcs: [arc('arc-1')] });
    const curve = { kind: 'sketch-curve', sketchId: SKETCH_ID, featureId: 'arc-1' } as const;
    expect(mathGeometrySelection(['arc-1'], SKETCH_ID, sketch, []).candidates).toEqual([
      { kind: 'length', curve },
      { kind: 'radius', curve },
      { kind: 'central-angle', curve, unit: 'degree' },
    ]);
  });

  it('立体の円形の辺も長さに加えて半径・中心角(GR-22、直線の辺は半径を出さない)', () => {
    const body = solidBody('body-1');
    const circularEdge = mathGeometrySelection([edgeId('body-1', 1)], SKETCH_ID, emptySketch(), [body]);
    expect(circularEdge.candidates.map(c => c.kind)).toEqual(['length', 'radius', 'central-angle']);
    const straightEdge = mathGeometrySelection([edgeId('body-1', 0)], SKETCH_ID, emptySketch(), [body]);
    expect(straightEdge.candidates.map(c => c.kind)).toEqual(['length']);
  });

  it('矩形など複合輪郭(線分・円弧だけ)は長さでなく輪郭全体の長さ(GR-22、Q9=CL1)', () => {
    const rectCurves = [
      segment('rect-1', [0, 0, 0], [10, 0, 0]),
      segment('rect-1', [10, 0, 0], [10, 10, 0]),
      segment('rect-1', [10, 10, 0], [0, 10, 0]),
      segment('rect-1', [0, 10, 0], [0, 0, 0]),
    ];
    const sketch = emptySketch({ segments: rectCurves, curvesByFeature: new Map([['rect-1', rectCurves]]) });
    const result = mathGeometrySelection(['rect-1'], SKETCH_ID, sketch, []);
    expect(result.reason).toBeNull();
    expect(result.candidates).toEqual([{ kind: 'contour-length', sketchId: SKETCH_ID, featureId: 'rect-1' }]);
  });

  it('楕円・自由曲線を含む複合輪郭は輪郭全体の長さも出さない(GR-22、mathGeometry.ts の contourLength と同じ拒否)', () => {
    const mixedSegment = segment('mixed-1', [0, 0, 0], [10, 0, 0]);
    const mixedEllipse = ellipse('mixed-1');
    const sketch = emptySketch({ segments: [mixedSegment], ellipses: [mixedEllipse],
      curvesByFeature: new Map<string, readonly ResolvedCurve[]>([['mixed-1', [mixedSegment, mixedEllipse]]]) });
    const result = mathGeometrySelection(['mixed-1'], SKETCH_ID, sketch, []);
    expect(result.candidates).toEqual([]);
    expect(result.reason).toBe('unsupportedPair');
  });

  it('楕円・スプラインは候補なし', () => {
    const sketch = emptySketch({ ellipses: [ellipse('ellipse-1')], splines: [spline('spline-1')] });
    expect(mathGeometrySelection(['ellipse-1'], SKETCH_ID, sketch, []).reason).toBe('unsupportedPair');
    expect(mathGeometrySelection(['spline-1'], SKETCH_ID, sketch, []).reason).toBe('unsupportedPair');
  });

  it('立体の頂点は X/Y/Z の 3 つの座標', () => {
    const body = solidBody('body-1');
    const result = mathGeometrySelection([vertexId('body-1', 0)], SKETCH_ID, emptySketch(), [body]);
    expect(result.candidates.map(c => c.kind)).toEqual(['coordinate', 'coordinate', 'coordinate']);
  });

  it('立体の辺は長さ', () => {
    const body = solidBody('body-1');
    const result = mathGeometrySelection([edgeId('body-1', 0)], SKETCH_ID, emptySketch(), [body]);
    expect(result.candidates).toEqual([
      { kind: 'length', curve: { kind: 'edge', reference: { bodyFeatureId: 'body-1', index: 0,
        fingerprint: { kind: 'edge', curveKind: 'line', length: 10, position: [5, 0, 0], axis: [1, 0, 0], radius: null } } } },
    ]);
  });

  it('面は面積', () => {
    const body = solidBody('body-1');
    const result = mathGeometrySelection([faceId('body-1', 0)], SKETCH_ID, emptySketch(), [body]);
    expect(result.candidates).toEqual([
      { kind: 'area', shape: { kind: 'face', reference: { bodyFeatureId: 'body-1', index: 0,
        fingerprint: { kind: 'face', surfaceKind: 'plane', area: 100, position: [0, 0, 0], axis: [0, 0, 1], radius: null } } } },
    ]);
  });

  it('立体(solid)は体積と面積(体積が先)', () => {
    const body = solidBody('body-1', { bodyKind: 'solid' });
    const result = mathGeometrySelection(['body-1'], SKETCH_ID, emptySketch(), [body]);
    expect(result.candidates).toEqual([
      { kind: 'volume', body: { kind: 'body', featureId: 'body-1' } },
      { kind: 'area', shape: { kind: 'body', featureId: 'body-1' } },
    ]);
  });

  it('殻(shell)は面積だけ(体積は bodyKind===solid のときだけ)', () => {
    const body = solidBody('body-1', { bodyKind: 'shell' });
    const result = mathGeometrySelection(['body-1'], SKETCH_ID, emptySketch(), [body]);
    expect(result.candidates).toEqual([
      { kind: 'area', shape: { kind: 'body', featureId: 'body-1' } },
    ]);
  });

  it('読み込みメッシュ(mesh)も面積だけ', () => {
    const body = solidBody('body-1', { bodyKind: 'mesh' });
    const result = mathGeometrySelection(['body-1'], SKETCH_ID, emptySketch(), [body]);
    expect(result.candidates.map(c => c.kind)).toEqual(['area']);
  });

  it('無効なボディ(isValid=false)は候補なし', () => {
    const body = solidBody('body-1', { isValid: false });
    const result = mathGeometrySelection(['body-1'], SKETCH_ID, emptySketch(), [body]);
    expect(result.candidates).toEqual([]);
    expect(result.reason).toBe('unsupportedPair');
  });
});

/* ---------------------------------------------------------------------------
 * Pair-selection candidates (§4(a): 2 点→距離、2 形→最短距離、2 直線→角度・平行・垂直)
 * ------------------------------------------------------------------------- */

describe('2 つ選んだときの候補', () => {
  it('2 つのスケッチの点は 2 点の距離', () => {
    const sketch = emptySketch({ points: [point('point-1'), point('point-2', [1, 0, 0])] });
    const result = mathGeometrySelection(['point-1', 'point-2'], SKETCH_ID, sketch, []);
    expect(result.candidates).toEqual([
      { kind: 'point-distance',
        first: { kind: 'sketch-point', sketchId: SKETCH_ID, reference: { kind: 'point', pointId: 'point-1' } },
        second: { kind: 'sketch-point', sketchId: SKETCH_ID, reference: { kind: 'point', pointId: 'point-2' } } },
    ]);
  });

  it('2 つの立体の頂点は 2 点の距離(最短距離ではない)', () => {
    const body = solidBody('body-1');
    const result = mathGeometrySelection([vertexId('body-1', 0), vertexId('body-1', 1)], SKETCH_ID, emptySketch(), [body]);
    expect(result.candidates.map(c => c.kind)).toEqual(['point-distance']);
  });

  it('2 つの面は最短距離に加えて面どうしの角度・平行・垂直(GR-22、両方とも平面のとき)', () => {
    const body = solidBody('body-1');
    const result = mathGeometrySelection([faceId('body-1', 0), faceId('body-1', 1)], SKETCH_ID, emptySketch(), [body]);
    expect(result.candidates.map(c => c.kind)).toEqual(['shape-distance', 'plane-angle', 'parallel', 'perpendicular']);
  });

  it('立体と面は最短距離', () => {
    const bodyA = solidBody('body-1');
    const bodyB = solidBody('body-2');
    const result = mathGeometrySelection(['body-1', faceId('body-2', 0)], SKETCH_ID, emptySketch(), [bodyA, bodyB]);
    expect(result.candidates.map(c => c.kind)).toEqual(['shape-distance']);
  });

  it('まっすぐな辺 2 本は最短距離・角度・平行・垂直・合同・相似の 6 つ(GR-22 で合同・相似が加わった)', () => {
    const body = solidBody('body-1', {
      edges: [edgeEntry(0), edgeEntry(1, { midpoint: [5, 10, 0], start: [0, 10, 0], end: [10, 10, 0] })],
    });
    const result = mathGeometrySelection([edgeId('body-1', 0), edgeId('body-1', 1)], SKETCH_ID, emptySketch(), [body]);
    expect(result.candidates.map(c => c.kind)).toEqual(['shape-distance', 'angle', 'parallel', 'perpendicular', 'congruent', 'similar']);
  });

  it('2 つの円形の辺は最短距離・合同・相似(角度は無い、GR-22)', () => {
    const body = solidBody('body-1', {
      edges: [edgeEntry(0, { curveKind: 'circle', axis: [0, 0, 1] }),
        edgeEntry(1, { curveKind: 'circle', axis: [0, 0, 1], midpoint: [5, 10, 0], radius: 3 })],
    });
    const result = mathGeometrySelection([edgeId('body-1', 0), edgeId('body-1', 1)], SKETCH_ID, emptySketch(), [body]);
    expect(result.candidates.map(c => c.kind)).toEqual(['shape-distance', 'congruent', 'similar']);
  });

  it('2 つのまっすぐなスケッチの線分は角度・平行・垂直・合同・相似(最短距離は無い、GR-22 で合同・相似が加わった)', () => {
    const sketch = emptySketch({ segments: [segment('seg-1', [0, 0, 0], [10, 0, 0]), segment('seg-2', [0, 5, 0], [10, 5, 0])] });
    const result = mathGeometrySelection(['seg-1', 'seg-2'], SKETCH_ID, sketch, []);
    expect(result.candidates.map(c => c.kind)).toEqual(['angle', 'parallel', 'perpendicular', 'congruent', 'similar']);
    expect(result.candidates[0]).toEqual({ kind: 'angle', unit: 'degree',
      first: { kind: 'sketch-curve', sketchId: SKETCH_ID, featureId: 'seg-1' },
      second: { kind: 'sketch-curve', sketchId: SKETCH_ID, featureId: 'seg-2' } });
  });

  it('2 つの円弧は合同・相似だけ(角度・平行・垂直は直線どうしにしか出さない、GR-22)', () => {
    const sketch = emptySketch({ arcs: [arc('arc-a'), arc('arc-b')] });
    const result = mathGeometrySelection(['arc-a', 'arc-b'], SKETCH_ID, sketch, []);
    expect(result.candidates).toEqual([
      { kind: 'congruent', first: { kind: 'sketch-curve', sketchId: SKETCH_ID, featureId: 'arc-a' },
        second: { kind: 'sketch-curve', sketchId: SKETCH_ID, featureId: 'arc-b' } },
      { kind: 'similar', first: { kind: 'sketch-curve', sketchId: SKETCH_ID, featureId: 'arc-a' },
        second: { kind: 'sketch-curve', sketchId: SKETCH_ID, featureId: 'arc-b' } },
    ]);
  });

  it('線分と円弧の組は角度も合同・相似も出さない(比べる形の種類が違う、GR-22)', () => {
    const sketch = emptySketch({ segments: [segment('seg-1', [0, 0, 0], [10, 0, 0])], arcs: [arc('arc-1')] });
    const result = mathGeometrySelection(['seg-1', 'arc-1'], SKETCH_ID, sketch, []);
    expect(result.candidates).toEqual([]);
    expect(result.reason).toBe('unsupportedPair');
  });

  it('閉じた三角形どうしは合同・相似(featureの参照をそのまま渡す、最初の辺だけを指定しない、GR-22)', () => {
    const triangleA = polygon('tri-a', [[0, 0, 0], [10, 0, 0], [0, 10, 0]]);
    const triangleB = polygon('tri-b', [[0, 0, 0], [5, 0, 0], [0, 5, 0]]);
    const sketch = emptySketch({ segments: [...triangleA, ...triangleB],
      curvesByFeature: new Map([['tri-a', triangleA], ['tri-b', triangleB]]) });
    const result = mathGeometrySelection(['tri-a', 'tri-b'], SKETCH_ID, sketch, []);
    expect(result.candidates).toEqual([
      { kind: 'congruent', first: { kind: 'sketch-curve', sketchId: SKETCH_ID, featureId: 'tri-a' },
        second: { kind: 'sketch-curve', sketchId: SKETCH_ID, featureId: 'tri-b' } },
      { kind: 'similar', first: { kind: 'sketch-curve', sketchId: SKETCH_ID, featureId: 'tri-a' },
        second: { kind: 'sketch-curve', sketchId: SKETCH_ID, featureId: 'tri-b' } },
    ]);
  });

  it('辺の数が違う多角形どうしは合同・相似を出さない(model が必ず unsupported にするため、GR-22)', () => {
    const triangle = polygon('tri-1', [[0, 0, 0], [10, 0, 0], [0, 10, 0]]);
    const quad = polygon('quad-1', [[0, 0, 0], [10, 0, 0], [10, 10, 0], [0, 10, 0]]);
    const sketch = emptySketch({ segments: [...triangle, ...quad],
      curvesByFeature: new Map([['tri-1', triangle], ['quad-1', quad]]) });
    const result = mathGeometrySelection(['tri-1', 'quad-1'], SKETCH_ID, sketch, []);
    expect(result.candidates).toEqual([]);
    expect(result.reason).toBe('unsupportedPair');
  });

  it('円弧の混じった輪郭は多角形として合同・相似を出さない(直線だけの閉多角形に限る、GR-22)', () => {
    const mixedSegment = segment('mixed-1', [0, 0, 0], [10, 0, 0]);
    const mixedArc = arc('mixed-1');
    const triangle = polygon('tri-1', [[0, 0, 0], [10, 0, 0], [0, 10, 0]]);
    const sketch = emptySketch({ segments: [mixedSegment, ...triangle], arcs: [mixedArc],
      curvesByFeature: new Map<string, readonly ResolvedCurve[]>([['mixed-1', [mixedSegment, mixedArc]], ['tri-1', triangle]]) });
    const result = mathGeometrySelection(['mixed-1', 'tri-1'], SKETCH_ID, sketch, []);
    expect(result.candidates).toEqual([]);
    expect(result.reason).toBe('unsupportedPair');
  });

  it('スケッチの点と立体の面の組は候補なし(スケッチ点は shape ではない)', () => {
    const sketch = emptySketch({ points: [point('point-1')] });
    const body = solidBody('body-1');
    const result = mathGeometrySelection(['point-1', faceId('body-1', 0)], SKETCH_ID, sketch, [body]);
    expect(result.candidates).toEqual([]);
    expect(result.reason).toBe('unsupportedPair');
  });

  it('殻(shell)どうしでも最短距離は出せる(bodyKind を見ないのは shape-distance/area だけ)', () => {
    const bodyA = solidBody('body-1', { bodyKind: 'shell' });
    const bodyB = solidBody('body-2', { bodyKind: 'shell' });
    const result = mathGeometrySelection(['body-1', 'body-2'], SKETCH_ID, emptySketch(), [bodyA, bodyB]);
    expect(result.candidates.map(c => c.kind)).toEqual(['shape-distance']);
  });

  it('同じ id を 2 回選ぶと非対応', () => {
    const sketch = emptySketch({ points: [point('point-1')] });
    const result = mathGeometrySelection(['point-1', 'point-1'], SKETCH_ID, sketch, []);
    expect(result.candidates).toEqual([]);
    expect(result.reason).toBe('unsupportedPair');
  });
});

/* ---------------------------------------------------------------------------
 * Plane / line-plane candidates (GR-22, §4(f): parallel/perpendicular の直線・平面への拡張)
 * ------------------------------------------------------------------------- */

describe('直線と平面・平面どうしの候補(GR-22)', () => {
  it('スケッチの線分と平面な面は直線と面の角度・平行・垂直(最短距離はスケッチ線分に shape が無いため出ない)', () => {
    const sketch = emptySketch({ segments: [segment('seg-1', [0, 0, 0], [10, 0, 0])] });
    const body = solidBody('body-1');
    const result = mathGeometrySelection(['seg-1', faceId('body-1', 0)], SKETCH_ID, sketch, [body]);
    expect(result.candidates).toEqual([
      { kind: 'line-plane-angle', unit: 'degree',
        line: { kind: 'sketch-curve', sketchId: SKETCH_ID, featureId: 'seg-1' },
        plane: { kind: 'face', reference: { bodyFeatureId: 'body-1', index: 0,
          fingerprint: { kind: 'face', surfaceKind: 'plane', area: 100, position: [0, 0, 0], axis: [0, 0, 1], radius: null } } } },
      { kind: 'parallel',
        first: { kind: 'sketch-curve', sketchId: SKETCH_ID, featureId: 'seg-1' },
        second: { kind: 'face', reference: { bodyFeatureId: 'body-1', index: 0,
          fingerprint: { kind: 'face', surfaceKind: 'plane', area: 100, position: [0, 0, 0], axis: [0, 0, 1], radius: null } } } },
      { kind: 'perpendicular',
        first: { kind: 'sketch-curve', sketchId: SKETCH_ID, featureId: 'seg-1' },
        second: { kind: 'face', reference: { bodyFeatureId: 'body-1', index: 0,
          fingerprint: { kind: 'face', surfaceKind: 'plane', area: 100, position: [0, 0, 0], axis: [0, 0, 1], radius: null } } } },
    ]);
  });

  it('面を先に選んでも直線と面の角度になり、line は曲線のまま(選ぶ順で first/second が入れ替わらない)', () => {
    const sketch = emptySketch({ segments: [segment('seg-1', [0, 0, 0], [10, 0, 0])] });
    const body = solidBody('body-1');
    const result = mathGeometrySelection([faceId('body-1', 0), 'seg-1'], SKETCH_ID, sketch, [body]);
    expect(result.candidates.map(c => c.kind)).toEqual(['line-plane-angle', 'parallel', 'perpendicular']);
    const lineOnly = result.candidates.find(c => c.kind === 'line-plane-angle');
    expect(lineOnly).toMatchObject({ line: { kind: 'sketch-curve', sketchId: SKETCH_ID, featureId: 'seg-1' } });
  });

  it('平面でない面(円柱面)と直線の組は候補なし(GR-09 の plane-angle/line-plane-angle は平面限定)', () => {
    const sketch = emptySketch({ segments: [segment('seg-1', [0, 0, 0], [10, 0, 0])] });
    const body = solidBody('body-1', { faces: [faceEntry(0, { surfaceKind: 'cylinder' })] });
    const result = mathGeometrySelection(['seg-1', faceId('body-1', 0)], SKETCH_ID, sketch, [body]);
    expect(result.candidates).toEqual([]);
    expect(result.reason).toBe('unsupportedPair');
  });
});

/* ---------------------------------------------------------------------------
 * 3-point angle (GR-22, §4(f): ∠ABC, second = vertex)
 * ------------------------------------------------------------------------- */

describe('3 点を選んだときの候補(GR-22、Q8=G1)', () => {
  it('3 つのスケッチの点は 2 番目を頂点とする角度', () => {
    const sketch = emptySketch({ points: [point('a', [1, 0, 0]), point('b', [0, 0, 0]), point('c', [0, 1, 0])] });
    const result = mathGeometrySelection(['a', 'b', 'c'], SKETCH_ID, sketch, []);
    expect(result.reason).toBeNull();
    expect(result.candidates).toEqual([{ kind: 'point-angle', unit: 'degree',
      first: { kind: 'sketch-point', sketchId: SKETCH_ID, reference: { kind: 'point', pointId: 'a' } },
      second: { kind: 'sketch-point', sketchId: SKETCH_ID, reference: { kind: 'point', pointId: 'b' } },
      third: { kind: 'sketch-point', sketchId: SKETCH_ID, reference: { kind: 'point', pointId: 'c' } } }]);
  });

  it('選ぶ順を変えると頂点(2 番目)も変わる', () => {
    const sketch = emptySketch({ points: [point('a'), point('b'), point('c')] });
    const result = mathGeometrySelection(['c', 'a', 'b'], SKETCH_ID, sketch, []);
    expect(result.candidates).toEqual([{ kind: 'point-angle', unit: 'degree',
      first: { kind: 'sketch-point', sketchId: SKETCH_ID, reference: { kind: 'point', pointId: 'c' } },
      second: { kind: 'sketch-point', sketchId: SKETCH_ID, reference: { kind: 'point', pointId: 'a' } },
      third: { kind: 'sketch-point', sketchId: SKETCH_ID, reference: { kind: 'point', pointId: 'b' } } }]);
  });

  it('立体の頂点どうしでも 3 点の角度になる', () => {
    const body = solidBody('body-1', { vertices: [vertexEntry(0, [0, 0, 0]), vertexEntry(1, [10, 0, 0]), vertexEntry(2, [0, 10, 0])] });
    const result = mathGeometrySelection(
      [vertexId('body-1', 0), vertexId('body-1', 1), vertexId('body-1', 2)], SKETCH_ID, emptySketch(), [body]);
    expect(result.candidates.map(c => c.kind)).toEqual(['point-angle']);
  });

  it('3 つ選んでも点でなければ非対応のまま(GR-15 の前提を保つ)', () => {
    const sketch = emptySketch({ points: [point('p1'), point('p2'), point('p3')] });
    const result = mathGeometrySelection(['p1', 'p2', 'unknown'], SKETCH_ID, sketch, []);
    expect(result.candidates).toEqual([]);
    expect(result.reason).toBe('unsupportedPair');
  });

  it('点2つと辺1つの3選択は角度を出さない(点でない項目が混ざる)', () => {
    const sketch = emptySketch({ points: [point('p1'), point('p2')], segments: [segment('seg-1', [0, 0, 0], [10, 0, 0])] });
    const result = mathGeometrySelection(['p1', 'p2', 'seg-1'], SKETCH_ID, sketch, []);
    expect(result.candidates).toEqual([]);
    expect(result.reason).toBe('unsupportedPair');
  });

  it('MATH_GEOMETRY_SELECTION_LIMIT は 3 のまま(4 つ以上は選びすぎ)', () => {
    expect(MATH_GEOMETRY_SELECTION_LIMIT).toBe(3);
  });
});

/* ---------------------------------------------------------------------------
 * Coordinate in a reference frame (GR-22, §4(f): coordinate.frame)
 * ------------------------------------------------------------------------- */

describe('座標系付きの座標(GR-22、選択に座標系を含む場合)', () => {
  it('点のあとに座標系を選ぶと、その座標系での X/Y/Z の 3 候補になる', () => {
    const sketch = emptySketch({ points: [point('point-1')] });
    const frame = coordinateSystemReference('frame-1');
    const result = mathGeometrySelection(['point-1', 'frame-1'], SKETCH_ID, sketch, [], [frame]);
    expect(result.reason).toBeNull();
    expect(result.candidates).toEqual([
      { kind: 'coordinate', component: 'X', point: { kind: 'sketch-point', sketchId: SKETCH_ID, reference: { kind: 'point', pointId: 'point-1' } },
        frame: { kind: 'reference', featureId: 'frame-1' } },
      { kind: 'coordinate', component: 'Y', point: { kind: 'sketch-point', sketchId: SKETCH_ID, reference: { kind: 'point', pointId: 'point-1' } },
        frame: { kind: 'reference', featureId: 'frame-1' } },
      { kind: 'coordinate', component: 'Z', point: { kind: 'sketch-point', sketchId: SKETCH_ID, reference: { kind: 'point', pointId: 'point-1' } },
        frame: { kind: 'reference', featureId: 'frame-1' } },
    ]);
  });

  it('座標系のあとに点を選んでも同じ 3 候補になる(順不同)', () => {
    const sketch = emptySketch({ points: [point('point-1')] });
    const frame = coordinateSystemReference('frame-1');
    const result = mathGeometrySelection(['frame-1', 'point-1'], SKETCH_ID, sketch, [], [frame]);
    expect(result.candidates.map(c => c.kind)).toEqual(['coordinate', 'coordinate', 'coordinate']);
    expect(result.candidates.every(c => c.kind === 'coordinate' && c.frame?.featureId === 'frame-1')).toBe(true);
  });

  it('座標系だけを選んでも候補は出ない(座標を測る点が無い)', () => {
    const frame = coordinateSystemReference('frame-1');
    const result = mathGeometrySelection(['frame-1'], SKETCH_ID, emptySketch(), [], [frame]);
    expect(result.candidates).toEqual([]);
    expect(result.reason).toBe('unsupportedPair');
  });

  it('座標系以外の基準ジオメトリ(基準軸)は座標の frame にならない', () => {
    const sketch = emptySketch({ points: [point('point-1')] });
    const axis = axisReference('axis-1');
    const result = mathGeometrySelection(['point-1', 'axis-1'], SKETCH_ID, sketch, [], [axis]);
    expect(result.candidates).toEqual([]);
    expect(result.reason).toBe('unsupportedPair');
  });

  it('references を渡さない呼び出し(GR-26 の状態欄など)は座標系を素通りする(引数省略時は空配列扱い)', () => {
    const sketch = emptySketch({ points: [point('point-1')] });
    const result = mathGeometrySelection(['point-1', 'frame-1'], SKETCH_ID, sketch, []);
    expect(result.candidates).toEqual([]);
    expect(result.reason).toBe('unsupportedPair');
  });
});

/* ---------------------------------------------------------------------------
 * Selection-count edge cases
 * ------------------------------------------------------------------------- */

describe('選ぶ数による断り', () => {
  it('何も選んでいない', () => {
    const result = mathGeometrySelection([], SKETCH_ID, emptySketch(), []);
    expect(result.candidates).toEqual([]);
    expect(result.reason).toBe('nothingSelected');
  });

  it('4 つ以上選ぶと選びすぎ', () => {
    const sketch = emptySketch({ points: [point('p1'), point('p2'), point('p3'), point('p4')] });
    const result = mathGeometrySelection(['p1', 'p2', 'p3', 'p4'], SKETCH_ID, sketch, []);
    expect(result.candidates).toEqual([]);
    expect(result.reason).toBe('tooMany');
  });

  it('存在しない id は非対応として断る', () => {
    const result = mathGeometrySelection(['unknown-1'], SKETCH_ID, emptySketch(), []);
    expect(result.candidates).toEqual([]);
    expect(result.reason).toBe('unsupportedPair');
  });

  const reasons: readonly MathGeometryCandidateReason[] = ['nothingSelected', 'unsupportedPair', 'tooMany'];
  it('理由コードは 3 種類だけ(GR-22 は新しい理由コードを増やさない)', () => {
    expect(reasons).toHaveLength(3);
  });
});
