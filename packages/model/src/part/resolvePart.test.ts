import {
  evaluateExpression,
  expressionValueFromNumber,
  type ExpressionValue,
} from '@pointercad/expression';
import { describe, expect, it } from 'vitest';

import {
  absoluteCoordinate,
  appendFeature,
  createPointFeature,
  DEFAULT_FACE_COLOR,
  nextFeatureId,
  nextFeatureName,
} from '../sketch/createSketchDocument.js';
import { DEFAULT_WORK_PLANE_ID } from '../sketch/planeMath.js';
import type {
  ResolvedArc,
  ResolvedCurve,
  ResolvedSegment,
  SketchDocument,
  SketchFaceFeature,
  SketchLineFeature,
  SketchPointArrayFeature,
} from '../sketch/types.js';
import type { Vec3 } from '../sketch/vec3.js';
import {
  findMetricThread,
  metricThreadPitch,
  threadMinorDiameter,
  type ThreadSeries,
} from '../thread/metricThread.js';
import { cacheKeyFor, type KeyCurve } from './cacheKey.js';
import { appendSolid, createEmptyPartDocument, replaceSketch } from './createPartDocument.js';
import {
  resolveHoleCenters,
  resolveMachiningTarget,
  resolvePart,
  resolveRevolveAxis,
  translateCurve,
} from './resolvePart.js';
import type { ResolvedPart, ResolvedPartSketch, ResolvedSolidStep } from './resolvePart.js';
import { fingerprintKeyText } from './subShapeRef.js';
import type {
  BooleanFeature,
  BooleanOperation,
  ExtrudeFeature,
  HoleDepth,
  HoleFeature,
  PartDocument,
  RevolveAxis,
  RevolveFeature,
  SewFeature,
  SketchFaceRef,
  SketchLineRef,
  SketchPointRef,
  SolidFeature,
  SubShapeRef,
  ThreadHoleFeature,
  ThreadRepresentation,
} from './types.js';

/** テストの中で式を書くための補助。評価できない式はテストの誤りとして落とす。 */
function expr(source: string): ExpressionValue {
  const result = evaluateExpression(source);
  if (!result.ok) {
    throw new Error(`テストの式が評価できない: ${source}(${result.error.code})`);
  }
  return result.value;
}

function toExpr(value: string | ExpressionValue): ExpressionValue {
  return typeof value === 'string' ? expr(value) : value;
}

/**
 * 評価に失敗した式の欄。保存されたファイルから読み戻したときに起こり得る形
 * (source を保って value を NaN にする、docs/報告記録.md 2026-09-03 07:58 の⑤)。
 */
function notANumber(source: string): ExpressionValue {
  return { source, value: Number.NaN, display: 'NaN' };
}

function addPoints(
  sketch: SketchDocument,
  coordinates: readonly (readonly [number, number, number])[],
): { sketch: SketchDocument; pointIds: readonly string[] } {
  let current = sketch;
  const pointIds: string[] = [];
  for (const [x, y, z] of coordinates) {
    const point = createPointFeature(current, absoluteCoordinate(x, y, z));
    current = appendFeature(current, point);
    pointIds.push(point.id);
  }
  return { sketch: current, pointIds };
}

function addFace(
  sketch: SketchDocument,
  pointIds: readonly string[],
): { sketch: SketchDocument; faceId: string } {
  const face: SketchFaceFeature = {
    id: nextFeatureId(sketch, 'face'),
    name: nextFeatureName(sketch, 'face'),
    planeId: DEFAULT_WORK_PLANE_ID,
    kind: 'face',
    boundary: pointIds.map((featureId) => ({ featureId })),
    color: DEFAULT_FACE_COLOR,
  };
  return { sketch: appendFeature(sketch, face), faceId: face.id };
}

interface Fixture {
  readonly document: PartDocument;
  /** z = 0 の 40×30 の長方形。左下から反時計回り(+Z から見て)。 */
  readonly faceA: SketchFaceRef;
  /** z = 10 の 40×30 の長方形。 */
  readonly faceB: SketchFaceRef;
  /** 境界の点が実在せず、スケッチ側で解決できない面。 */
  readonly brokenFace: SketchFaceRef;
  /** (1,2,3) から (4,6,3) への線分。回転軸に使う。 */
  readonly axisLine: SketchLineRef;
  /** (10,10,0) の点。穴の中心に使う。 */
  readonly pointA: SketchPointRef;
  /** (30,20,0) の点。穴の中心に使う。 */
  readonly pointB: SketchPointRef;
  /** (50,0,0) から X 方向へ間隔 5 で 3 点並ぶ点列(FR-308)。 */
  readonly pointArray: SketchPointRef;
}

/**
 * 検査の土台。1本のスケッチに次を入れる。
 * - 面A: (0,0,0) (40,0,0) (40,30,0) (0,30,0) の 4 点で張った 40×30 の長方形
 * - 面B: 同じ形を z = 10 へ
 * - 壊れた面: 実在しない点 id を境界に持つ
 * - 軸の線分: (1,2,3) → (4,6,3)
 * - 穴の中心にする点2つ: (10,10,0) と (30,20,0)
 * - 点列: (50,0,0) から X 方向へ間隔 5 で 3 点(→ (50,0,0) (55,0,0) (60,0,0))
 */
function createFixture(): Fixture {
  const base = createEmptyPartDocument();
  const empty = base.sketches[0];
  const cornersA = addPoints(empty, [
    [0, 0, 0],
    [40, 0, 0],
    [40, 30, 0],
    [0, 30, 0],
  ]);
  const faceA = addFace(cornersA.sketch, cornersA.pointIds);
  const cornersB = addPoints(faceA.sketch, [
    [0, 0, 10],
    [40, 0, 10],
    [40, 30, 10],
    [0, 30, 10],
  ]);
  const faceB = addFace(cornersB.sketch, cornersB.pointIds);
  const brokenFace = addFace(faceB.sketch, ['point-404']);
  const line: SketchLineFeature = {
    id: nextFeatureId(brokenFace.sketch, 'line'),
    name: nextFeatureName(brokenFace.sketch, 'line'),
    planeId: DEFAULT_WORK_PLANE_ID,
    kind: 'line',
    from: absoluteCoordinate(1, 2, 3),
    to: absoluteCoordinate(4, 6, 3),
  };
  const withLine = appendFeature(brokenFace.sketch, line);
  const centers = addPoints(withLine, [
    [10, 10, 0],
    [30, 20, 0],
  ]);
  const array: SketchPointArrayFeature = {
    id: nextFeatureId(centers.sketch, 'pointArray'),
    name: nextFeatureName(centers.sketch, 'pointArray'),
    planeId: DEFAULT_WORK_PLANE_ID,
    kind: 'pointArray',
    base: absoluteCoordinate(50, 0, 0),
    azimuth: expressionValueFromNumber(0),
    spacing: expressionValueFromNumber(5),
    count: expressionValueFromNumber(3),
  };
  const sketch = appendFeature(centers.sketch, array);
  return {
    document: replaceSketch(base, sketch),
    faceA: { sketchId: sketch.id, faceFeatureId: faceA.faceId },
    faceB: { sketchId: sketch.id, faceFeatureId: faceB.faceId },
    brokenFace: { sketchId: sketch.id, faceFeatureId: brokenFace.faceId },
    axisLine: { sketchId: sketch.id, lineFeatureId: line.id },
    pointA: { sketchId: sketch.id, pointFeatureId: centers.pointIds[0] },
    pointB: { sketchId: sketch.id, pointFeatureId: centers.pointIds[1] },
    pointArray: { sketchId: sketch.id, pointFeatureId: array.id },
  };
}

interface ExtrudeOptions {
  readonly distance?: string | ExpressionValue;
  readonly reversed?: boolean;
  readonly symmetric?: boolean;
  readonly suppressed?: boolean;
  readonly name?: string;
}

function extrudeFeature(
  id: string,
  profile: SketchFaceRef,
  options: ExtrudeOptions = {},
): ExtrudeFeature {
  return {
    id,
    name: options.name ?? id,
    suppressed: options.suppressed ?? false,
    kind: 'extrude',
    profile,
    distance: toExpr(options.distance ?? '10'),
    reversed: options.reversed ?? false,
    symmetric: options.symmetric ?? false,
  };
}

interface RevolveOptions {
  readonly angle?: string | ExpressionValue;
  readonly axis?: RevolveAxis;
  readonly reversed?: boolean;
  readonly suppressed?: boolean;
}

function revolveFeature(
  id: string,
  profile: SketchFaceRef,
  options: RevolveOptions = {},
): RevolveFeature {
  return {
    id,
    name: id,
    suppressed: options.suppressed ?? false,
    kind: 'revolve',
    profile,
    axis: options.axis ?? { kind: 'world', axis: 'z' },
    angle: toExpr(options.angle ?? '360'),
    reversed: options.reversed ?? false,
  };
}

