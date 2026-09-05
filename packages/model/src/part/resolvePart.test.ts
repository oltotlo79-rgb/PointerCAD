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
import type { PlaneSpec } from '../geometry/planeSpec.js';
import {
  DEFAULT_WORK_PLANE_ID,
  FREE_WORK_PLANE_ID,
  type WorkPlaneId,
} from '../sketch/planeMath.js';
import type {
  CoordinateInput,
  PointReference,
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
import { dotVec3, lengthVec3, type Vec3 } from '../sketch/vec3.js';
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
  consumedBodyIds,
  consumedTargetsOf,
  createEmptyPartDocument,
  DEFAULT_CUT_KEEP,
  DEFAULT_PRIMITIVE_AXIS,
  DEFAULT_RULED_SPHERE_SEGMENTS,
  defaultPrimitiveOrigin,
  liveBodyIds,
  removeSolid,
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
  CutFeature,
  DraftFeature,
  EmbossFeature,
  ExtrudeEnd,
  ExtrudeFeature,
  FilletFeature,
  HoleDepth,
  HoleEntry,
  HoleFeature,
  LoftFeature,
  MirrorFeature,
  MirrorPlane,
  PartDocument,
  PatternDirection,
  PatternFeature,
  PatternPlacement,
  PrimitiveFeature,
  PrimitiveShape,
  RevolveAxis,
  RevolveFeature,
  RibFeature,
  RibSide,
  RuledFeature,
  RuledSection,
  RuledSphereSegments,
  ScaleFactor,
  ScaleFeature,
  SewFeature,
  ShellFeature,
  SketchCurveRef,
  SketchFaceRef,
  SketchLineRef,
  SketchPointRef,
  SolidFeature,
  SolidOrigin,
  SpringDerived,
  SpringFeature,
  SpringHandedness,
  SubShapeRef,
  SurfaceFeature,
  SurfaceOperation,
  SweepFeature,
  ThicknessSide,
  ThreadHoleFeature,
  ThreadRepresentation,
  ThreadShaftFeature,
  TransformFeature,
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

// ---------------------------------------------------------------------------
// P5 の Should 群 前半(押し出しの終端・テーパ・薄板 FR-415/FR-401/FR-416、
// 抜き勾配 FR-417、ミラー FR-419、移動/回転・拡大縮小 FR-424)。§2.11、タスク45
// ---------------------------------------------------------------------------

interface ShapedExtrudeOptions extends ExtrudeOptions {
  readonly end?: ExtrudeEnd;
  readonly taperAngle?: string | ExpressionValue;
  readonly taperOutward?: boolean;
  readonly thickness?: string | ExpressionValue | null;
  readonly thicknessSide?: ThicknessSide;
}

/**
 * 終端・傾き・薄板を足した押し出し。**省略した欄は文書にも入れない**
 * (省略と既定が同じ段・同じ鍵になることを検査で見るため、undefined を書き込まない)。
 */
function shapedExtrude(
  id: string,
  profile: SketchFaceRef,
  options: ShapedExtrudeOptions = {},
): ExtrudeFeature {
  return {
    ...extrudeFeature(id, profile, options),
    ...(options.end === undefined ? {} : { end: options.end }),
    ...(options.taperAngle === undefined ? {} : { taperAngle: toExpr(options.taperAngle) }),
    ...(options.taperOutward === undefined ? {} : { taperOutward: options.taperOutward }),
    ...(options.thickness === undefined
      ? {}
      : { thickness: options.thickness === null ? null : toExpr(options.thickness) }),
    ...(options.thicknessSide === undefined ? {} : { thicknessSide: options.thicknessSide }),
  };
}

/** 箱の側面(x = 40、法線 +X)の指紋。抜き勾配の「傾ける面」・平行な面の検査に使う。 */
function sideFaceRef(bodyFeatureId: string, index = 1): SubShapeRef {
  return {
    bodyFeatureId,
    index,
    fingerprint: {
      kind: 'face',
      surfaceKind: 'plane',
      area: 300,
      position: [40, 15, 5],
      axis: [1, 0, 0],
      radius: null,
    },
  };
}

/** 平らでない面(円柱の側面)の指紋。「平らな面だけ」の断りに使う。 */
function cylinderFaceRef(bodyFeatureId: string): SubShapeRef {
  return {
    bodyFeatureId,
    index: 4,
    fingerprint: {
      kind: 'face',
      surfaceKind: 'cylinder',
      area: 314,
      position: [20, 15, 5],
      axis: [0, 0, 1],
      radius: 5,
    },
  };
}

interface DraftOptions {
  readonly faces?: readonly SubShapeRef[];
  readonly neutralFace?: SubShapeRef;
  readonly angle?: string | ExpressionValue;
  readonly reversed?: boolean;
}

function draftFeature(
  id: string,
  targetFeatureId: string,
  options: DraftOptions = {},
): DraftFeature {
  return {
    id,
    name: id,
    suppressed: false,
    kind: 'draft',
    targetFeatureId,
    faces: options.faces ?? [sideFaceRef(targetFeatureId)],
    neutralFace: options.neutralFace ?? topFaceRef(targetFeatureId),
    angle: toExpr(options.angle ?? '3'),
    reversed: options.reversed ?? false,
  };
}

function mirrorFeature(
  id: string,
  targetFeatureId: string,
  plane: MirrorPlane = { kind: 'workPlane', planeId: 'xy' },
): MirrorFeature {
  return { id, name: id, suppressed: false, kind: 'mirror', targetFeatureId, plane };
}

interface TransformOptions {
  readonly translation?: readonly [string, string, string];
  readonly rotationAxis?: RevolveAxis | null;
  readonly rotationAngle?: string | ExpressionValue;
}

function transformFeature(
  id: string,
  targetFeatureId: string,
  options: TransformOptions = {},
): TransformFeature {
  const [x, y, z] = options.translation ?? ['0', '0', '0'];
  return {
    id,
    name: id,
    suppressed: false,
    kind: 'transform',
    targetFeatureId,
    translation: [expr(x), expr(y), expr(z)],
    rotationAxis: options.rotationAxis ?? null,
    rotationAngle: toExpr(options.rotationAngle ?? '0'),
  };
}

function scaleFeature(
  id: string,
  targetFeatureId: string,
  factor: ScaleFactor,
  origin: PointReference = { kind: 'origin' },
): ScaleFeature {
  return { id, name: id, suppressed: false, kind: 'scale', targetFeatureId, origin, factor };
}

function uniformFactor(value: string): ScaleFactor {
  return { kind: 'uniform', value: expr(value) };
}

function perAxisFactor(x: string, y: string, z: string): ScaleFactor {
  return { kind: 'perAxis', x: expr(x), y: expr(y), z: expr(z) };
}

function draftPlan(step: ResolvedSolidStep): Extract<ResolvedSolidStep['plan'], { kind: 'draft' }> {
  if (step.plan.kind !== 'draft') {
    throw new Error(`テストの前提が壊れている: 抜き勾配でない段 ${step.plan.kind}`);
  }
  return step.plan;
}

function mirrorPlan(
  step: ResolvedSolidStep,
): Extract<ResolvedSolidStep['plan'], { kind: 'mirror' }> {
  if (step.plan.kind !== 'mirror') {
    throw new Error(`テストの前提が壊れている: ミラーでない段 ${step.plan.kind}`);
  }
  return step.plan;
}

function transformPlan(
  step: ResolvedSolidStep,
): Extract<ResolvedSolidStep['plan'], { kind: 'transform' }> {
  if (step.plan.kind !== 'transform') {
    throw new Error(`テストの前提が壊れている: 移動/回転でない段 ${step.plan.kind}`);
  }
  return step.plan;
}

function scalePlan(step: ResolvedSolidStep): Extract<ResolvedSolidStep['plan'], { kind: 'scale' }> {
  if (step.plan.kind !== 'scale') {
    throw new Error(`テストの前提が壊れている: 拡大縮小でない段 ${step.plan.kind}`);
  }
  return step.plan;
}

/** 5π/180。計画書 タスク45 の検証表の期待値(± 1e-12)。 */
const FIVE_DEGREES_IN_RADIANS = 0.08726646259971647;
/** π/2。同じく検証表の期待値。 */
const NINETY_DEGREES_IN_RADIANS = 1.5707963267948966;

describe('押し出しの終端・テーパ・薄板(FR-415、FR-401、FR-416)', () => {
  it('5 欄を省くと段も鍵も P2 の押し出しと 1 ドットも変わらない', () => {
    const fixture = createFixture();
    const document = withSolids(fixture.document, shapedExtrude('extrude-1', fixture.faceA));
    const plan = extrudePlan(resolvePart(document).steps[0]);
    expect(plan.end).toBeUndefined();
    expect(plan.taperAngle).toBeUndefined();
    expect(plan.thin).toBeUndefined();
    expect(plan.targetKey).toBeUndefined();
    expect(plan.distance).toBe(10);
  });

  it('既定を明示しても、省略したときと同じ鍵になる(タスク44 の決め 3)', () => {
    const fixture = createFixture();
    const keyOf = (feature: ExtrudeFeature): string =>
      resolvePart(withSolids(fixture.document, feature)).steps[0].key;
    expect(
      keyOf(
        shapedExtrude('extrude-1', fixture.faceA, {
          end: { kind: 'distance' },
          taperAngle: '0',
          taperOutward: false,
          thickness: null,
          thicknessSide: 'inner',
        }),
      ),
    ).toBe(keyOf(extrudeFeature('extrude-1', fixture.faceA)));
  });

  it('同じ入力なら鍵は 2 回とも同じ(決定性)', () => {
    const fixture = createFixture();
    const build = (): string =>
      resolvePart(
        withSolids(
          fixture.document,
          shapedExtrude('extrude-1', fixture.faceA, { taperAngle: '5', thickness: '2' }),
        ),
      ).steps[0].key;
    expect(build()).toBe(build());
  });

  it('両側へ 20 なら断面が 10 手前へ動き、前後 10 / 10 の形になる', () => {
    const fixture = createFixture();
    const document = withSolids(
      fixture.document,
      shapedExtrude('extrude-1', fixture.faceA, { distance: '20', end: { kind: 'symmetric' } }),
    );
    const plan = extrudePlan(resolvePart(document).steps[0]);
    // 断面を距離の半分だけ逆向きへ動かすのは model の役目(§0.a-0.8)なので、
    // 段は「前へ 10・後ろへ 10」を平行移動と長さ 20 で表す(end は載せない)。
    expect(segmentEnds(plan.profile)).toEqual(rectangleEnds(-10));
    expect(plan.distance).toBe(20);
    expect(plan.end).toBeUndefined();
  });

  it('end が正本: 旧 symmetric と end.symmetric は同じ段になる', () => {
    const fixture = createFixture();
    const keyOf = (feature: ExtrudeFeature): string =>
      resolvePart(withSolids(fixture.document, feature)).steps[0].key;
    expect(keyOf(shapedExtrude('extrude-1', fixture.faceA, { end: { kind: 'symmetric' } }))).toBe(
      keyOf(extrudeFeature('extrude-1', fixture.faceA, { symmetric: true })),
    );
  });

  it('end が正本: 旧 symmetric が真でも end が距離なら片側へ出す', () => {
    const fixture = createFixture();
    const document = withSolids(
      fixture.document,
      shapedExtrude('extrude-1', fixture.faceA, { symmetric: true, end: { kind: 'distance' } }),
    );
    expect(segmentEnds(extrudePlan(resolvePart(document).steps[0]).profile)).toEqual(
      rectangleEnds(0),
    );
  });

  it('選んだ面まで: 同じ箱の上面(z = 10)までの距離 10 を model が計算する', () => {
    const fixture = createFixture();
    const document = withSolids(
      fixture.document,
      extrudeFeature('extrude-1', fixture.faceA),
      shapedExtrude('extrude-2', fixture.faceA, {
        end: { kind: 'toFace', face: topFaceRef('extrude-1') },
      }),
    );
    const result = resolvePart(document);
    const plan = extrudePlan(result.steps[1]);
    expect(plan.end).toEqual({ kind: 'toFace', distance: 10 });
    expect(plan.distance).toBe(10);
    // 面を借りるだけで消費しないので、もとの箱は画面に残る(§0.a-0.33)。
    expect(result.liveBodyIds).toEqual(['extrude-1', 'extrude-2']);
  });

  it('選んだ面まで: 面が押し出す向きの後ろ側なら断る(FR-504)', () => {
    const fixture = createFixture();
    const document = withSolids(
      fixture.document,
      extrudeFeature('extrude-1', fixture.faceA),
      shapedExtrude('extrude-2', fixture.faceA, {
        reversed: true,
        end: { kind: 'toFace', face: topFaceRef('extrude-1') },
      }),
    );
    const result = resolvePart(document);
    expect(result.steps).toHaveLength(1);
    expect(result.errors[0].code).toBe('invalidValue');
    expect(result.errors[0].message).toContain('向きの先');
  });

  it('選んだ面まで: 向きと面が平行なら断る', () => {
    const fixture = createFixture();
    const document = withSolids(
      fixture.document,
      extrudeFeature('extrude-1', fixture.faceA),
      shapedExtrude('extrude-2', fixture.faceA, {
        end: { kind: 'toFace', face: sideFaceRef('extrude-1') },
      }),
    );
    const result = resolvePart(document);
    expect(result.errors[0].code).toBe('degenerate');
    expect(result.errors[0].message).toContain('平行');
  });

  it('選んだ面まで: 平らでない面は断る', () => {
    const fixture = createFixture();
    const document = withSolids(
      fixture.document,
      extrudeFeature('extrude-1', fixture.faceA),
      shapedExtrude('extrude-2', fixture.faceA, {
        end: { kind: 'toFace', face: cylinderFaceRef('extrude-1') },
      }),
    );
    const result = resolvePart(document);
    expect(result.errors[0].code).toBe('degenerate');
    expect(result.errors[0].message).toContain('平らな面');
  });

  it('選んだ面が動けば距離も鍵も変わる(NFR-PF-3)', () => {
    const fixture = createFixture();
    const build = (z: number): ResolvedSolidStep => {
      const face = topFaceRef('extrude-1');
      const document = withSolids(
        fixture.document,
        extrudeFeature('extrude-1', fixture.faceA),
        shapedExtrude('extrude-2', fixture.faceA, {
          end: {
            kind: 'toFace',
            face: { ...face, fingerprint: { ...face.fingerprint, position: [20, 15, z] } },
          },
        }),
      );
      return resolvePart(document).steps[1];
    };
    expect(extrudePlan(build(20)).distance).toBe(20);
    expect(build(20).key).not.toBe(build(10).key);
  });

  it('次の面まで: 直前の生きた立体の鍵を持ち、その立体は消費しない', () => {
    const fixture = createFixture();
    const document = withSolids(
      fixture.document,
      extrudeFeature('extrude-1', fixture.faceA),
      shapedExtrude('extrude-2', fixture.faceB, { end: { kind: 'toNext' } }),
    );
    const result = resolvePart(document);
    const plan = extrudePlan(result.steps[1]);
    expect(plan.end).toEqual({ kind: 'toNext' });
    expect(plan.targetKey).toBe(result.steps[0].key);
    expect(result.liveBodyIds).toEqual(['extrude-1', 'extrude-2']);
  });

  it('次の面まで: 相手にできる立体が無ければ断る(文言はカーネルと同じ)', () => {
    const fixture = createFixture();
    const document = withSolids(
      fixture.document,
      shapedExtrude('extrude-1', fixture.faceA, { end: { kind: 'toNext' } }),
    );
    const result = resolvePart(document);
    expect(result.steps).toEqual([]);
    expect(result.errors[0].code).toBe('missingBody');
    expect(result.errors[0].message).toBe('押し出す先に立体がありません。');
  });

  it('テーパ 5 度は 5π/180 ラジアンで段に乗る', () => {
    const fixture = createFixture();
    const document = withSolids(
      fixture.document,
      shapedExtrude('extrude-1', fixture.faceA, { taperAngle: '5', taperOutward: true }),
    );
    const plan = extrudePlan(resolvePart(document).steps[0]);
    expect(plan.taperAngle).toBeCloseTo(FIVE_DEGREES_IN_RADIANS, 12);
    expect(plan.taperOutward).toBe(true);
  });

  it('テーパ 61 度は断る(上限は抜き勾配と同じ 60 度、§0.a-0.72)', () => {
    const fixture = createFixture();
    const document = withSolids(
      fixture.document,
      shapedExtrude('extrude-1', fixture.faceA, { taperAngle: '61' }),
    );
    const result = resolvePart(document);
    expect(result.steps).toEqual([]);
    expect(result.errors[0].code).toBe('invalidValue');
    expect(result.errors[0].message).toContain('60 度以下');
  });

  it('テーパの向きだけを変えても、角が 0 なら同じ鍵(形が同じだから)', () => {
    const fixture = createFixture();
    const keyOf = (taperOutward: boolean): string =>
      resolvePart(
        withSolids(
          fixture.document,
          shapedExtrude('extrude-1', fixture.faceA, { taperAngle: '0', taperOutward }),
        ),
      ).steps[0].key;
    expect(keyOf(true)).toBe(keyOf(false));
  });

  it('薄板 2mm・内側は thin として段に乗り、向きが変われば鍵も変わる', () => {
    const fixture = createFixture();
    const build = (thicknessSide: ThicknessSide): ResolvedSolidStep =>
      resolvePart(
        withSolids(
          fixture.document,
          shapedExtrude('extrude-1', fixture.faceA, { thickness: '2', thicknessSide }),
        ),
      ).steps[0];
    expect(extrudePlan(build('inner')).thin).toEqual({ thickness: 2, side: 'inner' });
    expect(build('outer').key).not.toBe(build('inner').key);
  });

  it('薄板の厚みが 0 なら断る', () => {
    const fixture = createFixture();
    const document = withSolids(
      fixture.document,
      shapedExtrude('extrude-1', fixture.faceA, { thickness: '0' }),
    );
    const result = resolvePart(document);
    expect(result.errors[0].code).toBe('invalidValue');
    expect(result.errors[0].message).toContain('0 より大きい');
  });
});

describe('抜き勾配(FR-417)', () => {
  /** 箱 1 つと、その側面を傾ける抜き勾配 1 つを持つ文書。 */
  function draftDocument(options: DraftOptions = {}): PartDocument {
    const fixture = createFixture();
    return withSolids(
      fixture.document,
      extrudeFeature('extrude-1', fixture.faceA),
      draftFeature('draft-1', 'extrude-1', options),
    );
  }

  it('傾ける面と中立面の指紋が段に乗り、角度はラジアンになる', () => {
    const result = resolvePart(draftDocument({ angle: '5', reversed: true }));
    const plan = draftPlan(result.steps[1]);
    expect(plan.targetKey).toBe(result.steps[0].key);
    expect(plan.faces).toEqual([sideFaceRef('extrude-1')]);
    expect(plan.neutralFace).toEqual(topFaceRef('extrude-1'));
    expect(plan.angle).toBeCloseTo(FIVE_DEGREES_IN_RADIANS, 12);
    expect(plan.reversed).toBe(true);
  });

  it('対象を消費するので、残るのは傾けた立体だけ', () => {
    expect(resolvePart(draftDocument()).liveBodyIds).toEqual(['draft-1']);
  });

  it('傾ける面は通し番号の昇順に並べ、同じ面を 2 度選んでも 1 度だけ渡す', () => {
    const faces = [
      sideFaceRef('extrude-1', 3),
      sideFaceRef('extrude-1', 1),
      sideFaceRef('extrude-1', 3),
    ];
    const plan = draftPlan(resolvePart(draftDocument({ faces })).steps[1]);
    expect(plan.faces.map((face) => face.index)).toEqual([1, 3]);
  });

  it('角度が 61 度なら断る(上限 60 度、§0.a-0.72)', () => {
    const result = resolvePart(draftDocument({ angle: '61' }));
    expect(result.errors[0].code).toBe('invalidValue');
    expect(result.errors[0].message).toContain('60 度以下');
  });

  it('角度が 0 なら断る(傾かない)', () => {
    const result = resolvePart(draftDocument({ angle: '0' }));
    expect(result.errors[0].code).toBe('invalidValue');
  });

  it('面を 1 つも指していなければ断る', () => {
    const result = resolvePart(draftDocument({ faces: [] }));
    expect(result.errors[0].code).toBe('missingSubShape');
  });

  it('面でないもの(辺)を指したら断る', () => {
    const result = resolvePart(draftDocument({ faces: [edgeRef('extrude-1')] }));
    expect(result.errors[0].code).toBe('invalidValue');
    expect(result.errors[0].message).toContain('面だけ');
  });

  it('別の立体の面を指したら断る(カーネルは対象の中から選び直すため)', () => {
    const result = resolvePart(draftDocument({ faces: [sideFaceRef('extrude-9')] }));
    expect(result.errors[0].code).toBe('invalidValue');
    expect(result.errors[0].message).toContain('もとの立体の面');
  });

  it('中立面が平らでなければ断る', () => {
    const result = resolvePart(draftDocument({ neutralFace: cylinderFaceRef('extrude-1') }));
    expect(result.errors[0].code).toBe('degenerate');
    expect(result.errors[0].message).toContain('平らな面');
  });
});

describe('ミラー(FR-419)', () => {
  function mirrorDocument(plane?: MirrorPlane): PartDocument {
    const fixture = createFixture();
    return withSolids(
      fixture.document,
      extrudeFeature('extrude-1', fixture.faceA),
      plane === undefined
        ? mirrorFeature('mirror-1', 'extrude-1')
        : mirrorFeature('mirror-1', 'extrude-1', plane),
    );
  }

  it('基準の XY 面は「原点を通る +Z 法線の平面」になる', () => {
    const result = resolvePart(mirrorDocument());
    const plan = mirrorPlan(result.steps[1]);
    expect(plan.origin).toEqual([0, 0, 0]);
    expect(plan.normal).toEqual([0, 0, 1]);
    expect(plan.targetKey).toBe(result.steps[0].key);
  });

  it('立体の平らな面を鏡にすると、面の重心と法線が段に乗る', () => {
    const document = mirrorDocument({ kind: 'face', face: topFaceRef('extrude-1') });
    const plan = mirrorPlan(resolvePart(document).steps[1]);
    expect(plan.origin).toEqual([20, 15, 10]);
    expect(plan.normal).toEqual([0, 0, 1]);
  });

  it('対象を消費しないので、元と鏡像の両方が残る(§0.a-0.36)', () => {
    expect(resolvePart(mirrorDocument()).liveBodyIds).toEqual(['extrude-1', 'mirror-1']);
  });

  it('鏡にする面が平らでなければ断る', () => {
    const document = mirrorDocument({ kind: 'face', face: cylinderFaceRef('extrude-1') });
    const result = resolvePart(document);
    expect(result.errors[0].code).toBe('degenerate');
    expect(result.errors[0].message).toContain('平らな面');
  });

  it('鏡にできるのは面だけ(辺を指したら断る)', () => {
    const document = mirrorDocument({ kind: 'face', face: edgeRef('extrude-1') });
    const result = resolvePart(document);
    expect(result.errors[0].code).toBe('invalidValue');
  });

  it('鏡に映すもとの立体が無ければ断る', () => {
    const fixture = createFixture();
    const document = withSolids(fixture.document, mirrorFeature('mirror-1', 'extrude-9'));
    const result = resolvePart(document);
    expect(result.steps).toEqual([]);
    expect(result.errors[0].code).toBe('missingBody');
  });

  it('元を伸ばすと鏡像の鍵も変わる(消費しないが targetKey を混ぜる、NFR-PF-3)', () => {
    const fixture = createFixture();
    const build = (distance: string): string =>
      resolvePart(
        withSolids(
          fixture.document,
          extrudeFeature('extrude-1', fixture.faceA, { distance }),
          mirrorFeature('mirror-1', 'extrude-1'),
        ),
      ).steps[1].key;
    expect(build('20')).not.toBe(build('10'));
  });
});

describe('移動/回転と拡大縮小(FR-424)', () => {
  function transformDocument(options: TransformOptions = {}): PartDocument {
    const fixture = createFixture();
    return withSolids(
      fixture.document,
      extrudeFeature('extrude-1', fixture.faceA),
      transformFeature('transform-1', 'extrude-1', options),
    );
  }

  function scaleDocument(factor: ScaleFactor, origin?: PointReference): PartDocument {
    const fixture = createFixture();
    return withSolids(
      fixture.document,
      extrudeFeature('extrude-1', fixture.faceA),
      origin === undefined
        ? scaleFeature('scale-1', 'extrude-1', factor)
        : scaleFeature('scale-1', 'extrude-1', factor, origin),
    );
  }

  it('平行移動だけなら、回転角 0 の剛体変換になる', () => {
    const plan = transformPlan(
      resolvePart(transformDocument({ translation: ['10', '0', '0'] })).steps[1],
    );
    expect(plan.translation).toEqual([10, 0, 0]);
    expect(plan.rotationAngle).toBe(0);
  });

  it('回転 90 度は π/2 ラジアンで、軸の原点と向きが段に乗る', () => {
    const plan = transformPlan(
      resolvePart(
        transformDocument({ rotationAxis: { kind: 'world', axis: 'z' }, rotationAngle: '90' }),
      ).steps[1],
    );
    expect(plan.rotationAngle).toBeCloseTo(NINETY_DEGREES_IN_RADIANS, 12);
    expect(plan.rotationOrigin).toEqual([0, 0, 0]);
    expect(plan.rotationAxis).toEqual([0, 0, 1]);
  });

  it('移動/回転は対象を消費するので、残るのは動かした立体だけ', () => {
    expect(resolvePart(transformDocument()).liveBodyIds).toEqual(['transform-1']);
  });

  it('移動の量が数でなければ断る', () => {
    const fixture = createFixture();
    const feature = transformFeature('transform-1', 'extrude-1');
    const document = withSolids(fixture.document, extrudeFeature('extrude-1', fixture.faceA), {
      ...feature,
      translation: [notANumber('1 +'), expr('0'), expr('0')],
    });
    const result = resolvePart(document);
    expect(result.errors[0].code).toBe('invalidValue');
  });

  it('回転の軸が引けなければ断る', () => {
    const result = resolvePart(
      transformDocument({
        rotationAxis: { kind: 'line', line: { sketchId: 'sketch-9', lineFeatureId: 'line-9' } },
        rotationAngle: '90',
      }),
    );
    expect(result.errors[0].code).toBe('missingProfile');
  });

  it('全体の倍率は uniform だけに入る(perAxis は null)', () => {
    const plan = scalePlan(resolvePart(scaleDocument(uniformFactor('2'))).steps[1]);
    expect(plan.uniform).toBe(2);
    expect(plan.perAxis).toBeNull();
    expect(plan.origin).toEqual([0, 0, 0]);
  });

  it('軸ごとの倍率が 3 つとも同じなら全体の倍率へ正規化する(同じ形に鍵を 2 つ作らない)', () => {
    const plan = scalePlan(resolvePart(scaleDocument(perAxisFactor('2', '2', '2'))).steps[1]);
    expect(plan.uniform).toBe(2);
    expect(plan.perAxis).toBeNull();
    expect(resolvePart(scaleDocument(perAxisFactor('2', '2', '2'))).steps[1].key).toBe(
      resolvePart(scaleDocument(uniformFactor('2'))).steps[1].key,
    );
  });

  it('軸ごとの倍率が違えば perAxis のまま段に乗る', () => {
    const plan = scalePlan(resolvePart(scaleDocument(perAxisFactor('2', '3', '4'))).steps[1]);
    expect(plan.uniform).toBeNull();
    expect(plan.perAxis).toEqual([2, 3, 4]);
  });

  it('倍率 0 は断る(文言に「0 より大きい」)', () => {
    const result = resolvePart(scaleDocument(uniformFactor('0')));
    expect(result.steps).toHaveLength(1);
    expect(result.errors[0].code).toBe('invalidValue');
    expect(result.errors[0].message).toContain('0 より大きい');
  });

  it('倍率 1001 は断る(上限 1000)', () => {
    const result = resolvePart(scaleDocument(uniformFactor('1001')));
    expect(result.errors[0].code).toBe('invalidValue');
    expect(result.errors[0].message).toContain('1000 以下');
  });

  it('軸ごとの倍率の 1 つが範囲の外なら断る', () => {
    const result = resolvePart(scaleDocument(perAxisFactor('2', '0', '2')));
    expect(result.errors[0].code).toBe('invalidValue');
  });

  it('中心にする点が引けなければ断る', () => {
    const result = resolvePart(
      scaleDocument(uniformFactor('2'), { kind: 'point', pointId: 'point-404' }),
    );
    expect(result.errors[0].code).toBe('missingProfile');
  });

  it('拡大縮小は対象を消費するので、残るのは拡大縮小した立体だけ', () => {
    expect(resolvePart(scaleDocument(uniformFactor('2'))).liveBodyIds).toEqual(['scale-1']);
  });
});

/* ------------------------------------------------------------------ *
 * P5 タスク46: スイープ(FR-409)・リブ(FR-420)・エンボス(FR-421)・
 * ざぐり/皿もみ(FR-422)・外ねじ(FR-423)・点集合パターン(FR-425)・
 * 曲面(FR-428)・くり抜き(FR-418)・可変半径フィレット(FR-426)
 * ------------------------------------------------------------------ */

/** 線分フィーチャーを 1 本足す。作図面を変えられるのは「輪郭の平面」の検査のため。 */
function addLine(
  sketch: SketchDocument,
  from: readonly [number, number, number],
  to: readonly [number, number, number],
  planeId: WorkPlaneId = DEFAULT_WORK_PLANE_ID,
): { readonly sketch: SketchDocument; readonly id: string } {
  const line: SketchLineFeature = {
    id: nextFeatureId(sketch, 'line'),
    name: nextFeatureName(sketch, 'line'),
    planeId,
    kind: 'line',
    from: absoluteCoordinate(from[0], from[1], from[2]),
    to: absoluteCoordinate(to[0], to[1], to[2]),
    construction: false,
  };
  return { sketch: appendFeature(sketch, line), id: line.id };
}

interface CurveFixture {
  readonly document: PartDocument;
  readonly faceA: SketchFaceRef;
  readonly faceB: SketchFaceRef;
  readonly brokenFace: SketchFaceRef;
  readonly sketchId: string;
  /** (0,0,0) → (0,0,50) の線分。スイープの経路に使う。 */
  readonly path: SketchCurveRef;
  /** (10,10,20) → (30,10,20) の線分(XY 面)。リブ・曲面の輪郭に使う。 */
  readonly flat: SketchCurveRef;
  /** (0,15,30) → (40,15,30) の線分(XZ 面)。リブの伸ばす向きの検査に使う。 */
  readonly upright: SketchCurveRef;
  /** 上と同じ線を逆向きにかいたもの。かいた順で向きが変わらないことの検査に使う。 */
  readonly uprightReversed: SketchCurveRef;
  /** 実在しない曲線 id を指す参照。 */
  readonly missing: SketchCurveRef;
  /** 曲線 id が空の参照(道筋を 1 本も選んでいない)。 */
  readonly empty: SketchCurveRef;
}

function curveFixture(): CurveFixture {
  const fixture = createFixture();
  const base = fixture.document.sketches[0];
  const path = addLine(base, [0, 0, 0], [0, 0, 50]);
  const flat = addLine(path.sketch, [10, 10, 20], [30, 10, 20]);
  const upright = addLine(flat.sketch, [0, 15, 30], [40, 15, 30], 'xz');
  const uprightReversed = addLine(upright.sketch, [40, 15, 30], [0, 15, 30], 'xz');
  const sketch = uprightReversed.sketch;
  const sketchId = sketch.id;
  return {
    document: replaceSketch(fixture.document, sketch),
    faceA: fixture.faceA,
    faceB: fixture.faceB,
    brokenFace: fixture.brokenFace,
    sketchId,
    path: { sketchId, curveIds: [path.id] },
    flat: { sketchId, curveIds: [flat.id] },
    upright: { sketchId, curveIds: [upright.id] },
    uprightReversed: { sketchId, curveIds: [uprightReversed.id] },
    missing: { sketchId, curveIds: ['line-404'] },
    empty: { sketchId, curveIds: [] },
  };
}

function sweepPlan(step: ResolvedSolidStep): Extract<ResolvedSolidStep['plan'], { kind: 'sweep' }> {
  if (step.plan.kind !== 'sweep') {
    throw new Error(`テストの前提が壊れている: スイープでない段 ${step.plan.kind}`);
  }
  return step.plan;
}

function ribPlan(step: ResolvedSolidStep): Extract<ResolvedSolidStep['plan'], { kind: 'rib' }> {
  if (step.plan.kind !== 'rib') {
    throw new Error(`テストの前提が壊れている: リブでない段 ${step.plan.kind}`);
  }
  return step.plan;
}

function embossPlan(
  step: ResolvedSolidStep,
): Extract<ResolvedSolidStep['plan'], { kind: 'emboss' }> {
  if (step.plan.kind !== 'emboss') {
    throw new Error(`テストの前提が壊れている: エンボスでない段 ${step.plan.kind}`);
  }
  return step.plan;
}

function threadShaftPlan(
  step: ResolvedSolidStep,
): Extract<ResolvedSolidStep['plan'], { kind: 'threadShaft' }> {
  if (step.plan.kind !== 'threadShaft') {
    throw new Error(`テストの前提が壊れている: 外ねじでない段 ${step.plan.kind}`);
  }
  return step.plan;
}

function surfacePlan(
  step: ResolvedSolidStep,
): Extract<ResolvedSolidStep['plan'], { kind: 'surface' }> {
  if (step.plan.kind !== 'surface') {
    throw new Error(`テストの前提が壊れている: 曲面でない段 ${step.plan.kind}`);
  }
  return step.plan;
}

function cutPlan(step: ResolvedSolidStep): Extract<ResolvedSolidStep['plan'], { kind: 'cut' }> {
  if (step.plan.kind !== 'cut') {
    throw new Error(`テストの前提が壊れている: 切断でない段 ${step.plan.kind}`);
  }
  return step.plan;
}

/** 座標を成分ごとに照合する(小数の下位の揺れを許す)。 */
function expectVec3(actual: Vec3, expected: Vec3): void {
  actual.forEach((value, index) => {
    expect(value).toBeCloseTo(expected[index], 9);
  });
}

function shellPlan(step: ResolvedSolidStep): Extract<ResolvedSolidStep['plan'], { kind: 'shell' }> {
  if (step.plan.kind !== 'shell') {
    throw new Error(`テストの前提が壊れている: くり抜きでない段 ${step.plan.kind}`);
  }
  return step.plan;
}

/**
 * 外ねじを切る円柱面の指紋(P5 タスク46)。**半径を引数に取る**ところだけが既にある
 * `cylinderFaceRef` と違う——呼び径と軸の実寸の食い違い(§0.a-0.85)を作るのに要る。
 */
function threadFaceRef(bodyFeatureId: string, radius: number): SubShapeRef {
  return {
    bodyFeatureId,
    index: 3,
    fingerprint: {
      kind: 'face',
      surfaceKind: 'cylinder',
      area: 628.3185307179587,
      position: [0, 0, 10],
      axis: [0, 0, 1],
      radius,
    },
  };
}

describe('スイープ(FR-409、P5 タスク46)', () => {
  function sweepFeature(
    id: string,
    profile: SketchFaceRef,
    path: SketchCurveRef,
    frenet = false,
  ): SweepFeature {
    return { id, name: id, suppressed: false, kind: 'sweep', profile, path, frenet };
  }

  it('断面の輪郭と経路の曲線が段に乗る', () => {
    const fixture = curveFixture();
    const document = withSolids(
      fixture.document,
      sweepFeature('sweep-1', fixture.faceA, fixture.path),
    );
    const result = resolvePart(document);
    expect(result.errors).toEqual([]);
    const plan = sweepPlan(result.steps[0]);
    expect(segmentEnds(plan.profile)).toEqual(rectangleEnds(0));
    expect(segmentEnds(plan.path)).toEqual([
      [
        [0, 0, 0],
        [0, 0, 50],
      ],
    ]);
    expect(plan.frenet).toBe(false);
  });

  it('Frenet のつまみがそのまま段に乗る', () => {
    const fixture = curveFixture();
    const plan = sweepPlan(
      resolvePart(
        withSolids(fixture.document, sweepFeature('sweep-1', fixture.faceA, fixture.path, true)),
      ).steps[0],
    );
    expect(plan.frenet).toBe(true);
  });

  it('経路が空なら断る(文言に「道筋」)', () => {
    const fixture = curveFixture();
    const result = resolvePart(
      withSolids(fixture.document, sweepFeature('sweep-1', fixture.faceA, fixture.empty)),
    );
    expect(result.steps).toEqual([]);
    expect(result.errors[0].code).toBe('missingProfile');
    expect(result.errors[0].message).toContain('道筋');
  });

  it('経路の曲線が見つからなければ断る', () => {
    const fixture = curveFixture();
    const result = resolvePart(
      withSolids(fixture.document, sweepFeature('sweep-1', fixture.faceA, fixture.missing)),
    );
    expect(result.errors[0].code).toBe('missingProfile');
    expect(result.errors[0].message).toContain('道筋');
  });

  it('断面が見つからなければ断る(文言は「掃くもとの面」)', () => {
    const fixture = curveFixture();
    const result = resolvePart(
      withSolids(fixture.document, sweepFeature('sweep-1', fixture.brokenFace, fixture.path)),
    );
    expect(result.errors.some((error) => error.message.includes('掃くもとの面'))).toBe(true);
  });

  it('スイープは対象を取らないので、先に作った立体はそのまま残る', () => {
    const fixture = curveFixture();
    const document = withSolids(
      fixture.document,
      extrudeFeature('extrude-1', fixture.faceA),
      sweepFeature('sweep-1', fixture.faceA, fixture.path),
    );
    expect(resolvePart(document).liveBodyIds).toEqual(['extrude-1', 'sweep-1']);
    expect(consumedTargetsOf(sweepFeature('sweep-1', fixture.faceA, fixture.path))).toEqual([]);
  });

  it('同じ入力なら同じ鍵、経路を変えれば違う鍵(NFR-PF-3)', () => {
    const fixture = curveFixture();
    const build = (path: SketchCurveRef): string =>
      resolvePart(withSolids(fixture.document, sweepFeature('sweep-1', fixture.faceA, path)))
        .steps[0].key;
    expect(build(fixture.path)).toBe(build(fixture.path));
    expect(build(fixture.flat)).not.toBe(build(fixture.path));
  });
});

describe('リブ(FR-420、P5 タスク46)', () => {
  interface RibOptions {
    readonly thickness?: string;
    readonly side?: RibSide;
    readonly extendToBody?: boolean;
  }

  function ribFeature(
    id: string,
    targetFeatureId: string,
    profile: SketchCurveRef,
    options: RibOptions = {},
  ): RibFeature {
    return {
      id,
      name: id,
      suppressed: false,
      kind: 'rib',
      targetFeatureId,
      profile,
      thickness: expr(options.thickness ?? '3'),
      side: options.side ?? 'both',
      extendToBody: options.extendToBody ?? true,
    };
  }

  function ribDocument(profile: SketchCurveRef, options: RibOptions = {}): PartDocument {
    const fixture = curveFixture();
    return withSolids(
      fixture.document,
      extrudeFeature('extrude-1', fixture.faceA),
      ribFeature('rib-1', 'extrude-1', profile, options),
    );
  }

  it('輪郭・厚み・法線・両側が段に乗る(法線は作図面から)', () => {
    const fixture = curveFixture();
    const result = resolvePart(ribDocument(fixture.flat));
    expect(result.errors).toEqual([]);
    const plan = ribPlan(result.steps[1]);
    expect(segmentEnds(plan.profile)).toEqual([
      [
        [10, 10, 20],
        [30, 10, 20],
      ],
    ]);
    expect(plan.thickness).toBe(3);
    expect(plan.normal).toEqual([0, 0, 1]);
    expect(plan.symmetric).toBe(true);
    expect(plan.direction).toEqual([0, 1, 0]);
    expect(plan.extendToBody).toBe(true);
  });

  it('「材料まで伸ばす」を省略すると既定で true が段に乗る(42c でカーネルの段に欄が増えた)', () => {
    const fixture = curveFixture();
    const feature = ribFeature('rib-1', 'extrude-1', fixture.flat);
    expect(feature.extendToBody).toBe(true);
    const plan = ribPlan(resolvePart(ribDocument(fixture.flat)).steps[1]);
    expect(plan.extendToBody).toBe(true);
  });

  it('片側(positive)は両側にしない', () => {
    const fixture = curveFixture();
    const plan = ribPlan(resolvePart(ribDocument(fixture.flat, { side: 'positive' })).steps[1]);
    expect(plan.symmetric).toBe(false);
    expect(plan.normal).toEqual([0, 0, 1]);
  });

  it('片側(negative)は法線を裏返して片側にする', () => {
    const fixture = curveFixture();
    const plan = ribPlan(resolvePart(ribDocument(fixture.flat, { side: 'negative' })).steps[1]);
    expect(plan.symmetric).toBe(false);
    expect(plan.normal).toEqual([0, 0, -1]);
  });

  it('伸ばす向きは、輪郭をかいた順に関わらず下を向く', () => {
    const fixture = curveFixture();
    const forward = ribPlan(resolvePart(ribDocument(fixture.upright)).steps[1]);
    const backward = ribPlan(resolvePart(ribDocument(fixture.uprightReversed)).steps[1]);
    expect(forward.direction).toEqual([0, 0, -1]);
    expect(backward.direction).toEqual([0, 0, -1]);
  });

  it('厚み 0 は断る(文言に「0 より大きい」)', () => {
    const fixture = curveFixture();
    const result = resolvePart(ribDocument(fixture.flat, { thickness: '0' }));
    expect(result.steps).toHaveLength(1);
    expect(result.errors[0].code).toBe('invalidValue');
    expect(result.errors[0].message).toContain('0 より大きい');
  });

  it('輪郭が見つからなければ断る', () => {
    const fixture = curveFixture();
    const result = resolvePart(ribDocument(fixture.missing));
    expect(result.errors[0].code).toBe('missingProfile');
    expect(result.errors[0].message).toContain('リブの輪郭');
  });

  it('「材料まで伸ばす」を切ったリブは、段の extendToBody === false で作れる(42c でカーネルの段に欄が増えた)', () => {
    const fixture = curveFixture();
    const result = resolvePart(ribDocument(fixture.flat, { extendToBody: false }));
    expect(result.errors).toEqual([]);
    expect(ribPlan(result.steps[1]).extendToBody).toBe(false);
  });

  it('リブは対象を消費するので、残るのはリブを足した立体だけ', () => {
    const fixture = curveFixture();
    expect(resolvePart(ribDocument(fixture.flat)).liveBodyIds).toEqual(['rib-1']);
  });

  it('厚みを変えれば鍵が変わり、同じ入力なら同じ鍵', () => {
    const fixture = curveFixture();
    const build = (thickness: string): string =>
      resolvePart(ribDocument(fixture.flat, { thickness })).steps[1].key;
    expect(build('3')).toBe(build('3'));
    expect(build('4')).not.toBe(build('3'));
  });
});

describe('エンボス(FR-421、P5 タスク46)', () => {
  interface EmbossOptions {
    readonly face?: SubShapeRef;
    readonly height?: string;
    readonly raised?: boolean;
  }

  function embossFeature(
    id: string,
    targetFeatureId: string,
    profile: SketchFaceRef,
    options: EmbossOptions = {},
  ): EmbossFeature {
    return {
      id,
      name: id,
      suppressed: false,
      kind: 'emboss',
      targetFeatureId,
      face: options.face ?? topFaceRef(targetFeatureId),
      profile,
      height: expr(options.height ?? '2'),
      raised: options.raised ?? false,
    };
  }

  function embossDocument(options: EmbossOptions = {}): PartDocument {
    const fixture = createFixture();
    return withSolids(
      fixture.document,
      extrudeFeature('extrude-1', fixture.faceA),
      embossFeature('emboss-1', 'extrude-1', fixture.faceB, options),
    );
  }

  it('面の指紋・輪郭・深さ・彫るかどうかが段に乗る', () => {
    const result = resolvePart(embossDocument());
    expect(result.errors).toEqual([]);
    const plan = embossPlan(result.steps[1]);
    expect(plan.face).toEqual(topFaceRef('extrude-1'));
    expect(plan.profiles).toHaveLength(1);
    expect(segmentEnds(plan.profiles[0])).toEqual(rectangleEnds(10));
    expect(plan.depth).toBe(2);
    expect(plan.raised).toBe(false);
    expect(plan.targetKey).toBe(result.steps[0].key);
  });

  it('浮き出す指定がそのまま段に乗る', () => {
    const plan = embossPlan(resolvePart(embossDocument({ raised: true })).steps[1]);
    expect(plan.raised).toBe(true);
  });

  it('別のボディの面を指したら断る', () => {
    const result = resolvePart(embossDocument({ face: topFaceRef('extrude-9') }));
    expect(result.errors[0].code).toBe('invalidValue');
    expect(result.errors[0].message).toContain('もとの立体の面');
  });

  it('面でないもの(辺)を指したら断る', () => {
    const result = resolvePart(embossDocument({ face: edgeRef('extrude-1') }));
    expect(result.errors[0].code).toBe('invalidValue');
    expect(result.errors[0].message).toContain('面だけ');
  });

  it('高さ 0 は断る', () => {
    const result = resolvePart(embossDocument({ height: '0' }));
    expect(result.errors[0].code).toBe('invalidValue');
    expect(result.errors[0].message).toContain('0 より大きい');
  });

  it('エンボスは対象を消費するので、残るのは彫った立体だけ', () => {
    expect(resolvePart(embossDocument()).liveBodyIds).toEqual(['emboss-1']);
  });
});

describe('ざぐり・皿もみ(FR-422、P5 タスク46)', () => {
  function holeDocument(entry: HoleEntry | undefined, diameter = '6'): PartDocument {
    const fixture = createFixture();
    const hole = holeFeature('hole-1', 'extrude-1', [fixture.pointA], { diameter });
    return withSolids(
      fixture.document,
      extrudeFeature('extrude-1', fixture.faceA),
      entry === undefined ? hole : { ...hole, entry },
    );
  }

  it('ざぐり(径 11・深さ 4)が段に乗る', () => {
    const result = resolvePart(
      holeDocument({ kind: 'counterbore', diameter: expr('11'), depth: expr('4') }),
    );
    expect(result.errors).toEqual([]);
    const plan = holePlan(result.steps[1]);
    expect(plan.entry).toEqual({ kind: 'counterbore', diameter: 11, depth: 4 });
  });

  it('皿もみ(頭径 12・角度 90 度)はラジアンへ直る(π/2)', () => {
    const plan = holePlan(
      resolvePart(
        holeDocument({ kind: 'countersink', diameter: expr('12'), angle: expr('90') }),
      ).steps[1],
    );
    expect(plan.entry).toEqual({
      kind: 'countersink',
      diameter: 12,
      angle: 1.5707963267948966,
    });
  });

  it('皿もみの深さは段に載せない(カーネルが角度と径から出す)', () => {
    const plan = holePlan(
      resolvePart(
        holeDocument({ kind: 'countersink', diameter: expr('12'), angle: expr('90') }),
      ).steps[1],
    );
    expect(plan.entry).not.toHaveProperty('depth');
  });

  it('ざぐりの径が下穴の径以下なら断る(先出し検査)', () => {
    const result = resolvePart(
      holeDocument({ kind: 'counterbore', diameter: expr('6'), depth: expr('4') }),
    );
    expect(result.steps).toHaveLength(1);
    expect(result.errors[0].code).toBe('invalidValue');
    expect(result.errors[0].message).toContain('ざぐりの径');
  });

  it('ざぐりの深さ 0 は断る', () => {
    const result = resolvePart(
      holeDocument({ kind: 'counterbore', diameter: expr('11'), depth: expr('0') }),
    );
    expect(result.errors[0].code).toBe('invalidValue');
    expect(result.errors[0].message).toContain('ざぐりの深さ');
  });

  it('皿もみの角度 0 度・180 度は断る', () => {
    const zero = resolvePart(
      holeDocument({ kind: 'countersink', diameter: expr('12'), angle: expr('0') }),
    );
    const flat = resolvePart(
      holeDocument({ kind: 'countersink', diameter: expr('12'), angle: expr('180') }),
    );
    expect(zero.errors[0].message).toContain('皿もみの角度');
    expect(flat.errors[0].message).toContain('皿もみの角度');
  });

  it('皿もみの頭径が穴の径以下なら断る', () => {
    const result = resolvePart(
      holeDocument({ kind: 'countersink', diameter: expr('6'), angle: expr('90') }),
    );
    expect(result.errors[0].message).toContain('皿もみの頭の径');
  });

  it('入口を省いた穴と「広げない」を書いた穴は、段も鍵も同じ', () => {
    const omitted = resolvePart(holeDocument(undefined));
    const plain = resolvePart(holeDocument({ kind: 'plain' }));
    expect(holePlan(omitted.steps[1])).not.toHaveProperty('entry');
    expect(holePlan(plain.steps[1])).not.toHaveProperty('entry');
    expect(plain.steps[1].key).toBe(omitted.steps[1].key);
  });

  it('ざぐりを足すと鍵が変わる(NFR-PF-3)', () => {
    const plain = resolvePart(holeDocument(undefined)).steps[1].key;
    const bored = resolvePart(
      holeDocument({ kind: 'counterbore', diameter: expr('11'), depth: expr('4') }),
    ).steps[1].key;
    expect(bored).not.toBe(plain);
  });

  it('入口を省いたねじ穴は、段に entry 欄を持たない(穴と同じ約束)', () => {
    const fixture = createFixture();
    const thread = threadHoleFeature('thread-1', 'extrude-1', [fixture.pointA]);
    const result = resolvePart(
      withSolids(fixture.document, extrudeFeature('extrude-1', fixture.faceA), thread),
    );
    expect(result.errors).toEqual([]);
    expect(threadPlan(result.steps[1])).not.toHaveProperty('entry');
  });

  it('ねじ穴のざぐり付きの段に entry が乗る(42c でカーネルの段 ThreadStepSpec に欄が増えた)', () => {
    const fixture = createFixture();
    const thread = threadHoleFeature('thread-1', 'extrude-1', [fixture.pointA]);
    const result = resolvePart(
      withSolids(fixture.document, extrudeFeature('extrude-1', fixture.faceA), {
        ...thread,
        entry: { kind: 'counterbore', diameter: expr('11'), depth: expr('4') },
      }),
    );
    expect(result.errors).toEqual([]);
    expect(threadPlan(result.steps[1]).entry).toEqual({
      kind: 'counterbore',
      diameter: 11,
      depth: 4,
    });
  });

  it('ねじ穴も、入口を足すと鍵が変わる(NFR-PF-3)', () => {
    const fixture = createFixture();
    const thread = threadHoleFeature('thread-1', 'extrude-1', [fixture.pointA]);
    const document = withSolids(fixture.document, extrudeFeature('extrude-1', fixture.faceA), thread);
    const plain = resolvePart(document).steps[1].key;
    const bored = resolvePart(
      withSolids(fixture.document, extrudeFeature('extrude-1', fixture.faceA), {
        ...thread,
        entry: { kind: 'counterbore', diameter: expr('11'), depth: expr('4') },
      }),
    ).steps[1].key;
    expect(bored).not.toBe(plain);
  });
});

describe('外ねじ(FR-423、P5 タスク46)', () => {
  interface ThreadShaftOptions {
    readonly face?: SubShapeRef;
    readonly nominal?: string;
    readonly pitch?: string;
    readonly length?: string;
    readonly fromEnd?: 'first' | 'last';
    readonly modeled?: boolean;
  }

  function threadShaftFeature(
    id: string,
    targetFeatureId: string,
    options: ThreadShaftOptions = {},
  ): ThreadShaftFeature {
    return {
      id,
      name: id,
      suppressed: false,
      kind: 'threadShaft',
      targetFeatureId,
      face: options.face ?? threadFaceRef(targetFeatureId, 5),
      nominal: options.nominal ?? 'M10',
      series: 'coarse',
      pitch: expr(options.pitch ?? '1.5'),
      length: expr(options.length ?? '20'),
      fromEnd: options.fromEnd ?? 'first',
      modeled: options.modeled ?? false,
    };
  }

  function shaftDocument(options: ThreadShaftOptions = {}): PartDocument {
    const fixture = createFixture();
    return withSolids(
      fixture.document,
      extrudeFeature('extrude-1', fixture.faceA),
      threadShaftFeature('threadShaft-1', 'extrude-1', options),
    );
  }

  it('M10 の呼び径 10・ピッチ 1.5 が段に乗る(規格表から呼び径、文書からピッチ)', () => {
    const result = resolvePart(shaftDocument());
    expect(result.errors).toEqual([]);
    const plan = threadShaftPlan(result.steps[1]);
    expect(plan.majorDiameter).toBe(10);
    expect(plan.pitch).toBe(1.5);
    expect(plan.length).toBe(20);
    expect(plan.fromEnd).toBe('first');
    expect(plan.modeled).toBe(false);
    expect(findMetricThread('M10')?.diameter).toBe(10);
  });

  it('実らせんのつまみがそのまま段に乗る', () => {
    const plan = threadShaftPlan(resolvePart(shaftDocument({ modeled: true })).steps[1]);
    expect(plan.modeled).toBe(true);
  });

  it('呼び径と軸の実寸が食い違えば断る(φ20 の軸に M10)', () => {
    const result = resolvePart(
      shaftDocument({ face: threadFaceRef('extrude-1', 10), nominal: 'M10' }),
    );
    expect(result.steps).toHaveLength(1);
    expect(result.errors[0].code).toBe('invalidValue');
    expect(result.errors[0].message).toContain('呼び径と軸の径が合いません');
  });

  it('0.5mm までの差は通す(許容の境目)', () => {
    const inside = resolvePart(shaftDocument({ face: threadFaceRef('extrude-1', 5.2) }));
    expect(inside.errors).toEqual([]);
    const outside = resolvePart(shaftDocument({ face: threadFaceRef('extrude-1', 5.3) }));
    expect(outside.errors[0].code).toBe('invalidValue');
  });

  it('平らな面にはねじを切れない', () => {
    const result = resolvePart(shaftDocument({ face: topFaceRef('extrude-1') }));
    expect(result.errors[0].code).toBe('invalidValue');
    expect(result.errors[0].message).toContain('円柱の面');
  });

  it('別のボディの面を指したら断る', () => {
    const result = resolvePart(shaftDocument({ face: threadFaceRef('extrude-9', 5) }));
    expect(result.errors[0].code).toBe('invalidValue');
    expect(result.errors[0].message).toContain('もとの立体の面');
  });

  it('知らない呼びは断る', () => {
    const result = resolvePart(shaftDocument({ nominal: 'M99' }));
    expect(result.errors[0].code).toBe('invalidValue');
    expect(result.errors[0].message).toContain('ねじの呼び');
  });

  it('ねじ部の長さ 0 は断る', () => {
    const result = resolvePart(shaftDocument({ length: '0' }));
    expect(result.errors[0].code).toBe('invalidValue');
    expect(result.errors[0].message).toContain('ねじ部の長さ');
  });

  it('外ねじは対象を消費するので、残るのはねじを切った立体だけ', () => {
    expect(resolvePart(shaftDocument()).liveBodyIds).toEqual(['threadShaft-1']);
  });
});

describe('点の集まりへ複製(FR-425、P5 タスク46)', () => {
  /** 点 count 個を持つスケッチと、その点を使う点集合パターンの文書を作る。 */
  function pointPatternDocument(
    count = 5,
    options: { readonly missing?: boolean } = {},
  ): { readonly document: PartDocument; readonly pointIds: readonly string[] } {
    const fixture = createFixture();
    const base = fixture.document.sketches[0];
    const coordinates: (readonly [number, number, number])[] = [];
    for (let index = 0; index < count; index += 1) {
      coordinates.push([10 + index * 5, 10, 0]);
    }
    const added = addPoints(base, coordinates);
    const document = replaceSketch(fixture.document, added.sketch);
    const points: readonly PointReference[] = options.missing
      ? [{ kind: 'point', pointId: 'point-404' }]
      : added.pointIds.map((pointId): PointReference => ({ kind: 'point', pointId }));
    const centers: readonly SketchPointRef[] =
      added.pointIds.length === 0
        ? [fixture.pointA]
        : [{ sketchId: added.sketch.id, pointFeatureId: added.pointIds[0] }];
    const pattern: PatternFeature = {
      id: 'pattern-1',
      name: 'pattern-1',
      suppressed: false,
      kind: 'pattern',
      sourceFeatureId: 'hole-1',
      placement: { kind: 'points', points },
    };
    return {
      document: withSolids(
        document,
        extrudeFeature('extrude-1', fixture.faceA),
        holeFeature('hole-1', 'extrude-1', centers),
        pattern,
      ),
      pointIds: added.pointIds,
    };
  }

  it('点 5 個なら変換が 5 個できて、最初は恒等(基準は最初の点)', () => {
    const { document } = pointPatternDocument(5);
    const result = resolvePart(document);
    expect(result.errors).toEqual([]);
    const plan = holePlan(result.steps[2]);
    expect(plan.transforms).toHaveLength(5);
    expect(plan.transforms[0].translation).toEqual([0, 0, 0]);
    expect(plan.transforms[0].rotationAngle).toBe(0);
    expect(plan.transforms.map((transform) => transform.translation)).toEqual([
      [0, 0, 0],
      [5, 0, 0],
      [10, 0, 0],
      [15, 0, 0],
      [20, 0, 0],
    ]);
  });

  it('もとの穴を再解決しても消費の記録を共有しない(2026-09-04 06:10 の②)', () => {
    const { document } = pointPatternDocument(3);
    const result = resolvePart(document);
    expect(codesOf(result)).toEqual([]);
    expect(result.steps.map((step) => step.featureId)).toEqual([
      'extrude-1',
      'hole-1',
      'pattern-1',
    ]);
    expect(result.liveBodyIds).toEqual(['pattern-1']);
  });

  it('点が引けなければ断る', () => {
    const { document } = pointPatternDocument(3, { missing: true });
    const result = resolvePart(document);
    expect(result.errors.some((error) => error.message.includes('並べる点'))).toBe(true);
  });

  it('点が 1 つも選ばれていなければ断る', () => {
    const { document } = pointPatternDocument(0);
    const result = resolvePart(document);
    expect(result.errors.some((error) => error.message.includes('並べる点'))).toBe(true);
  });

  it('resolvePatternTransforms は点の解決を渡さなければ断る(既定は「引けない」)', () => {
    const outcome = resolvePatternTransforms(
      { kind: 'points', points: [{ kind: 'point', pointId: 'point-1' }] },
      [],
    );
    expect(outcome.ok).toBe(false);
  });

  it('点の解決を渡せば、最初の点を基準に平行移動が並ぶ(純関数として)', () => {
    const positions: ReadonlyMap<string, Vec3> = new Map<string, Vec3>([
      ['a', [1, 2, 3]],
      ['b', [4, 2, 3]],
    ]);
    const outcome = resolvePatternTransforms(
      {
        kind: 'points',
        points: [
          { kind: 'point', pointId: 'a' },
          { kind: 'point', pointId: 'b' },
        ],
      },
      [],
      new Map(),
      (reference) =>
        reference.kind === 'point' ? (positions.get(reference.pointId) ?? null) : null,
    );
    if (!outcome.ok) {
      throw new Error('テストの前提が壊れている: 点の解決が失敗した');
    }
    expect(outcome.transforms.map((transform) => transform.translation)).toEqual([
      [0, 0, 0],
      [3, 0, 0],
    ]);
  });

  it('点の参照先のスケッチを referencedSketchIds が数える(FR-325 の順序の制約)', () => {
    const { document, pointIds } = pointPatternDocument(3);
    const pattern = document.solids.find((solid) => solid.id === 'pattern-1');
    if (pattern === undefined) {
      throw new Error('テストの前提が壊れている: パターンが無い');
    }
    // スケッチの一覧を渡さなければ数えられない(P5 タスク43 のまま)。
    expect(referencedSketchIds(pattern)).toEqual([]);
    expect(referencedSketchIds(pattern, document.sketches)).toEqual([
      document.sketches[0].id,
      document.sketches[0].id,
      document.sketches[0].id,
    ]);
    expect(pointIds).toHaveLength(3);
  });
});

describe('曲面(FR-428、P5 タスク46)', () => {
  function surfaceFeature(id: string, operation: SurfaceOperation): SurfaceFeature {
    return { id, name: id, suppressed: false, kind: 'surface', operation };
  }

  function surfaceDocument(operation: SurfaceOperation): PartDocument {
    const fixture = curveFixture();
    return withSolids(
      fixture.document,
      extrudeFeature('extrude-1', fixture.faceA),
      surfaceFeature('surface-1', operation),
    );
  }

  it('押し出し面は輪郭・向き・長さが段に乗る', () => {
    const fixture = curveFixture();
    const result = resolvePart(
      surfaceDocument({
        kind: 'extrude',
        profile: fixture.flat,
        distance: expr('20'),
        reversed: false,
      }),
    );
    expect(result.errors).toEqual([]);
    const plan = surfacePlan(result.steps[1]);
    if (plan.shape.kind !== 'extrude') {
      throw new Error('テストの前提が壊れている: 押し出し面でない');
    }
    expect(plan.shape.direction).toEqual([0, 0, 1]);
    expect(plan.shape.distance).toBe(20);
    expect(plan.targetKey).toBeNull();
  });

  it('押し出し面の向きを反転すると法線が裏返る', () => {
    const fixture = curveFixture();
    const plan = surfacePlan(
      resolvePart(
        surfaceDocument({
          kind: 'extrude',
          profile: fixture.flat,
          distance: expr('20'),
          reversed: true,
        }),
      ).steps[1],
    );
    if (plan.shape.kind !== 'extrude') {
      throw new Error('テストの前提が壊れている: 押し出し面でない');
    }
    expect(plan.shape.direction).toEqual([0, 0, -1]);
  });

  it('押し出し面の長さ 0 は断る', () => {
    const fixture = curveFixture();
    const result = resolvePart(
      surfaceDocument({
        kind: 'extrude',
        profile: fixture.flat,
        distance: expr('0'),
        reversed: false,
      }),
    );
    expect(result.errors[0].code).toBe('invalidValue');
  });

  it('回転面の角度は度からラジアンへ直る', () => {
    const fixture = curveFixture();
    const plan = surfacePlan(
      resolvePart(
        surfaceDocument({
          kind: 'revolve',
          profile: fixture.flat,
          axis: { kind: 'world', axis: 'z' },
          angle: expr('90'),
          reversed: false,
        }),
      ).steps[1],
    );
    if (plan.shape.kind !== 'revolve') {
      throw new Error('テストの前提が壊れている: 回転面でない');
    }
    expect(plan.shape.angle).toBe(1.5707963267948966);
    expect(plan.shape.axisDirection).toEqual([0, 0, 1]);
  });

  it('平らな面は輪郭だけが段に乗る', () => {
    const fixture = curveFixture();
    const plan = surfacePlan(
      resolvePart(surfaceDocument({ kind: 'planar', profile: fixture.flat })).steps[1],
    );
    expect(plan.shape.kind).toBe('planar');
    expect(plan.targetKey).toBeNull();
  });

  it('ロフト面は断面が 2 つ以上要る', () => {
    const fixture = curveFixture();
    const ok = resolvePart(
      surfaceDocument({ kind: 'loft', sections: [fixture.flat, fixture.path], ruled: true }),
    );
    expect(ok.errors).toEqual([]);
    const plan = surfacePlan(ok.steps[1]);
    if (plan.shape.kind !== 'loft') {
      throw new Error('テストの前提が壊れている: ロフト面でない');
    }
    expect(plan.shape.sections).toHaveLength(2);
    expect(plan.shape.ruled).toBe(true);
    const tooFew = resolvePart(
      surfaceDocument({ kind: 'loft', sections: [fixture.flat], ruled: false }),
    );
    expect(tooFew.errors[0].code).toBe('missingProfile');
  });

  it('立体の面を取り出す曲面は、面を借りる立体の鍵を持つ(消費しない)', () => {
    const result = resolvePart(
      surfaceDocument({
        kind: 'face',
        targetFeatureId: 'extrude-1',
        face: topFaceRef('extrude-1'),
      }),
    );
    expect(result.errors).toEqual([]);
    const plan = surfacePlan(result.steps[1]);
    expect(plan.targetKey).toBe(result.steps[0].key);
    expect(result.liveBodyIds).toEqual(['extrude-1', 'surface-1']);
  });

  it('面のオフセットは距離と面の指紋が段に乗る', () => {
    const result = resolvePart(
      surfaceDocument({
        kind: 'offset',
        targetFeatureId: 'extrude-1',
        face: topFaceRef('extrude-1'),
        distance: expr('5'),
      }),
    );
    expect(result.errors).toEqual([]);
    const plan = surfacePlan(result.steps[1]);
    if (plan.shape.kind !== 'offset') {
      throw new Error('テストの前提が壊れている: オフセットでない');
    }
    expect(plan.shape.distance).toBe(5);
    expect(plan.shape.face).toEqual(topFaceRef('extrude-1'));
    expect(plan.targetKey).toBe(result.steps[0].key);
  });

  it('オフセットの距離 0 は断る(元の面と同じ形になるため)', () => {
    const result = resolvePart(
      surfaceDocument({
        kind: 'offset',
        targetFeatureId: 'extrude-1',
        face: topFaceRef('extrude-1'),
        distance: expr('0'),
      }),
    );
    expect(result.steps).toHaveLength(1);
    expect(result.errors[0].code).toBe('invalidValue');
    expect(result.errors[0].message).toContain('0 以外');
  });

  it('面でないもの(辺)を取り出そうとしたら断る', () => {
    const result = resolvePart(
      surfaceDocument({
        kind: 'face',
        targetFeatureId: 'extrude-1',
        face: edgeRef('extrude-1'),
      }),
    );
    expect(result.errors[0].code).toBe('invalidValue');
    expect(result.errors[0].message).toContain('立体の面だけ');
  });

  it('面を借りる立体が無ければ断る', () => {
    const result = resolvePart(
      surfaceDocument({
        kind: 'face',
        targetFeatureId: 'extrude-9',
        face: topFaceRef('extrude-9'),
      }),
    );
    expect(result.errors[0].code).toBe('missingBody');
  });

  it('上流を伸ばすと、面を借りた曲面の鍵も変わる(NFR-PF-3)', () => {
    const fixture = curveFixture();
    const build = (distance: string): string =>
      resolvePart(
        withSolids(
          fixture.document,
          extrudeFeature('extrude-1', fixture.faceA, { distance }),
          surfaceFeature('surface-1', {
            kind: 'face',
            targetFeatureId: 'extrude-1',
            face: topFaceRef('extrude-1'),
          }),
        ),
      ).steps[1].key;
    expect(build('20')).not.toBe(build('10'));
  });
});

describe('くり抜き(FR-418、P5 タスク46)', () => {
  interface ShellOptions {
    readonly openFaces?: readonly SubShapeRef[];
    readonly thickness?: string;
    readonly outward?: boolean;
  }

  function shellFeature(
    id: string,
    targetFeatureId: string,
    options: ShellOptions = {},
  ): ShellFeature {
    return {
      id,
      name: id,
      suppressed: false,
      kind: 'shell',
      targetFeatureId,
      openFaces: options.openFaces ?? [topFaceRef(targetFeatureId)],
      thickness: expr(options.thickness ?? '2'),
      outward: options.outward ?? false,
    };
  }

  function shellDocument(options: ShellOptions = {}): PartDocument {
    const fixture = createFixture();
    return withSolids(
      fixture.document,
      extrudeFeature('extrude-1', fixture.faceA),
      shellFeature('shell-1', 'extrude-1', options),
    );
  }

  it('開ける面・厚さ・向きが段に乗る', () => {
    const result = resolvePart(shellDocument());
    expect(result.errors).toEqual([]);
    const plan = shellPlan(result.steps[1]);
    expect(plan.openFaces).toEqual([topFaceRef('extrude-1')]);
    expect(plan.thickness).toBe(2);
    expect(plan.outward).toBe(false);
    expect(plan.targetKey).toBe(result.steps[0].key);
  });

  it('開ける面が 0 枚でも作れる(中だけが空になる)', () => {
    const result = resolvePart(shellDocument({ openFaces: [] }));
    expect(result.errors).toEqual([]);
    expect(shellPlan(result.steps[1]).openFaces).toEqual([]);
  });

  it('同じ面を 2 度指しても 1 度だけ数える', () => {
    const face = topFaceRef('extrude-1');
    const plan = shellPlan(resolvePart(shellDocument({ openFaces: [face, face] })).steps[1]);
    expect(plan.openFaces).toHaveLength(1);
  });

  it('厚さ 0 は断る', () => {
    const result = resolvePart(shellDocument({ thickness: '0' }));
    expect(result.steps).toHaveLength(1);
    expect(result.errors[0].code).toBe('invalidValue');
    expect(result.errors[0].message).toContain('壁の厚さ');
  });

  it('面でないもの(辺)を開けようとしたら断る', () => {
    const result = resolvePart(shellDocument({ openFaces: [edgeRef('extrude-1')] }));
    expect(result.errors[0].code).toBe('invalidValue');
    expect(result.errors[0].message).toContain('面だけ');
  });

  it('別のボディの面を開けようとしたら断る', () => {
    const result = resolvePart(shellDocument({ openFaces: [topFaceRef('extrude-9')] }));
    expect(result.errors[0].code).toBe('invalidValue');
    expect(result.errors[0].message).toContain('もとの立体の面');
  });

  it('くり抜きは対象を消費するので、残るのはくり抜いた立体だけ', () => {
    expect(resolvePart(shellDocument()).liveBodyIds).toEqual(['shell-1']);
    expect(consumedTargetsOf(shellFeature('shell-1', 'extrude-1'))).toEqual(['extrude-1']);
  });

  it('外向きにすると鍵が変わる、同じ入力なら同じ鍵', () => {
    const inner = resolvePart(shellDocument()).steps[1].key;
    expect(resolvePart(shellDocument()).steps[1].key).toBe(inner);
    expect(resolvePart(shellDocument({ outward: true })).steps[1].key).not.toBe(inner);
  });
});

describe('可変半径フィレット(FR-426、P5 タスク46)', () => {
  function filletDocument(radius: string, radiusEnd?: string): PartDocument {
    const fixture = createFixture();
    const fillet = filletFeature('fillet-1', 'extrude-1', [edgeRef('extrude-1')], { radius });
    return withSolids(
      fixture.document,
      extrudeFeature('extrude-1', fixture.faceA),
      radiusEnd === undefined ? fillet : { ...fillet, radiusEnd: expr(radiusEnd) },
    );
  }

  it('終点側の半径を入れると、段が始点と終点の 2 値になる', () => {
    const result = resolvePart(filletDocument('2', '5'));
    expect(result.errors).toEqual([]);
    expect(filletPlan(result.steps[1]).radius).toEqual({ start: 2, end: 5 });
  });

  it('終点側を省くと一定半径のまま(段は P3 と同じ数 1 つ)', () => {
    const omitted = resolvePart(filletDocument('2'));
    expect(filletPlan(omitted.steps[1]).radius).toBe(2);
  });

  it('可変半径は一定半径と違う鍵になる', () => {
    expect(resolvePart(filletDocument('2', '5')).steps[1].key).not.toBe(
      resolvePart(filletDocument('2')).steps[1].key,
    );
  });

  it('始点と終点が同じでも可変のまま段に乗る(カーネルが一定半径と同じ形にする)', () => {
    expect(filletPlan(resolvePart(filletDocument('2', '2')).steps[1]).radius).toEqual({
      start: 2,
      end: 2,
    });
  });

  it('終点側の半径 0 は断る(カーネルの Add_3(0, r) をここで止める)', () => {
    const result = resolvePart(filletDocument('2', '0'));
    expect(result.steps).toHaveLength(1);
    expect(result.errors[0].code).toBe('invalidValue');
    expect(result.errors[0].message).toContain('0 より大きい');
  });
});

describe('平面による切断(FR-432、P5 タスク27c)', () => {
  interface CutOptions {
    readonly keep?: CutFeature['keep'];
    readonly pairedWith?: string | null;
    readonly targetFeatureId?: string;
    readonly suppressed?: boolean;
  }

  function cutFeature(id: string, plane: PlaneSpec, options: CutOptions = {}): CutFeature {
    return {
      id,
      name: id,
      suppressed: options.suppressed ?? false,
      kind: 'cut',
      targetFeatureId: options.targetFeatureId ?? 'extrude-1',
      plane,
      keep: options.keep ?? DEFAULT_CUT_KEEP,
      pairedWith: options.pairedWith ?? null,
    };
  }

  /**
   * 切断の検査の土台。z = 5 の平面を決められる 3 点(と、一直線にするための 4 点目)を
   * スケッチへ足し、40×30 を Z へ 10 押し出した箱を切る。
   */
  function cutFixture(): {
    readonly document: PartDocument;
    readonly points: readonly string[];
  } {
    const fixture = createFixture();
    const added = addPoints(fixture.document.sketches[0], [
      [0, 0, 5],
      [40, 0, 5],
      [0, 30, 5],
      [10, 0, 5],
    ]);
    const document = withSolids(
      replaceSketch(fixture.document, added.sketch),
      extrudeFeature('extrude-1', fixture.faceA),
    );
    return { document, points: added.pointIds };
  }

  function cutPointRef(pointId: string): PointReference {
    return { kind: 'point', pointId };
  }

  /** X 方向のまっすぐな辺(中点 (20,0,0))。切断面の基準にする。 */
  function cutXEdgeRef(bodyFeatureId: string): SubShapeRef {
    return {
      bodyFeatureId,
      index: 5,
      fingerprint: {
        kind: 'edge',
        curveKind: 'line',
        length: 40,
        position: [20, 0, 0],
        axis: [1, 0, 0],
        radius: null,
      },
    };
  }

  /** 円の辺。まっすぐでない辺を断ることの検査に使う。 */
  function cutCircleEdgeRef(bodyFeatureId: string): SubShapeRef {
    return {
      bodyFeatureId,
      index: 6,
      fingerprint: {
        kind: 'edge',
        curveKind: 'circle',
        length: 18.84,
        position: [20, 15, 10],
        axis: [0, 0, 1],
        radius: 3,
      },
    };
  }

  /** 切断 1 つを積んだ文書を解決する。 */
  function cutStep(plane: PlaneSpec, options: CutOptions = {}): ResolvedPart {
    const fixture = cutFixture();
    return resolvePart(withSolids(fixture.document, cutFeature('cut-1', plane, options)));
  }

  it('3 点を通る切断面は、法線が [0,0,1] で原点が z = 5 の点になる', () => {
    const fixture = cutFixture();
    const plane: PlaneSpec = {
      kind: 'threePoints',
      p1: cutPointRef(fixture.points[0]),
      p2: cutPointRef(fixture.points[1]),
      p3: cutPointRef(fixture.points[2]),
    };
    const result = resolvePart(withSolids(fixture.document, cutFeature('cut-1', plane)));
    expect(result.errors).toEqual([]);
    const plan = cutPlan(result.steps[1]);
    expectVec3(plan.normal, [0, 0, 1]);
    expectVec3(plan.origin, [0, 0, 5]);
    expect(plan.keepPositive).toBe(true);
    expect(plan.targetKey).toBe(result.steps[0].key);
  });

  it('3 点が一直線なら切断面が決まらないと断る(FR-504)', () => {
    const fixture = cutFixture();
    const plane: PlaneSpec = {
      kind: 'threePoints',
      p1: cutPointRef(fixture.points[0]),
      p2: cutPointRef(fixture.points[1]),
      p3: cutPointRef(fixture.points[3]),
    };
    const result = resolvePart(withSolids(fixture.document, cutFeature('cut-1', plane)));
    expect(result.steps).toHaveLength(1);
    expect(result.errors[0].code).toBe('notPlanar');
    expect(result.errors[0].message).toContain('一直線');
  });

  it('点+辺(垂直)は辺の向きが法線になる', () => {
    const fixture = cutFixture();
    const plane: PlaneSpec = {
      kind: 'pointAndEdge',
      point: cutPointRef(fixture.points[0]),
      edge: cutXEdgeRef('extrude-1'),
      mode: 'perpendicular',
    };
    const plan = cutPlan(
      resolvePart(withSolids(fixture.document, cutFeature('cut-1', plane))).steps[1],
    );
    expectVec3(plan.normal, [1, 0, 0]);
  });

  it('点+辺(辺を含む)は、法線が辺の向きにも「中点→点」にも垂直になる', () => {
    const fixture = cutFixture();
    const plane: PlaneSpec = {
      kind: 'pointAndEdge',
      point: cutPointRef(fixture.points[2]),
      edge: cutXEdgeRef('extrude-1'),
      mode: 'containing',
    };
    const plan = cutPlan(
      resolvePart(withSolids(fixture.document, cutFeature('cut-1', plane))).steps[1],
    );
    // 辺は (20,0,0) を中点に X 方向、点は (0,30,5)。
    expect(dotVec3(plan.normal, [1, 0, 0])).toBeCloseTo(0, 9);
    expect(dotVec3(plan.normal, [-20, 30, 5])).toBeCloseTo(0, 9);
    expect(lengthVec3(plan.normal)).toBeCloseTo(1, 9);
  });

  it('まっすぐでない辺(円)は断る', () => {
    const fixture = cutFixture();
    const plane: PlaneSpec = {
      kind: 'pointAndEdge',
      point: cutPointRef(fixture.points[0]),
      edge: cutCircleEdgeRef('extrude-1'),
      mode: 'perpendicular',
    };
    const result = resolvePart(withSolids(fixture.document, cutFeature('cut-1', plane)));
    expect(result.steps).toHaveLength(1);
    expect(result.errors[0].message).toContain('まっすぐな辺');
  });

  it('点+軸(Z 軸・傾き 0)は軸そのものが法線になる', () => {
    const fixture = cutFixture();
    const plane: PlaneSpec = {
      kind: 'pointAndAxis',
      point: cutPointRef(fixture.points[0]),
      axis: { kind: 'world', axis: 'z' },
      tilt: expr('0'),
      azimuth: expr('0'),
    };
    const plan = cutPlan(
      resolvePart(withSolids(fixture.document, cutFeature('cut-1', plane))).steps[1],
    );
    expectVec3(plan.normal, [0, 0, 1]);
  });

  it('点+軸(Z 軸・傾き 30)は穴・ばねと同じ規約で倒れる', () => {
    const fixture = cutFixture();
    const plane: PlaneSpec = {
      kind: 'pointAndAxis',
      point: cutPointRef(fixture.points[0]),
      axis: { kind: 'world', axis: 'z' },
      tilt: expr('30'),
      azimuth: expr('0'),
    };
    const plan = cutPlan(
      resolvePart(withSolids(fixture.document, cutFeature('cut-1', plane))).steps[1],
    );
    expectVec3(plan.normal, [0, -0.5, 0.8660254037844387]);
  });

  it('傾き 180 度は断る(裏返るだけで新しい平面にならない)', () => {
    const fixture = cutFixture();
    const plane: PlaneSpec = {
      kind: 'pointAndAxis',
      point: cutPointRef(fixture.points[0]),
      axis: { kind: 'world', axis: 'z' },
      tilt: expr('180'),
      azimuth: expr('0'),
    };
    const result = resolvePart(withSolids(fixture.document, cutFeature('cut-1', plane)));
    expect(result.errors[0].code).toBe('invalidValue');
    expect(result.errors[0].message).toContain('0 度以上 180 度未満');
  });

  it('点を通り既存の平らな面に平行な切断面は、面の法線と指した点になる', () => {
    const fixture = cutFixture();
    const plane: PlaneSpec = {
      kind: 'pointAndParallelFace',
      point: cutPointRef(fixture.points[0]),
      face: topFaceRef('extrude-1'),
    };
    const plan = cutPlan(
      resolvePart(withSolids(fixture.document, cutFeature('cut-1', plane))).steps[1],
    );
    expectVec3(plan.normal, [0, 0, 1]);
    expectVec3(plan.origin, [0, 0, 5]);
  });

  it('平らでない面(円柱面)に平行な切断面は断る', () => {
    const fixture = cutFixture();
    const plane: PlaneSpec = {
      kind: 'pointAndParallelFace',
      point: cutPointRef(fixture.points[0]),
      face: cylinderFaceRef('extrude-1'),
    };
    const result = resolvePart(withSolids(fixture.document, cutFeature('cut-1', plane)));
    expect(result.steps).toHaveLength(1);
    expect(result.errors[0].message).toContain('平らな面');
  });

  it('作業平面(XY)を切断面にできる', () => {
    const result = cutStep({ kind: 'workPlane', planeId: 'xy', offset: expr('0') });
    expect(result.errors).toEqual([]);
    const plan = cutPlan(result.steps[1]);
    expectVec3(plan.normal, [0, 0, 1]);
    expectVec3(plan.origin, [0, 0, 0]);
  });

  it('存在しない平面 id は断る', () => {
    const result = cutStep({ kind: 'workPlane', planeId: 'plane-404', offset: expr('0') });
    expect(result.steps).toHaveLength(1);
    expect(result.errors[0].message).toContain('平面が見つかりません');
  });

  it('残す側を反対にすると段の keepPositive が false になる', () => {
    const result = cutStep(
      { kind: 'workPlane', planeId: 'xy', offset: expr('5') },
      { keep: 'negative' },
    );
    expect(cutPlan(result.steps[1]).keepPositive).toBe(false);
    expectVec3(cutPlan(result.steps[1]).origin, [0, 0, 5]);
  });

  it('切断は対象を消費するので、残るのは切断だけ', () => {
    const result = cutStep({ kind: 'workPlane', planeId: 'xy', offset: expr('5') });
    expect(result.liveBodyIds).toEqual(['cut-1']);
    expect(
      consumedTargetsOf(
        cutFeature('cut-1', { kind: 'workPlane', planeId: 'xy', offset: expr('0') }),
      ),
    ).toEqual(['extrude-1']);
  });

  it('切るもとの立体が無ければ断る', () => {
    const result = cutStep(
      { kind: 'workPlane', planeId: 'xy', offset: expr('5') },
      { targetFeatureId: 'extrude-404' },
    );
    expect(result.steps).toHaveLength(1);
    expect(result.errors[0].code).toBe('missingBody');
  });

  /* -- 「反対側も残す」の対(§0.a-0.58) -- */

  /** 同じ立体を表と裏から切る 2 つ(2 つ目が 1 つ目を `pairedWith` で指す)。 */
  function pairedDocument(options: { readonly suppressSecond?: boolean } = {}): PartDocument {
    const fixture = cutFixture();
    const plane: PlaneSpec = { kind: 'workPlane', planeId: 'xy', offset: expr('5') };
    return withSolids(
      fixture.document,
      cutFeature('cut-1', plane),
      cutFeature('cut-2', plane, {
        keep: 'negative',
        pairedWith: 'cut-1',
        suppressed: options.suppressSecond ?? false,
      }),
    );
  }

  it('対になった 2 つの切断は、対象を 1 度だけ消費して 2 つとも残る', () => {
    const document = pairedDocument();
    expect(Array.from(consumedBodyIds(document))).toEqual(['extrude-1']);
    expect(liveBodyIds(document)).toEqual(['cut-1', 'cut-2']);
    const result = resolvePart(document);
    expect(result.errors).toEqual([]);
    expect(result.steps).toHaveLength(3);
    expect(result.liveBodyIds).toEqual(['cut-1', 'cut-2']);
    expect(cutPlan(result.steps[1]).keepPositive).toBe(true);
    expect(cutPlan(result.steps[2]).keepPositive).toBe(false);
  });

  it('対の相手を消すと、残ったほうが単独の切断になる(段は 1 つ)', () => {
    const result = resolvePart(removeSolid(pairedDocument(), 'cut-1'));
    expect(result.errors).toEqual([]);
    expect(result.steps).toHaveLength(2);
    expect(result.liveBodyIds).toEqual(['cut-2']);
  });

  it('対の片方を抑制すると、残ったほうが単独の切断になる(FR-503)', () => {
    const result = resolvePart(pairedDocument({ suppressSecond: true }));
    expect(result.errors).toEqual([]);
    expect(result.liveBodyIds).toEqual(['cut-1']);
  });

  it('対でない 2 つ目は、すでに使われた立体を切ろうとして断られる', () => {
    const fixture = cutFixture();
    const plane: PlaneSpec = { kind: 'workPlane', planeId: 'xy', offset: expr('5') };
    const result = resolvePart(
      withSolids(
        fixture.document,
        cutFeature('cut-1', plane),
        cutFeature('cut-2', plane, { keep: 'negative' }),
      ),
    );
    expect(result.errors[0].code).toBe('consumedTwice');
    expect(result.liveBodyIds).toEqual(['cut-1']);
  });

  it('相手が文書に無い pairedWith は単独の切断として扱う(文書は書き換えない)', () => {
    const result = cutStep(
      { kind: 'workPlane', planeId: 'xy', offset: expr('5') },
      { pairedWith: 'cut-404' },
    );
    expect(result.errors).toEqual([]);
    expect(result.liveBodyIds).toEqual(['cut-1']);
  });

  /* -- 鍵(§0.a-0.20、NFR-PF-3) -- */

  it('残す側を変えると鍵が変わり、pairedWith を変えても鍵は変わらない', () => {
    const plane: PlaneSpec = { kind: 'workPlane', planeId: 'xy', offset: expr('5') };
    const positive = cutStep(plane).steps[1].key;
    expect(cutStep(plane).steps[1].key).toBe(positive);
    expect(cutStep(plane, { keep: 'negative' }).steps[1].key).not.toBe(positive);
    expect(cutStep(plane, { pairedWith: 'cut-404' }).steps[1].key).toBe(positive);
  });

  it('切断面の点の座標を変えると鍵が変わる', () => {
    function keyForZ(z: number): string {
      const fixture = createFixture();
      const added = addPoints(fixture.document.sketches[0], [
        [0, 0, z],
        [40, 0, z],
        [0, 30, z],
      ]);
      const plane: PlaneSpec = {
        kind: 'threePoints',
        p1: cutPointRef(added.pointIds[0]),
        p2: cutPointRef(added.pointIds[1]),
        p3: cutPointRef(added.pointIds[2]),
      };
      return resolvePart(
        withSolids(
          replaceSketch(fixture.document, added.sketch),
          extrudeFeature('extrude-1', fixture.faceA),
          cutFeature('cut-1', plane),
        ),
      ).steps[1].key;
    }
    expect(keyForZ(5)).not.toBe(keyForZ(6));
  });

  it('上流の押し出しを伸ばすと切断の鍵も変わる(鍵の連鎖)', () => {
    function keyForDistance(distance: string): string {
      const fixture = createFixture();
      return resolvePart(
        withSolids(
          fixture.document,
          extrudeFeature('extrude-1', fixture.faceA, { distance }),
          cutFeature('cut-1', { kind: 'workPlane', planeId: 'xy', offset: expr('5') }),
        ),
      ).steps[1].key;
    }
    expect(keyForDistance('10')).not.toBe(keyForDistance('20'));
  });

  /* -- 順序の制約(FR-325、§0.a-0.11) -- */

  it('切断面の点が指すスケッチを referencedSketchIds が数える', () => {
    const fixture = cutFixture();
    const plane: PlaneSpec = {
      kind: 'threePoints',
      p1: cutPointRef(fixture.points[0]),
      p2: cutPointRef(fixture.points[1]),
      p3: cutPointRef(fixture.points[2]),
    };
    const sketchId = fixture.document.sketches[0].id;
    expect(referencedSketchIds(cutFeature('cut-1', plane), fixture.document.sketches)).toEqual([
      sketchId,
      sketchId,
      sketchId,
    ]);
    // スケッチの一覧を渡さなければ数えない(既存の呼び出しのふるまいを変えない)。
    expect(referencedSketchIds(cutFeature('cut-1', plane))).toEqual([]);
  });

  it('作業平面だけの切断面はスケッチを使わない', () => {
    const feature = cutFeature('cut-1', { kind: 'workPlane', planeId: 'xy', offset: expr('0') });
    expect(referencedSketchIds(feature, cutFixture().document.sketches)).toEqual([]);
  });
});
