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
import {
  DEFAULT_WORK_PLANE_ID,
  FREE_WORK_PLANE_ID,
  type WorkPlaneId,
} from '../sketch/planeMath.js';
import type {
  CoordinateInput,
  ResolvedArc,
  ResolvedCurve,
  ResolvedSegment,
  SketchArcFeature,
  SketchDocument,
  SketchFaceFeature,
  SketchFeature,
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
import {
  addSketch,
  appendReference,
  appendSolid,
  consumedTargetsOf,
  createEmptyPartDocument,
  DEFAULT_PRIMITIVE_AXIS,
  DEFAULT_RULED_SPHERE_SEGMENTS,
  defaultPrimitiveOrigin,
  replaceSketch,
} from './createPartDocument.js';
import {
  referencedSketchIds,
  resolveHoleCenters,
  resolveMachiningTarget,
  resolvePart,
  resolvePatternTransforms,
  resolveRevolveAxis,
  resolveSpringLength,
  resolveSpringOrigin,
  resolveTiltedDirection,
  translateCurve,
} from './resolvePart.js';
import type {
  RevolveAxisFrame,
  ResolvedPart,
  ResolvedPartSketch,
  ResolvedSolidStep,
} from './resolvePart.js';
import { fingerprintKeyText } from './subShapeRef.js';
import type {
  BooleanFeature,
  BooleanOperation,
  ChamferFeature,
  ChamferSize,
  ExtrudeFeature,
  FilletFeature,
  HoleDepth,
  HoleFeature,
  LoftFeature,
  PartDocument,
  PatternDirection,
  PatternFeature,
  PatternPlacement,
  PrimitiveFeature,
  PrimitiveShape,
  RevolveAxis,
  RevolveFeature,
  RuledFeature,
  RuledSection,
  RuledSphereSegments,
  SewFeature,
  SketchFaceRef,
  SketchLineRef,
  SketchPointRef,
  SolidFeature,
  SolidOrigin,
  SpringDerived,
  SpringFeature,
  SpringHandedness,
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
    construction: false,
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
    layout: {
      kind: 'linear',
      base: absoluteCoordinate(50, 0, 0),
      azimuth: expressionValueFromNumber(0),
      spacing: expressionValueFromNumber(5),
      count: expressionValueFromNumber(3),
    },
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

/**
 * 40×30 の面を Z へ 10 押し出した箱の「上面の角 (40,30,10)」の頂点の指紋。
 * 基本形状の中心に立体の頂点を指す検査(FR-429、§0.a-0.18)に使う。
 */
function vertexRef(bodyFeatureId: string, position: Vec3 = [40, 30, 10]): SubShapeRef {
  return { bodyFeatureId, index: 2, fingerprint: { kind: 'vertex', position } };
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

/** 通し番号だけを変えた辺の指紋(R面取り・C面取りの `targets` を複数本にする検査に使う)。 */
function edgeRefAt(bodyFeatureId: string, index: number): SubShapeRef {
  return { ...edgeRef(bodyFeatureId), index };
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

interface SpringOptions {
  readonly axis?: RevolveAxis;
  readonly tiltAngle?: string | ExpressionValue;
  readonly tiltAzimuth?: string | ExpressionValue;
  readonly length?: string | ExpressionValue;
  readonly pitch?: string | ExpressionValue;
  readonly turns?: string | ExpressionValue;
  readonly derived?: SpringDerived;
  readonly coilDiameter?: string | ExpressionValue;
  readonly wireDiameter?: string | ExpressionValue;
  readonly handedness?: SpringHandedness;
  readonly suppressed?: boolean;
  readonly name?: string;
}

/**
 * ばね。既定はピッチ 5・巻数 4(§0.a-0.30 の既定値、derived='length' で全長 20 になる)、
 * コイル径 20・線径 2・右巻き・軸はワールド Z・傾き 0。
 */
function springFeature(
  id: string,
  origin: SketchPointRef,
  options: SpringOptions = {},
): SpringFeature {
  return {
    id,
    name: options.name ?? id,
    suppressed: options.suppressed ?? false,
    kind: 'spring',
    origin,
    axis: options.axis ?? { kind: 'world', axis: 'z' },
    tiltAngle: toExpr(options.tiltAngle ?? '0'),
    tiltAzimuth: toExpr(options.tiltAzimuth ?? '0'),
    length: toExpr(options.length ?? '20'),
    pitch: toExpr(options.pitch ?? '5'),
    turns: toExpr(options.turns ?? '4'),
    derived: options.derived ?? 'length',
    coilDiameter: toExpr(options.coilDiameter ?? '20'),
    wireDiameter: toExpr(options.wireDiameter ?? '2'),
    handedness: options.handedness ?? 'right',
  };
}

interface PrimitiveOptions {
  readonly origin?: SolidOrigin;
  readonly axis?: RevolveAxis;
  readonly suppressed?: boolean;
  readonly name?: string;
}

/**
 * 基本形状(FR-429)。既定は中心が原点の絶対座標・向きがワールド Z(`createPartDocument.ts`
 * の既定と同じ)で、寸法だけを検査ごとに渡す。
 */
function primitiveFeature(
  id: string,
  shape: PrimitiveShape,
  options: PrimitiveOptions = {},
): PrimitiveFeature {
  return {
    id,
    name: options.name ?? id,
    suppressed: options.suppressed ?? false,
    kind: 'primitive',
    origin: options.origin ?? defaultPrimitiveOrigin(),
    axis: options.axis ?? DEFAULT_PRIMITIVE_AXIS,
    shape,
  };
}

/** 基本形状5種の寸法。既定値は §2.7.1 の表(球 10 / 箱 20³ / 円柱 10・20 / 円錐 10・0・20 / トーラス 20・5)。 */
function sphereShape(radius: string | ExpressionValue = '10'): PrimitiveShape {
  return { kind: 'sphere', radius: toExpr(radius) };
}

function boxShape(
  sizeX: string | ExpressionValue = '20',
  sizeY: string | ExpressionValue = '20',
  sizeZ: string | ExpressionValue = '20',
): PrimitiveShape {
  return { kind: 'box', sizeX: toExpr(sizeX), sizeY: toExpr(sizeY), sizeZ: toExpr(sizeZ) };
}

function cylinderShape(
  radius: string | ExpressionValue = '10',
  height: string | ExpressionValue = '20',
): PrimitiveShape {
  return { kind: 'cylinder', radius: toExpr(radius), height: toExpr(height) };
}

function coneShape(
  bottomRadius: string | ExpressionValue = '10',
  topRadius: string | ExpressionValue = '0',
  height: string | ExpressionValue = '20',
): PrimitiveShape {
  return {
    kind: 'cone',
    bottomRadius: toExpr(bottomRadius),
    topRadius: toExpr(topRadius),
    height: toExpr(height),
  };
}

function torusShape(
  majorRadius: string | ExpressionValue = '20',
  minorRadius: string | ExpressionValue = '5',
): PrimitiveShape {
  return { kind: 'torus', majorRadius: toExpr(majorRadius), minorRadius: toExpr(minorRadius) };
}

/** 中心を絶対座標の式で指す(式の文字列をそのまま保つ。FR-202)。 */
function coordinateOrigin(x: string, y: string, z: string): SolidOrigin {
  const value: CoordinateInput = { mode: 'absolute', x: expr(x), y: expr(y), z: expr(z) };
  return { kind: 'coordinate', value };
}

interface FilletOptions {
  readonly radius?: string | ExpressionValue;
  readonly suppressed?: boolean;
  readonly name?: string;
}

/** R面取り。既定は半径5(タスク16 の検証表の値)。 */
function filletFeature(
  id: string,
  targetFeatureId: string,
  targets: readonly SubShapeRef[],
  options: FilletOptions = {},
): FilletFeature {
  return {
    id,
    name: options.name ?? id,
    suppressed: options.suppressed ?? false,
    kind: 'fillet',
    targetFeatureId,
    targets,
    radius: toExpr(options.radius ?? '5'),
  };
}

interface ChamferOptions {
  readonly size?: ChamferSize;
  readonly swapReferenceFace?: boolean;
  readonly suppressed?: boolean;
  readonly name?: string;
}

/** C面取り。既定は等距離2mm・基準面の入れ替えなし。 */
function chamferFeature(
  id: string,
  targetFeatureId: string,
  targets: readonly SubShapeRef[],
  options: ChamferOptions = {},
): ChamferFeature {
  return {
    id,
    name: options.name ?? id,
    suppressed: options.suppressed ?? false,
    kind: 'chamfer',
    targetFeatureId,
    targets,
    size: options.size ?? { kind: 'equal', distance: expr('2') },
    swapReferenceFace: options.swapReferenceFace ?? false,
  };
}

interface LinearPlacementOptions {
  readonly direction?: PatternDirection;
  readonly spacing?: string | ExpressionValue;
  readonly count?: string | ExpressionValue;
  readonly symmetric?: boolean;
}

/** 直線パターンの配置。既定はワールド X・間隔20・個数3・両側なし(§0.a-0.21 の既定)。 */
function linearPlacement(options: LinearPlacementOptions = {}): PatternPlacement {
  return {
    kind: 'linear',
    direction: options.direction ?? { kind: 'world', axis: 'x' },
    spacing: toExpr(options.spacing ?? '20'),
    count: toExpr(options.count ?? '3'),
    symmetric: options.symmetric ?? false,
  };
}

interface CircularPlacementOptions {
  readonly axis?: PatternDirection;
  readonly angle?: string | ExpressionValue;
  readonly count?: string | ExpressionValue;
  readonly fullCircle?: boolean;
}

/** 円形パターンの配置。既定はワールド Z・全周・個数4(§0.a-0.21 の既定)。 */
function circularPlacement(options: CircularPlacementOptions = {}): PatternPlacement {
  return {
    kind: 'circular',
    axis: options.axis ?? { kind: 'world', axis: 'z' },
    angle: toExpr(options.angle ?? '360'),
    count: toExpr(options.count ?? '4'),
    fullCircle: options.fullCircle ?? true,
  };
}

interface PatternOptions {
  readonly suppressed?: boolean;
  readonly name?: string;
}

function patternFeature(
  id: string,
  sourceFeatureId: string,
  placement: PatternPlacement,
  options: PatternOptions = {},
): PatternFeature {
  return {
    id,
    name: options.name ?? id,
    suppressed: options.suppressed ?? false,
    kind: 'pattern',
    sourceFeatureId,
    placement,
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

function springPlan(step: ResolvedSolidStep): Extract<ResolvedSolidStep['plan'], { kind: 'spring' }> {
  if (step.plan.kind !== 'spring') {
    throw new Error(`テストの前提が壊れている: ばねでない段 ${step.plan.kind}`);
  }
  return step.plan;
}

function primitivePlan(
  step: ResolvedSolidStep,
): Extract<ResolvedSolidStep['plan'], { kind: 'primitive' }> {
  if (step.plan.kind !== 'primitive') {
    throw new Error(`テストの前提が壊れている: 基本形状でない段 ${step.plan.kind}`);
  }
  return step.plan;
}

function filletPlan(step: ResolvedSolidStep): Extract<ResolvedSolidStep['plan'], { kind: 'fillet' }> {
  if (step.plan.kind !== 'fillet') {
    throw new Error(`テストの前提が壊れている: R面取りでない段 ${step.plan.kind}`);
  }
  return step.plan;
}

function chamferPlan(step: ResolvedSolidStep): Extract<ResolvedSolidStep['plan'], { kind: 'chamfer' }> {
  if (step.plan.kind !== 'chamfer') {
    throw new Error(`テストの前提が壊れている: C面取りでない段 ${step.plan.kind}`);
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

describe('resolveSpringLength', () => {
  it("derived: 'length' はピッチ×巻数を計算する(保存値は無視)", () => {
    const outcome = resolveSpringLength({ length: 0, pitch: 5, turns: 4 }, 'length');
    expect(outcome).toEqual({ ok: true, length: 20, pitch: 5, turns: 4 });
  });

  it("derived: 'pitch' は全長÷巻数を計算する", () => {
    const outcome = resolveSpringLength({ length: 20, pitch: 0, turns: 4 }, 'pitch');
    expect(outcome).toEqual({ ok: true, length: 20, pitch: 5, turns: 4 });
  });

  it("derived: 'turns' は全長÷ピッチを計算する", () => {
    const outcome = resolveSpringLength({ length: 20, pitch: 5, turns: 0 }, 'turns');
    expect(outcome).toEqual({ ok: true, length: 20, pitch: 5, turns: 4 });
  });

  it("derived の欄の保存値は使わない(全長 20 でもピッチ 5・巻数 99 なら 495 になる)", () => {
    const outcome = resolveSpringLength({ length: 20, pitch: 5, turns: 99 }, 'length');
    expect(outcome).toEqual({ ok: true, length: 495, pitch: 5, turns: 99 });
  });

  it("derived: 'pitch' で巻数が 0 なら断り、文言に「巻数」を含む(0 で割れない)", () => {
    const outcome = resolveSpringLength({ length: 20, pitch: 0, turns: 0 }, 'pitch');
    expect(outcome.ok).toBe(false);
    if (outcome.ok) {
      throw new Error('テストの前提が壊れている: 失敗するはずの呼び出しが成功した');
    }
    expect(outcome.message).toContain('巻数');
  });

  it("derived: 'turns' でピッチが 0 なら断り、文言に「ピッチ」を含む", () => {
    const outcome = resolveSpringLength({ length: 20, pitch: 0, turns: 0 }, 'turns');
    expect(outcome.ok).toBe(false);
    if (outcome.ok) {
      throw new Error('テストの前提が壊れている: 失敗するはずの呼び出しが成功した');
    }
    expect(outcome.message).toContain('ピッチ');
  });

  it("derived: 'length' でピッチが負なら断る", () => {
    const outcome = resolveSpringLength({ length: 0, pitch: -5, turns: 4 }, 'length');
    expect(outcome.ok).toBe(false);
  });

  it("derived: 'length' で巻数が非数(NaN)なら断る", () => {
    const outcome = resolveSpringLength(
      { length: 0, pitch: 5, turns: Number.NaN },
      'length',
    );
    expect(outcome.ok).toBe(false);
  });

  it("derived: 'pitch' で全長が 0 以下なら断り、文言に「全長」を含む", () => {
    const outcome = resolveSpringLength({ length: 0, pitch: 0, turns: 4 }, 'pitch');
    expect(outcome.ok).toBe(false);
    if (outcome.ok) {
      throw new Error('テストの前提が壊れている: 失敗するはずの呼び出しが成功した');
    }
    expect(outcome.message).toContain('全長');
  });
});

describe('resolveSpringOrigin', () => {
  it('点フィーチャーの座標を返す', () => {
    const fixture = createFixture();
    const origin = resolveSpringOrigin(fixture.pointA, sketchesOf(fixture.document));
    expect(origin).toEqual([10, 10, 0]);
  });

  it('点フィーチャーが見つからなければ null', () => {
    const fixture = createFixture();
    const origin = resolveSpringOrigin(
      { sketchId: fixture.pointA.sketchId, pointFeatureId: 'point-404' },
      sketchesOf(fixture.document),
    );
    expect(origin).toBeNull();
  });

  it('スケッチが見つからなければ null', () => {
    const fixture = createFixture();
    const origin = resolveSpringOrigin(
      { sketchId: 'sketch-404', pointFeatureId: fixture.pointA.pointFeatureId },
      sketchesOf(fixture.document),
    );
    expect(origin).toBeNull();
  });
});

describe('resolveTiltedDirection', () => {
  it('傾き 0 なら軸の向きをそのまま返す(方位角によらない)', () => {
    const frame: RevolveAxisFrame = { origin: [0, 0, 0], direction: [0, 0, 1] };
    expect(resolveTiltedDirection(frame, 0, 0)).toEqual([0, 0, 1]);
    expect(resolveTiltedDirection(frame, 0, Math.PI)).toEqual([0, 0, 1]);
  });

  it('傾き 30 度・方位角 0 の Z 成分は cos(30 度)', () => {
    const frame: RevolveAxisFrame = { origin: [0, 0, 0], direction: [0, 0, 1] };
    const direction = resolveTiltedDirection(frame, Math.PI / 6, 0);
    expect(direction[2]).toBeCloseTo(Math.cos(Math.PI / 6), 9);
  });

  it('結果は常に単位ベクトル(傾き・方位角によらない)', () => {
    const frame: RevolveAxisFrame = { origin: [0, 0, 0], direction: [1, 0, 0] };
    for (const tilt of [0, Math.PI / 6, Math.PI / 4, Math.PI / 3]) {
      for (const azimuth of [0, Math.PI / 2, Math.PI, (3 * Math.PI) / 2]) {
        const direction = resolveTiltedDirection(frame, tilt, azimuth);
        const length = Math.hypot(direction[0], direction[1], direction[2]);
        expect(length).toBeCloseTo(1, 9);
      }
    }
  });

  it('方位角を変えると(傾きが 0 でなければ)向きが変わる', () => {
    const frame: RevolveAxisFrame = { origin: [0, 0, 0], direction: [0, 0, 1] };
    const a = resolveTiltedDirection(frame, Math.PI / 6, 0);
    const b = resolveTiltedDirection(frame, Math.PI / 6, Math.PI / 2);
    expect(a).not.toEqual(b);
  });
});

describe('resolvePart ばね', () => {
  it('既定値で1段作り、ピッチ・巻数・コイル径・線径・巻き方向をそのまま渡す', () => {
    const fixture = createFixture();
    const document = withSolids(fixture.document, springFeature('spring-1', fixture.pointA));
    const result = resolvePart(document);
    expect(result.errors).toEqual([]);
    expect(result.steps).toHaveLength(1);
    const plan = springPlan(result.steps[0]);
    expect(plan.turns).toBe(4);
    expect(plan.pitch).toBe(5);
    expect(plan.coilDiameter).toBe(20);
    expect(plan.wireDiameter).toBe(2);
    expect(plan.handedness).toBe('right');
    expect(result.liveBodyIds).toEqual(['spring-1']);
  });

  it('始点はスケッチの点の座標', () => {
    const fixture = createFixture();
    const document = withSolids(fixture.document, springFeature('spring-1', fixture.pointA));
    const plan = springPlan(resolvePart(document).steps[0]);
    expect(plan.origin[0]).toBeCloseTo(10, 9);
    expect(plan.origin[1]).toBeCloseTo(10, 9);
    expect(plan.origin[2]).toBeCloseTo(0, 9);
  });

  it('軸がワールド Z・傾き 0 なら向きは [0, 0, 1]', () => {
    const fixture = createFixture();
    const document = withSolids(fixture.document, springFeature('spring-1', fixture.pointA));
    const plan = springPlan(resolvePart(document).steps[0]);
    expect(plan.direction[0]).toBeCloseTo(0, 12);
    expect(plan.direction[1]).toBeCloseTo(0, 12);
    expect(plan.direction[2]).toBeCloseTo(1, 12);
  });

  it('軸がワールド Z・傾き 30 度・方位角 0 なら向きの Z 成分は cos(30 度)', () => {
    const fixture = createFixture();
    const document = withSolids(
      fixture.document,
      springFeature('spring-1', fixture.pointA, { tiltAngle: '30', tiltAzimuth: '0' }),
    );
    const plan = springPlan(resolvePart(document).steps[0]);
    expect(plan.direction[2]).toBeCloseTo(Math.cos(Math.PI / 6), 9);
  });

  it('軸に線分を指せる(回転軸と同じ RevolveAxis を流用)', () => {
    const fixture = createFixture();
    const document = withSolids(
      fixture.document,
      springFeature('spring-1', fixture.pointA, { axis: { kind: 'line', line: fixture.axisLine } }),
    );
    const result = resolvePart(document);
    expect(result.errors).toEqual([]);
    const expectedDirection = resolveRevolveAxis(
      { kind: 'line', line: fixture.axisLine },
      result.sketches,
    );
    if (expectedDirection === null) {
      throw new Error('テストの前提が壊れている: 軸の線分が解決できない');
    }
    const plan = springPlan(result.steps[0]);
    expect(plan.direction[0]).toBeCloseTo(expectedDirection.direction[0], 9);
    expect(plan.direction[1]).toBeCloseTo(expectedDirection.direction[1], 9);
    expect(plan.direction[2]).toBeCloseTo(expectedDirection.direction[2], 9);
  });

  it('傾きが 90 度なら invalidValue', () => {
    const fixture = createFixture();
    const document = withSolids(
      fixture.document,
      springFeature('spring-1', fixture.pointA, { tiltAngle: '90' }),
    );
    const result = resolvePart(document);
    expect(codesOf(result)).toEqual(['invalidValue']);
    expect(result.steps).toEqual([]);
  });

  it('始点の点フィーチャーが見つからなければ missingProfile(例外にならない)', () => {
    const fixture = createFixture();
    const document = withSolids(
      fixture.document,
      springFeature('spring-1', { sketchId: fixture.pointA.sketchId, pointFeatureId: 'point-404' }),
    );
    const result = resolvePart(document);
    expect(codesOf(result)).toEqual(['missingProfile']);
    expect(result.errors[0].message).toContain('始点');
    expect(result.steps).toEqual([]);
  });

  it('軸の線分が見つからなければ missingProfile', () => {
    const fixture = createFixture();
    const document = withSolids(
      fixture.document,
      springFeature('spring-1', fixture.pointA, {
        axis: { kind: 'line', line: { sketchId: fixture.axisLine.sketchId, lineFeatureId: 'line-404' } },
      }),
    );
    const result = resolvePart(document);
    expect(codesOf(result)).toEqual(['missingProfile']);
    expect(result.errors[0].message).toContain('軸');
  });

  it('コイル径が 0 以下なら invalidValue', () => {
    const fixture = createFixture();
    const document = withSolids(
      fixture.document,
      springFeature('spring-1', fixture.pointA, { coilDiameter: '0' }),
    );
    expect(codesOf(resolvePart(document))).toEqual(['invalidValue']);
  });

  it('線径が 0 以下なら invalidValue', () => {
    const fixture = createFixture();
    const document = withSolids(
      fixture.document,
      springFeature('spring-1', fixture.pointA, { wireDiameter: '0' }),
    );
    expect(codesOf(resolvePart(document))).toEqual(['invalidValue']);
  });

  it('線径がコイル径以上なら invalidValue(線径はコイル径より小さく)', () => {
    const fixture = createFixture();
    const document = withSolids(
      fixture.document,
      springFeature('spring-1', fixture.pointA, { coilDiameter: '20', wireDiameter: '20' }),
    );
    const result = resolvePart(document);
    expect(codesOf(result)).toEqual(['invalidValue']);
    expect(result.errors[0].message).toContain('線径はコイル径より小さく');
  });

  it('ピッチが線径以下なら invalidValue(隣どうしの線がぶつかります)', () => {
    const fixture = createFixture();
    const document = withSolids(
      fixture.document,
      springFeature('spring-1', fixture.pointA, { pitch: '2', wireDiameter: '2' }),
    );
    const result = resolvePart(document);
    expect(codesOf(result)).toEqual(['invalidValue']);
    expect(result.errors[0].message).toContain('隣どうしの線がぶつかります');
  });

  it('巻数が 201 なら invalidValue(上限 200)', () => {
    const fixture = createFixture();
    const document = withSolids(
      fixture.document,
      springFeature('spring-1', fixture.pointA, {
        derived: 'length',
        pitch: '1',
        turns: '201',
      }),
    );
    expect(codesOf(resolvePart(document))).toEqual(['invalidValue']);
  });

  it("derived: 'pitch' は全長・巻数からピッチを計算する", () => {
    const fixture = createFixture();
    const document = withSolids(
      fixture.document,
      springFeature('spring-1', fixture.pointA, {
        derived: 'pitch',
        length: '20',
        turns: '4',
      }),
    );
    const plan = springPlan(resolvePart(document).steps[0]);
    expect(plan.pitch).toBe(5);
    expect(plan.turns).toBe(4);
  });

  it("derived: 'turns' は全長・ピッチから巻数を計算する", () => {
    const fixture = createFixture();
    const document = withSolids(
      fixture.document,
      springFeature('spring-1', fixture.pointA, {
        derived: 'turns',
        length: '20',
        pitch: '5',
      }),
    );
    const plan = springPlan(resolvePart(document).steps[0]);
    expect(plan.turns).toBe(4);
    expect(plan.pitch).toBe(5);
  });

  it('押し出し → ばねは対象を消費しない(両方が画面に残る)', () => {
    const fixture = createFixture();
    const document = withSolids(
      fixture.document,
      extrudeFeature('extrude-1', fixture.faceA),
      springFeature('spring-1', fixture.pointA),
    );
    const result = resolvePart(document);
    expect(result.errors).toEqual([]);
    expect(result.steps).toHaveLength(2);
    expect(result.steps.map((step) => step.visible)).toEqual([true, true]);
    expect(result.liveBodyIds).toEqual(['extrude-1', 'spring-1']);
  });

  it('抑制したばねは何も作らず、失敗としても数えない', () => {
    const fixture = createFixture();
    const document = withSolids(
      fixture.document,
      springFeature('spring-1', fixture.pointA, { suppressed: true }),
    );
    const result = resolvePart(document);
    expect(result.errors).toEqual([]);
    expect(result.steps).toEqual([]);
    expect(result.liveBodyIds).toEqual([]);
  });

  it('鍵は始点・向き・コイル径・線径・ピッチ・巻数・巻き方向から作られる(全長と derived は混ぜない)', () => {
    const fixture = createFixture();
    const document = withSolids(fixture.document, springFeature('spring-1', fixture.pointA));
    const result = resolvePart(document);
    expect(result.steps[0].key).toBe(
      cacheKeyFor({
        kind: 'spring',
        origin: [10, 10, 0],
        direction: [0, 0, 1],
        coilDiameter: 20,
        wireDiameter: 2,
        pitch: 5,
        turns: 4,
        handedness: 'right',
      }),
    );
  });

  it('同じ文書を 2 回解決すると鍵が一致し、名前だけ変えても変わらない(決定性)', () => {
    const fixture = createFixture();
    const build = (name: string): ResolvedPart =>
      resolvePart(withSolids(fixture.document, springFeature('spring-1', fixture.pointA, { name })));
    const first = build('ばね1');
    expect(build('ばね1').steps[0].key).toBe(first.steps[0].key);
    expect(build('中つなぎ').steps[0].key).toBe(first.steps[0].key);
  });

  it('derived だけ変えて同じ数値結果になる文書は鍵が一致する', () => {
    const fixture = createFixture();
    const byLength = resolvePart(
      withSolids(
        fixture.document,
        springFeature('spring-1', fixture.pointA, { derived: 'length', pitch: '5', turns: '4' }),
      ),
    );
    const byPitch = resolvePart(
      withSolids(
        fixture.document,
        springFeature('spring-1', fixture.pointA, { derived: 'pitch', length: '20', turns: '4' }),
      ),
    );
    expect(byPitch.steps[0].key).toBe(byLength.steps[0].key);
  });

  it('コイル径やピッチ・巻き方向を変えると鍵が変わる', () => {
    const fixture = createFixture();
    const base = resolvePart(
      withSolids(fixture.document, springFeature('spring-1', fixture.pointA)),
    ).steps[0].key;
    const coilChanged = resolvePart(
      withSolids(
        fixture.document,
        springFeature('spring-1', fixture.pointA, { coilDiameter: '24' }),
      ),
    ).steps[0].key;
    const pitchChanged = resolvePart(
      withSolids(fixture.document, springFeature('spring-1', fixture.pointA, { pitch: '6' })),
    ).steps[0].key;
    const handednessChanged = resolvePart(
      withSolids(
        fixture.document,
        springFeature('spring-1', fixture.pointA, { handedness: 'left' }),
      ),
    ).steps[0].key;
    expect(coilChanged).not.toBe(base);
    expect(pitchChanged).not.toBe(base);
    expect(handednessChanged).not.toBe(base);
  });
});

/** R面取り・C面取りの検査で使う、縦4本ぶんの辺の指紋(通し番号0〜3)。 */
function fourEdges(bodyFeatureId: string): readonly SubShapeRef[] {
  return [
    edgeRefAt(bodyFeatureId, 0),
    edgeRefAt(bodyFeatureId, 1),
    edgeRefAt(bodyFeatureId, 2),
    edgeRefAt(bodyFeatureId, 3),
  ];
}

describe('resolvePart R面取り', () => {
  it('対象を消費し、辺4本・半径5をそのまま渡す', () => {
    const fixture = createFixture();
    const document = withSolids(
      fixture.document,
      extrudeFeature('extrude-1', fixture.faceA),
      filletFeature('fillet-1', 'extrude-1', fourEdges('extrude-1')),
    );
    const result = resolvePart(document);
    expect(result.errors).toEqual([]);
    expect(result.steps).toHaveLength(2);
    expect(result.steps.map((step) => step.visible)).toEqual([false, true]);
    const plan = filletPlan(result.steps[1]);
    expect(plan.targetKey).toBe(result.steps[0].key);
    expect(plan.radius).toBe(5);
    expect(plan.targets).toHaveLength(4);
    expect(result.liveBodyIds).toEqual(['fillet-1']);
  });

  it('targets の並びを逆にしても鍵が同じ(通し番号の昇順に並べ替える)', () => {
    const fixture = createFixture();
    const build = (targets: readonly SubShapeRef[]): ResolvedPart =>
      resolvePart(
        withSolids(
          fixture.document,
          extrudeFeature('extrude-1', fixture.faceA),
          filletFeature('fillet-1', 'extrude-1', targets),
        ),
      );
    const forward = build(fourEdges('extrude-1'));
    const reversed = build([...fourEdges('extrude-1')].reverse());
    expect(reversed.steps[1].key).toBe(forward.steps[1].key);
  });

  it('同じ辺を2回指しても1回だけ扱う(重複除去)', () => {
    const fixture = createFixture();
    const document = withSolids(
      fixture.document,
      extrudeFeature('extrude-1', fixture.faceA),
      filletFeature('fillet-1', 'extrude-1', [
        edgeRefAt('extrude-1', 0),
        edgeRefAt('extrude-1', 0),
        edgeRefAt('extrude-1', 1),
      ]),
    );
    const plan = filletPlan(resolvePart(document).steps[1]);
    expect(plan.targets).toHaveLength(2);
  });

  it('半径が 0 なら invalidValue', () => {
    const fixture = createFixture();
    const document = withSolids(
      fixture.document,
      extrudeFeature('extrude-1', fixture.faceA),
      filletFeature('fillet-1', 'extrude-1', fourEdges('extrude-1'), { radius: '0' }),
    );
    expect(codesOf(resolvePart(document))).toEqual(['invalidValue']);
  });

  it('半径が数になっていなければ invalidValue', () => {
    const fixture = createFixture();
    const document = withSolids(
      fixture.document,
      extrudeFeature('extrude-1', fixture.faceA),
      filletFeature('fillet-1', 'extrude-1', fourEdges('extrude-1'), { radius: notANumber('a') }),
    );
    expect(codesOf(resolvePart(document))).toEqual(['invalidValue']);
  });

  it('辺が 0 本なら missingSubShape', () => {
    const fixture = createFixture();
    const document = withSolids(
      fixture.document,
      extrudeFeature('extrude-1', fixture.faceA),
      filletFeature('fillet-1', 'extrude-1', []),
    );
    const result = resolvePart(document);
    expect(codesOf(result)).toEqual(['missingSubShape']);
    expect(result.errors[0].message).toContain('見つかりません');
  });

  it('対象のボディが無ければ missingBody', () => {
    const fixture = createFixture();
    const document = withSolids(
      fixture.document,
      filletFeature('fillet-1', 'extrude-404', fourEdges('extrude-404')),
    );
    expect(codesOf(resolvePart(document))).toEqual(['missingBody']);
  });

  it('対象がすでに別のブーリアンに消費されていれば consumedTwice', () => {
    const fixture = createFixture();
    const document = withSolids(
      fixture.document,
      extrudeFeature('extrude-1', fixture.faceA),
      extrudeFeature('extrude-2', fixture.faceB, { distance: '4' }),
      booleanFeature('union-1', 'union', 'extrude-1', 'extrude-2'),
      filletFeature('fillet-1', 'extrude-1', fourEdges('extrude-1')),
    );
    expect(codesOf(resolvePart(document))).toEqual(['consumedTwice']);
  });

  it('抑制した R面取りは何も作らず、失敗としても数えない', () => {
    const fixture = createFixture();
    const document = withSolids(
      fixture.document,
      extrudeFeature('extrude-1', fixture.faceA),
      filletFeature('fillet-1', 'extrude-1', fourEdges('extrude-1'), { suppressed: true }),
    );
    const result = resolvePart(document);
    expect(result.errors).toEqual([]);
    expect(result.steps).toHaveLength(1);
    expect(result.liveBodyIds).toEqual(['extrude-1']);
  });

  it('鍵は targetKey・targets・半径から作られる', () => {
    const fixture = createFixture();
    const document = withSolids(
      fixture.document,
      extrudeFeature('extrude-1', fixture.faceA),
      filletFeature('fillet-1', 'extrude-1', fourEdges('extrude-1')),
    );
    const result = resolvePart(document);
    expect(result.steps[1].key).toBe(
      cacheKeyFor({
        kind: 'fillet',
        targetKey: result.steps[0].key,
        targets: fourEdges('extrude-1').map(fingerprintKeyText),
        radius: 5,
      }),
    );
  });
});

describe('resolvePart C面取り', () => {
  it('等距離 2 をそのまま渡す', () => {
    const fixture = createFixture();
    const document = withSolids(
      fixture.document,
      extrudeFeature('extrude-1', fixture.faceA),
      chamferFeature('chamfer-1', 'extrude-1', [edgeRefAt('extrude-1', 0)], {
        size: { kind: 'equal', distance: expr('2') },
      }),
    );
    const result = resolvePart(document);
    expect(result.errors).toEqual([]);
    const plan = chamferPlan(result.steps[1]);
    expect(plan.targetKey).toBe(result.steps[0].key);
    expect(plan.targets).toHaveLength(1);
    if (plan.size.kind !== 'equal') {
      throw new Error('テストの前提が壊れている: 等距離でない');
    }
    expect(plan.size.distance).toBe(2);
    expect(plan.swapReferenceFace).toBe(false);
    expect(result.liveBodyIds).toEqual(['chamfer-1']);
  });

  it('2距離 3/1・基準面の入れ替えをそのまま渡す', () => {
    const fixture = createFixture();
    const document = withSolids(
      fixture.document,
      extrudeFeature('extrude-1', fixture.faceA),
      chamferFeature('chamfer-1', 'extrude-1', [edgeRefAt('extrude-1', 0)], {
        size: { kind: 'twoDistances', distance1: expr('3'), distance2: expr('1') },
        swapReferenceFace: true,
      }),
    );
    const plan = chamferPlan(resolvePart(document).steps[1]);
    if (plan.size.kind !== 'twoDistances') {
      throw new Error('テストの前提が壊れている: 2距離でない');
    }
    expect(plan.size.distance1).toBe(3);
    expect(plan.size.distance2).toBe(1);
    expect(plan.swapReferenceFace).toBe(true);
  });

  it('距離+角度 30 度は角度がラジアンへ直る', () => {
    const fixture = createFixture();
    const document = withSolids(
      fixture.document,
      extrudeFeature('extrude-1', fixture.faceA),
      chamferFeature('chamfer-1', 'extrude-1', [edgeRefAt('extrude-1', 0)], {
        size: { kind: 'distanceAngle', distance: expr('2'), angle: expr('30') },
      }),
    );
    const plan = chamferPlan(resolvePart(document).steps[1]);
    if (plan.size.kind !== 'distanceAngle') {
      throw new Error('テストの前提が壊れている: 距離+角度でない');
    }
    expect(plan.size.distance).toBe(2);
    expect(plan.size.angle).toBeCloseTo(Math.PI / 6, 12);
  });

  it('角度 90 度は invalidValue', () => {
    const fixture = createFixture();
    const document = withSolids(
      fixture.document,
      extrudeFeature('extrude-1', fixture.faceA),
      chamferFeature('chamfer-1', 'extrude-1', [edgeRefAt('extrude-1', 0)], {
        size: { kind: 'distanceAngle', distance: expr('2'), angle: expr('90') },
      }),
    );
    const result = resolvePart(document);
    expect(codesOf(result)).toEqual(['invalidValue']);
    expect(result.errors[0].message).toContain('90 度より小さく');
  });

  it('角度 0 度は invalidValue', () => {
    const fixture = createFixture();
    const document = withSolids(
      fixture.document,
      extrudeFeature('extrude-1', fixture.faceA),
      chamferFeature('chamfer-1', 'extrude-1', [edgeRefAt('extrude-1', 0)], {
        size: { kind: 'distanceAngle', distance: expr('2'), angle: expr('0') },
      }),
    );
    expect(codesOf(resolvePart(document))).toEqual(['invalidValue']);
  });

  it('等距離の距離が 0 以下なら invalidValue', () => {
    const fixture = createFixture();
    const document = withSolids(
      fixture.document,
      extrudeFeature('extrude-1', fixture.faceA),
      chamferFeature('chamfer-1', 'extrude-1', [edgeRefAt('extrude-1', 0)], {
        size: { kind: 'equal', distance: expr('0') },
      }),
    );
    expect(codesOf(resolvePart(document))).toEqual(['invalidValue']);
  });

  it('2距離の一方が 0 以下なら invalidValue', () => {
    const fixture = createFixture();
    const document = withSolids(
      fixture.document,
      extrudeFeature('extrude-1', fixture.faceA),
      chamferFeature('chamfer-1', 'extrude-1', [edgeRefAt('extrude-1', 0)], {
        size: { kind: 'twoDistances', distance1: expr('3'), distance2: expr('0') },
      }),
    );
    expect(codesOf(resolvePart(document))).toEqual(['invalidValue']);
  });

  it('targets の並びを逆にしても鍵が同じ', () => {
    const fixture = createFixture();
    const build = (targets: readonly SubShapeRef[]): ResolvedPart =>
      resolvePart(
        withSolids(
          fixture.document,
          extrudeFeature('extrude-1', fixture.faceA),
          chamferFeature('chamfer-1', 'extrude-1', targets),
        ),
      );
    const forward = build(fourEdges('extrude-1'));
    const reversed = build([...fourEdges('extrude-1')].reverse());
    expect(reversed.steps[1].key).toBe(forward.steps[1].key);
  });

  it('辺が 0 本なら missingSubShape', () => {
    const fixture = createFixture();
    const document = withSolids(
      fixture.document,
      extrudeFeature('extrude-1', fixture.faceA),
      chamferFeature('chamfer-1', 'extrude-1', []),
    );
    expect(codesOf(resolvePart(document))).toEqual(['missingSubShape']);
  });

  it('鍵は targetKey・targets・大きさ・swapReferenceFace から作られる', () => {
    const fixture = createFixture();
    const document = withSolids(
      fixture.document,
      extrudeFeature('extrude-1', fixture.faceA),
      chamferFeature('chamfer-1', 'extrude-1', [edgeRefAt('extrude-1', 0)], {
        size: { kind: 'equal', distance: expr('2') },
      }),
    );
    const result = resolvePart(document);
    expect(result.steps[1].key).toBe(
      cacheKeyFor({
        kind: 'chamfer',
        targetKey: result.steps[0].key,
        targets: [fingerprintKeyText(edgeRefAt('extrude-1', 0))],
        mode: 'equal',
        distance1: 2,
        distance2: 0,
        swapReferenceFace: false,
      }),
    );
  });
});

describe('resolvePatternTransforms', () => {
  it('直線・両側なし: 個数3・間隔20 → 変換2つ([20,0,0], [40,0,0])', () => {
    const fixture = createFixture();
    const outcome = resolvePatternTransforms(linearPlacement(), sketchesOf(fixture.document));
    if (!outcome.ok) {
      throw new Error('テストの前提が壊れている: 失敗した');
    }
    expect(outcome.transforms).toHaveLength(2);
    expect(outcome.transforms[0].translation).toEqual([20, 0, 0]);
    expect(outcome.transforms[1].translation).toEqual([40, 0, 0]);
    expect(outcome.transforms.every((transform) => transform.rotationAngle === 0)).toBe(true);
  });

  it('直線・両側あり: 個数3 → 変換2つ([-20,0,0], [20,0,0])', () => {
    const fixture = createFixture();
    const outcome = resolvePatternTransforms(
      linearPlacement({ symmetric: true }),
      sketchesOf(fixture.document),
    );
    if (!outcome.ok) {
      throw new Error('テストの前提が壊れている: 失敗した');
    }
    expect(outcome.transforms.map((transform) => transform.translation)).toEqual([
      [-20, 0, 0],
      [20, 0, 0],
    ]);
  });

  it('直線・両側あり・個数4は invalidValue(奇数のみ)', () => {
    const fixture = createFixture();
    const outcome = resolvePatternTransforms(
      linearPlacement({ symmetric: true, count: '4' }),
      sketchesOf(fixture.document),
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) {
      throw new Error('テストの前提が壊れている');
    }
    expect(outcome.code).toBe('invalidValue');
    expect(outcome.message).toContain('奇数');
  });

  it('円形・全周: 個数4 → 回転角 π/2, π, 3π/2', () => {
    const fixture = createFixture();
    const outcome = resolvePatternTransforms(circularPlacement(), sketchesOf(fixture.document));
    if (!outcome.ok) {
      throw new Error('テストの前提が壊れている: 失敗した');
    }
    expect(outcome.transforms).toHaveLength(3);
    expect(outcome.transforms[0].rotationAngle).toBeCloseTo(Math.PI / 2, 12);
    expect(outcome.transforms[1].rotationAngle).toBeCloseTo(Math.PI, 12);
    expect(outcome.transforms[2].rotationAngle).toBeCloseTo((3 * Math.PI) / 2, 12);
  });

  it('円形・全周でない: 角度180・個数3 → 回転角 π/2, π', () => {
    const fixture = createFixture();
    const outcome = resolvePatternTransforms(
      circularPlacement({ fullCircle: false, angle: '180', count: '3' }),
      sketchesOf(fixture.document),
    );
    if (!outcome.ok) {
      throw new Error('テストの前提が壊れている: 失敗した');
    }
    expect(outcome.transforms).toHaveLength(2);
    expect(outcome.transforms[0].rotationAngle).toBeCloseTo(Math.PI / 2, 12);
    expect(outcome.transforms[1].rotationAngle).toBeCloseTo(Math.PI, 12);
  });

  it('個数 1 は invalidValue', () => {
    const fixture = createFixture();
    const outcome = resolvePatternTransforms(
      linearPlacement({ count: '1' }),
      sketchesOf(fixture.document),
    );
    expect(outcome.ok).toBe(false);
  });

  it('個数 101 は invalidValue(上限 100)', () => {
    const fixture = createFixture();
    const outcome = resolvePatternTransforms(
      linearPlacement({ count: '101' }),
      sketchesOf(fixture.document),
    );
    expect(outcome.ok).toBe(false);
  });

  it('個数が整数でなければ invalidValue', () => {
    const fixture = createFixture();
    const outcome = resolvePatternTransforms(
      linearPlacement({ count: '2.5' }),
      sketchesOf(fixture.document),
    );
    expect(outcome.ok).toBe(false);
  });

  it('間隔が 0 以下なら invalidValue', () => {
    const fixture = createFixture();
    const outcome = resolvePatternTransforms(
      linearPlacement({ spacing: '0' }),
      sketchesOf(fixture.document),
    );
    expect(outcome.ok).toBe(false);
  });

  it('角度が 0 以下(全周でない)なら invalidValue', () => {
    const fixture = createFixture();
    const outcome = resolvePatternTransforms(
      circularPlacement({ fullCircle: false, angle: '0' }),
      sketchesOf(fixture.document),
    );
    expect(outcome.ok).toBe(false);
  });

  it('角度が 360 を超えると invalidValue', () => {
    const fixture = createFixture();
    const outcome = resolvePatternTransforms(
      circularPlacement({ fullCircle: false, angle: '361' }),
      sketchesOf(fixture.document),
    );
    expect(outcome.ok).toBe(false);
  });

  it('直線の向きにする線分が見つからなければ missingProfile', () => {
    const fixture = createFixture();
    const outcome = resolvePatternTransforms(
      linearPlacement({
        direction: {
          kind: 'line',
          line: { sketchId: fixture.axisLine.sketchId, lineFeatureId: 'line-404' },
        },
      }),
      sketchesOf(fixture.document),
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) {
      throw new Error('テストの前提が壊れている');
    }
    expect(outcome.code).toBe('missingProfile');
  });

  it('円形の軸にする線分が見つからなければ missingProfile', () => {
    const fixture = createFixture();
    const outcome = resolvePatternTransforms(
      circularPlacement({
        axis: {
          kind: 'line',
          line: { sketchId: fixture.axisLine.sketchId, lineFeatureId: 'line-404' },
        },
      }),
      sketchesOf(fixture.document),
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) {
      throw new Error('テストの前提が壊れている');
    }
    expect(outcome.code).toBe('missingProfile');
  });
});

describe('resolvePart パターン', () => {
  it('直線パターン(X軸・間隔20・個数3・両側なし)は穴の transforms を差し替える', () => {
    const fixture = createFixture();
    const document = withSolids(
      fixture.document,
      extrudeFeature('extrude-1', fixture.faceA),
      holeFeature('hole-1', 'extrude-1', [fixture.pointA]),
      patternFeature('pattern-1', 'hole-1', linearPlacement()),
    );
    const result = resolvePart(document);
    expect(result.errors).toEqual([]);
    expect(result.steps).toHaveLength(3);
    const plan = holePlan(result.steps[2]);
    expect(plan.targetKey).toBe(result.steps[1].key);
    expect(plan.transforms.map((transform) => transform.translation)).toEqual([
      [20, 0, 0],
      [40, 0, 0],
    ]);
    expect(result.liveBodyIds).toEqual(['pattern-1']);
  });

  it('両側あり・個数3の穴は変換2つ([-20,0,0], [20,0,0])', () => {
    const fixture = createFixture();
    const document = withSolids(
      fixture.document,
      extrudeFeature('extrude-1', fixture.faceA),
      holeFeature('hole-1', 'extrude-1', [fixture.pointA]),
      patternFeature('pattern-1', 'hole-1', linearPlacement({ symmetric: true })),
    );
    const plan = holePlan(resolvePart(document).steps[2]);
    expect(plan.transforms.map((transform) => transform.translation)).toEqual([
      [-20, 0, 0],
      [20, 0, 0],
    ]);
  });

  it('両側あり・個数4は invalidValue(奇数のみ)', () => {
    const fixture = createFixture();
    const document = withSolids(
      fixture.document,
      extrudeFeature('extrude-1', fixture.faceA),
      holeFeature('hole-1', 'extrude-1', [fixture.pointA]),
      patternFeature('pattern-1', 'hole-1', linearPlacement({ symmetric: true, count: '4' })),
    );
    const result = resolvePart(document);
    expect(codesOf(result)).toEqual(['invalidValue']);
    expect(result.errors[0].message).toContain('奇数');
  });

  it('円形パターン(Z軸・全周・個数4)の穴は回転角 π/2, π, 3π/2', () => {
    const fixture = createFixture();
    const document = withSolids(
      fixture.document,
      extrudeFeature('extrude-1', fixture.faceA),
      holeFeature('hole-1', 'extrude-1', [fixture.pointA]),
      patternFeature('pattern-1', 'hole-1', circularPlacement()),
    );
    const plan = holePlan(resolvePart(document).steps[2]);
    expect(plan.transforms).toHaveLength(3);
    expect(plan.transforms[0].rotationAngle).toBeCloseTo(Math.PI / 2, 12);
    expect(plan.transforms[1].rotationAngle).toBeCloseTo(Math.PI, 12);
    expect(plan.transforms[2].rotationAngle).toBeCloseTo((3 * Math.PI) / 2, 12);
  });

  it('円形パターン(Z軸・角度180・個数3・全周なし)の穴は回転角 π/2, π', () => {
    const fixture = createFixture();
    const document = withSolids(
      fixture.document,
      extrudeFeature('extrude-1', fixture.faceA),
      holeFeature('hole-1', 'extrude-1', [fixture.pointA]),
      patternFeature(
        'pattern-1',
        'hole-1',
        circularPlacement({ fullCircle: false, angle: '180', count: '3' }),
      ),
    );
    const plan = holePlan(resolvePart(document).steps[2]);
    expect(plan.transforms).toHaveLength(2);
    expect(plan.transforms[0].rotationAngle).toBeCloseTo(Math.PI / 2, 12);
    expect(plan.transforms[1].rotationAngle).toBeCloseTo(Math.PI, 12);
  });

  it('個数 1 は invalidValue', () => {
    const fixture = createFixture();
    const document = withSolids(
      fixture.document,
      extrudeFeature('extrude-1', fixture.faceA),
      holeFeature('hole-1', 'extrude-1', [fixture.pointA]),
      patternFeature('pattern-1', 'hole-1', linearPlacement({ count: '1' })),
    );
    expect(codesOf(resolvePart(document))).toEqual(['invalidValue']);
  });

  it('個数 101 は invalidValue(上限 100)', () => {
    const fixture = createFixture();
    const document = withSolids(
      fixture.document,
      extrudeFeature('extrude-1', fixture.faceA),
      holeFeature('hole-1', 'extrude-1', [fixture.pointA]),
      patternFeature('pattern-1', 'hole-1', linearPlacement({ count: '101' })),
    );
    expect(codesOf(resolvePart(document))).toEqual(['invalidValue']);
  });

  it('対象が押し出しなら invalidValue(穴とねじ穴だけ)', () => {
    const fixture = createFixture();
    const document = withSolids(
      fixture.document,
      extrudeFeature('extrude-1', fixture.faceA),
      patternFeature('pattern-1', 'extrude-1', linearPlacement()),
    );
    const result = resolvePart(document);
    expect(codesOf(result)).toEqual(['invalidValue']);
    expect(result.errors[0].message).toContain('穴とねじ穴だけ');
  });

  it('対象が自分自身なら invalidValue', () => {
    const fixture = createFixture();
    const document = withSolids(
      fixture.document,
      patternFeature('pattern-1', 'pattern-1', linearPlacement()),
    );
    expect(codesOf(resolvePart(document))).toEqual(['invalidValue']);
  });

  it('対象の穴が失敗していれば、パターンも失敗する(例外にならない)', () => {
    const fixture = createFixture();
    const document = withSolids(
      fixture.document,
      extrudeFeature('extrude-1', fixture.faceA),
      holeFeature('hole-1', 'extrude-1', [fixture.pointA], { tiltAngle: '90' }),
      patternFeature('pattern-1', 'hole-1', linearPlacement()),
    );
    const result = resolvePart(document);
    expect(result.errors.map((error) => error.featureId).sort()).toEqual(['hole-1', 'pattern-1']);
    // 穴が作れなかったので押し出しだけが画面に残る(パターンもボディを作らない)。
    expect(result.steps.map((step) => step.featureId)).toEqual(['extrude-1']);
    expect(result.liveBodyIds).toEqual(['extrude-1']);
  });

  it('もとがねじ穴なら plan.kind は thread になる', () => {
    const fixture = createFixture();
    const document = withSolids(
      fixture.document,
      extrudeFeature('extrude-1', fixture.faceA),
      threadHoleFeature('thread-1', 'extrude-1', [fixture.pointA]),
      patternFeature('pattern-1', 'thread-1', linearPlacement()),
    );
    const result = resolvePart(document);
    expect(result.errors).toEqual([]);
    const plan = threadPlan(result.steps[2]);
    expect(plan.targetKey).toBe(result.steps[1].key);
    expect(plan.transforms).toHaveLength(2);
  });

  it('向きにする線分が見つからなければ missingProfile', () => {
    const fixture = createFixture();
    const document = withSolids(
      fixture.document,
      extrudeFeature('extrude-1', fixture.faceA),
      holeFeature('hole-1', 'extrude-1', [fixture.pointA]),
      patternFeature(
        'pattern-1',
        'hole-1',
        linearPlacement({
          direction: {
            kind: 'line',
            line: { sketchId: fixture.axisLine.sketchId, lineFeatureId: 'line-404' },
          },
        }),
      ),
    );
    expect(codesOf(resolvePart(document))).toEqual(['missingProfile']);
  });

  it('対象がすでに別のパターンに使われていれば consumedTwice', () => {
    const fixture = createFixture();
    const document = withSolids(
      fixture.document,
      extrudeFeature('extrude-1', fixture.faceA),
      holeFeature('hole-1', 'extrude-1', [fixture.pointA]),
      patternFeature('pattern-1', 'hole-1', linearPlacement()),
      patternFeature('pattern-2', 'hole-1', linearPlacement()),
    );
    const result = resolvePart(document);
    expect(codesOf(result)).toEqual(['consumedTwice']);
  });

  it('押し出し → 穴 → パターンの liveBodyIds はパターンの id だけ', () => {
    const fixture = createFixture();
    const document = withSolids(
      fixture.document,
      extrudeFeature('extrude-1', fixture.faceA),
      holeFeature('hole-1', 'extrude-1', [fixture.pointA]),
      patternFeature('pattern-1', 'hole-1', linearPlacement()),
    );
    expect(resolvePart(document).liveBodyIds).toEqual(['pattern-1']);
  });

  it('同じ文書を2回解決すると鍵が一致する(決定性)', () => {
    const fixture = createFixture();
    const document = withSolids(
      fixture.document,
      extrudeFeature('extrude-1', fixture.faceA),
      holeFeature('hole-1', 'extrude-1', [fixture.pointA]),
      patternFeature('pattern-1', 'hole-1', linearPlacement()),
    );
    const first = resolvePart(document);
    const second = resolvePart(document);
    expect(second.steps[2].key).toBe(first.steps[2].key);
  });

  it('間隔だけを変えると鍵が変わる', () => {
    const fixture = createFixture();
    const build = (spacing: string): ResolvedPart =>
      resolvePart(
        withSolids(
          fixture.document,
          extrudeFeature('extrude-1', fixture.faceA),
          holeFeature('hole-1', 'extrude-1', [fixture.pointA]),
          patternFeature('pattern-1', 'hole-1', linearPlacement({ spacing })),
        ),
      );
    expect(build('30').steps[2].key).not.toBe(build('20').steps[2].key);
  });

  it('抑制したパターンは何も作らず、失敗としても数えない', () => {
    const fixture = createFixture();
    const document = withSolids(
      fixture.document,
      extrudeFeature('extrude-1', fixture.faceA),
      holeFeature('hole-1', 'extrude-1', [fixture.pointA]),
      patternFeature('pattern-1', 'hole-1', linearPlacement(), { suppressed: true }),
    );
    const result = resolvePart(document);
    expect(result.errors).toEqual([]);
    expect(result.steps).toHaveLength(2);
    expect(result.liveBodyIds).toEqual(['hole-1']);
  });
});

describe('基準ジオメトリと部品の解決の噛み合わせ(FR-328、FR-329、タスク9)', () => {
  /** 作業平面 1 枚(XY を +Z へ 10)だけを持つ部品。 */
  function withRaisedPlane(): PartDocument {
    const base = createEmptyPartDocument();
    return appendReference(base, {
      id: 'referencePlane-1',
      kind: 'referencePlane',
      name: '作業平面1',
      visible: true,
      plane: { kind: 'workPlane', planeId: 'xy', offset: expressionValueFromNumber(10) },
    });
  }

  it('作業平面は解決結果に載り、失敗が無ければ errors は増えない', () => {
    const resolved = resolvePart(withRaisedPlane());
    expect(resolved.errors).toEqual([]);
    expect(resolved.references.planes).toHaveLength(1);
    expect(resolved.references.planes[0].plane.origin).toEqual([0, 0, 10]);
  });

  it('スケッチのフィーチャーは作業平面フィーチャーの上に描ける(WorkPlaneId の拡張)', () => {
    const document = withRaisedPlane();
    const sketch = document.sketches[0];
    const arc: SketchArcFeature = {
      id: 'arc-1',
      name: '円弧1',
      planeId: 'referencePlane-1',
      kind: 'arc',
      center: absoluteCoordinate(0, 0, 10),
      radius: expressionValueFromNumber(5),
      startAngle: expressionValueFromNumber(0),
      endAngle: expressionValueFromNumber(90),
      construction: false,
    };
    const resolved = resolvePart(replaceSketch(document, appendFeature(sketch, arc)));
    expect(resolved.sketches[0].resolved.errors).toEqual([]);
    expect(resolved.sketches[0].resolved.arcs[0].center).toEqual([0, 0, 10]);
    expect(resolved.sketches[0].resolved.arcs[0].normal).toEqual([0, 0, 1]);
  });

  it('基準ジオメトリの失敗は部品の errors へ写り、文書は壊れない(FR-504)', () => {
    const base = createEmptyPartDocument();
    const document = appendReference(base, {
      id: 'referencePlane-1',
      kind: 'referencePlane',
      name: '作業平面1',
      visible: true,
      plane: { kind: 'workPlane', planeId: 'referencePlane-404', offset: expressionValueFromNumber(0) },
    });
    const resolved = resolvePart(document);
    expect(resolved.references.planes).toEqual([]);
    expect(resolved.errors).toHaveLength(1);
    expect(resolved.errors[0].featureId).toBe('referencePlane-1');
    expect(resolved.errors[0].code).toBe('missingProfile');
  });

  it('回転軸に基準軸を選べる(FR-329「回転体やパターンの向きに使える」)', () => {
    const fixture = createFixture();
    // 原点 → (0,0,10) の基準軸。向きは +Z で、ワールド Z 軸と同じ結果になる。
    const withAxis = appendReference(fixture.document, {
      id: 'referenceAxis-1',
      kind: 'referenceAxis',
      name: '基準軸1',
      visible: true,
      definition: {
        kind: 'twoPoints',
        from: { kind: 'origin' },
        to: { kind: 'point', pointId: 'point-5' },
      },
    });
    const revolve: RevolveFeature = {
      id: 'revolve-1',
      kind: 'revolve',
      name: '回転1',
      suppressed: false,
      profile: fixture.faceA,
      axis: { kind: 'reference', referenceFeatureId: 'referenceAxis-1' },
      angle: expressionValueFromNumber(90),
      reversed: false,
    };
    const resolved = resolvePart(appendSolid(withAxis, revolve));
    expect(resolved.errors).toEqual([]);
    const step = resolved.steps.find((candidate) => candidate.featureId === 'revolve-1');
    expect(step).toBeDefined();
    if (step === undefined || step.plan.kind !== 'revolve') {
      return;
    }
    expect(step.plan.axisDirection[2]).toBeCloseTo(1, 12);
  });

  it('基準軸が無ければ回転は理由つきで断り、他のフィーチャーは解決される(FR-504)', () => {
    const fixture = createFixture();
    const revolve: RevolveFeature = {
      id: 'revolve-1',
      kind: 'revolve',
      name: '回転1',
      suppressed: false,
      profile: fixture.faceA,
      axis: { kind: 'reference', referenceFeatureId: 'referenceAxis-404' },
      angle: expressionValueFromNumber(90),
      reversed: false,
    };
    const resolved = resolvePart(appendSolid(fixture.document, revolve));
    expect(resolved.steps).toEqual([]);
    expect(resolved.errors).toHaveLength(1);
    expect(resolved.errors[0].featureId).toBe('revolve-1');
  });

  it('基準ジオメトリが 1 つも無い部品は、これまでどおり解決される(回帰確認)', () => {
    const fixture = createFixture();
    const resolved = resolvePart(fixture.document);
    expect(resolved.references.planes).toEqual([]);
    expect(resolved.references.axes).toEqual([]);
    expect(resolved.references.errors).toEqual([]);
    expect(resolved.errors).toEqual([]);
  });
});

describe('投影・交差の解決順序(FR-325、§0.a-0.11、タスク25)', () => {
  /** 立体 `bodyFeatureId` の平らな面を指す指紋。 */
  function faceRef(bodyFeatureId: string): SubShapeRef {
    return {
      bodyFeatureId,
      index: 4,
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

  /** 40×30 の長方形(カーネルが返したことにする投影の結果)。 */
  const RECTANGLE: readonly ResolvedCurve[] = [
    { kind: 'segment', featureId: 'from-kernel', from: [0, 0, 0], to: [40, 0, 0] },
    { kind: 'segment', featureId: 'from-kernel', from: [40, 0, 0], to: [40, 30, 0] },
    { kind: 'segment', featureId: 'from-kernel', from: [40, 30, 0], to: [0, 30, 0] },
    { kind: 'segment', featureId: 'from-kernel', from: [0, 30, 0], to: [0, 0, 0] },
  ];

  /**
   * 検査の土台。スケッチ2 に投影(または交差)を 1 つ持ち、`extrude-1`(面Aを
   * 押し出した立体)を参照する。`useProjection` を false にすると、投影の面を
   * 使う押し出しを置かない(スケッチがどの立体からも使われない場合)。
   */
  function documentWithProjection(
    feature: 'projectedCurve' | 'planeSection',
    options: { readonly bodyFeatureId?: string; readonly useProjection?: boolean } = {},
  ): { readonly document: PartDocument } {
    const fixture = createFixture();
    const bodyFeatureId = options.bodyFeatureId ?? 'extrude-1';
    const projected: SketchFeature =
      feature === 'projectedCurve'
        ? {
            id: 'pj1',
            name: '投影1',
            planeId: DEFAULT_WORK_PLANE_ID,
            kind: 'projectedCurve',
            source: faceRef(bodyFeatureId),
            construction: false,
          }
        : {
            id: 'pj1',
            name: '断面1',
            planeId: DEFAULT_WORK_PLANE_ID,
            kind: 'planeSection',
            targetFeatureId: bodyFeatureId,
            construction: false,
          };
    const face: SketchFaceFeature = {
      id: 'f-pj',
      name: '面-投影',
      planeId: DEFAULT_WORK_PLANE_ID,
      kind: 'face',
      boundary: [{ featureId: 'pj1' }],
      color: DEFAULT_FACE_COLOR,
    };
    let document = addSketch(fixture.document, {
      id: 'sketch-2',
      name: 'スケッチ2',
      features: [projected, face],
    });
    document = appendSolid(document, extrudeFeature('extrude-1', fixture.faceA));
    if (options.useProjection !== false) {
      document = appendSolid(
        document,
        extrudeFeature(
          'extrude-2',
          { sketchId: 'sketch-2', faceFeatureId: 'f-pj' },
          { distance: '5' },
        ),
      );
    }
    return { document };
  }

  it('形がまだ無いときは、段の鍵つきの依頼を projections へ積む', () => {
    const { document } = documentWithProjection('projectedCurve');
    const resolved = resolvePart(document);

    expect(resolved.projections).toHaveLength(1);
    const request = resolved.projections[0];
    expect(request.featureId).toBe('pj1');
    expect(request.sketchId).toBe('sketch-2');
    expect(request.source).toEqual({ kind: 'subShape', ref: faceRef('extrude-1') });
    // もとの立体の段の鍵をそのまま持つので、カーネルが形状キャッシュから引ける。
    expect(request.bodyKey).toBe(
      resolved.steps.find((step) => step.featureId === 'extrude-1')?.key,
    );
    expect(request.key.length).toBeGreaterThan(0);
    // 投影の面がまだ無いので、それを使う押し出しだけが失敗する(FR-504)。
    expect(resolved.errors.map((error) => error.featureId)).toEqual(['extrude-2']);
  });

  it('交差の依頼は立体そのものを指す', () => {
    const { document } = documentWithProjection('planeSection');
    const resolved = resolvePart(document);

    expect(resolved.projections).toHaveLength(1);
    expect(resolved.projections[0].source).toEqual({
      kind: 'body',
      bodyFeatureId: 'extrude-1',
    });
  });

  it('もとの立体の鍵が変われば、投影の鍵も必ず変わる(上流追従、NFR-PF-3)', () => {
    const { document } = documentWithProjection('projectedCurve');
    const before = resolvePart(document).projections[0];

    const changed: PartDocument = {
      ...document,
      solids: document.solids.map((feature) =>
        feature.id === 'extrude-1' && feature.kind === 'extrude'
          ? { ...feature, distance: expr('20') }
          : feature,
      ),
    };
    const after = resolvePart(changed).projections[0];

    expect(after.bodyKey).not.toBe(before.bodyKey);
    expect(after.key).not.toBe(before.key);
  });

  it('作図面が変われば投影の鍵も変わる(投影先が違えば別の曲線になる)', () => {
    const { document } = documentWithProjection('projectedCurve');
    const before = resolvePart(document).projections[0];

    const onXz: PartDocument = {
      ...document,
      sketches: document.sketches.map((sketch) =>
        sketch.id === 'sketch-2'
          ? {
              ...sketch,
              features: sketch.features.map((feature) =>
                feature.id === 'pj1' ? { ...feature, planeId: 'xz' } : feature,
              ),
            }
          : sketch,
      ),
    };
    const after = resolvePart(onXz).projections[0];

    expect(after.bodyKey).toBe(before.bodyKey);
    expect(after.key).not.toBe(before.key);
  });

  it('覚え書きから曲線が引けると、投影の面を使う押し出しまで解決する', () => {
    const { document } = documentWithProjection('projectedCurve');
    const resolved = resolvePart(document, { projectedCurves: () => RECTANGLE });

    expect(resolved.projections).toEqual([]);
    expect(resolved.errors).toEqual([]);
    const step = resolved.steps.find((candidate) => candidate.featureId === 'extrude-2');
    if (step === undefined) {
      throw new Error('投影の面を押し出した段があるはず');
    }
    expect(extrudePlan(step).profile).toHaveLength(4);
    expect(extrudePlan(step).distance).toBe(5);
  });

  it('参照先の立体が無いときは missingBody で断り、他は解決する(FR-504)', () => {
    const { document } = documentWithProjection('projectedCurve', {
      bodyFeatureId: 'extrude-404',
    });
    const resolved = resolvePart(document);

    expect(resolved.projections).toEqual([]);
    const failure = resolved.errors.find((error) => error.featureId === 'pj1');
    expect(failure?.code).toBe('missingBody');
    expect(failure?.message).toContain('投影のもとになる立体が見つかりません');
    // もとの立体そのものは作れている(文書は壊れない)。
    expect(resolved.steps.map((step) => step.featureId)).toEqual(['extrude-1']);
  });

  it('自分より後に作られる立体を指すと順序違反として断る(§0.a-0.11)', () => {
    const fixture = createFixture();
    const projected: SketchFeature = {
      id: 'pj1',
      name: '投影1',
      planeId: DEFAULT_WORK_PLANE_ID,
      kind: 'projectedCurve',
      // まだ作られていない後ろの立体(extrude-2)を指す。
      source: faceRef('extrude-2'),
      construction: false,
    };
    const face: SketchFaceFeature = {
      id: 'f-pj',
      name: '面-投影',
      planeId: DEFAULT_WORK_PLANE_ID,
      kind: 'face',
      boundary: [{ featureId: 'pj1' }],
      color: DEFAULT_FACE_COLOR,
    };
    let document = addSketch(fixture.document, {
      id: 'sketch-2',
      name: 'スケッチ2',
      features: [projected, face],
    });
    // スケッチ2 を使うのは extrude-1(位置 0)、参照先の extrude-2 は位置 1 なので順序違反。
    document = appendSolid(
      document,
      extrudeFeature('extrude-1', { sketchId: 'sketch-2', faceFeatureId: 'f-pj' }),
    );
    document = appendSolid(document, extrudeFeature('extrude-2', fixture.faceA));

    const resolved = resolvePart(document);

    expect(resolved.projections).toEqual([]);
    const failure = resolved.errors.find((error) => error.featureId === 'pj1');
    expect(failure?.code).toBe('missingBody');
    expect(failure?.message).toContain('このスケッチを使う立体より前に作られた立体だけ');
    // 後ろの立体そのものは作れている(FR-504「止めずに警告する」)。
    expect(resolved.steps.map((step) => step.featureId)).toEqual(['extrude-2']);
  });

  it('そのスケッチをどの立体も使っていなければ、どの立体でも参照できる', () => {
    const { document } = documentWithProjection('projectedCurve', { useProjection: false });
    const resolved = resolvePart(document);

    expect(resolved.errors).toEqual([]);
    expect(resolved.projections).toHaveLength(1);
    expect(resolved.projections[0].featureId).toBe('pj1');
  });

  it('投影を持たない部品では projections は空のまま(費用を増やさない、NFR-PF-3)', () => {
    const fixture = createFixture();
    const document = appendSolid(fixture.document, extrudeFeature('extrude-1', fixture.faceA));

    expect(resolvePart(document).projections).toEqual([]);
  });

  it('部分形状の選び直しの口を渡すと、3D スケッチの頂点参照がいまの形へ追従する(FR-330)', () => {
    const fixture = createFixture();
    const vertex: SubShapeRef = {
      bodyFeatureId: 'extrude-1',
      index: 2,
      fingerprint: { kind: 'vertex', position: [40, 30, 10] },
    };
    const document = appendSolid(
      addSketch(fixture.document, {
        id: 'sketch-2',
        name: 'スケッチ2',
        features: [
          {
            id: 'p-v',
            name: '点-頂点',
            planeId: FREE_WORK_PLANE_ID,
            kind: 'point',
            at: {
              mode: 'relative',
              base: { kind: 'subShape', ref: vertex },
              dx: expr('0'),
              dy: expr('0'),
              dz: expr('0'),
            },
          },
        ],
      }),
      extrudeFeature('extrude-1', fixture.faceA),
    );

    // 口を渡さないと、保存された指紋の位置のまま(タスク10 の振る舞い)。
    const fixed = resolvePart(document);
    const fixedSketch = fixed.sketches.find((entry) => entry.sketchId === 'sketch-2');
    expect(fixedSketch?.resolved.points[0].position).toEqual([40, 30, 10]);

    // 口を渡すと、いまの形で選び直した位置になる(タスク25 で配線した上流追従)。
    const followed = resolvePart(document, {
      subShape: () => ({
        kind: 'vertex',
        position: [40, 30, 20],
        axis: null,
        surfaceKind: null,
        curveKind: null,
      }),
    });
    const followedSketch = followed.sketches.find((entry) => entry.sketchId === 'sketch-2');
    expect(followedSketch?.resolved.points[0].position).toEqual([40, 30, 20]);
  });

  it('部分形状の選び直しの口は基準ジオメトリ(FR-329)にも効く', () => {
    const fixture = createFixture();
    const document = appendReference(fixture.document, {
      id: 'ref-1',
      name: '基準点1',
      visible: true,
      kind: 'referencePoint',
      definition: {
        kind: 'vertex',
        vertex: {
          bodyFeatureId: 'extrude-1',
          index: 2,
          fingerprint: { kind: 'vertex', position: [40, 30, 10] },
        },
      },
    });

    const fixed = resolvePart(document);
    expect(fixed.references.points[0].position).toEqual([40, 30, 10]);

    const followed = resolvePart(document, {
      subShape: () => ({
        kind: 'vertex',
        position: [40, 30, 20],
        axis: null,
        surfaceKind: null,
        curveKind: null,
      }),
    });
    expect(followed.references.points[0].position).toEqual([40, 30, 20]);
  });
});

describe('referencedSketchIds(FR-325 の順序の判定、タスク25)', () => {
  it('押し出しは断面のスケッチを使う', () => {
    expect(
      referencedSketchIds(
        extrudeFeature('e1', { sketchId: 'sketch-9', faceFeatureId: 'face-1' }),
      ),
    ).toEqual(['sketch-9']);
  });

  it('回転は断面と、軸に使った線分のスケッチの両方を使う', () => {
    expect(
      referencedSketchIds(
        revolveFeature(
          'r1',
          { sketchId: 'sketch-1', faceFeatureId: 'face-1' },
          { axis: { kind: 'line', line: { sketchId: 'sketch-2', lineFeatureId: 'line-1' } } },
        ),
      ),
    ).toEqual(['sketch-1', 'sketch-2']);
  });

  it('ブーリアンはスケッチを使わない(指すのはボディの id だけ)', () => {
    expect(
      referencedSketchIds({
        id: 'b1',
        name: 'b1',
        suppressed: false,
        kind: 'boolean',
        operation: 'union',
        targetFeatureId: 'a',
        toolFeatureId: 'b',
      }),
    ).toEqual([]);
  });
});

/* ------------------------------------------------------------------ *
 * 拘束を部品文書の経路で解く(FR-313、P4b タスク8)
 *
 * カーネルを呼ばない側の検査。体積まで見る検査は `constraintKernel.test.ts`。
 * ここで固定するのは「`resolvePart` がスケッチを解く 2 か所の**どちらも**
 * 拘束を通っていること」と、診断・断りが `ResolvedPartSketch` に載ることの 2 つ
 * (P4 タスク21 の教訓: model 単体が緑でも部品文書の経路が素通しになりうる)。
 * ------------------------------------------------------------------ */

/** 拘束で 40×30 の長方形へ整う枠のスケッチ(わざとずれた座標から始める)。 */
function constrainedFrame(
  sketchId: string,
  planeId: WorkPlaneId = DEFAULT_WORK_PLANE_ID,
): SketchDocument {
  const corners: readonly (readonly [number, number, number])[] = [
    [0, 0, 0],
    [38, 1, 0],
    [39, 29, 0],
    [1, 31, 0],
  ];
  const features: SketchFeature[] = corners.map((corner, index) => {
    const next = corners[(index + 1) % corners.length];
    const line: SketchLineFeature = {
      id: `line-${index + 1}`,
      name: `線分${index + 1}`,
      planeId,
      kind: 'line',
      from: absoluteCoordinate(corner[0], corner[1], corner[2]),
      to: absoluteCoordinate(next[0], next[1], next[2]),
      construction: false,
    };
    return line;
  });
  const vertex = (
    featureId: string,
    which: 'start' | 'end',
  ): { readonly kind: 'vertex'; readonly featureId: string; readonly vertex: 'start' | 'end' } => ({
    kind: 'vertex',
    featureId,
    vertex: which,
  });
  const curve = (featureId: string): {
    readonly kind: 'curve';
    readonly element: { readonly featureId: string };
  } => ({ kind: 'curve', element: { featureId } });
  return {
    id: sketchId,
    name: sketchId,
    features,
    constraints: [
      { id: 'fix-1', name: '固定1', kind: 'fix', target: vertex('line-1', 'start') },
      { id: 'c-1', name: '一致1', kind: 'coincident', a: vertex('line-1', 'end'), b: vertex('line-2', 'start') },
      { id: 'c-2', name: '一致2', kind: 'coincident', a: vertex('line-2', 'end'), b: vertex('line-3', 'start') },
      { id: 'c-3', name: '一致3', kind: 'coincident', a: vertex('line-3', 'end'), b: vertex('line-4', 'start') },
      { id: 'c-4', name: '一致4', kind: 'coincident', a: vertex('line-4', 'end'), b: vertex('line-1', 'start') },
      { id: 'h-1', name: '水平1', kind: 'horizontal', target: curve('line-1') },
      { id: 'h-2', name: '水平2', kind: 'horizontal', target: curve('line-3') },
      { id: 'v-1', name: '垂直1', kind: 'vertical', target: curve('line-2') },
      { id: 'v-2', name: '垂直2', kind: 'vertical', target: curve('line-4') },
      {
        id: 'd-1',
        name: '幅1',
        kind: 'distance',
        a: vertex('line-1', 'start'),
        b: vertex('line-1', 'end'),
        length: expr('40'),
      },
      {
        id: 'd-2',
        name: '奥行1',
        kind: 'distance',
        a: vertex('line-2', 'start'),
        b: vertex('line-2', 'end'),
        length: expr('30'),
      },
    ],
  };
}

describe('resolvePart の拘束(FR-313、タスク8)', () => {
  it('部品文書の経路でも拘束が効き、枠が 40×30 の長方形へ整う', () => {
    const document = replaceSketch(createEmptyPartDocument(), constrainedFrame('sketch-1'));
    const resolved = resolvePart(document);
    // 解いた座標は 1e-9 の許容量まで詰めた値なので、厳密一致ではなく近さで見る。
    const expected: readonly (readonly Vec3[])[] = [
      [
        [0, 0, 0],
        [40, 0, 0],
      ],
      [
        [40, 0, 0],
        [40, 30, 0],
      ],
      [
        [40, 30, 0],
        [0, 30, 0],
      ],
      [
        [0, 30, 0],
        [0, 0, 0],
      ],
    ];
    const actual = segmentEnds(resolved.sketches[0].resolved.segments);
    expect(actual).toHaveLength(expected.length);
    expected.forEach((ends, index) => {
      ends.forEach((point, side) => {
        point.forEach((value, axis) => {
          expect(actual[index][side][axis]).toBeCloseTo(value, 8);
        });
      });
    });
  });

  it('診断が載り、自由度 0・断り無しになる', () => {
    const document = replaceSketch(createEmptyPartDocument(), constrainedFrame('sketch-1'));
    const entry = resolvePart(document).sketches[0];
    expect(entry.diagnosis?.degreesOfFreedom).toBe(0);
    expect(entry.diagnosis?.conflicting).toEqual([]);
    expect(entry.constraintErrors).toEqual([]);
  });

  it('拘束を 1 つも持たないスケッチでは診断を作らない(据え置き)', () => {
    const fixture = createFixture();
    for (const entry of resolvePart(fixture.document).sketches) {
      expect(entry.diagnosis).toBeNull();
      expect(entry.constraintErrors).toEqual([]);
    }
  });

  it('基準ジオメトリを先に解く経路(1 か所目)でも拘束が効く', () => {
    // 基準ジオメトリの解決は、必要になったスケッチをその場で解く
    // (`resolveSketchesAndReferences` の 1 か所目)。そこも拘束を通っていることを、
    // スケッチの線分を軸にした作業平面の向きで確かめる。
    // 拘束を解く前の line-1 は (0,0,0)→(38,1,0) で少し傾いており、解いた後は X 軸に沿う。
    // XY 面をその軸まわりに 90 度倒すと、法線は X 軸に垂直な向き = (0,-1,0) になる。
    let document = replaceSketch(createEmptyPartDocument(), constrainedFrame('sketch-1'));
    document = appendReference(document, {
      id: 'plane-1',
      name: '作業平面1',
      visible: true,
      kind: 'referencePlane',
      plane: {
        kind: 'tilted',
        base: DEFAULT_WORK_PLANE_ID,
        axis: { kind: 'line', line: { sketchId: 'sketch-1', lineFeatureId: 'line-1' } },
        angle: expr('90'),
      },
    });
    const plane = resolvePart(document).references.planes.find(
      (entry) => entry.featureId === 'plane-1',
    );
    expect(plane).toBeDefined();
    for (const [index, expected] of [0, -1, 0].entries()) {
      expect(plane?.plane.normal[index] ?? 0).toBeCloseTo(expected, 9);
    }
  });

  it('3D スケッチに拘束を足すと断りが載り、形は拘束を無視したまま', () => {
    const document = replaceSketch(
      createEmptyPartDocument(),
      constrainedFrame('sketch-1', FREE_WORK_PLANE_ID),
    );
    const entry = resolvePart(document).sketches[0];
    expect(entry.constraintErrors).toHaveLength(1);
    expect(entry.constraintErrors[0].code).toBe('constraintUnsolved');
    expect(entry.resolved.segments[0].to).toEqual([38, 1, 0]);
  });
});

describe('resolvePart 基本形状(FR-429、P5 タスク16)', () => {
  it('既定の球を1段作り、中心・向き・半径をそのまま渡す', () => {
    const fixture = createFixture();
    const document = withSolids(fixture.document, primitiveFeature('sphere-1', sphereShape()));
    const result = resolvePart(document);
    expect(result.errors).toEqual([]);
    expect(result.steps).toHaveLength(1);
    const plan = primitivePlan(result.steps[0]);
    expect(plan.origin).toEqual([0, 0, 0]);
    expect(plan.axis).toEqual([0, 0, 1]);
    expect(plan.shape).toEqual({ kind: 'sphere', radius: 10 });
    expect(plan.originQuery).toBeNull();
    expect(plan.targetKey).toBeNull();
    expect(result.liveBodyIds).toEqual(['sphere-1']);
  });

  it('中心の座標の式 [5, 5*2, 15] は [5, 10, 15] に解ける', () => {
    const fixture = createFixture();
    const document = withSolids(
      fixture.document,
      primitiveFeature('box-1', boxShape(), { origin: coordinateOrigin('5', '5*2', '15') }),
    );
    const result = resolvePart(document);
    expect(result.errors).toEqual([]);
    expect(primitivePlan(result.steps[0]).origin).toEqual([5, 10, 15]);
  });

  it('中心にスケッチの点を指すと、その点の座標になる', () => {
    const fixture = createFixture();
    const document = withSolids(
      fixture.document,
      primitiveFeature('cylinder-1', cylinderShape(), {
        origin: { kind: 'sketchPoint', ref: fixture.pointA },
      }),
    );
    const result = resolvePart(document);
    expect(result.errors).toEqual([]);
    const plan = primitivePlan(result.steps[0]);
    expect(plan.origin[0]).toBeCloseTo(10, 9);
    expect(plan.origin[1]).toBeCloseTo(10, 9);
    expect(plan.origin[2]).toBeCloseTo(0, 9);
    expect(plan.originQuery).toBeNull();
  });

  it('中心に立体の頂点を指すと、指紋と上流の鍵が段に乗り、位置は頂点からのずれ 0 になる', () => {
    const fixture = createFixture();
    const document = withSolids(
      fixture.document,
      extrudeFeature('extrude-1', fixture.faceA),
      primitiveFeature('sphere-1', sphereShape('5'), {
        origin: { kind: 'vertex', ref: vertexRef('extrude-1') },
      }),
    );
    const result = resolvePart(document);
    expect(result.errors).toEqual([]);
    const plan = primitivePlan(result.steps[1]);
    expect(plan.origin).toEqual([0, 0, 0]);
    expect(plan.originQuery).toEqual(vertexRef('extrude-1'));
    expect(plan.targetKey).toBe(result.steps[0].key);
  });

  it('頂点を借りても対象は消費しない(押し出しと球の2つが画面に残る)', () => {
    const fixture = createFixture();
    const document = withSolids(
      fixture.document,
      extrudeFeature('extrude-1', fixture.faceA),
      primitiveFeature('sphere-1', sphereShape('5'), {
        origin: { kind: 'vertex', ref: vertexRef('extrude-1') },
      }),
    );
    const result = resolvePart(document);
    expect(result.liveBodyIds).toEqual(['extrude-1', 'sphere-1']);
    expect(result.steps.every((step) => step.visible)).toBe(true);
  });

  it('上流の押し出しを伸ばすと、頂点を借りた球の鍵も変わる(鍵の連鎖)', () => {
    const fixture = createFixture();
    const build = (distance: string): ResolvedPart =>
      resolvePart(
        withSolids(
          fixture.document,
          extrudeFeature('extrude-1', fixture.faceA, { distance }),
          primitiveFeature('sphere-1', sphereShape('5'), {
            origin: { kind: 'vertex', ref: vertexRef('extrude-1') },
          }),
        ),
      );
    const shorter = build('10');
    const taller = build('20');
    expect(taller.steps[0].key).not.toBe(shorter.steps[0].key);
    expect(taller.steps[1].key).not.toBe(shorter.steps[1].key);
  });

  it('中心にしたスケッチの点が見つからなければ missingProfile(例外にならない)', () => {
    const fixture = createFixture();
    const document = withSolids(
      fixture.document,
      primitiveFeature('sphere-1', sphereShape(), {
        origin: {
          kind: 'sketchPoint',
          ref: { sketchId: fixture.pointA.sketchId, pointFeatureId: 'point-404' },
        },
      }),
    );
    const result = resolvePart(document);
    expect(codesOf(result)).toEqual(['missingProfile']);
    expect(result.errors[0].message).toContain('中心にする点');
    expect(result.steps).toEqual([]);
  });

  it('中心にした頂点の立体が引けなければ missingSubShape', () => {
    const fixture = createFixture();
    const document = withSolids(
      fixture.document,
      primitiveFeature('sphere-1', sphereShape(), {
        origin: { kind: 'vertex', ref: vertexRef('extrude-404') },
      }),
    );
    const result = resolvePart(document);
    expect(codesOf(result)).toEqual(['missingSubShape']);
    expect(result.errors[0].message).toContain('中心にする頂点');
    expect(result.steps).toEqual([]);
  });

  it('中心に面の指紋を指すと invalidValue(中心にできるのは頂点だけ)', () => {
    const fixture = createFixture();
    const document = withSolids(
      fixture.document,
      extrudeFeature('extrude-1', fixture.faceA),
      primitiveFeature('sphere-1', sphereShape(), {
        origin: { kind: 'vertex', ref: topFaceRef('extrude-1') },
      }),
    );
    const result = resolvePart(document);
    expect(codesOf(result)).toEqual(['invalidValue']);
    expect(result.errors[0].message).toContain('立体の頂点だけ');
  });

  it('中心の式が評価できなければ invalidValue(式のエラーをそのまま見せる)', () => {
    const fixture = createFixture();
    const brokenValue: CoordinateInput = {
      mode: 'absolute',
      x: expr('0'),
      y: notANumber('1/0'),
      z: expr('0'),
    };
    const document = withSolids(
      fixture.document,
      primitiveFeature('sphere-1', sphereShape(), {
        origin: { kind: 'coordinate', value: brokenValue },
      }),
    );
    const result = resolvePart(document);
    expect(codesOf(result)).toEqual(['invalidValue']);
    expect(result.errors[0].message).toContain('数になっていません');
  });

  it('球の半径が -1 なら invalidValue(0 より大きい)', () => {
    const fixture = createFixture();
    const document = withSolids(fixture.document, primitiveFeature('sphere-1', sphereShape('-1')));
    const result = resolvePart(document);
    expect(codesOf(result)).toEqual(['invalidValue']);
    expect(result.errors[0].message).toContain('0 より大きい');
    expect(result.steps).toEqual([]);
  });

  it('箱の Y の長さが 0 なら、どの欄が悪いか分かる断りになる', () => {
    const fixture = createFixture();
    const document = withSolids(
      fixture.document,
      primitiveFeature('box-1', boxShape('20', '0', '20')),
    );
    const result = resolvePart(document);
    expect(codesOf(result)).toEqual(['invalidValue']);
    expect(result.errors[0].message).toBe('Y の長さは 0 より大きい数にしてください。');
  });

  it('円柱の高さが数でなければ invalidValue', () => {
    const fixture = createFixture();
    const document = withSolids(
      fixture.document,
      primitiveFeature('cylinder-1', cylinderShape('10', notANumber('0/0'))),
    );
    const result = resolvePart(document);
    expect(codesOf(result)).toEqual(['invalidValue']);
    expect(result.errors[0].message).toBe('高さは 0 より大きい数にしてください。');
  });

  it('円錐の上半径 0(既定)は尖った円錐として通る', () => {
    const fixture = createFixture();
    const document = withSolids(fixture.document, primitiveFeature('cone-1', coneShape()));
    const result = resolvePart(document);
    expect(result.errors).toEqual([]);
    expect(primitivePlan(result.steps[0]).shape).toEqual({
      kind: 'cone',
      bottomRadius: 10,
      topRadius: 0,
      height: 20,
    });
  });

  it('円錐の両半径が 0 なら invalidValue', () => {
    const fixture = createFixture();
    const document = withSolids(
      fixture.document,
      primitiveFeature('cone-1', coneShape('0', '0', '20')),
    );
    const result = resolvePart(document);
    expect(codesOf(result)).toEqual(['invalidValue']);
    expect(result.errors[0].message).toContain('どちらか一方を 0 より大きく');
  });

  it('円錐の半径が負なら「0 以上」で断る', () => {
    const fixture = createFixture();
    const document = withSolids(
      fixture.document,
      primitiveFeature('cone-1', coneShape('10', '-1', '20')),
    );
    const result = resolvePart(document);
    expect(codesOf(result)).toEqual(['invalidValue']);
    expect(result.errors[0].message).toBe('円錐の半径は 0 以上にしてください。');
  });

  it('円錐の上下の半径が同じなら、円柱を使うよう促して断る', () => {
    const fixture = createFixture();
    const document = withSolids(
      fixture.document,
      primitiveFeature('cone-1', coneShape('10', '10', '20')),
    );
    const result = resolvePart(document);
    expect(codesOf(result)).toEqual(['invalidValue']);
    expect(result.errors[0].message).toBe('円錐の上下の半径が同じです。円柱を使ってください。');
  });

  it('トーラスの管の半径が主半径以上なら invalidValue(自己交差)', () => {
    const fixture = createFixture();
    const document = withSolids(
      fixture.document,
      primitiveFeature('torus-1', torusShape('20', '20')),
    );
    const result = resolvePart(document);
    expect(codesOf(result)).toEqual(['invalidValue']);
    expect(result.errors[0].message).toContain('中心までの半径より小さく');
  });

  it('トーラスの既定は主半径 20・管の半径 5', () => {
    const fixture = createFixture();
    const document = withSolids(fixture.document, primitiveFeature('torus-1', torusShape()));
    const result = resolvePart(document);
    expect(result.errors).toEqual([]);
    expect(primitivePlan(result.steps[0]).shape).toEqual({
      kind: 'torus',
      majorRadius: 20,
      minorRadius: 5,
    });
  });

  it('向きにワールド X を選ぶと軸は [1, 0, 0]', () => {
    const fixture = createFixture();
    const document = withSolids(
      fixture.document,
      primitiveFeature('cylinder-1', cylinderShape(), { axis: { kind: 'world', axis: 'x' } }),
    );
    const result = resolvePart(document);
    expect(result.errors).toEqual([]);
    expect(primitivePlan(result.steps[0]).axis).toEqual([1, 0, 0]);
  });

  it('向きにスケッチの線分を指すと、その線分の向き(単位)になる', () => {
    const fixture = createFixture();
    const axis: RevolveAxis = { kind: 'line', line: fixture.axisLine };
    const document = withSolids(
      fixture.document,
      primitiveFeature('cylinder-1', cylinderShape(), { axis }),
    );
    const result = resolvePart(document);
    expect(result.errors).toEqual([]);
    const expected = resolveRevolveAxis(axis, result.sketches);
    if (expected === null) {
      throw new Error('テストの前提が壊れている: 軸の線分が解決できない');
    }
    const plan = primitivePlan(result.steps[0]);
    for (const index of [0, 1, 2]) {
      expect(plan.axis[index]).toBeCloseTo(expected.direction[index], 9);
    }
  });

  it('向きの線分が見つからなければ missingProfile', () => {
    const fixture = createFixture();
    const document = withSolids(
      fixture.document,
      primitiveFeature('cylinder-1', cylinderShape(), {
        axis: {
          kind: 'line',
          line: { sketchId: fixture.axisLine.sketchId, lineFeatureId: 'line-404' },
        },
      }),
    );
    const result = resolvePart(document);
    expect(codesOf(result)).toEqual(['missingProfile']);
    expect(result.errors[0].message).toContain('向きにする線分');
  });

  it('抑制した球は段にも liveBodyIds にも出ず、失敗としても数えない', () => {
    const fixture = createFixture();
    const document = withSolids(
      fixture.document,
      primitiveFeature('sphere-1', sphereShape(), { suppressed: true }),
    );
    const result = resolvePart(document);
    expect(result.steps).toEqual([]);
    expect(result.errors).toEqual([]);
    expect(result.liveBodyIds).toEqual([]);
  });

  it('球 → 箱 → 差 の3段になり、消費された2つは画面から消える', () => {
    const fixture = createFixture();
    const document = withSolids(
      fixture.document,
      primitiveFeature('sphere-1', sphereShape()),
      primitiveFeature('box-1', boxShape()),
      booleanFeature('boolean-1', 'subtract', 'sphere-1', 'box-1'),
    );
    const result = resolvePart(document);
    expect(result.errors).toEqual([]);
    expect(result.steps).toHaveLength(3);
    expect(result.liveBodyIds).toEqual(['boolean-1']);
    const plan = booleanPlan(result.steps[2]);
    expect(plan.targetKey).toBe(result.steps[0].key);
    expect(plan.toolKey).toBe(result.steps[1].key);
  });

  it('寸法を変えると鍵が変わり、名前だけ変えても鍵は変わらない', () => {
    const fixture = createFixture();
    const build = (radius: string, name: string): ResolvedPart =>
      resolvePart(
        withSolids(fixture.document, primitiveFeature('sphere-1', sphereShape(radius), { name })),
      );
    const base = build('10', '球1');
    expect(build('10', '球A').steps[0].key).toBe(base.steps[0].key);
    expect(build('12', '球1').steps[0].key).not.toBe(base.steps[0].key);
  });

  it('中心を動かすと鍵が変わり、同じ座標に解ける別の指し方なら同じ鍵になる', () => {
    const fixture = createFixture();
    const build = (origin: SolidOrigin): ResolvedPart =>
      resolvePart(withSolids(fixture.document, primitiveFeature('sphere-1', sphereShape(), { origin })));
    const atCoordinate = build(coordinateOrigin('10', '10', '0'));
    // 中心の指し方(座標の式・スケッチの点)は世界座標へ解いてから段に乗るので、
    // 同じ (10,10,0) を指すなら鍵も同じになる(形が同じなら作り直さない、NFR-PF-3)。
    expect(build({ kind: 'sketchPoint', ref: fixture.pointA }).steps[0].key).toBe(
      atCoordinate.steps[0].key,
    );
    expect(build(coordinateOrigin('11', '10', '0')).steps[0].key).not.toBe(
      atCoordinate.steps[0].key,
    );
  });

  it('referencedSketchIds は中心がスケッチの点のときだけそのスケッチを数える', () => {
    const fixture = createFixture();
    const axis: RevolveAxis = { kind: 'line', line: fixture.axisLine };
    expect(referencedSketchIds(primitiveFeature('sphere-1', sphereShape()))).toEqual([]);
    expect(
      referencedSketchIds(
        primitiveFeature('sphere-1', sphereShape(), {
          origin: { kind: 'vertex', ref: vertexRef('extrude-1') },
        }),
      ),
    ).toEqual([]);
    expect(
      referencedSketchIds(
        primitiveFeature('sphere-1', sphereShape(), {
          origin: { kind: 'sketchPoint', ref: fixture.pointA },
          axis,
        }),
      ),
    ).toEqual([fixture.pointA.sketchId, fixture.axisLine.sketchId]);
  });
});

describe('スケッチの球面上の点(FR-431、P5 タスク19b: resolvePart の配線)', () => {
  /** 球面上の点(緯度・経度)を原点にした点フィーチャー1つだけを持つスケッチの部品文書。 */
  function documentWithSphereGridPoint(
    latitude: number,
    longitude: number,
    solids: readonly SolidFeature[],
    sphereFeatureId = 'sphere-1',
  ): PartDocument {
    const base = createEmptyPartDocument();
    const sketchBase = base.sketches[0];
    const at: CoordinateInput = {
      mode: 'relative',
      base: {
        kind: 'sphereGrid',
        sphereFeatureId,
        latitude: expressionValueFromNumber(latitude),
        longitude: expressionValueFromNumber(longitude),
      },
      dx: expressionValueFromNumber(0),
      dy: expressionValueFromNumber(0),
      dz: expressionValueFromNumber(0),
    };
    const point = createPointFeature(sketchBase, at);
    const sketch = appendFeature(sketchBase, point);
    return { ...replaceSketch(base, sketch), solids };
  }

  it('球 r10(中心原点)の球面上の点(緯度30・経度45)が resolvePart で解ける', () => {
    const document = documentWithSphereGridPoint(30, 45, [
      primitiveFeature('sphere-1', sphereShape('10'), { origin: coordinateOrigin('0', '0', '0') }),
    ]);
    const result = resolvePart(document);
    expect(result.errors).toEqual([]);
    const points = sketchesOf(document)[0].resolved.points;
    expect(points).toHaveLength(1);
    expect(points[0].position[0]).toBeCloseTo(6.123724356957945, 9);
    expect(points[0].position[1]).toBeCloseTo(6.123724356957945, 9);
    expect(points[0].position[2]).toBeCloseTo(5, 9);
  });

  it('球の半径を 10 → 20 にすると点も外へ動く(追従、FR-431)', () => {
    const before = documentWithSphereGridPoint(30, 45, [
      primitiveFeature('sphere-1', sphereShape('10'), { origin: coordinateOrigin('0', '0', '0') }),
    ]);
    const after = documentWithSphereGridPoint(30, 45, [
      primitiveFeature('sphere-1', sphereShape('20'), { origin: coordinateOrigin('0', '0', '0') }),
    ]);
    const beforePosition = sketchesOf(before)[0].resolved.points[0].position;
    const afterPosition = sketchesOf(after)[0].resolved.points[0].position;
    expect(afterPosition[0]).toBeCloseTo(beforePosition[0] * 2, 9);
    expect(afterPosition[1]).toBeCloseTo(beforePosition[1] * 2, 9);
    expect(afterPosition[2]).toBeCloseTo(beforePosition[2] * 2, 9);
  });

  it('球を消すと missingBase(球が見つかりません)で断る', () => {
    const document = documentWithSphereGridPoint(30, 45, []);
    const resolved = sketchesOf(document)[0].resolved;
    expect(resolved.points).toEqual([]);
    expect(resolved.errors).toHaveLength(1);
    expect(resolved.errors[0].code).toBe('missingBase');
    expect(resolved.errors[0].message).toBe('球が見つかりません。球を選び直してください。');
  });
});

describe('resolvePart 面をつなぐ・ロフト(FR-430、FR-410、P5 タスク25)', () => {
  function sketchSection(ref: SketchFaceRef): RuledSection {
    return { kind: 'sketchFace', ref };
  }

  function solidFaceSection(ref: SubShapeRef): RuledSection {
    return { kind: 'solidFace', ref };
  }

  function sphereSection(sphereFeatureId: string): RuledSection {
    return { kind: 'sphere', sphereFeatureId };
  }

  interface RuledOptions {
    readonly twist?: string | ExpressionValue;
    readonly sphereSegments?: RuledSphereSegments;
    readonly suppressed?: boolean;
    readonly name?: string;
  }

  function ruledFeature(
    id: string,
    first: RuledSection,
    second: RuledSection,
    options: RuledOptions = {},
  ): RuledFeature {
    return {
      id,
      name: options.name ?? id,
      suppressed: options.suppressed ?? false,
      kind: 'ruled',
      first,
      second,
      twist: toExpr(options.twist ?? '0'),
      sphereSegments: options.sphereSegments ?? DEFAULT_RULED_SPHERE_SEGMENTS,
    };
  }

  function loftFeature(
    id: string,
    sections: readonly RuledSection[],
    options: RuledOptions = {},
  ): LoftFeature {
    return {
      id,
      name: options.name ?? id,
      suppressed: options.suppressed ?? false,
      kind: 'loft',
      sections,
      twist: toExpr(options.twist ?? '0'),
    };
  }

  function thruSectionsPlan(
    step: ResolvedSolidStep,
  ): Extract<ResolvedSolidStep['plan'], { kind: 'thruSections' }> {
    if (step.plan.kind !== 'thruSections') {
      throw new Error(`テストの前提が壊れている: つなぐ段でない ${step.plan.kind}`);
    }
    return step.plan;
  }

  /**
   * 長方形の面 2 枚だけを持つ部品。上の面の高さを引数で変えられるので、
   * 「輪郭が変われば鍵が変わる」(NFR-PF-3)を独立に確かめられる。
   */
  function twoFaceDocument(topZ: number): {
    readonly document: PartDocument;
    readonly bottom: SketchFaceRef;
    readonly top: SketchFaceRef;
  } {
    const base = createEmptyPartDocument();
    const lower = addPoints(base.sketches[0], [
      [0, 0, 0],
      [40, 0, 0],
      [40, 30, 0],
      [0, 30, 0],
    ]);
    const bottom = addFace(lower.sketch, lower.pointIds);
    const upper = addPoints(bottom.sketch, [
      [0, 0, topZ],
      [20, 0, topZ],
      [20, 15, topZ],
      [0, 15, topZ],
    ]);
    const top = addFace(upper.sketch, upper.pointIds);
    const sketch = top.sketch;
    return {
      document: replaceSketch(base, sketch),
      bottom: { sketchId: sketch.id, faceFeatureId: bottom.faceId },
      top: { sketchId: sketch.id, faceFeatureId: top.faceId },
    };
  }

  it('スケッチの面 2 つを結ぶと段が 1 つでき、断面は 2 つ・直線で結ぶ', () => {
    const fixture = createFixture();
    const document = withSolids(
      fixture.document,
      ruledFeature('ruled-1', sketchSection(fixture.faceA), sketchSection(fixture.faceB)),
    );
    const result = resolvePart(document);
    expect(result.errors).toEqual([]);
    expect(result.steps).toHaveLength(1);
    const plan = thruSectionsPlan(result.steps[0]);
    expect(plan.sections).toHaveLength(2);
    expect(plan.ruled).toBe(true);
    expect(plan.closed).toBe(true);
    expect(plan.twist).toBe(0);
    expect(plan.sphereSegments).toBe(24);
  });

  it('スケッチの面の断面には、解決済みの輪郭がそのまま乗る', () => {
    const fixture = createFixture();
    const result = resolvePart(
      withSolids(
        fixture.document,
        ruledFeature('ruled-1', sketchSection(fixture.faceA), sketchSection(fixture.faceB)),
      ),
    );
    const first = thruSectionsPlan(result.steps[0]).sections[0];
    if (first.kind !== 'curves') {
      throw new Error('スケッチの面は輪郭になるはず');
    }
    // 面A は (0,0,0) (40,0,0) (40,30,0) (0,30,0) の 40×30 の長方形(4 本の線分)。
    expect(segmentEnds(first.curves)).toEqual([
      [
        [0, 0, 0],
        [40, 0, 0],
      ],
      [
        [40, 0, 0],
        [40, 30, 0],
      ],
      [
        [40, 30, 0],
        [0, 30, 0],
      ],
      [
        [0, 30, 0],
        [0, 0, 0],
      ],
    ]);
  });

  it('片方に球を置くと、中心と半径の断面になる(球面上の点と同じ数値)', () => {
    const fixture = createFixture();
    const document = withSolids(
      fixture.document,
      primitiveFeature('sphere-1', sphereShape('10'), {
        origin: coordinateOrigin('0', '0', '30'),
      }),
      ruledFeature('ruled-1', sphereSection('sphere-1'), sketchSection(fixture.faceA)),
    );
    const result = resolvePart(document);
    expect(result.errors).toEqual([]);
    const plan = thruSectionsPlan(result.steps[1]);
    expect(plan.sections[0]).toEqual({ kind: 'sphere', center: [0, 0, 30], radius: 10 });
    expect(plan.sections[1].kind).toBe('curves');
  });

  it('球どうしはつなげない(§2.9.3)', () => {
    const fixture = createFixture();
    const document = withSolids(
      fixture.document,
      primitiveFeature('sphere-1', sphereShape('10')),
      primitiveFeature('sphere-2', sphereShape('5'), { origin: coordinateOrigin('0', '0', '40') }),
      ruledFeature('ruled-1', sphereSection('sphere-1'), sphereSection('sphere-2')),
    );
    const result = resolvePart(document);
    expect(result.steps).toHaveLength(2);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].code).toBe('degenerate');
    expect(result.errors[0].message).toContain('球どうしを');
  });

  it('抑制した球はつなぐ相手にできない(画面に無いため)', () => {
    const fixture = createFixture();
    const document = withSolids(
      fixture.document,
      primitiveFeature('sphere-1', sphereShape('10'), { suppressed: true }),
      ruledFeature('ruled-1', sphereSection('sphere-1'), sketchSection(fixture.faceA)),
    );
    const result = resolvePart(document);
    expect(result.steps).toEqual([]);
    expect(result.errors[0].code).toBe('missingProfile');
    expect(result.errors[0].message).toContain('球');
  });

  it('立体の面 2 つを結ぶと faceQuery が 2 つ乗り、targetKey が対象の段の鍵になる', () => {
    const fixture = createFixture();
    const document = withSolids(
      fixture.document,
      extrudeFeature('extrude-1', fixture.faceA),
      extrudeFeature('extrude-2', fixture.faceB, { distance: '4' }),
      ruledFeature(
        'ruled-1',
        solidFaceSection(topFaceRef('extrude-1')),
        solidFaceSection(topFaceRef('extrude-2')),
      ),
    );
    const result = resolvePart(document);
    expect(result.errors).toEqual([]);
    const plan = thruSectionsPlan(result.steps[2]);
    expect(plan.sections.map((section) => section.kind)).toEqual(['faceQuery', 'faceQuery']);
    const first = plan.sections[0];
    const second = plan.sections[1];
    if (first.kind !== 'faceQuery' || second.kind !== 'faceQuery') {
      throw new Error('立体の面は faceQuery になるはず');
    }
    expect(first.targetKey).toBe(result.steps[0].key);
    expect(second.targetKey).toBe(result.steps[1].key);
    expect(first.query).toEqual(topFaceRef('extrude-1'));
  });

  it('輪郭に面でないもの(辺)を指すと断る', () => {
    const fixture = createFixture();
    const document = withSolids(
      fixture.document,
      extrudeFeature('extrude-1', fixture.faceA),
      ruledFeature('ruled-1', solidFaceSection(edgeRef('extrude-1')), sketchSection(fixture.faceB)),
    );
    const result = resolvePart(document);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].code).toBe('invalidValue');
    expect(result.errors[0].message).toContain('立体の面だけ');
  });

  it('輪郭にした立体が無ければ断る(FR-504)', () => {
    const fixture = createFixture();
    const document = withSolids(
      fixture.document,
      ruledFeature(
        'ruled-1',
        solidFaceSection(topFaceRef('extrude-404')),
        sketchSection(fixture.faceB),
      ),
    );
    const result = resolvePart(document);
    expect(result.steps).toEqual([]);
    expect(result.errors[0].code).toBe('missingBody');
  });

  it('元の立体を消費しない(§0.a-0.27)', () => {
    const fixture = createFixture();
    const ruled = ruledFeature(
      'ruled-1',
      solidFaceSection(topFaceRef('extrude-1')),
      sphereSection('sphere-1'),
    );
    expect(consumedTargetsOf(ruled)).toEqual([]);
    const document = withSolids(
      fixture.document,
      extrudeFeature('extrude-1', fixture.faceA),
      primitiveFeature('sphere-1', sphereShape('10'), {
        origin: coordinateOrigin('20', '15', '40'),
      }),
      ruled,
    );
    const result = resolvePart(document);
    expect(result.errors).toEqual([]);
    // 押し出しと球はそのまま画面に残り、つないだ立体が 3 つ目として増える。
    expect(result.liveBodyIds).toEqual(['extrude-1', 'sphere-1', 'ruled-1']);
  });

  it('ロフトは 3 断面をなめらかに結ぶ(ruled が false)', () => {
    const fixture = createFixture();
    const document = withSolids(
      fixture.document,
      extrudeFeature('extrude-1', fixture.faceA),
      loftFeature('loft-1', [
        sketchSection(fixture.faceA),
        sketchSection(fixture.faceB),
        solidFaceSection(topFaceRef('extrude-1')),
      ]),
    );
    const result = resolvePart(document);
    expect(result.errors).toEqual([]);
    const plan = thruSectionsPlan(result.steps[1]);
    expect(plan.ruled).toBe(false);
    expect(plan.sections).toHaveLength(3);
  });

  it('断面が 1 つだけのロフトは断る(つなぐ面を 2 つ)', () => {
    const fixture = createFixture();
    const document = withSolids(
      fixture.document,
      loftFeature('loft-1', [sketchSection(fixture.faceA)]),
    );
    const result = resolvePart(document);
    expect(result.steps).toEqual([]);
    expect(result.errors[0].code).toBe('missingProfile');
    expect(result.errors[0].message).toContain('つなぐ面を 2 つ');
  });

  it('ロフトには球を置けない(§2.9.3)', () => {
    const fixture = createFixture();
    const document = withSolids(
      fixture.document,
      primitiveFeature('sphere-1', sphereShape('10')),
      loftFeature('loft-1', [sketchSection(fixture.faceA), sphereSection('sphere-1')]),
    );
    const result = resolvePart(document);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].code).toBe('degenerate');
    expect(result.errors[0].message).toContain('ロフトには球を使えません');
  });

  it('ねじれの補正が小数(1.5)なら、切り捨てずに断る', () => {
    const fixture = createFixture();
    const document = withSolids(
      fixture.document,
      ruledFeature('ruled-1', sketchSection(fixture.faceA), sketchSection(fixture.faceB), {
        twist: '1.5',
      }),
    );
    const result = resolvePart(document);
    expect(result.steps).toEqual([]);
    expect(result.errors[0].code).toBe('invalidValue');
    expect(result.errors[0].message).toContain('整数');
  });

  it('ねじれの補正は負の整数でも通る(向きを逆へずらせる)', () => {
    const fixture = createFixture();
    const result = resolvePart(
      withSolids(
        fixture.document,
        ruledFeature('ruled-1', sketchSection(fixture.faceA), sketchSection(fixture.faceB), {
          twist: '0-2',
        }),
      ),
    );
    expect(result.errors).toEqual([]);
    expect(thruSectionsPlan(result.steps[0]).twist).toBe(-2);
  });

  it('つなぐもとのスケッチの面が無ければ断る(FR-504)', () => {
    const fixture = createFixture();
    const document = withSolids(
      fixture.document,
      ruledFeature('ruled-1', sketchSection(fixture.faceA), sketchSection(fixture.brokenFace)),
    );
    const result = resolvePart(document);
    expect(result.steps).toEqual([]);
    expect(result.errors[0].code).toBe('missingProfile');
  });

  it('輪郭が変わると鍵が変わる(NFR-PF-3)', () => {
    const build = (topZ: number): string => {
      const faces = twoFaceDocument(topZ);
      const document = withSolids(
        faces.document,
        ruledFeature('ruled-1', sketchSection(faces.bottom), sketchSection(faces.top)),
      );
      return resolvePart(document).steps[0].key;
    };
    expect(build(20)).not.toBe(build(10));
  });

  it('球の半径が変わると鍵が変わる', () => {
    const fixture = createFixture();
    const build = (radius: string): string =>
      resolvePart(
        withSolids(
          fixture.document,
          primitiveFeature('sphere-1', sphereShape(radius), {
            origin: coordinateOrigin('20', '15', '40'),
          }),
          ruledFeature('ruled-1', sphereSection('sphere-1'), sketchSection(fixture.faceA)),
        ),
      ).steps[1].key;
    expect(build('5')).not.toBe(build('10'));
  });

  it('ねじれの補正・球の点の数・罫線面/ロフトの別で鍵が変わる', () => {
    const fixture = createFixture();
    const ruledKey = (options: RuledOptions): string =>
      resolvePart(
        withSolids(
          fixture.document,
          ruledFeature(
            'ruled-1',
            sketchSection(fixture.faceA),
            sketchSection(fixture.faceB),
            options,
          ),
        ),
      ).steps[0].key;
    const loftKey = resolvePart(
      withSolids(
        fixture.document,
        loftFeature('loft-1', [sketchSection(fixture.faceA), sketchSection(fixture.faceB)]),
      ),
    ).steps[0].key;
    expect(ruledKey({ twist: '1' })).not.toBe(ruledKey({}));
    expect(ruledKey({ sphereSegments: 72 })).not.toBe(ruledKey({}));
    // 同じ断面・同じねじれでも、直線で結ぶかなめらかに結ぶかで形が違う(§0.a-0.25)。
    expect(loftKey).not.toBe(ruledKey({}));
  });

  it('輪郭に借りた立体を伸ばすと、つないだ段の鍵も変わる(鍵の連鎖)', () => {
    const fixture = createFixture();
    const build = (distance: string): ResolvedPart =>
      resolvePart(
        withSolids(
          fixture.document,
          extrudeFeature('extrude-1', fixture.faceA, { distance }),
          ruledFeature(
            'ruled-1',
            solidFaceSection(topFaceRef('extrude-1')),
            sketchSection(fixture.faceB),
          ),
        ),
      );
    const shorter = build('10');
    const taller = build('20');
    expect(taller.steps[0].key).not.toBe(shorter.steps[0].key);
    expect(taller.steps[1].key).not.toBe(shorter.steps[1].key);
  });

  it('referencedSketchIds はスケッチの面を指した断面だけを数える', () => {
    const fixture = createFixture();
    expect(
      referencedSketchIds(
        ruledFeature('ruled-1', sketchSection(fixture.faceA), sphereSection('sphere-1')),
      ),
    ).toEqual([fixture.faceA.sketchId]);
    expect(
      referencedSketchIds(
        loftFeature('loft-1', [
          solidFaceSection(topFaceRef('extrude-1')),
          sketchSection(fixture.faceA),
          sketchSection(fixture.faceB),
        ]),
      ),
    ).toEqual([fixture.faceA.sketchId, fixture.faceB.sketchId]);
  });
});