function sewFeature(
  id: string,
  faces: readonly SketchFaceRef[],
  options: { readonly tolerance?: string | ExpressionValue; readonly suppressed?: boolean } = {},
): SewFeature {
  return {
    id,
    name: id,
    suppressed: options.suppressed ?? false,
    kind: 'sew',
    faces,
    tolerance: toExpr(options.tolerance ?? '0.01'),
  };
}

function booleanFeature(
  id: string,
  operation: BooleanOperation,
  targetFeatureId: string,
  toolFeatureId: string,
  options: { readonly suppressed?: boolean } = {},
): BooleanFeature {
  return {
    id,
    name: id,
    suppressed: options.suppressed ?? false,
    kind: 'boolean',
    operation,
    targetFeatureId,
    toolFeatureId,
  };
}

/**
 * M6 並目の下穴径 D1。式の欄へ入れると `expressionValueFromNumber` が有効数字12桁へ
 * 丸めるので、文書に入る値は 4.917468245269452 ではなく 4.91746824527 になる。
 * 鍵は 9 桁で丸める(`KEY_DECIMALS`)ので、どちらでも同じ鍵になる。
 */
const M6_DRILL_DIAMETER = expressionValueFromNumber(threadMinorDiameter(6, 1)).value;

/**
 * 40×30 の面を Z へ 10 押し出した箱の「上の面」の指紋(計画書 §2.2.3 の検算表と同じ値)。
 * 面積 1200、重心 (20,15,10)、法線 [0,0,1]、通し番号 0。
 */
function topFaceRef(bodyFeatureId: string): SubShapeRef {
  return {
    bodyFeatureId,
    index: 0,
    fingerprint: {
      kind: 'face',
      surfaceKind: 'plane',
      area: 1200,
      position: [20, 15, 10],
      axis: [0, 0, 1],
      radius: null,
    },
  };
}

/** 箱の縦の辺1本の指紋。「面でないものを指した」検査に使う。 */
function edgeRef(bodyFeatureId: string): SubShapeRef {
  return {
    bodyFeatureId,
    index: 3,
    fingerprint: {
      kind: 'edge',
      curveKind: 'line',
      length: 10,
      position: [0, 0, 5],
      axis: [0, 0, 1],
      radius: null,
    },
  };
}

interface HoleOptions {
  readonly face?: SubShapeRef;
  readonly diameter?: string | ExpressionValue;
  readonly depth?: HoleDepth;
  readonly tiltAngle?: string | ExpressionValue;
  readonly tiltAzimuth?: string | ExpressionValue;
  readonly suppressed?: boolean;
  readonly name?: string;
}

function holeFeature(
  id: string,
  targetFeatureId: string,
  centers: readonly SketchPointRef[],
  options: HoleOptions = {},
): HoleFeature {
  return {
    id,
    name: options.name ?? id,
    suppressed: options.suppressed ?? false,
    kind: 'hole',
    targetFeatureId,
    face: options.face ?? topFaceRef(targetFeatureId),
    centers,
    diameter: toExpr(options.diameter ?? '6'),
    depth: options.depth ?? { kind: 'through' },
    tiltAngle: toExpr(options.tiltAngle ?? '0'),
    tiltAzimuth: toExpr(options.tiltAzimuth ?? '0'),
  };
}

interface ThreadHoleOptions extends HoleOptions {
  readonly designation?: string;
  readonly series?: ThreadSeries;
  readonly pitch?: string | ExpressionValue;
  readonly drillDiameter?: string | ExpressionValue;
  readonly threadLength?: string | ExpressionValue;
  readonly representation?: ThreadRepresentation;
}

/**
 * ねじ穴。既定は M6 並目・簡略表示・貫通で、ピッチと下穴径は規格表どおりの値を入れる
 * (UI がその場入力で入れる既定値と同じ作り方。FR-406、§0.a-0.14)。
 */
function threadHoleFeature(
  id: string,
  targetFeatureId: string,
  centers: readonly SketchPointRef[],
  options: ThreadHoleOptions = {},
): ThreadHoleFeature {
  const designation = options.designation ?? 'M6';
  const series = options.series ?? 'coarse';
  const size = findMetricThread(designation);
  const defaultPitch = size === undefined ? 1 : metricThreadPitch(size, series);
  const defaultDrill =
    size === undefined ? 1 : threadMinorDiameter(size.diameter, defaultPitch);
  return {
    id,
    name: options.name ?? id,
    suppressed: options.suppressed ?? false,
    kind: 'threadHole',
    targetFeatureId,
    face: options.face ?? topFaceRef(targetFeatureId),
    centers,
    designation,
    series,
    pitch: toExpr(options.pitch ?? expressionValueFromNumber(defaultPitch)),
    drillDiameter: toExpr(options.drillDiameter ?? expressionValueFromNumber(defaultDrill)),
    depth: options.depth ?? { kind: 'through' },
    threadLength: toExpr(options.threadLength ?? '10'),
    representation: options.representation ?? 'simplified',
    tiltAngle: toExpr(options.tiltAngle ?? '0'),
    tiltAzimuth: toExpr(options.tiltAzimuth ?? '0'),
  };
}

function withSolids(document: PartDocument, ...solids: readonly SolidFeature[]): PartDocument {
  return solids.reduce((current, solid) => appendSolid(current, solid), document);
}

/** 段の種類を狭める。違う種類ならテストの前提が壊れているので落とす。 */
function extrudePlan(step: ResolvedSolidStep): Extract<ResolvedSolidStep['plan'], { kind: 'extrude' }> {
  if (step.plan.kind !== 'extrude') {
    throw new Error(`テストの前提が壊れている: 押し出しでない段 ${step.plan.kind}`);
  }
  return step.plan;
}

function revolvePlan(step: ResolvedSolidStep): Extract<ResolvedSolidStep['plan'], { kind: 'revolve' }> {
  if (step.plan.kind !== 'revolve') {
    throw new Error(`テストの前提が壊れている: 回転でない段 ${step.plan.kind}`);
  }
  return step.plan;
}

function sewPlan(step: ResolvedSolidStep): Extract<ResolvedSolidStep['plan'], { kind: 'sew' }> {
  if (step.plan.kind !== 'sew') {
    throw new Error(`テストの前提が壊れている: 縫合でない段 ${step.plan.kind}`);
  }
  return step.plan;
}

function booleanPlan(step: ResolvedSolidStep): Extract<ResolvedSolidStep['plan'], { kind: 'boolean' }> {
  if (step.plan.kind !== 'boolean') {
    throw new Error(`テストの前提が壊れている: ブーリアンでない段 ${step.plan.kind}`);
  }
  return step.plan;
}

function holePlan(step: ResolvedSolidStep): Extract<ResolvedSolidStep['plan'], { kind: 'hole' }> {
  if (step.plan.kind !== 'hole') {
    throw new Error(`テストの前提が壊れている: 穴でない段 ${step.plan.kind}`);
  }
  return step.plan;
}

function threadPlan(step: ResolvedSolidStep): Extract<ResolvedSolidStep['plan'], { kind: 'thread' }> {
  if (step.plan.kind !== 'thread') {
    throw new Error(`テストの前提が壊れている: ねじ穴でない段 ${step.plan.kind}`);
  }
  return step.plan;
}

/** 検査の中で中心点の一覧を作る補助(resolveHoleCenters の単体検査に使う)。 */
function sketchesOf(document: PartDocument): readonly ResolvedPartSketch[] {
  return resolvePart(document).sketches;
}

/** 線分の並びを [始点, 終点] の一覧にする。円弧が混じっていたらテストの前提が壊れている。 */
function segmentEnds(curves: readonly ResolvedCurve[]): readonly (readonly Vec3[])[] {
  return curves.map((curve) => {
    if (curve.kind !== 'segment') {
      throw new Error('テストの前提が壊れている: 線分でない曲線');
    }
    return [curve.from, curve.to];
  });
}

/** 鍵の材料に使う曲線へ詰め替える(cacheKeyFor の入力を独立に組み立てるため)。 */
function keySegment(from: Vec3, to: Vec3): KeyCurve {
  return { kind: 'segment', from, to };
}

function codesOf(result: ResolvedPart): readonly string[] {
  return result.errors.map((error) => error.code);
}

/**
 * 面Aの断面が z = offset にあるときの 4 本の線分。
 * 面Aの境界は (0,0) (40,0) (40,30) (0,30) の順なので、隣どうしを結んで最後は先頭へ戻る。
 */
function rectangleEnds(z: number): readonly (readonly Vec3[])[] {
  return [
    [
      [0, 0, z],
      [40, 0, z],
    ],
    [
      [40, 0, z],
      [40, 30, z],
    ],
    [
      [40, 30, z],
      [0, 30, z],
    ],
    [
      [0, 30, z],
      [0, 0, z],
    ],
  ];
}

describe('translateCurve', () => {
  it('線分は始点と終点の両方が動き、種類と作成元は変わらない', () => {
    const segment: ResolvedSegment = {
      kind: 'segment',
      featureId: 'face-1',
      from: [1, 2, 3],
      to: [4, 5, 6],
    };
    const moved = translateCurve(segment, [10, -20, 30]);
    expect(moved).toEqual({
      kind: 'segment',
      featureId: 'face-1',
      from: [11, -18, 33],
      to: [14, -15, 36],
    });
  });

  it('円弧は中心だけが動き、法線・第1軸・半径・角度は変わらない', () => {
    const arc: ResolvedArc = {
      kind: 'arc',
      featureId: 'arc-1',
      center: [1, 2, 3],
      normal: [0, 0, 1],
      xAxis: [1, 0, 0],
      radius: 7,
      startAngle: 0.25,
      endAngle: 1.5,
    };
    const moved = translateCurve(arc, [0, 0, -5]);
    expect(moved).toEqual({ ...arc, center: [1, 2, -2] });
  });

  it('元の曲線を書き換えない', () => {
    const segment: ResolvedSegment = {
      kind: 'segment',
      featureId: 'face-1',
      from: [0, 0, 0],
      to: [1, 0, 0],
    };
    translateCurve(segment, [0, 0, 5]);
    expect(segment.from).toEqual([0, 0, 0]);
  });
});

describe('resolveRevolveAxis', () => {
  it('ワールドの X / Y / Z 軸は原点と単位ベクトルになる', () => {
    const { sketches } = resolvePart(createFixture().document);
    expect(resolveRevolveAxis({ kind: 'world', axis: 'x' }, sketches)).toEqual({
      origin: [0, 0, 0],
      direction: [1, 0, 0],
    });
    expect(resolveRevolveAxis({ kind: 'world', axis: 'y' }, sketches)).toEqual({
      origin: [0, 0, 0],
      direction: [0, 1, 0],
    });
    expect(resolveRevolveAxis({ kind: 'world', axis: 'z' }, sketches)).toEqual({
      origin: [0, 0, 0],
      direction: [0, 0, 1],
    });
  });

  it('スケッチの線分は始点と、長さ1に直した向きになる', () => {
    const fixture = createFixture();
    const { sketches } = resolvePart(fixture.document);
    const frame = resolveRevolveAxis({ kind: 'line', line: fixture.axisLine }, sketches);
    // (4,6,3) - (1,2,3) = (3,4,0)、長さは √(9+16) = 5。単位ベクトルは (0.6, 0.8, 0)。
    expect(frame).not.toBeNull();
    expect(frame?.origin).toEqual([1, 2, 3]);
    expect(frame?.direction[0]).toBeCloseTo(0.6, 12);
    expect(frame?.direction[1]).toBeCloseTo(0.8, 12);
    expect(frame?.direction[2]).toBeCloseTo(0, 12);
  });

  it('線分が見つからないときは null', () => {
    const fixture = createFixture();
    const { sketches } = resolvePart(fixture.document);
    expect(
      resolveRevolveAxis(
        { kind: 'line', line: { sketchId: fixture.axisLine.sketchId, lineFeatureId: 'line-404' } },
        sketches,
      ),
    ).toBeNull();
  });

  it('スケッチが見つからないときは null', () => {
    const fixture = createFixture();
    const { sketches } = resolvePart(fixture.document);
    expect(
      resolveRevolveAxis(
        { kind: 'line', line: { sketchId: 'sketch-404', lineFeatureId: 'line-1' } },
        sketches,
      ),
    ).toBeNull();
  });
});

describe('resolvePart スケッチの解決', () => {
  it('文書のスケッチを順に解決して持ち回る', () => {
    const fixture = createFixture();
    const result = resolvePart(fixture.document);
    expect(result.sketches).toHaveLength(1);
    expect(result.sketches[0].sketchId).toBe(fixture.faceA.sketchId);
    // 壊れた面は解決されず、スケッチ側の失敗として残る(部品の errors へは写さない)。
    expect(result.sketches[0].resolved.faces.map((face) => face.featureId)).toEqual([
      fixture.faceA.faceFeatureId,
      fixture.faceB.faceFeatureId,
    ]);
    expect(result.sketches[0].resolved.errors).toHaveLength(1);
    expect(result.errors).toEqual([]);
  });

  it('ソリッドが無ければ段も失敗も無い', () => {
    const result = resolvePart(createFixture().document);
    expect(result.steps).toEqual([]);
    expect(result.errors).toEqual([]);
    expect(result.liveBodyIds).toEqual([]);
  });
});

describe('resolvePart 押し出し', () => {
  it('距離・向き・断面をそのまま渡す(向きは面の法線)', () => {
    const fixture = createFixture();
    const document = withSolids(fixture.document, extrudeFeature('extrude-1', fixture.faceA));
    const result = resolvePart(document);
    expect(result.errors).toEqual([]);
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0].featureId).toBe('extrude-1');
    const plan = extrudePlan(result.steps[0]);
    expect(plan.distance).toBe(10);
    // 面Aの境界は +Z から見て反時計回りなので、当てはめた法線は +Z になる
    //(fitPlaneNormal は最初に見つけた最大の外積を採る。(40,0,0)×(40,30,0) = (0,0,1200))。
    expect(plan.direction).toEqual([0, 0, 1]);
    expect(segmentEnds(plan.profile)).toEqual(rectangleEnds(0));
    expect(result.steps[0].visible).toBe(true);
    expect(result.liveBodyIds).toEqual(['extrude-1']);
  });

  it('鍵は解決済みの断面・向き・距離だけから作られる', () => {
    const fixture = createFixture();
    const document = withSolids(fixture.document, extrudeFeature('extrude-1', fixture.faceA));
    const result = resolvePart(document);
    const expected = cacheKeyFor({
      kind: 'extrude',
      profile: [
        keySegment([0, 0, 0], [40, 0, 0]),
        keySegment([40, 0, 0], [40, 30, 0]),
        keySegment([40, 30, 0], [0, 30, 0]),
        keySegment([0, 30, 0], [0, 0, 0]),
      ],
      direction: [0, 0, 1],
      distance: 10,
    });
    expect(result.steps[0].key).toBe(expected);
  });

  it('反転すると向きだけが逆になり、断面は動かない', () => {
    const fixture = createFixture();
    const document = withSolids(
      fixture.document,
      extrudeFeature('extrude-1', fixture.faceA, { reversed: true }),
    );
    const plan = extrudePlan(resolvePart(document).steps[0]);
    expect(plan.direction).toEqual([0, 0, -1]);
    expect(plan.distance).toBe(10);
    expect(segmentEnds(plan.profile)).toEqual(rectangleEnds(0));
  });

  it('両側なら断面を距離の半分だけ逆向きへ動かし、距離は変えない', () => {
    const fixture = createFixture();
    const document = withSolids(
      fixture.document,
      extrudeFeature('extrude-1', fixture.faceA, { symmetric: true }),
    );
    const plan = extrudePlan(resolvePart(document).steps[0]);
    // 向きは +Z、距離 10 なので、断面は (0,0,-1) × 5 = (0,0,-5) だけ動く。
    expect(plan.direction).toEqual([0, 0, 1]);
    expect(plan.distance).toBe(10);
    expect(segmentEnds(plan.profile)).toEqual(rectangleEnds(-5));
  });

  it('反転と両側を同時に指定すると、逆向きの半分だけ動く', () => {
    const fixture = createFixture();
    const document = withSolids(
      fixture.document,
      extrudeFeature('extrude-1', fixture.faceA, { reversed: true, symmetric: true }),
    );
    const plan = extrudePlan(resolvePart(document).steps[0]);
    // 向きは -Z、距離 10 なので、断面は (0,0,1) × 5 = (0,0,5) だけ動く。
    expect(plan.direction).toEqual([0, 0, -1]);
    expect(segmentEnds(plan.profile)).toEqual(rectangleEnds(5));
  });

  it('両側かどうかで鍵が変わる', () => {
    const fixture = createFixture();
    const plain = resolvePart(
      withSolids(fixture.document, extrudeFeature('extrude-1', fixture.faceA)),
    );
    const symmetric = resolvePart(
      withSolids(fixture.document, extrudeFeature('extrude-1', fixture.faceA, { symmetric: true })),
    );
    expect(symmetric.steps[0].key).not.toBe(plain.steps[0].key);
  });

  it('距離が 0 なら段を作らず invalidValue にする', () => {
    const fixture = createFixture();
    const document = withSolids(
      fixture.document,
      extrudeFeature('extrude-1', fixture.faceA, { distance: '0' }),
    );
    const result = resolvePart(document);
    expect(result.steps).toEqual([]);
    expect(codesOf(result)).toEqual(['invalidValue']);
    expect(result.errors[0].featureId).toBe('extrude-1');
    expect(result.errors[0].message.length).toBeGreaterThan(0);
  });

  it('距離が負なら invalidValue', () => {
    const fixture = createFixture();
    const result = resolvePart(
      withSolids(fixture.document, extrudeFeature('extrude-1', fixture.faceA, { distance: '0-3' })),
    );
    expect(codesOf(result)).toEqual(['invalidValue']);
  });

  it('距離が数になっていなければ invalidValue', () => {
    const fixture = createFixture();
    const result = resolvePart(
      withSolids(
        fixture.document,
        extrudeFeature('extrude-1', fixture.faceA, { distance: notANumber('a') }),
      ),
    );
    expect(codesOf(result)).toEqual(['invalidValue']);
  });

  it('面 id が実在しなければ missingProfile', () => {
    const fixture = createFixture();
    const result = resolvePart(
      withSolids(
        fixture.document,
        extrudeFeature('extrude-1', {
          sketchId: fixture.faceA.sketchId,
          faceFeatureId: 'face-404',
        }),
      ),
    );
    expect(result.steps).toEqual([]);
    expect(codesOf(result)).toEqual(['missingProfile']);
  });

  it('スケッチ id が実在しなければ missingProfile', () => {
    const fixture = createFixture();
    const result = resolvePart(
      withSolids(
        fixture.document,
        extrudeFeature('extrude-1', { sketchId: 'sketch-404', faceFeatureId: 'face-1' }),
      ),
    );
    expect(codesOf(result)).toEqual(['missingProfile']);
  });

  it('スケッチ側で面が解決できていなければ missingProfile', () => {
    const fixture = createFixture();
    const result = resolvePart(
      withSolids(fixture.document, extrudeFeature('extrude-1', fixture.brokenFace)),
    );
    expect(result.steps).toEqual([]);
    expect(codesOf(result)).toEqual(['missingProfile']);
  });
});

describe('resolvePart 回転', () => {
  it('ワールド Z 軸まわりの 90 度は π/2 ラジアンになる', () => {
    const fixture = createFixture();
    const document = withSolids(
      fixture.document,
      revolveFeature('revolve-1', fixture.faceA, { angle: '90' }),
    );
    const result = resolvePart(document);
    expect(result.errors).toEqual([]);
    const plan = revolvePlan(result.steps[0]);
    // 90 度 = 90 × π / 180 = π / 2。
    expect(plan.angle).toBeCloseTo(Math.PI / 2, 12);
    expect(plan.axisOrigin).toEqual([0, 0, 0]);
    expect(plan.axisDirection).toEqual([0, 0, 1]);
    expect(segmentEnds(plan.profile)).toEqual(rectangleEnds(0));
  });

  it('全周(360 度)は 2π ラジアンになる', () => {
    const fixture = createFixture();
    const result = resolvePart(
      withSolids(fixture.document, revolveFeature('revolve-1', fixture.faceA)),
    );
    expect(result.errors).toEqual([]);
    expect(revolvePlan(result.steps[0]).angle).toBeCloseTo(2 * Math.PI, 12);
  });

  it('スケッチの線分を軸にできる', () => {
    const fixture = createFixture();
    const document = withSolids(
      fixture.document,
      revolveFeature('revolve-1', fixture.faceA, {
        axis: { kind: 'line', line: fixture.axisLine },
      }),
    );
    const plan = revolvePlan(resolvePart(document).steps[0]);
    // 線分 (1,2,3) → (4,6,3)。始点が原点、向きは (3,4,0)/5 = (0.6, 0.8, 0)。
    expect(plan.axisOrigin).toEqual([1, 2, 3]);
    expect(plan.axisDirection[0]).toBeCloseTo(0.6, 12);
    expect(plan.axisDirection[1]).toBeCloseTo(0.8, 12);
    expect(plan.axisDirection[2]).toBeCloseTo(0, 12);
  });

  it('反転すると軸の向きだけが逆になる', () => {
    const fixture = createFixture();
    const document = withSolids(
      fixture.document,
      revolveFeature('revolve-1', fixture.faceA, { reversed: true }),
    );
    const plan = revolvePlan(resolvePart(document).steps[0]);
    expect(plan.axisOrigin).toEqual([0, 0, 0]);
    expect(plan.axisDirection).toEqual([0, 0, -1]);
  });

  it('線分の軸を反転すると向きが逆になる', () => {
    const fixture = createFixture();
    const document = withSolids(
      fixture.document,
      revolveFeature('revolve-1', fixture.faceA, {
        axis: { kind: 'line', line: fixture.axisLine },
        reversed: true,
      }),
    );
    const plan = revolvePlan(resolvePart(document).steps[0]);
    expect(plan.axisDirection[0]).toBeCloseTo(-0.6, 12);
    expect(plan.axisDirection[1]).toBeCloseTo(-0.8, 12);
  });

  it('角度が 360 を超えたら invalidValue', () => {
    const fixture = createFixture();
    const result = resolvePart(
      withSolids(fixture.document, revolveFeature('revolve-1', fixture.faceA, { angle: '370' })),
    );
    expect(result.steps).toEqual([]);
    expect(codesOf(result)).toEqual(['invalidValue']);
  });

  it('角度が 0 以下なら invalidValue', () => {
    const fixture = createFixture();
    const result = resolvePart(
      withSolids(fixture.document, revolveFeature('revolve-1', fixture.faceA, { angle: '0' })),
    );
    expect(codesOf(result)).toEqual(['invalidValue']);
  });

  it('角度が数になっていなければ invalidValue', () => {
    const fixture = createFixture();
    const result = resolvePart(
      withSolids(
        fixture.document,
        revolveFeature('revolve-1', fixture.faceA, { angle: notANumber('a') }),
      ),
    );
    expect(codesOf(result)).toEqual(['invalidValue']);
  });

  it('軸の線分が見つからなければ missingProfile', () => {
    const fixture = createFixture();
    const result = resolvePart(
      withSolids(
        fixture.document,
        revolveFeature('revolve-1', fixture.faceA, {
          axis: {
            kind: 'line',
            line: { sketchId: fixture.axisLine.sketchId, lineFeatureId: 'line-404' },
          },
        }),
      ),
    );
    expect(result.steps).toEqual([]);
    expect(codesOf(result)).toEqual(['missingProfile']);
  });

  it('断面が見つからなければ missingProfile', () => {
    const fixture = createFixture();
    const result = resolvePart(
      withSolids(
        fixture.document,
        revolveFeature('revolve-1', {
          sketchId: fixture.faceA.sketchId,
          faceFeatureId: 'face-404',
        }),
      ),
    );
    expect(codesOf(result)).toEqual(['missingProfile']);
  });
});

describe('resolvePart 縫合', () => {
  it('面ごとの曲線列と許容量を渡す', () => {
    const fixture = createFixture();
    const document = withSolids(
      fixture.document,
      sewFeature('sew-1', [fixture.faceA, fixture.faceB]),
    );
    const result = resolvePart(document);
    expect(result.errors).toEqual([]);
    const plan = sewPlan(result.steps[0]);
    expect(plan.tolerance).toBe(0.01);
    expect(plan.profiles).toHaveLength(2);
    expect(segmentEnds(plan.profiles[0])).toEqual(rectangleEnds(0));
    expect(segmentEnds(plan.profiles[1])).toEqual(rectangleEnds(10));
  });

  it('面が 2 枚未満なら degenerate', () => {
    const fixture = createFixture();
    const result = resolvePart(withSolids(fixture.document, sewFeature('sew-1', [fixture.faceA])));
    expect(result.steps).toEqual([]);
    expect(codesOf(result)).toEqual(['degenerate']);
  });

  it('見つからない面が混じっていれば missingProfile', () => {
    const fixture = createFixture();
    const result = resolvePart(
      withSolids(
        fixture.document,
        sewFeature('sew-1', [
          fixture.faceA,
          { sketchId: fixture.faceA.sketchId, faceFeatureId: 'face-404' },
        ]),
      ),
    );
    expect(codesOf(result)).toEqual(['missingProfile']);
  });

  it('許容量が 0 以下なら invalidValue', () => {
    const fixture = createFixture();
    const result = resolvePart(
      withSolids(
        fixture.document,
        sewFeature('sew-1', [fixture.faceA, fixture.faceB], { tolerance: '0' }),
      ),
    );
    expect(codesOf(result)).toEqual(['invalidValue']);
  });
});

describe('resolvePart ブーリアン', () => {
  it('対象と相手を消費し、自分だけが画面に残る', () => {
    const fixture = createFixture();
    const document = withSolids(
      fixture.document,
      extrudeFeature('extrude-1', fixture.faceA),
      extrudeFeature('extrude-2', fixture.faceB, { distance: '4' }),
      booleanFeature('subtract-1', 'subtract', 'extrude-1', 'extrude-2'),
    );
    const result = resolvePart(document);
    expect(result.errors).toEqual([]);
    expect(result.steps).toHaveLength(3);
    expect(result.steps.map((step) => step.visible)).toEqual([false, false, true]);
    const plan = booleanPlan(result.steps[2]);
    expect(plan.operation).toBe('subtract');
    expect(plan.targetKey).toBe(result.steps[0].key);
    expect(plan.toolKey).toBe(result.steps[1].key);
    expect(result.liveBodyIds).toEqual(['subtract-1']);
  });

  it('鍵は上流の鍵から作る(上流が変われば必ず変わる)', () => {
    const fixture = createFixture();
    const document = withSolids(
      fixture.document,
      extrudeFeature('extrude-1', fixture.faceA),
      extrudeFeature('extrude-2', fixture.faceB, { distance: '4' }),
      booleanFeature('union-1', 'union', 'extrude-1', 'extrude-2'),
    );
    const result = resolvePart(document);
    expect(result.steps[2].key).toBe(
      cacheKeyFor({
        kind: 'boolean',
        operation: 'union',
        targetKey: result.steps[0].key,
        toolKey: result.steps[1].key,
      }),
    );
  });

  it('同じボディを 2 回消費しようとしたら後の方が consumedTwice', () => {
    const fixture = createFixture();
    const document = withSolids(
      fixture.document,
      extrudeFeature('extrude-1', fixture.faceA),
      extrudeFeature('extrude-2', fixture.faceB, { distance: '4' }),
      extrudeFeature('extrude-3', fixture.faceB, { distance: '6' }),
      booleanFeature('union-1', 'union', 'extrude-1', 'extrude-2'),
      booleanFeature('union-2', 'union', 'extrude-1', 'extrude-3'),
    );
    const result = resolvePart(document);
    expect(codesOf(result)).toEqual(['consumedTwice']);
    expect(result.errors[0].featureId).toBe('union-2');
    expect(result.steps.map((step) => step.featureId)).toEqual([
      'extrude-1',
      'extrude-2',
      'extrude-3',
      'union-1',
    ]);
    expect(result.liveBodyIds).toEqual(['extrude-3', 'union-1']);
  });

  it('相手が消費済みでも consumedTwice', () => {
    const fixture = createFixture();
    const document = withSolids(
      fixture.document,
      extrudeFeature('extrude-1', fixture.faceA),
      extrudeFeature('extrude-2', fixture.faceB, { distance: '4' }),
      extrudeFeature('extrude-3', fixture.faceB, { distance: '6' }),
      booleanFeature('union-1', 'union', 'extrude-1', 'extrude-2'),
      booleanFeature('union-2', 'union', 'extrude-3', 'extrude-2'),
    );
    const result = resolvePart(document);
    expect(codesOf(result)).toEqual(['consumedTwice']);
    expect(result.errors[0].featureId).toBe('union-2');
  });

  it('対象と相手が同じなら invalidValue', () => {
    const fixture = createFixture();
    const document = withSolids(
      fixture.document,
      extrudeFeature('extrude-1', fixture.faceA),
      booleanFeature('union-1', 'union', 'extrude-1', 'extrude-1'),
    );
    const result = resolvePart(document);
    expect(codesOf(result)).toEqual(['invalidValue']);
    expect(result.errors[0].featureId).toBe('union-1');
    // 消費しないので対象は画面に残る。
    expect(result.liveBodyIds).toEqual(['extrude-1']);
  });

  it('参照先のボディが無ければ missingBody', () => {
    const fixture = createFixture();
    const document = withSolids(
      fixture.document,
      extrudeFeature('extrude-1', fixture.faceA),
      booleanFeature('union-1', 'union', 'extrude-1', 'extrude-404'),
    );
    const result = resolvePart(document);
    expect(codesOf(result)).toEqual(['missingBody']);
    expect(result.liveBodyIds).toEqual(['extrude-1']);
  });

  it('上流が失敗した段を参照したら missingBody(例外にならない)', () => {
    const fixture = createFixture();
    const document = withSolids(
      fixture.document,
      extrudeFeature('extrude-1', fixture.faceA, { distance: '0' }),
      extrudeFeature('extrude-2', fixture.faceB, { distance: '4' }),
      booleanFeature('subtract-1', 'subtract', 'extrude-1', 'extrude-2'),
    );
    const result = resolvePart(document);
    expect(codesOf(result)).toEqual(['invalidValue', 'missingBody']);
    expect(result.steps.map((step) => step.featureId)).toEqual(['extrude-2']);
    expect(result.liveBodyIds).toEqual(['extrude-2']);
  });

  it('抑制された段のボディは参照できない', () => {
    const fixture = createFixture();
    const document = withSolids(
      fixture.document,
      extrudeFeature('extrude-1', fixture.faceA, { suppressed: true }),
      extrudeFeature('extrude-2', fixture.faceB, { distance: '4' }),
      booleanFeature('union-1', 'union', 'extrude-1', 'extrude-2'),
    );
    const result = resolvePart(document);
    expect(codesOf(result)).toEqual(['missingBody']);
    expect(result.liveBodyIds).toEqual(['extrude-2']);
  });

  it('履歴で後にある段は参照できない(前方参照は missingBody)', () => {
    const fixture = createFixture();
    const document = withSolids(
      fixture.document,
      extrudeFeature('extrude-1', fixture.faceA),
      booleanFeature('union-1', 'union', 'extrude-1', 'extrude-2'),
      extrudeFeature('extrude-2', fixture.faceB, { distance: '4' }),
    );
    const result = resolvePart(document);
    expect(codesOf(result)).toEqual(['missingBody']);
    expect(result.steps.map((step) => step.featureId)).toEqual(['extrude-1', 'extrude-2']);
  });

  it('ブーリアンの結果をさらに組み合わせられる', () => {
    const fixture = createFixture();
    const document = withSolids(
      fixture.document,
      extrudeFeature('extrude-1', fixture.faceA),
      extrudeFeature('extrude-2', fixture.faceB, { distance: '4' }),
      extrudeFeature('extrude-3', fixture.faceB, { distance: '6' }),
      booleanFeature('union-1', 'union', 'extrude-1', 'extrude-2'),
      booleanFeature('subtract-1', 'subtract', 'union-1', 'extrude-3'),
    );
    const result = resolvePart(document);
    expect(result.errors).toEqual([]);
    expect(result.liveBodyIds).toEqual(['subtract-1']);
    expect(booleanPlan(result.steps[4]).targetKey).toBe(result.steps[3].key);
  });
});

describe('resolvePart 抑制', () => {
  it('抑制した段は飛ばし、失敗としては数えない', () => {
    const fixture = createFixture();
    const document = withSolids(
      fixture.document,
      extrudeFeature('extrude-1', fixture.faceA, { suppressed: true }),
    );
    const result = resolvePart(document);
    expect(result.steps).toEqual([]);
    expect(result.errors).toEqual([]);
    expect(result.liveBodyIds).toEqual([]);
  });

  it('抑制されたブーリアンは何も消費しない', () => {
    const fixture = createFixture();
    const document = withSolids(
      fixture.document,
      extrudeFeature('extrude-1', fixture.faceA),
      extrudeFeature('extrude-2', fixture.faceB, { distance: '4' }),
      booleanFeature('union-1', 'union', 'extrude-1', 'extrude-2', { suppressed: true }),
    );
    const result = resolvePart(document);
    expect(result.errors).toEqual([]);
    expect(result.liveBodyIds).toEqual(['extrude-1', 'extrude-2']);
  });
});

describe('resolvePart 鍵の性質', () => {
  it('同じ文書を 2 回解決すると鍵が一致する(決定性)', () => {
    const fixture = createFixture();
    const document = withSolids(
      fixture.document,
      extrudeFeature('extrude-1', fixture.faceA),
      extrudeFeature('extrude-2', fixture.faceB, { distance: '4' }),
      booleanFeature('union-1', 'union', 'extrude-1', 'extrude-2'),
    );
    const first = resolvePart(document);
    const second = resolvePart(document);
    expect(second.steps.map((step) => step.key)).toEqual(first.steps.map((step) => step.key));
  });

  it('名前だけを変えても鍵は変わらない', () => {
    const fixture = createFixture();
    const before = resolvePart(
      withSolids(fixture.document, extrudeFeature('extrude-1', fixture.faceA, { name: '押し出し1' })),
    );
    const after = resolvePart(
      withSolids(fixture.document, extrudeFeature('extrude-1', fixture.faceA, { name: '底板' })),
    );
    expect(after.steps[0].key).toBe(before.steps[0].key);
  });

  it('上流の距離を変えると、その段と下流のブーリアンの鍵が変わる', () => {
    const fixture = createFixture();
    const build = (distance: string): ResolvedPart =>
      resolvePart(
        withSolids(
          fixture.document,
          extrudeFeature('extrude-1', fixture.faceA, { distance }),
          extrudeFeature('extrude-2', fixture.faceB, { distance: '4' }),
          booleanFeature('union-1', 'union', 'extrude-1', 'extrude-2'),
        ),
      );
    const before = build('10');
    const after = build('20');
    expect(after.steps[0].key).not.toBe(before.steps[0].key);
    // 変えていない段の鍵はそのまま(キャッシュが効く、NFR-PF-3)。
    expect(after.steps[1].key).toBe(before.steps[1].key);
    // 下流へ伝わる(鍵の連鎖)。
    expect(after.steps[2].key).not.toBe(before.steps[2].key);
  });

  it('操作の種類を変えるとブーリアンの鍵が変わる', () => {
    const fixture = createFixture();
    const build = (operation: BooleanOperation): ResolvedPart =>
      resolvePart(
        withSolids(
          fixture.document,
          extrudeFeature('extrude-1', fixture.faceA),
          extrudeFeature('extrude-2', fixture.faceB, { distance: '4' }),
          booleanFeature('op-1', operation, 'extrude-1', 'extrude-2'),
        ),
      );
    expect(build('subtract').steps[2].key).not.toBe(build('union').steps[2].key);
  });

  it('抑制された段があっても残る段の鍵は変わらない', () => {
    const fixture = createFixture();
    const alone = resolvePart(
      withSolids(fixture.document, extrudeFeature('extrude-1', fixture.faceA)),
    );
    const withSuppressed = resolvePart(
      withSolids(
        fixture.document,
        extrudeFeature('extrude-1', fixture.faceA),
        extrudeFeature('extrude-2', fixture.faceB, { suppressed: true }),
      ),
    );
    expect(withSuppressed.steps).toHaveLength(1);
    expect(withSuppressed.steps[0].key).toBe(alone.steps[0].key);
  });
});

describe('resolveMachiningTarget', () => {
  it('作成に成功した未消費のボディなら鍵を返す', () => {
    const outcome = resolveMachiningTarget(
      'hole-1',
      'extrude-1',
      new Map([['extrude-1', 'key-1']]),
      new Set(),
    );
    expect(outcome).toEqual({ ok: true, targetKey: 'key-1' });
  });

  it('ボディが無ければ missingBody', () => {
    const outcome = resolveMachiningTarget('hole-1', 'extrude-9', new Map(), new Set());
    expect(outcome.ok).toBe(false);
    if (outcome.ok) {
      throw new Error('テストの前提が壊れている: 失敗するはずの呼び出しが成功した');
    }
    expect(outcome.error.code).toBe('missingBody');
    expect(outcome.error.featureId).toBe('hole-1');
    expect(outcome.error.message.length).toBeGreaterThan(0);
  });

  it('すでに消費されていれば consumedTwice', () => {
    const outcome = resolveMachiningTarget(
      'hole-1',
      'extrude-1',
      new Map([['extrude-1', 'key-1']]),
      new Set(['extrude-1']),
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) {
      throw new Error('テストの前提が壊れている: 失敗するはずの呼び出しが成功した');
    }
    expect(outcome.error.code).toBe('consumedTwice');
  });
});

describe('resolveHoleCenters', () => {
  it('点フィーチャーは1点になる', () => {
    const fixture = createFixture();
    const outcome = resolveHoleCenters('hole-1', [fixture.pointA], sketchesOf(fixture.document));
    expect(outcome).toEqual({ ok: true, centers: [[10, 10, 0]] });
  });

  it('点列フィーチャーは全点に展開される(FR-308)', () => {
    const fixture = createFixture();
    const outcome = resolveHoleCenters(
      'hole-1',
      [fixture.pointArray],
      sketchesOf(fixture.document),
    );
    // (50,0,0) から X 方向へ間隔 5 で 3 点。
    expect(outcome).toEqual({
      ok: true,
      centers: [
        [50, 0, 0],
        [55, 0, 0],
        [60, 0, 0],
      ],
    });
  });

  it('参照した順に並ぶ(並べ替えない)', () => {
    const fixture = createFixture();
    const outcome = resolveHoleCenters(
      'hole-1',
      [fixture.pointB, fixture.pointA],
      sketchesOf(fixture.document),
    );
    expect(outcome).toEqual({
      ok: true,
      centers: [
        [30, 20, 0],
        [10, 10, 0],
      ],
    });
  });

  it('参照が空なら missingProfile', () => {
    const fixture = createFixture();
    const outcome = resolveHoleCenters('hole-1', [], sketchesOf(fixture.document));
    expect(outcome.ok).toBe(false);
    if (outcome.ok) {
      throw new Error('テストの前提が壊れている: 失敗するはずの呼び出しが成功した');
    }
    expect(outcome.error.code).toBe('missingProfile');
    expect(outcome.error.message).toContain('穴の中心にする点');
  });

  it('点フィーチャーが消えていれば missingProfile', () => {
    const fixture = createFixture();
    const outcome = resolveHoleCenters(
      'hole-1',
      [{ sketchId: fixture.pointA.sketchId, pointFeatureId: 'point-404' }],
      sketchesOf(fixture.document),
    );
    expect(outcome.ok).toBe(false);
  });

  it('スケッチが消えていれば missingProfile', () => {
    const fixture = createFixture();
    const outcome = resolveHoleCenters(
      'hole-1',
      [{ sketchId: 'sketch-404', pointFeatureId: fixture.pointA.pointFeatureId }],
      sketchesOf(fixture.document),
    );
    expect(outcome.ok).toBe(false);
  });

  it('一部の参照が見つからなくても、取れた点で続ける', () => {
    const fixture = createFixture();
    const outcome = resolveHoleCenters(
      'hole-1',
      [{ sketchId: fixture.pointA.sketchId, pointFeatureId: 'point-404' }, fixture.pointA],
      sketchesOf(fixture.document),
    );
    expect(outcome).toEqual({ ok: true, centers: [[10, 10, 0]] });
  });
});

describe('resolvePart 穴', () => {
  it('対象を消費し、面・中心・径・貫通をそのまま渡す', () => {
    const fixture = createFixture();
    const document = withSolids(
      fixture.document,
      extrudeFeature('extrude-1', fixture.faceA),
      holeFeature('hole-1', 'extrude-1', [fixture.pointA]),
    );
    const result = resolvePart(document);
    expect(result.errors).toEqual([]);
    expect(result.steps).toHaveLength(2);
    expect(result.steps.map((step) => step.visible)).toEqual([false, true]);
    const plan = holePlan(result.steps[1]);
    expect(plan.targetKey).toBe(result.steps[0].key);
    expect(plan.face).toEqual(topFaceRef('extrude-1'));
    expect(plan.centers).toEqual([[10, 10, 0]]);
    expect(plan.diameter).toBe(6);
    expect(plan.depth).toBeNull();
    expect(plan.tiltAngle).toBe(0);
    expect(plan.tiltAzimuth).toBe(0);
    // パターンでない穴の変換は必ず空(cacheKey.ts の HoleKeyMaterial の注釈)。
    expect(plan.transforms).toEqual([]);
    expect(result.liveBodyIds).toEqual(['hole-1']);
  });

  it('点列を指すと全点が中心になる', () => {
    const fixture = createFixture();
    const document = withSolids(
      fixture.document,
      extrudeFeature('extrude-1', fixture.faceA),
      holeFeature('hole-1', 'extrude-1', [fixture.pointArray]),
    );
    expect(holePlan(resolvePart(document).steps[1]).centers).toHaveLength(3);
  });

  it('点を2つ指すと選んだ順に並ぶ', () => {
    const fixture = createFixture();
    const document = withSolids(
      fixture.document,
      extrudeFeature('extrude-1', fixture.faceA),
      holeFeature('hole-1', 'extrude-1', [fixture.pointB, fixture.pointA]),
    );
    expect(holePlan(resolvePart(document).steps[1]).centers).toEqual([
      [30, 20, 0],
      [10, 10, 0],
    ]);
  });

  it('止まり穴は深さをそのまま渡す', () => {
    const fixture = createFixture();
    const document = withSolids(
      fixture.document,
      extrudeFeature('extrude-1', fixture.faceA),
      holeFeature('hole-1', 'extrude-1', [fixture.pointA], {
        depth: { kind: 'blind', depth: expr('4') },
      }),
    );
    expect(holePlan(resolvePart(document).steps[1]).depth).toBe(4);
  });

  it('傾き 30 度・方位角 45 度はラジアンへ直る', () => {
    const fixture = createFixture();
    const document = withSolids(
      fixture.document,
      extrudeFeature('extrude-1', fixture.faceA),
      holeFeature('hole-1', 'extrude-1', [fixture.pointA], {
        tiltAngle: '30',
        tiltAzimuth: '45',
      }),
    );
    const plan = holePlan(resolvePart(document).steps[1]);
    // 30 度 = 30 × π / 180 = π / 6、45 度 = π / 4。
    expect(plan.tiltAngle).toBeCloseTo(Math.PI / 6, 12);
    expect(plan.tiltAzimuth).toBeCloseTo(Math.PI / 4, 12);
  });

  it('方位角は 360 度を超えてもよい(面内の向きなので範囲を決めない)', () => {
    const fixture = createFixture();
    const document = withSolids(
      fixture.document,
      extrudeFeature('extrude-1', fixture.faceA),
      holeFeature('hole-1', 'extrude-1', [fixture.pointA], { tiltAzimuth: '450' }),
    );
    const result = resolvePart(document);
    expect(result.errors).toEqual([]);
    expect(holePlan(result.steps[1]).tiltAzimuth).toBeCloseTo((450 * Math.PI) / 180, 12);
  });

  it('傾きが 90 度なら invalidValue(面と平行になり材料へ入らない)', () => {
    const fixture = createFixture();
    const document = withSolids(
      fixture.document,
      extrudeFeature('extrude-1', fixture.faceA),
      holeFeature('hole-1', 'extrude-1', [fixture.pointA], { tiltAngle: '90' }),
    );
    const result = resolvePart(document);
    expect(codesOf(result)).toEqual(['invalidValue']);
    expect(result.errors[0].message).toContain('90 度未満');
    // 穴が作れなかったので対象は消費されず、押し出しが画面に残る。
    expect(result.steps.map((step) => step.featureId)).toEqual(['extrude-1']);
    expect(result.liveBodyIds).toEqual(['extrude-1']);
  });

  it('傾きが負なら invalidValue', () => {
    const fixture = createFixture();
    const document = withSolids(
      fixture.document,
      extrudeFeature('extrude-1', fixture.faceA),
      holeFeature('hole-1', 'extrude-1', [fixture.pointA], { tiltAngle: '0-1' }),
    );
    expect(codesOf(resolvePart(document))).toEqual(['invalidValue']);
  });

  it('方位角が数になっていなければ invalidValue', () => {
    const fixture = createFixture();
    const document = withSolids(
      fixture.document,
      extrudeFeature('extrude-1', fixture.faceA),
      holeFeature('hole-1', 'extrude-1', [fixture.pointA], {
        tiltAzimuth: notANumber('a'),
      }),
    );
    expect(codesOf(resolvePart(document))).toEqual(['invalidValue']);
  });

  it('直径が 0 なら段を作らず invalidValue', () => {
    const fixture = createFixture();
    const document = withSolids(
      fixture.document,
      extrudeFeature('extrude-1', fixture.faceA),
      holeFeature('hole-1', 'extrude-1', [fixture.pointA], { diameter: '0' }),
    );
    const result = resolvePart(document);
    expect(codesOf(result)).toEqual(['invalidValue']);
    expect(result.steps.map((step) => step.featureId)).toEqual(['extrude-1']);
  });

  it('止まり穴の深さが 0 なら invalidValue', () => {
    const fixture = createFixture();
    const document = withSolids(
      fixture.document,
      extrudeFeature('extrude-1', fixture.faceA),
      holeFeature('hole-1', 'extrude-1', [fixture.pointA], {
        depth: { kind: 'blind', depth: expr('0') },
      }),
    );
    expect(codesOf(resolvePart(document))).toEqual(['invalidValue']);
  });

  it('面が別のボディのものなら invalidValue', () => {
    const fixture = createFixture();
    const document = withSolids(
      fixture.document,
      extrudeFeature('extrude-1', fixture.faceA),
      extrudeFeature('extrude-2', fixture.faceB, { distance: '4' }),
      holeFeature('hole-1', 'extrude-1', [fixture.pointA], { face: topFaceRef('extrude-2') }),
    );
    const result = resolvePart(document);
    expect(codesOf(result)).toEqual(['invalidValue']);
    expect(result.errors[0].message).toContain('もとの立体の面');
  });

  it('面でなく辺を指していたら invalidValue', () => {
    const fixture = createFixture();
    const document = withSolids(
      fixture.document,
      extrudeFeature('extrude-1', fixture.faceA),
      holeFeature('hole-1', 'extrude-1', [fixture.pointA], { face: edgeRef('extrude-1') }),
    );
    const result = resolvePart(document);
    expect(codesOf(result)).toEqual(['invalidValue']);
    expect(result.errors[0].message).toContain('面だけ');
  });

  it('対象が抑制されていれば missingBody', () => {
    const fixture = createFixture();
    const document = withSolids(
      fixture.document,
      extrudeFeature('extrude-1', fixture.faceA, { suppressed: true }),
      holeFeature('hole-1', 'extrude-1', [fixture.pointA]),
    );
    const result = resolvePart(document);
    expect(codesOf(result)).toEqual(['missingBody']);
    expect(result.steps).toEqual([]);
  });

  it('対象がすでにブーリアンに消費されていれば consumedTwice', () => {
    const fixture = createFixture();
    const document = withSolids(
      fixture.document,
      extrudeFeature('extrude-1', fixture.faceA),
      extrudeFeature('extrude-2', fixture.faceB, { distance: '4' }),
      booleanFeature('union-1', 'union', 'extrude-1', 'extrude-2'),
      holeFeature('hole-1', 'extrude-1', [fixture.pointA]),
    );
    const result = resolvePart(document);
    expect(codesOf(result)).toEqual(['consumedTwice']);
    expect(result.liveBodyIds).toEqual(['union-1']);
  });

  it('中心の点フィーチャーが消えていれば missingProfile(例外にならない)', () => {
    const fixture = createFixture();
    const document = withSolids(
      fixture.document,
      extrudeFeature('extrude-1', fixture.faceA),
      holeFeature('hole-1', 'extrude-1', [
        { sketchId: fixture.pointA.sketchId, pointFeatureId: 'point-404' },
      ]),
    );
    const result = resolvePart(document);
    expect(codesOf(result)).toEqual(['missingProfile']);
    expect(result.liveBodyIds).toEqual(['extrude-1']);
  });

  it('抑制した穴は何も消費しない(対象が画面に残る)', () => {
    const fixture = createFixture();
    const document = withSolids(
      fixture.document,
      extrudeFeature('extrude-1', fixture.faceA),
      holeFeature('hole-1', 'extrude-1', [fixture.pointA], { suppressed: true }),
    );
    const result = resolvePart(document);
    expect(result.errors).toEqual([]);
    expect(result.liveBodyIds).toEqual(['extrude-1']);
  });

  it('穴の結果にさらに穴をあけられる(鍵が連鎖する)', () => {
    const fixture = createFixture();
    const document = withSolids(
      fixture.document,
      extrudeFeature('extrude-1', fixture.faceA),
      holeFeature('hole-1', 'extrude-1', [fixture.pointA]),
      holeFeature('hole-2', 'hole-1', [fixture.pointB], { face: topFaceRef('hole-1') }),
    );
    const result = resolvePart(document);
    expect(result.errors).toEqual([]);
    expect(holePlan(result.steps[2]).targetKey).toBe(result.steps[1].key);
    expect(result.liveBodyIds).toEqual(['hole-2']);
  });

  it('鍵は対象の鍵・面の指紋・中心・径・深さ・傾きから作られる', () => {
    const fixture = createFixture();
    const document = withSolids(
      fixture.document,
      extrudeFeature('extrude-1', fixture.faceA),
      holeFeature('hole-1', 'extrude-1', [fixture.pointA]),
    );
    const result = resolvePart(document);
    expect(result.steps[1].key).toBe(
      cacheKeyFor({
        kind: 'hole',
        targetKey: result.steps[0].key,
        face: fingerprintKeyText(topFaceRef('extrude-1')),
        centers: [[10, 10, 0]],
        diameter: 6,
        depth: null,
        tiltAngle: 0,
        tiltAzimuth: 0,
        transforms: [],
      }),
    );
  });

  it('径だけを変えると穴の鍵だけが変わる', () => {
    const fixture = createFixture();
    const build = (diameter: string): ResolvedPart =>
      resolvePart(
        withSolids(
          fixture.document,
          extrudeFeature('extrude-1', fixture.faceA),
          holeFeature('hole-1', 'extrude-1', [fixture.pointA], { diameter }),
        ),
      );
    const before = build('6');
    const after = build('8');
    expect(after.steps[0].key).toBe(before.steps[0].key);
    expect(after.steps[1].key).not.toBe(before.steps[1].key);
  });

  it('中心の並びを変えると鍵が変わる(並びは形の作り方の一部)', () => {
    const fixture = createFixture();
    const build = (centers: readonly SketchPointRef[]): ResolvedPart =>
      resolvePart(
        withSolids(
          fixture.document,
          extrudeFeature('extrude-1', fixture.faceA),
          holeFeature('hole-1', 'extrude-1', centers),
        ),
      );
    expect(build([fixture.pointA, fixture.pointB]).steps[1].key).not.toBe(
      build([fixture.pointB, fixture.pointA]).steps[1].key,
    );
  });

  it('貫通と深さ 0 は別の鍵になるはずだが、深さ 0 は断るので比べるのは貫通と深さ 4', () => {
    const fixture = createFixture();
    const build = (depth: HoleDepth): ResolvedPart =>
      resolvePart(
        withSolids(
          fixture.document,
          extrudeFeature('extrude-1', fixture.faceA),
          holeFeature('hole-1', 'extrude-1', [fixture.pointA], { depth }),
        ),
      );
    expect(build({ kind: 'blind', depth: expr('4') }).steps[1].key).not.toBe(
      build({ kind: 'through' }).steps[1].key,
    );
  });

  it('同じ文書を 2 回解決すると鍵が一致し、名前だけ変えても変わらない', () => {
    const fixture = createFixture();
    const build = (name: string): ResolvedPart =>
      resolvePart(
        withSolids(
          fixture.document,
          extrudeFeature('extrude-1', fixture.faceA),
          holeFeature('hole-1', 'extrude-1', [fixture.pointA], { name }),
        ),
      );
    const first = build('穴1');
    expect(build('穴1').steps.map((step) => step.key)).toEqual(
      first.steps.map((step) => step.key),
    );
    expect(build('取付穴').steps.map((step) => step.key)).toEqual(
      first.steps.map((step) => step.key),
    );
  });
});

describe('resolvePart ねじ穴', () => {
  it('M6 並目・簡略表示は下穴 D1 を掘り、実らせんは作らずに印だけを返す', () => {
    const fixture = createFixture();
    const document = withSolids(
      fixture.document,
      extrudeFeature('extrude-1', fixture.faceA),
      threadHoleFeature('thread-1', 'extrude-1', [fixture.pointA]),
    );
    const result = resolvePart(document);
    expect(result.errors).toEqual([]);
    expect(result.steps.map((step) => step.visible)).toEqual([false, true]);
    const plan = threadPlan(result.steps[1]);
    // D1 = d − 2·(5/8)·(P√3/2) = 6 − 5√3/8 = 4.917468245269452(§2.5.1 の表と一致)。
    // 文書へ入るときに expressionValueFromNumber が有効数字12桁へ丸めるので
    // 4.91746824527 になる(差は 5.5e-13 で、計画書の許容 ±1e-9 の中)。
    expect(plan.drillDiameter).toBeCloseTo(4.917468245, 9);
    expect(plan.drillDiameter).toBe(M6_DRILL_DIAMETER);
    expect(plan.pitch).toBe(1);
    expect(plan.thread).toBeNull();
    expect(plan.mark).toEqual({ majorDiameter: 6, length: 10 });
    expect(plan.depth).toBeNull();
    expect(plan.centers).toEqual([[10, 10, 0]]);
    expect(plan.transforms).toEqual([]);
    expect(result.liveBodyIds).toEqual(['thread-1']);
  });

  it('実らせんを選ぶと外径・ピッチ・ねじ部の長さが段に入る', () => {
    const fixture = createFixture();
    const document = withSolids(
      fixture.document,
      extrudeFeature('extrude-1', fixture.faceA),
      threadHoleFeature('thread-1', 'extrude-1', [fixture.pointA], {
        representation: 'modeled',
      }),
    );
    const plan = threadPlan(resolvePart(document).steps[1]);
    expect(plan.thread).toEqual({ majorDiameter: 6, pitch: 1, length: 10 });
    // 印は実らせんでも作る(§2.4.2)。
    expect(plan.mark).toEqual({ majorDiameter: 6, length: 10 });
  });

  it('簡略表示と実らせんで鍵が変わる(形そのものが変わるため)', () => {
    const fixture = createFixture();
    const build = (representation: ThreadRepresentation): ResolvedPart =>
      resolvePart(
        withSolids(
          fixture.document,
          extrudeFeature('extrude-1', fixture.faceA),
          threadHoleFeature('thread-1', 'extrude-1', [fixture.pointA], { representation }),
        ),
      );
    expect(build('modeled').steps[1].key).not.toBe(build('simplified').steps[1].key);
  });

  it('M8 細目の既定のピッチは 1(§2.5.1)', () => {
    const fixture = createFixture();
    const document = withSolids(
      fixture.document,
      extrudeFeature('extrude-1', fixture.faceA),
      threadHoleFeature('thread-1', 'extrude-1', [fixture.pointA], {
        designation: 'M8',
        series: 'fine',
      }),
    );
    const plan = threadPlan(resolvePart(document).steps[1]);
    expect(plan.pitch).toBe(1);
    // D1 = 8 − 1.082532×1 = 6.917468245(細目なので並目の 6.646835 とは違う)。
    expect(plan.drillDiameter).toBeCloseTo(threadMinorDiameter(8, 1), 9);
    expect(plan.mark.majorDiameter).toBe(8);
  });

  it('規格表に無い呼びなら invalidValue', () => {
    const fixture = createFixture();
    const document = withSolids(
      fixture.document,
      extrudeFeature('extrude-1', fixture.faceA),
      threadHoleFeature('thread-1', 'extrude-1', [fixture.pointA], { designation: 'M5.5' }),
    );
    const result = resolvePart(document);
    expect(codesOf(result)).toEqual(['invalidValue']);
    expect(result.errors[0].message).toContain('ねじの呼び');
  });

  it('下穴の径が外径以上なら invalidValue', () => {
    const fixture = createFixture();
    const document = withSolids(
      fixture.document,
      extrudeFeature('extrude-1', fixture.faceA),
      threadHoleFeature('thread-1', 'extrude-1', [fixture.pointA], { drillDiameter: '6' }),
    );
    const result = resolvePart(document);
    expect(codesOf(result)).toEqual(['invalidValue']);
    expect(result.errors[0].message).toContain('ねじの外径より小さく');
  });

  it('ピッチが 0 以下なら invalidValue', () => {
    const fixture = createFixture();
    const document = withSolids(
      fixture.document,
      extrudeFeature('extrude-1', fixture.faceA),
      threadHoleFeature('thread-1', 'extrude-1', [fixture.pointA], { pitch: '0' }),
    );
    expect(codesOf(resolvePart(document))).toEqual(['invalidValue']);
  });

  it('ねじ部の長さが数になっていなければ invalidValue', () => {
    const fixture = createFixture();
    const document = withSolids(
      fixture.document,
      extrudeFeature('extrude-1', fixture.faceA),
      threadHoleFeature('thread-1', 'extrude-1', [fixture.pointA], {
        threadLength: notANumber('a'),
      }),
    );
    expect(codesOf(resolvePart(document))).toEqual(['invalidValue']);
  });

  it('止まり穴でねじ部の長さが深さを超えたら invalidValue', () => {
    const fixture = createFixture();
    const document = withSolids(
      fixture.document,
      extrudeFeature('extrude-1', fixture.faceA),
      threadHoleFeature('thread-1', 'extrude-1', [fixture.pointA], {
        depth: { kind: 'blind', depth: expr('10') },
        threadLength: '20',
      }),
    );
    const result = resolvePart(document);
    expect(codesOf(result)).toEqual(['invalidValue']);
    expect(result.errors[0].message).toContain('穴の深さ以下');
  });

  it('貫通ならねじ部の長さは深さと比べない', () => {
    const fixture = createFixture();
    const document = withSolids(
      fixture.document,
      extrudeFeature('extrude-1', fixture.faceA),
      threadHoleFeature('thread-1', 'extrude-1', [fixture.pointA], { threadLength: '20' }),
    );
    const result = resolvePart(document);
    expect(result.errors).toEqual([]);
    expect(threadPlan(result.steps[1]).mark.length).toBe(20);
  });

  it('止まり穴でねじ部の長さが深さと同じなら通る', () => {
    const fixture = createFixture();
    const document = withSolids(
      fixture.document,
      extrudeFeature('extrude-1', fixture.faceA),
      threadHoleFeature('thread-1', 'extrude-1', [fixture.pointA], {
        depth: { kind: 'blind', depth: expr('10') },
        threadLength: '10',
      }),
    );
    const result = resolvePart(document);
    expect(result.errors).toEqual([]);
    expect(threadPlan(result.steps[1]).depth).toBe(10);
  });

  it('対象・面・中心の断り方は穴と同じ', () => {
    const fixture = createFixture();
    const document = withSolids(
      fixture.document,
      extrudeFeature('extrude-1', fixture.faceA),
      threadHoleFeature('thread-1', 'extrude-1', []),
    );
    const result = resolvePart(document);
    expect(codesOf(result)).toEqual(['missingProfile']);
    expect(result.liveBodyIds).toEqual(['extrude-1']);
  });

  it('鍵は下穴・外径・ピッチ・ねじ部の長さ・表示方法から作られる', () => {
    const fixture = createFixture();
    const document = withSolids(
      fixture.document,
      extrudeFeature('extrude-1', fixture.faceA),
      threadHoleFeature('thread-1', 'extrude-1', [fixture.pointA]),
    );
    const result = resolvePart(document);
    expect(result.steps[1].key).toBe(
      cacheKeyFor({
        kind: 'thread',
        targetKey: result.steps[0].key,
        face: fingerprintKeyText(topFaceRef('extrude-1')),
        centers: [[10, 10, 0]],
        drillDiameter: M6_DRILL_DIAMETER,
        majorDiameter: 6,
        pitch: 1,
        threadLength: 10,
        depth: null,
        modeled: false,
        tiltAngle: 0,
        tiltAzimuth: 0,
        transforms: [],
      }),
    );
  });

  it('穴とねじ穴は同じ値でも別の鍵になる', () => {
    const fixture = createFixture();
    const hole = resolvePart(
      withSolids(
        fixture.document,
        extrudeFeature('extrude-1', fixture.faceA),
        holeFeature('hole-1', 'extrude-1', [fixture.pointA], {
          diameter: expressionValueFromNumber(M6_DRILL_DIAMETER),
        }),
      ),
    );
    const thread = resolvePart(
      withSolids(
        fixture.document,
        extrudeFeature('extrude-1', fixture.faceA),
        threadHoleFeature('thread-1', 'extrude-1', [fixture.pointA]),
      ),
    );
    expect(thread.steps[1].key).not.toBe(hole.steps[1].key);
  });
});
