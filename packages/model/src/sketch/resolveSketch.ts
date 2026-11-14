/**
 * スケッチの履歴全体をワールド座標へ解決する。
 *
 * 履歴を先頭から順にたどり、点・線分・円弧・点列・面を組み立てる(要件§6.3)。
 * 途中のフィーチャーが解決できなくても止めず、そのフィーチャーだけを errors へ入れて
 * 先へ進む(FR-504、NFR-RE-1)。解決できなかったフィーチャーは以後の参照先にならない。
 *
 * 座標 1 点の解決は resolveCoordinate.ts の担当で、ここは
 * 「そこまでに解決できたもの」(ResolveContext)を育てながら順に渡す。
 *
 * 作図面は 3 通りある。基準の 3 面(`WORK_PLANES`)、部品文書の作業平面
 * (FR-328、`SketchResolveOptions.workPlane` で引く)、そして
 * **作図面を持たない 3D スケッチ**(FR-330、`isFreeWorkPlaneId`)。
 * 3D スケッチで作れるのは点・線分・円弧・スプライン・面の 5 つで、円弧だけは
 * 向き(法線・角度 0 の向き)をフィーチャー自身が持つ。面は境界が同じ平面に乗るときだけ
 * 張れ、乗らなければ `notPlanar` で断る。
 */

import type { ResolvedSubShape } from '../geometry/planeSpec.js';
import type { SubShapeRef } from '../geometry/subShapeRef.js';
import {
  arcPointAt,
  ellipsePointAt,
  FULL_TURN,
  FULL_TURN_EPSILON,
  isFullCircle,
  isFullEllipse,
  traceCurveChain,
} from './intersectionMath.js';
import { radiusComponentKey } from './constraints/variables.js';
import {
  baseWorkPlane,
  degreesToRadians,
  directionInPlane,
  isFreeWorkPlaneId,
  planeToWorld,
  worldToPlane,
  type WorkPlane,
  type WorkPlaneId,
} from './planeMath.js';
import {
  resolveCoordinate,
  vertexKey,
  type ResolvedSphere,
  type ResolveContext,
  type ResolveOutcome,
} from './resolveCoordinate.js';
import {
  resolveCopyFeatureStep,
  resolveFunctionCurveStep,
  resolveOffsetStep,
  resolveProjectionStep,
} from './resolveSketchDerived.js';
import {
  createSketchResolveState,
  needsWorkPlane,
  recordCurve,
  recordCurveGroup,
  recordPoints,
  sketchError as error,
  sketchResultOf,
  type SketchFeatureStep,
  type SketchResolveLookups,
  type SketchResolveState,
} from './resolveSketchState.js';
import {
  hasDuplicateSplinePoint,
  MAX_SPLINE_POINTS,
  MIN_CLOSED_SPLINE_POINTS,
  MIN_SPLINE_POINTS,
  SPLINE_DUPLICATE_POINT_MESSAGE,
  SPLINE_TOO_FEW_CLOSED_MESSAGE,
  SPLINE_TOO_FEW_OPEN_MESSAGE,
  SPLINE_TOO_MANY_MESSAGE,
  splineCurveData,
} from './splineMath.js';
import type {
  FreeArcOrientation,
  PointArrayLayout,
  ResolvedArc,
  ResolvedCurve,
  ResolvedEllipse,
  ResolvedFace,
  ResolvedPoint,
  ResolvedSegment,
  ResolvedSketch,
  ResolvedSpline,
  SketchArcFeature,
  SketchDocument,
  SketchEllipseFeature,
  SketchError,
  SketchFaceFeature,
  SketchFeature,
  SketchLineFeature,
  SketchPointArrayFeature,
  SketchPointFeature,
  SketchPolygonFeature,
  SketchRectangleFeature,
  SketchSlotFeature,
  SketchSplineFeature,
} from './types.js';
import {
  addVec3,
  crossVec3,
  dotVec3,
  isSamePoint,
  lengthVec3,
  normalizeVec3,
  scaleVec3,
  SKETCH_TOLERANCE_MM,
  subVec3,
  type Vec3,
} from './vec3.js';
import type { FunctionPointResolver as TypeFunctionPointResolver } from '../functionGeometry/functionPointReference.js';


/** 点列で一度に作れる点の上限。打ち間違いで莫大な数を作らないための歯止め。 */
export const MAX_POINT_ARRAY_COUNT = 1000;

/** 点列の個数の下限。1 個でも点列として成立させる(2026-09-02)。 */
const MIN_POINT_ARRAY_COUNT = 1;

/** 平面の当てはめに使う円弧の標本点の数(両端を含む)。 */
const ARC_PLANE_SAMPLES = 5;

/**
 * 曲線の上の点・全周の判定は `intersectionMath.ts` にある(交点の計算がこれらを使うため
 * そちらへ移した)。ここから再輸出して、呼び出し側の import を変えずに済ませる。
 */
export {
  arcPointAt,
  curveEnd,
  curveStart,
  ellipsePointAt,
  isFullCircle,
  isFullEllipse,
} from './intersectionMath.js';

/**
 * 中心から見た幾何の方位角(ラジアン、長軸から短軸へ向かう向きが正)を、
 * 楕円の径数方程式のパラメータ角へ直す。
 *
 * 方位角 θ の向きの半直線と楕円の交点は
 *   a·cos u = r·cos θ、b·sin u = r·sin θ(r は中心からの距離)
 * を満たすので、tan u = (a/b)·tan θ、すなわち **u = atan2(sin θ / b, cos θ / a)**。
 * 例: a=20・b=10・θ=45° なら u = arctan 2 = 63.4349488…°、
 * その点は (20·cos u, 10·sin u) = (8.944…, 8.944…) で、方位角どおり x = y になる。
 *
 * `atan2` は (−π, π] しか返さないので、θ と同じ周回へ載せ直す。u と θ は必ず同じ象限に
 * あるので両者の差は π/2 未満で、周回のとり方はただ 1 つに決まる。こうすると
 * 「0° から 360°」の指定がパラメータ角でもちょうど 1 周ぶんになり、全周の楕円になる。
 * a = b(円)のときは u = θ で、円弧の角度の意味とそのまま一致する。
 */
export function azimuthToEllipseParameter(
  azimuth: number,
  majorRadius: number,
  minorRadius: number,
): number {
  const base = Math.atan2(Math.sin(azimuth) / minorRadius, Math.cos(azimuth) / majorRadius);
  const turns = Math.round((azimuth - base) / FULL_TURN);
  return base + turns * FULL_TURN;
}

/**
 * 点群が乗る平面の法線を求める。すべて一直線上に並んでいるときは null を返す。
 * 最も大きな外積を選ぶのは、ほとんど一直線に近い3点から不安定な法線を得ないため。
 */
export function fitPlaneNormal(points: readonly Vec3[]): Vec3 | null {
  if (points.length < 3) {
    return null;
  }
  const origin = points[0];
  let best: Vec3 | null = null;
  let bestLength = 0;
  for (let i = 1; i < points.length; i += 1) {
    for (let j = i + 1; j < points.length; j += 1) {
      const normal = crossVec3(subVec3(points[i], origin), subVec3(points[j], origin));
      const length = lengthVec3(normal);
      if (length > bestLength) {
        bestLength = length;
        best = normal;
      }
    }
  }
  if (best === null || bestLength <= SKETCH_TOLERANCE_MM) {
    return null;
  }
  return normalizeVec3(best);
}

/** すべての点が同じ平面に乗っているか(FR-309。非平面は FR-312 で Could なので断る)。 */
export function isPlanar(points: readonly Vec3[]): boolean {
  const normal = fitPlaneNormal(points);
  if (normal === null) {
    return false;
  }
  const origin = points[0];
  return points.every(
    (point) => Math.abs(dotVec3(subVec3(point, origin), normal)) <= SKETCH_TOLERANCE_MM,
  );
}

/**
 * 平面判定に使う標本点。円弧は中心と弧の上の数点を出し、弧が乗る平面まで見る。
 * 端点だけを見ると、端点だけが一致する別々の作図面の円弧を同じ平面と誤判定するため。
 */
function curveSamplePoints(curve: ResolvedCurve): Vec3[] {
  switch (curve.kind) {
    case 'segment':
      return [curve.from, curve.to];
    case 'arc': {
      const span = curve.endAngle - curve.startAngle;
      const samples: Vec3[] = [curve.center];
      for (let index = 0; index < ARC_PLANE_SAMPLES; index += 1) {
        samples.push(
          arcPointAt(curve, curve.startAngle + (span * index) / (ARC_PLANE_SAMPLES - 1)),
        );
      }
      return samples;
    }
    case 'ellipse': {
      const span = curve.endAngle - curve.startAngle;
      const samples: Vec3[] = [curve.center];
      for (let index = 0; index < ARC_PLANE_SAMPLES; index += 1) {
        samples.push(
          ellipsePointAt(curve, curve.startAngle + (span * index) / (ARC_PLANE_SAMPLES - 1)),
        );
      }
      return samples;
    }
    case 'spline':
      // 極は通過点(または制御点)の一次結合で、基底の和が必ず 1 になる(アフィン結合)。
      // だから点が同じ平面に乗っていれば曲線も必ずその平面に乗る。点だけ見れば足りる。
      return [...curve.points];
  }
}

/** 直角(ラジアン)。長穴の半円弧の開始角・終了角(中心の xAxis から ±90°)に使う。 */
const QUARTER_TURN = Math.PI / 2;

/**
 * 矩形・正多角形・長穴が生む曲線。この 3 つは線分と円弧しか作らないので、
 * `ResolvedCurve` の 4 種すべてではなくこの 2 種に絞っておく(意味の無い分岐を作らないため)。
 */
type PolylineCurve = ResolvedSegment | ResolvedArc;

type CurvesOutcome =
  | { readonly ok: true; readonly curves: readonly PolylineCurve[] }
  | { readonly ok: false; readonly error: SketchError };

/**
 * 矩形(FR-314)の 4 辺を対角 2 点から作る。対角の 2 点を作図面へ
 * 落とし(`worldToPlane`)、作図面内の軸に平行な 4 頂点を組み立ててから世界座標へ戻す。
 * こうすることで、対角の 2 点が作図面から多少ずれて入力されても矩形は平面上に収まる。
 */
function resolveRectangleCurves(
  featureId: string,
  plane: WorkPlane,
  corner1: Vec3,
  corner2: Vec3,
): CurvesOutcome {
  const [u1, v1] = worldToPlane(plane, corner1);
  const [u2, v2] = worldToPlane(plane, corner2);
  if (Math.abs(u2 - u1) <= SKETCH_TOLERANCE_MM || Math.abs(v2 - v1) <= SKETCH_TOLERANCE_MM) {
    return { ok: false, error: error(featureId, 'degenerate', '矩形の幅・高さが 0 です。') };
  }
  // 対角 2 点から、作図面の軸に平行な 4 頂点を反時計回りに並べる。
  const corners: readonly Vec3[] = [
    planeToWorld(plane, u1, v1),
    planeToWorld(plane, u2, v1),
    planeToWorld(plane, u2, v2),
    planeToWorld(plane, u1, v2),
  ];
  const curves: ResolvedSegment[] = corners.map(
    (from, index): ResolvedSegment => ({
      kind: 'segment',
      featureId,
      from,
      to: corners[(index + 1) % corners.length],
    }),
  );
  return { ok: true, curves };
}

/**
 * 正多角形(FR-315)の n 辺を中心・半径・辺数から作る。半径は円周(外接、頂点円)
 * かアポテム(内接、辺の中点までの距離)かで扱いが違うため、内接のときだけ
 * 外接半径 = 内接半径 ÷ cos(π/n) で頂点円の半径へ変換してから頂点を並べる。
 * 角度 0 は作図面の第1軸(円弧・点列と同じ規約)。
 */
function resolvePolygonCurves(
  featureId: string,
  plane: WorkPlane,
  center: Vec3,
  sides: number,
  radiusMode: 'circumscribed' | 'inscribed',
  radius: number,
): CurvesOutcome {
  const circumRadius =
    radiusMode === 'circumscribed' ? radius : radius / Math.cos(Math.PI / sides);
  const vertices: Vec3[] = [];
  for (let index = 0; index < sides; index += 1) {
    const angle = (2 * Math.PI * index) / sides;
    vertices.push(
      addVec3(
        center,
        addVec3(
          scaleVec3(plane.axisU, circumRadius * Math.cos(angle)),
          scaleVec3(plane.axisV, circumRadius * Math.sin(angle)),
        ),
      ),
    );
  }
  const curves: ResolvedSegment[] = vertices.map(
    (from, index): ResolvedSegment => ({
      kind: 'segment',
      featureId,
      from,
      to: vertices[(index + 1) % vertices.length],
    }),
  );
  return { ok: true, curves };
}

/**
 * 長穴(FR-316)を 2 中心点+幅から作る。直線区間 2 本(中心を結ぶ向きに平行)+
 * 半円弧 2 本(それぞれの中心・半径=幅/2)。矩形と同じく両中心を作図面へ落として組み立てる。
 *
 * 半円弧の向きの決め方: 中心 2 を通る円弧の xAxis を「中心1→中心2」の単位ベクトルに取ると、
 * 角度 0 の点がちょうど中心2から見て外向き(中心1と反対側)の膨らみになり、
 * ±90°(`QUARTER_TURN`)の点が長穴の両側の直線区間の端点に一致する
 * (導出は `resolveSketch.test.ts` の長穴の項を参照)。中心1側の円弧は xAxis を逆向きにして
 * 同じ考え方を使う。
 */
function resolveSlotCurves(
  featureId: string,
  plane: WorkPlane,
  center1: Vec3,
  center2: Vec3,
  width: number,
): CurvesOutcome {
  const [u1, v1] = worldToPlane(plane, center1);
  const [u2, v2] = worldToPlane(plane, center2);
  const du = u2 - u1;
  const dv = v2 - v1;
  const length = Math.hypot(du, dv);
  if (length <= SKETCH_TOLERANCE_MM) {
    return { ok: false, error: error(featureId, 'degenerate', '長穴の 2 つの中心が同じ位置です。') };
  }
  const half = width / 2;
  if (half <= SKETCH_TOLERANCE_MM) {
    return { ok: false, error: error(featureId, 'degenerate', '長穴の幅が小さすぎます。') };
  }
  const dirU = du / length;
  const dirV = dv / length;
  // 作図面内で90°回した向き(中心1→中心2の向きの左側)。
  const perpU = -dirV;
  const perpV = dirU;
  const center1Flat = planeToWorld(plane, u1, v1);
  const center2Flat = planeToWorld(plane, u2, v2);
  const pointA = planeToWorld(plane, u1 + half * perpU, v1 + half * perpV);
  const pointB = planeToWorld(plane, u2 + half * perpU, v2 + half * perpV);
  const pointC = planeToWorld(plane, u2 - half * perpU, v2 - half * perpV);
  const pointD = planeToWorld(plane, u1 - half * perpU, v1 - half * perpV);
  const dirVecWorld = addVec3(scaleVec3(plane.axisU, dirU), scaleVec3(plane.axisV, dirV));
  const arcAtCenter2: ResolvedArc = {
    kind: 'arc',
    featureId,
    center: center2Flat,
    normal: plane.normal,
    xAxis: dirVecWorld,
    radius: half,
    startAngle: -QUARTER_TURN,
    endAngle: QUARTER_TURN,
  };
  const arcAtCenter1: ResolvedArc = {
    kind: 'arc',
    featureId,
    center: center1Flat,
    normal: plane.normal,
    xAxis: scaleVec3(dirVecWorld, -1),
    radius: half,
    startAngle: -QUARTER_TURN,
    endAngle: QUARTER_TURN,
  };
  const segmentTop: ResolvedSegment = { kind: 'segment', featureId, from: pointA, to: pointB };
  const segmentBottom: ResolvedSegment = { kind: 'segment', featureId, from: pointC, to: pointD };
  return { ok: true, curves: [segmentTop, arcAtCenter2, segmentBottom, arcAtCenter1] };
}

type PointArrayOutcome =
  | { readonly ok: true; readonly points: readonly ResolvedPoint[] }
  | { readonly ok: false; readonly error: SketchError };

/** 点列の個数(1 本の並び)の妥当性(FR-308)。共通の下限・上限で見る。 */
function checkPointArrayCount(featureId: string, count: number): SketchError | null {
  if (
    !Number.isInteger(count) ||
    count < MIN_POINT_ARRAY_COUNT ||
    count > MAX_POINT_ARRAY_COUNT
  ) {
    return error(
      featureId,
      'invalidValue',
      `個数は ${String(MIN_POINT_ARRAY_COUNT)} 以上 ${String(MAX_POINT_ARRAY_COUNT)} 以下の整数にしてください。`,
    );
  }
  return null;
}

/** 直線状の点列(既存の挙動、FR-308)。方位角の向きへ等間隔に並べる。 */
function resolveLinearPointArray(
  featureId: string,
  layout: Extract<PointArrayLayout, { readonly kind: 'linear' }>,
  plane: WorkPlane,
  context: ResolveContext,
): PointArrayOutcome {
  const base = resolveCoordinate(layout.base, context, featureId);
  if (!base.ok) {
    return { ok: false, error: base.error };
  }
  const count = layout.count.value;
  const countError = checkPointArrayCount(featureId, count);
  if (countError !== null) {
    return { ok: false, error: countError };
  }
  const spacing = layout.spacing.value;
  if (!Number.isFinite(spacing) || spacing === 0) {
    return { ok: false, error: error(featureId, 'invalidValue', '間隔に 0 は指定できません。') };
  }
  const azimuth = layout.azimuth.value;
  if (!Number.isFinite(azimuth)) {
    return { ok: false, error: error(featureId, 'invalidValue', '方向の角度が数になっていません。') };
  }
  const direction = directionInPlane(plane, azimuth);
  const points: ResolvedPoint[] = [];
  for (let index = 0; index < count; index += 1) {
    points.push({
      id: `${featureId}#${String(index)}`,
      featureId,
      producerAnchor: { kind: 'linear-point', featureId, step: index },
      position: addVec3(base.value, scaleVec3(direction, spacing * index)),
    });
  }
  return { ok: true, points };
}

/**
 * 円周上の点列(FR-327)。中心・半径・個数で等角度に並べる。開始角は常に作図面の
 * 第1軸(角度 0、正多角形 `resolvePolygonCurves` と同じ規約)で、利用者に開始角の
 * 指定は持たせない。
 */
function greatestCommonDivisor(a: number, b: number): number {
  while (b !== 0) { const remainder = a % b; a = b; b = remainder; }
  return a;
}

function resolveCircularPointArray(
  featureId: string,
  layout: Extract<PointArrayLayout, { readonly kind: 'circular' }>,
  plane: WorkPlane,
  context: ResolveContext,
): PointArrayOutcome {
  const center = resolveCoordinate(layout.center, context, featureId);
  if (!center.ok) {
    return { ok: false, error: center.error };
  }
  const count = layout.count.value;
  const countError = checkPointArrayCount(featureId, count);
  if (countError !== null) {
    return { ok: false, error: countError };
  }
  const radius = layout.radius.value;
  if (!Number.isFinite(radius) || radius < 0) {
    return { ok: false, error: error(featureId, 'invalidValue', '半径は 0 より大きい必要があります。') };
  }
  if (radius <= SKETCH_TOLERANCE_MM) {
    return { ok: false, error: error(featureId, 'degenerate', '半径が小さすぎて点列になりません。') };
  }
  const points: ResolvedPoint[] = [];
  for (let index = 0; index < count; index += 1) {
    const angle = (FULL_TURN * index) / count;
    const position = addVec3(
      center.value,
      addVec3(
        scaleVec3(plane.axisU, radius * Math.cos(angle)),
        scaleVec3(plane.axisV, radius * Math.sin(angle)),
      ),
    );
    const divisor = greatestCommonDivisor(index, count);
    points.push({ id: `${featureId}#${String(index)}`, featureId, position,
      producerAnchor: { kind: 'circular-point', featureId, numerator: index / divisor, denominator: count / divisor } });
  }
  return { ok: true, points };
}

/** 行・列いずれかの個数の妥当性(グリッド、FR-327)。1 以上の整数であることだけを見る。 */
function checkGridAxisCount(featureId: string, label: string, count: number): SketchError | null {
  if (!Number.isInteger(count) || count < MIN_POINT_ARRAY_COUNT) {
    return error(featureId, 'invalidValue', `${label}の個数は 1 以上の整数にしてください。`);
  }
  return null;
}

/**
 * 格子状の点列(FR-327)。基準点から行方向・列方向へ「行 × 列」で並べる
 * (行が外側、列が内側。0 番目は基準点そのもの)。
 */
function resolveGridPointArray(
  featureId: string,
  layout: Extract<PointArrayLayout, { readonly kind: 'grid' }>,
  plane: WorkPlane,
  context: ResolveContext,
): PointArrayOutcome {
  const base = resolveCoordinate(layout.base, context, featureId);
  if (!base.ok) {
    return { ok: false, error: base.error };
  }
  const rowCount = layout.rowCount.value;
  const rowCountError = checkGridAxisCount(featureId, '行', rowCount);
  if (rowCountError !== null) {
    return { ok: false, error: rowCountError };
  }
  const colCount = layout.colCount.value;
  const colCountError = checkGridAxisCount(featureId, '列', colCount);
  if (colCountError !== null) {
    return { ok: false, error: colCountError };
  }
  if (rowCount * colCount > MAX_POINT_ARRAY_COUNT) {
    return {
      ok: false,
      error: error(
        featureId,
        'invalidValue',
        `点の合計数は ${String(MAX_POINT_ARRAY_COUNT)} 個以下にしてください。`,
      ),
    };
  }
  const rowSpacing = layout.rowSpacing.value;
  if (!Number.isFinite(rowSpacing) || rowSpacing === 0) {
    return { ok: false, error: error(featureId, 'invalidValue', '行の間隔に 0 は指定できません。') };
  }
  const colSpacing = layout.colSpacing.value;
  if (!Number.isFinite(colSpacing) || colSpacing === 0) {
    return { ok: false, error: error(featureId, 'invalidValue', '列の間隔に 0 は指定できません。') };
  }
  const rowAzimuth = layout.rowAzimuth.value;
  const colAzimuth = layout.colAzimuth.value;
  if (!Number.isFinite(rowAzimuth) || !Number.isFinite(colAzimuth)) {
    return { ok: false, error: error(featureId, 'invalidValue', '方向の角度が数になっていません。') };
  }
  const rowDirection = directionInPlane(plane, rowAzimuth);
  const colDirection = directionInPlane(plane, colAzimuth);
  const points: ResolvedPoint[] = [];
  for (let row = 0; row < rowCount; row += 1) {
    for (let col = 0; col < colCount; col += 1) {
      const index = row * colCount + col;
      const position = addVec3(
        base.value,
        addVec3(scaleVec3(rowDirection, rowSpacing * row), scaleVec3(colDirection, colSpacing * col)),
      );
      points.push({ id: `${featureId}#${String(index)}`, featureId, position,
        producerAnchor: { kind: 'grid-point', featureId, row, column: col } });
    }
  }
  return { ok: true, points };
}

/** 点列を並べ方(`layout.kind`)で分岐して解決する(FR-308、FR-327)。 */
function resolvePointArrayFeature(
  featureId: string,
  layout: PointArrayLayout,
  plane: WorkPlane,
  context: ResolveContext,
): PointArrayOutcome {
  switch (layout.kind) {
    case 'linear':
      return resolveLinearPointArray(featureId, layout, plane, context);
    case 'circular':
      return resolveCircularPointArray(featureId, layout, plane, context);
    case 'grid':
      return resolveGridPointArray(featureId, layout, plane, context);
  }
}

/**
 * 解決のときに外から渡せる手掛かり。
 *
 * 基準の 3 面(`WORK_PLANES`)はこのファイルだけで引けるが、任意の作業平面(FR-328)は
 * 部品文書の基準ジオメトリを見ないと決まらない。スケッチ 1 本は部品文書を知らないので、
 * 「作図面の id から平面を引く関数」を外から受け取る形にする(`resolvePart` が渡す)。
 * 渡されなければ基準の 3 面だけを引き、任意平面の id は `missingBase` で断る。
 */
export interface SketchResolveOptions {
  /** Current-generation mathematical failures. Cached fields of these owners are never resolved. */
  readonly invalidInputs?: ReadonlyMap<string, string>;
  readonly workPlane?: (planeId: WorkPlaneId) => WorkPlane | null;
  /**
   * 立体の部分形状(頂点・辺・面)の選び直し(FR-330)。
   * 渡されなければ保存された指紋の位置をそのまま使う(`resolveCoordinate.ts` の注釈)。
   * 上流の立体の変化への追従は部品文書の側が担う。
   */
  readonly subShape?: (reference: SubShapeRef) => ResolvedSubShape | null;
  /**
   * 計算済みのオフセット(FR-321)の曲線を鍵で引く。
   *
   * オフセットの形は OCCT に解いてもらうので、ここでは**読むだけ**にして解決を
   * 純関数のまま保つ。引けなければ「まだ計算していない」として `pendingOffsets` へ
   * 積み、カーネルへ頼むのは `recomputeSketch` の役目(`offsetMath.ts` の注釈)。
   */
  readonly offsetCurves?: (key: string) => readonly ResolvedCurve[] | null;
  /**
   * 計算済みの投影・交差(FR-325)の曲線を**フィーチャーの id で**引く。
   *
   * オフセット(`offsetCurves`)が鍵で引くのに対してこちらが id で引くのは、
   * 投影の鍵の材料に「もとの立体の段の鍵」が要り、それはスケッチ 1 本からは
   * 分からないため(`projectionMath.ts` の `ProjectionKeyMaterial` の注釈)。
   * 鍵を組み立てて覚え書きを引き、この関数を作るのは `resolvePart` の役目である。
   * 引けなければ「まだ計算していない」として `pendingProjections` へ積む。
   */
  readonly projectedCurves?: (featureId: string) => readonly ResolvedCurve[] | null;
  /** Current-generation, XYZ-clipped function geometry, supplied only after both workers succeed. */
  readonly functionCurves?: (featureId: string) => readonly ResolvedCurve[] | null;
  /**
   * 拘束を解いた後の点の位置(FR-313、3 段の解決の③)。
   *
   * 鍵は `ResolvedPoint.id` / `vertexKey` と同じ規約(点フィーチャーは `featureId`、
   * 線分の端点は `featureId:start` / `:end`、円弧・楕円の中心は `featureId:center`、
   * 点列・スプラインの n 番目は `featureId#n`)。**別の規約をここで作らない。**
   *
   * 差し込むのは解いた座標を持ちうる点(点・線分の端点・円弧と楕円の中心・円弧の端点・
   * スプラインの各点)だけ。規則から導かれる点(点列・複製・オフセット・投影・矩形・
   * 正多角形・長穴)はもとの規則から作り直されるので、ここへ入れても使われない
   * (`constraints/variables.ts` が同じ理由でそれらを変数にしない)。
   *
   * 上書きは `resolveCoordinate` が世界座標を出した**直後**に差し込む。相対座標・
   * 極座標の基準になっている点が上書きされれば、その下流も自動的に付いてくる。
   */
  readonly pointOverrides?: ReadonlyMap<string, Vec3>;
  /**
   * 拘束を解いた後の半径(同上)。鍵は `constraints/variables.ts` の
   * `radiusComponentKey`(円弧・円は `featureId.r`、楕円は `featureId.rmajor` /
   * `featureId.rminor`)。楕円は 1 フィーチャーに半径が 2 つあり、フィーチャーの id
   * だけでは区別できないのでこの鍵を借りる。
   */
  readonly radiusOverrides?: ReadonlyMap<string, number>;
  /**
   * 球の基本形状(FR-429)を id から引く(球面上の点 FR-431)。
   *
   * スケッチ 1 本は立体を知らないので、`ResolveContext.sphere` と同じ口をここでも外から
   * 受け取る(`subShape` と同じ考え方)。渡されなければ球を 1 つも知らない扱いになり、
   * `sphereGrid` の点は `resolveCoordinate.ts` の `MISSING_SPHERE_MESSAGE` で断る。
   * 球を引くのは部品文書の側(`resolvePart.ts`)の役目である。
   */
  readonly sphere?: (sphereFeatureId: string) => ResolvedSphere | null;
  readonly functionPoint?: TypeFunctionPointResolver;
  /** 部品の基準点を id から引く。`ResolveContext.partPoint` へそのまま渡す。部品文書の側(`resolvePart.ts`)が渡す。 */
  readonly partPoint?: ResolveContext['partPoint'];
}

/** 円弧の面の中で、その点が中心から見て何ラジアンの向きにあるか(`arcPointAt` の逆)。 */
function arcAngleOf(arc: ResolvedArc, world: Vec3): number {
  const yAxis = crossVec3(arc.normal, arc.xAxis);
  const spoke = subVec3(world, arc.center);
  return Math.atan2(dotVec3(spoke, yAxis), dotVec3(spoke, arc.xAxis));
}

/**
 * 拘束で動いた円弧の端点から、開始角・終了角を逆算する(FR-313)。
 *
 * 円弧の端点は拘束の変数(`constraints/variables.ts`。角度を変数にすると端点座標と
 * 二重定義になるため、角度ではなく端点そのものを動かす約束)。動いた端点をそのまま
 * 描くには、ここで角へ直してやる必要がある。
 *
 * **上書きが 1 つも無ければ保存された角をそのまま使う。** `Math.atan2` の戻りは
 * (−π, π] なので、370 度のように範囲の外に書かれた角を無条件に逆算し直すと、
 * 上書きが無いのに円弧がずれてしまう。
 *
 * 掃く向き(正か負か)と 1 周を超えない性質は保存された角から引き継ぐ。動いた端点が
 * 開始点と重なってしまう(掃く量が 0 になる)ときは、円弧を壊さないよう元の角を残す。
 */
function withOverriddenEndpoints(
  arc: ResolvedArc,
  start: Vec3 | undefined,
  end: Vec3 | undefined,
): ResolvedArc {
  if (start === undefined && end === undefined) {
    return arc;
  }
  const startAngle = start === undefined ? arc.startAngle : arcAngleOf(arc, start);
  const rawEnd = end === undefined ? arc.endAngle : arcAngleOf(arc, end);
  // 掃く量を [0, 2π) へ畳んでから、保存された向きが負なら 1 周ぶん引いて (−2π, 0] にする。
  const folded = (((rawEnd - startAngle) % FULL_TURN) + FULL_TURN) % FULL_TURN;
  const sweep = arc.endAngle >= arc.startAngle ? folded : folded - FULL_TURN;
  if (Math.abs(sweep) <= FULL_TURN_EPSILON) {
    return arc;
  }
  return { ...arc, startAngle, endAngle: startAngle + sweep };
}

/**
 * 3D スケッチ(FR-330)の円弧の向きを解く。作図面があればそこから借り、
 * 無ければフィーチャー自身の `freeOrientation` から作る。
 *
 * 第1軸は法線に垂直な成分だけを使う(`planeMath.ts` の `planeAxesFor` と同じ考え方)。
 * ただしここでは補助ベクトルへ戻さず、垂直な成分が無い(法線と平行な)ときは断る。
 * 利用者が指定した向きを黙って別の向きに置き換えると、画面に出る角度 0 の位置が
 * 予測できなくなるため。
 */
function resolveArcOrientation(
  featureId: string,
  plane: WorkPlane | null,
  orientation: FreeArcOrientation | undefined,
  context: ResolveContext,
): ResolveOutcome<{ readonly normal: Vec3; readonly xAxis: Vec3 }> {
  if (plane !== null) {
    return { ok: true, value: { normal: plane.normal, xAxis: plane.axisU } };
  }
  if (orientation === undefined) {
    return {
      ok: false,
      error: error(
        featureId,
        'missingBase',
        '3D スケッチの円弧には向きの指定が必要です。法線と角度 0 の向きを決めてください。',
      ),
    };
  }
  const normal = resolveCoordinate(orientation.normal, context, featureId);
  if (!normal.ok) {
    return normal;
  }
  if (lengthVec3(normal.value) <= SKETCH_TOLERANCE_MM) {
    return {
      ok: false,
      error: error(featureId, 'degenerate', '円弧の向き(法線)の長さが 0 です。'),
    };
  }
  const unitNormal = normalizeVec3(normal.value);
  const hint = resolveCoordinate(orientation.xAxis, context, featureId);
  if (!hint.ok) {
    return hint;
  }
  const projected = subVec3(hint.value, scaleVec3(unitNormal, dotVec3(hint.value, unitNormal)));
  if (lengthVec3(projected) <= SKETCH_TOLERANCE_MM) {
    return {
      ok: false,
      error: error(
        featureId,
        'degenerate',
        '角度 0 の向きが法線と平行です。法線と違う向きを指定してください。',
      ),
    };
  }
  return { ok: true, value: { normal: unitNormal, xAxis: normalizeVec3(projected) } };
}

/**
 * スケッチの履歴を先頭から順に解決する(要件§6.3)。
 * 途中のフィーチャーが解決できなくても止めず、そのフィーチャーだけを errors に入れて先へ進む
 * (FR-504、NFR-RE-1)。解決できなかったフィーチャーは以後の参照先にならない。
 *
 * 1 回の解決の記録は `resolveSketchState.ts`、種類ごとの解き方はこのファイルの resolve…Step と
 * `resolveSketchDerived.ts` が持つ。ここは記録を作り、履歴を 1 行ずつ渡すだけ。
 */
export function resolveSketch(
  document: SketchDocument,
  options: SketchResolveOptions = {},
): ResolvedSketch {
  const lookups = createSketchResolveLookups(options);
  const state = createSketchResolveState();
  for (const feature of document.features) {
    resolveHistoryStep(feature, options, lookups, state);
  }
  return sketchResultOf(state);
}

/** 外から渡された引き口に、渡されなかったときの既定を入れる。 */
function createSketchResolveLookups(options: SketchResolveOptions): SketchResolveLookups {
  // 拘束を解いた結果の差し込み(FR-313)。渡されなければ何も上書きしないので、
  // 拘束を持たない文書の解決は 1 行も余分な処理を通らない。
  const pointOverrides = options.pointOverrides;
  const radiusOverrides = options.radiusOverrides;
  return {
    workPlane: options.workPlane ?? baseWorkPlane,
    // 渡されなければ、すべてのオフセットが「まだ計算していない」扱いになる。
    offsetCurves: options.offsetCurves ?? ((): null => null),
    // 渡されなければ、すべての投影・交差が「まだ計算していない」扱いになる。
    projectedCurves: options.projectedCurves ?? ((): null => null),
    // 渡されなければ、関数の曲線はすべて「再計算が完了していない」扱いになる。
    functionCurves: (featureId) => options.functionCurves?.(featureId),
    pointOverrides,
    overridePoint: (key, value) => pointOverrides?.get(key) ?? value,
    overrideRadius: (key, value) => radiusOverrides?.get(key) ?? value,
  };
}

/** 履歴の 1 行を解く。値の不正な入力 → 面 → 作図面を引く → 種類ごとの解き方、の順に見る。 */
function resolveHistoryStep(
  feature: SketchFeature,
  options: SketchResolveOptions,
  lookups: SketchResolveLookups,
  state: SketchResolveState,
): void {
  const invalid = options.invalidInputs?.get(feature.id);
  if (invalid !== undefined) {
    state.errors.push({ featureId: feature.id, code: 'invalidValue', message: invalid });
    // A failed point-producing step must not make "previous" silently refer to an older point.
    if (feature.kind !== 'face') {
      state.previous = null;
    }
    return;
  }
  // 面は作図面を使わない(境界に選んだ要素だけで決まる)ので、作図面を引く前に片づける。
  if (feature.kind === 'face') {
    resolveFaceStep(feature, state);
    return;
  }
  // 作図面は基準の 3 面か、部品文書の作業平面フィーチャー(FR-328)。
  // 3D スケッチ(FR-330)だけは「作図面が無い」ことが正しい状態なので、
  // 引く前に分ける。それ以外で見つからなければ、そのフィーチャーだけを断って先へ進む
  // (FR-504、NFR-RE-1)。
  const free = isFreeWorkPlaneId(feature.planeId);
  const plane = free ? null : lookups.workPlane(feature.planeId);
  if (!free && plane === null) {
    state.errors.push(
      error(feature.id, 'missingBase', `作図面が見つかりません: ${feature.planeId}`),
    );
    return;
  }
  // subShape が渡されなければ `resolvePointReference` が保存された指紋の位置を使う。
  // sphere が渡されなければ球面上の点(FR-431)は「球が見つかりません」で断る。
  const context: ResolveContext = {
    plane,
    points: state.points,
    previous: state.previous,
    vertices: state.vertices,
    subShape: options.subShape,
    sphere: options.sphere,
    functionPoint: options.functionPoint,
    partPoint: options.partPoint,
  };
  resolvePlacedFeature(feature, { plane, context, state, lookups });
}

/** 面(FR-309)。境界に選んだ要素だけで決まる。解決できた面だけを faces へ積む。 */
function resolveFaceStep(feature: SketchFaceFeature, state: SketchResolveState): void {
  const face = resolveFace(
    feature,
    state.pointsByFeature,
    state.curveByFeature,
    state.curvesByFeature,
    state.constructionFeatureIds,
  );
  if (!face.ok) {
    state.errors.push(face.error);
    return;
  }
  state.faces.push(face.value);
}

/** 作図面の上(3D スケッチを含む)のフィーチャーを、種類ごとの解き方へ渡す。 */
function resolvePlacedFeature(
  feature: Exclude<SketchFeature, SketchFaceFeature>,
  step: SketchFeatureStep,
): void {
  switch (feature.kind) {
    case 'point':
      resolvePointStep(feature, step);
      return;
    case 'line':
      resolveLineStep(feature, step);
      return;
    case 'arc':
      resolveArcStep(feature, step);
      return;
    case 'pointArray':
      resolvePointArrayStep(feature, step);
      return;
    case 'rectangle':
      resolveRectangleStep(feature, step);
      return;
    case 'polygon':
      resolvePolygonStep(feature, step);
      return;
    case 'slot':
      resolveSlotStep(feature, step);
      return;
    case 'ellipse':
      resolveEllipseStep(feature, step);
      return;
    case 'spline':
      resolveSplineStep(feature, step);
      return;
    case 'offset':
      resolveOffsetStep(feature, step);
      return;
    case 'copy':
      resolveCopyFeatureStep(feature, step);
      return;
    case 'functionCurve':
      resolveFunctionCurveStep(feature, step);
      return;
    case 'projectedCurve':
    case 'planeSection':
      resolveProjectionStep(feature, step);
      return;
  }
}

/** 点(FR-301)。 */
function resolvePointStep(feature: SketchPointFeature, step: SketchFeatureStep): void {
  const at = resolveCoordinate(feature.at, step.context, feature.id);
  if (!at.ok) {
    step.state.errors.push(at.error);
    return;
  }
  // 拘束を解いた位置があればそれを使う。以後の参照(相対座標の基準・
  // 面の境界)はすべてこの位置を見るので、上書きは下流へそのまま伝わる。
  const position = step.lookups.overridePoint(feature.id, at.value);
  const resolved: ResolvedPoint = {
    id: feature.id,
    featureId: feature.id,
    position,
    producerAnchor: { kind: 'point', featureId: feature.id },
  };
  recordPoints(step.state, feature.id, [resolved]);
}

/** 線分(FR-304)。 */
function resolveLineStep(feature: SketchLineFeature, step: SketchFeatureStep): void {
  const { context, state, lookups } = step;
  const from = resolveCoordinate(feature.from, context, feature.id);
  if (!from.ok) {
    state.errors.push(from.error);
    return;
  }
  const fromPoint = lookups.overridePoint(vertexKey(feature.id, 'start'), from.value);
  // 終点は始点を「直前の点」として解決できるようにする(FR-307 の連続描画)。
  // 始点が上書きされていれば、相対指定の終点はその新しい始点から測る。
  const to = resolveCoordinate(feature.to, { ...context, previous: fromPoint }, feature.id);
  if (!to.ok) {
    state.errors.push(to.error);
    return;
  }
  const toPoint = lookups.overridePoint(vertexKey(feature.id, 'end'), to.value);
  if (isSamePoint(fromPoint, toPoint)) {
    state.errors.push(error(feature.id, 'degenerate', '線分の長さが 0 です。'));
    return;
  }
  const segment: ResolvedSegment = {
    kind: 'segment',
    featureId: feature.id,
    from: fromPoint,
    to: toPoint,
  };
  recordCurve(state, feature.id, feature.construction, segment);
}

/** 円弧(FR-305)。 */
function resolveArcStep(feature: SketchArcFeature, step: SketchFeatureStep): void {
  const { context, state, lookups } = step;
  const center = resolveCoordinate(feature.center, context, feature.id);
  if (!center.ok) {
    state.errors.push(center.error);
    return;
  }
  const centerPoint = lookups.overridePoint(vertexKey(feature.id, 'center'), center.value);
  const radius = lookups.overrideRadius(
    radiusComponentKey(feature.id, 'radius'),
    feature.radius.value,
  );
  if (!Number.isFinite(radius) || radius < 0) {
    state.errors.push(error(feature.id, 'invalidValue', '半径は 0 より大きい必要があります。'));
    return;
  }
  // 半径 0(と許容誤差に埋もれる大きさ)は円弧として成り立たない。
  if (radius <= SKETCH_TOLERANCE_MM) {
    state.errors.push(error(feature.id, 'degenerate', '半径が小さすぎて円弧になりません。'));
    return;
  }
  if (!Number.isFinite(feature.startAngle.value) || !Number.isFinite(feature.endAngle.value)) {
    state.errors.push(error(feature.id, 'invalidValue', '角度の値が数になっていません。'));
    return;
  }
  const startAngle = degreesToRadians(feature.startAngle.value);
  const endAngle = degreesToRadians(feature.endAngle.value);
  if (Math.abs(endAngle - startAngle) <= FULL_TURN_EPSILON) {
    state.errors.push(error(feature.id, 'degenerate', '開始角と終了角が同じです。'));
    return;
  }
  // 向きは作図面から借りるか、3D スケッチなら円弧自身の指定から作る(FR-330)。
  const orientation = resolveArcOrientation(
    feature.id,
    step.plane,
    feature.freeOrientation,
    context,
  );
  if (!orientation.ok) {
    state.errors.push(orientation.error);
    return;
  }
  const arc = withOverriddenEndpoints(
    {
      kind: 'arc',
      featureId: feature.id,
      center: centerPoint,
      normal: orientation.value.normal,
      xAxis: orientation.value.xAxis,
      radius,
      startAngle,
      endAngle,
    },
    lookups.pointOverrides?.get(vertexKey(feature.id, 'start')),
    lookups.pointOverrides?.get(vertexKey(feature.id, 'end')),
  );
  state.vertices.set(vertexKey(feature.id, 'center'), centerPoint);
  recordCurve(state, feature.id, feature.construction, arc);
}

/** 点列(FR-308、FR-327)。作図面の中の並びで決まるので、3D スケッチでは断る。 */
function resolvePointArrayStep(feature: SketchPointArrayFeature, step: SketchFeatureStep): void {
  const { plane, state } = step;
  if (plane === null) {
    state.errors.push(needsWorkPlane(feature.id, '点列'));
    return;
  }
  const outcome = resolvePointArrayFeature(feature.id, feature.layout, plane, step.context);
  if (!outcome.ok) {
    state.errors.push(outcome.error);
    return;
  }
  recordPoints(state, feature.id, outcome.points);
}

/** 矩形(FR-314)。 */
function resolveRectangleStep(feature: SketchRectangleFeature, step: SketchFeatureStep): void {
  const { plane, context, state } = step;
  if (plane === null) {
    state.errors.push(needsWorkPlane(feature.id, '矩形'));
    return;
  }
  const corner1 = resolveCoordinate(feature.corner1, context, feature.id);
  if (!corner1.ok) {
    state.errors.push(corner1.error);
    return;
  }
  // 2 点目は 1 点目を「直前の点」として解決できるようにする(FR-307 と同じ考え方)。
  const corner2 = resolveCoordinate(
    feature.corner2,
    { ...context, previous: corner1.value },
    feature.id,
  );
  if (!corner2.ok) {
    state.errors.push(corner2.error);
    return;
  }
  const rectangle = resolveRectangleCurves(feature.id, plane, corner1.value, corner2.value);
  if (!rectangle.ok) {
    state.errors.push(rectangle.error);
    return;
  }
  recordCurveGroup(state, feature.id, feature.construction, rectangle.curves);
}

/** 正多角形(FR-315)。中心を端点の手掛かり `center` にも残す。 */
function resolvePolygonStep(feature: SketchPolygonFeature, step: SketchFeatureStep): void {
  const { plane, state } = step;
  if (plane === null) {
    state.errors.push(needsWorkPlane(feature.id, '正多角形'));
    return;
  }
  const center = resolveCoordinate(feature.center, step.context, feature.id);
  if (!center.ok) {
    state.errors.push(center.error);
    return;
  }
  const sides = feature.sides.value;
  if (!Number.isFinite(sides) || !Number.isInteger(sides) || sides < 3) {
    state.errors.push(error(feature.id, 'invalidValue', '辺の数は 3 以上にしてください。'));
    return;
  }
  const radius = feature.radius.value;
  if (!Number.isFinite(radius) || radius < 0) {
    state.errors.push(error(feature.id, 'invalidValue', '半径は 0 より大きい必要があります。'));
    return;
  }
  if (radius <= SKETCH_TOLERANCE_MM) {
    state.errors.push(error(feature.id, 'degenerate', '半径が小さすぎて正多角形になりません。'));
    return;
  }
  const polygon = resolvePolygonCurves(
    feature.id,
    plane,
    center.value,
    sides,
    feature.radiusMode,
    radius,
  );
  if (!polygon.ok) {
    state.errors.push(polygon.error);
    return;
  }
  state.vertices.set(vertexKey(feature.id, 'center'), center.value);
  recordCurveGroup(state, feature.id, feature.construction, polygon.curves);
}

/** 長穴(FR-316)。2 つ目の中心は 1 つ目を「直前の点」として解決できる。 */
function resolveSlotStep(feature: SketchSlotFeature, step: SketchFeatureStep): void {
  const { plane, context, state } = step;
  if (plane === null) {
    state.errors.push(needsWorkPlane(feature.id, '長穴'));
    return;
  }
  const center1 = resolveCoordinate(feature.center1, context, feature.id);
  if (!center1.ok) {
    state.errors.push(center1.error);
    return;
  }
  const center2 = resolveCoordinate(
    feature.center2,
    { ...context, previous: center1.value },
    feature.id,
  );
  if (!center2.ok) {
    state.errors.push(center2.error);
    return;
  }
  const width = feature.width.value;
  if (!Number.isFinite(width) || width < 0) {
    state.errors.push(error(feature.id, 'invalidValue', '幅は 0 より大きい必要があります。'));
    return;
  }
  const slot = resolveSlotCurves(feature.id, plane, center1.value, center2.value, width);
  if (!slot.ok) {
    state.errors.push(slot.error);
    return;
  }
  recordCurveGroup(state, feature.id, feature.construction, slot.curves);
}

/** 楕円(FR-318)。利用者が入れる方位角を、楕円の径数方程式のパラメータ角へ直してから持つ。 */
function resolveEllipseStep(feature: SketchEllipseFeature, step: SketchFeatureStep): void {
  const { plane, state, lookups } = step;
  if (plane === null) {
    state.errors.push(needsWorkPlane(feature.id, '楕円'));
    return;
  }
  const center = resolveCoordinate(feature.center, step.context, feature.id);
  if (!center.ok) {
    state.errors.push(center.error);
    return;
  }
  const centerPoint = lookups.overridePoint(vertexKey(feature.id, 'center'), center.value);
  const majorRadius = lookups.overrideRadius(
    radiusComponentKey(feature.id, 'major'),
    feature.majorRadius.value,
  );
  const minorRadius = lookups.overrideRadius(
    radiusComponentKey(feature.id, 'minor'),
    feature.minorRadius.value,
  );
  if (
    !Number.isFinite(majorRadius) ||
    !Number.isFinite(minorRadius) ||
    majorRadius < 0 ||
    minorRadius < 0
  ) {
    state.errors.push(error(feature.id, 'invalidValue', '半径は 0 より大きい必要があります。'));
    return;
  }
  // 半径 0(と許容誤差に埋もれる大きさ)は楕円として成り立たない(円弧と同じ扱い)。
  if (majorRadius <= SKETCH_TOLERANCE_MM || minorRadius <= SKETCH_TOLERANCE_MM) {
    state.errors.push(error(feature.id, 'degenerate', '半径が小さすぎて楕円になりません。'));
    return;
  }
  // 長軸と短軸が入れ替わっているとカーネルが断る(makeEllipseEdge.ts)ので、ここで先に伝える。
  if (majorRadius < minorRadius) {
    state.errors.push(
      error(feature.id, 'invalidValue', '長軸の半径は短軸の半径より大きくしてください。'),
    );
    return;
  }
  if (
    !Number.isFinite(feature.rotation.value) ||
    !Number.isFinite(feature.startAngle.value) ||
    !Number.isFinite(feature.endAngle.value)
  ) {
    state.errors.push(error(feature.id, 'invalidValue', '角度の値が数になっていません。'));
    return;
  }
  const startAzimuth = degreesToRadians(feature.startAngle.value);
  const endAzimuth = degreesToRadians(feature.endAngle.value);
  if (Math.abs(endAzimuth - startAzimuth) <= FULL_TURN_EPSILON) {
    state.errors.push(error(feature.id, 'degenerate', '開始角と終了角が同じです。'));
    return;
  }
  const ellipse: ResolvedEllipse = {
    kind: 'ellipse',
    featureId: feature.id,
    center: centerPoint,
    normal: plane.normal,
    // 長軸の向きは作図面の第1軸から rotation だけ回した向き(円弧・点列と同じ規約)。
    majorAxis: directionInPlane(plane, feature.rotation.value),
    majorRadius,
    minorRadius,
    startAngle: azimuthToEllipseParameter(startAzimuth, majorRadius, minorRadius),
    endAngle: azimuthToEllipseParameter(endAzimuth, majorRadius, minorRadius),
  };
  state.vertices.set(vertexKey(feature.id, 'center'), centerPoint);
  recordCurve(state, feature.id, feature.construction, ellipse);
}

/** スプライン(FR-317)。1 つ目の点はこのフィーチャーを解き始めた時の直前の点を基準にできる。 */
function resolveSplineStep(feature: SketchSplineFeature, step: SketchFeatureStep): void {
  const spline = resolveSplineFeature(
    feature,
    step.context,
    step.context.previous,
    step.lookups.overridePoint,
  );
  if (!spline.ok) {
    step.state.errors.push(spline.error);
    return;
  }
  recordCurve(step.state, feature.id, feature.construction, spline.value);
}

type SplineOutcome =
  | { readonly ok: true; readonly value: ResolvedSpline }
  | { readonly ok: false; readonly error: SketchError };

/**
 * スプライン(FR-317)を解決する。点の数と重なりを先に確かめてから座標を解く。
 * 断りの文言はカーネル(`makeSplineEdge.ts`)と揃えてあるので、下描きと本物の曲線が
 * 同じ入力に対して同じ理由で断る(`splineMath.ts` の注釈)。
 *
 * 2 番目以降の点は 1 つ前の点を「直前の点」として解決できるようにする
 * (線分の終点・矩形の 2 点目と同じ考え方、FR-307)。
 */
function resolveSplineFeature(
  feature: SketchSplineFeature,
  context: ResolveContext,
  previous: Vec3 | null,
  /** 拘束を解いた位置の差し込み。鍵はスプラインの n 番目の点(`featureId#n`)。 */
  overridePoint: (key: string, value: Vec3) => Vec3,
): SplineOutcome {
  const count = feature.points.length;
  const minimum = feature.closed ? MIN_CLOSED_SPLINE_POINTS : MIN_SPLINE_POINTS;
  if (count < minimum) {
    const message = feature.closed ? SPLINE_TOO_FEW_CLOSED_MESSAGE : SPLINE_TOO_FEW_OPEN_MESSAGE;
    return { ok: false, error: error(feature.id, 'tooFewPoints', message) };
  }
  if (count > MAX_SPLINE_POINTS) {
    return { ok: false, error: error(feature.id, 'invalidValue', SPLINE_TOO_MANY_MESSAGE) };
  }

  const positions: Vec3[] = [];
  for (const input of feature.points) {
    const base = positions.length === 0 ? previous : positions[positions.length - 1];
    const resolved = resolveCoordinate(input, { ...context, previous: base }, feature.id);
    if (!resolved.ok) {
      return { ok: false, error: resolved.error };
    }
    // 上書きした点が次の点の「直前の点」にもなるので、相対指定の下流も付いてくる。
    positions.push(overridePoint(`${feature.id}#${positions.length}`, resolved.value));
  }

  // 通過点方式は弦の長さでパラメータを決めるので、重なった点があると曲線が定まらない。
  // 制御点方式は重なっていても構わない(カーネルと同じ扱い)。
  if (feature.mode === 'interpolate' && hasDuplicateSplinePoint(positions, feature.closed)) {
    return { ok: false, error: error(feature.id, 'degenerate', SPLINE_DUPLICATE_POINT_MESSAGE) };
  }

  return {
    ok: true,
    value: {
      kind: 'spline',
      featureId: feature.id,
      mode: feature.mode,
      points: positions,
      closed: feature.closed,
    },
  };
}

type FaceOutcome =
  | { readonly ok: true; readonly value: ResolvedFace }
  | { readonly ok: false; readonly error: SketchError };

/**
 * 面の境界を組み立てる(FR-309)。点だけ、または線・円弧だけを並べる。
 * 曲線の向きは変えない。ワイヤの向きはカーネル側の MakeWire が揃える。
 *
 * 矩形・正多角形・長穴(`curvesByFeature`)は、`index` を指定すれば n 番目の曲線だけ、
 * 省略すればそのフィーチャーの全曲線を順に展開して使う。
 *
 * 構築線(FR-320)は選べない: `constructionFeatureIds` に featureId があれば
 * `constructionElement` で断る(点・点列・面は construction を持たないため、この検査に
 * 現れるのは常に曲線の参照)。
 */
function resolveFace(
  feature: SketchFaceFeature,
  pointsByFeature: ReadonlyMap<string, readonly ResolvedPoint[]>,
  curveByFeature: ReadonlyMap<string, ResolvedCurve>,
  curvesByFeature: ReadonlyMap<string, readonly ResolvedCurve[]>,
  constructionFeatureIds: ReadonlySet<string>,
): FaceOutcome {
  if (feature.boundary.length === 0) {
    return { ok: false, error: error(feature.id, 'tooFewPoints', '面の境界が選ばれていません。') };
  }

  const pickedPoints: Vec3[] = [];
  const pickedCurves: ResolvedCurve[] = [];

  for (const reference of feature.boundary) {
    if (constructionFeatureIds.has(reference.featureId)) {
      return {
        ok: false,
        error: error(feature.id, 'constructionElement', '構築線は面の境界に使えません。'),
      };
    }
    const curve = curveByFeature.get(reference.featureId);
    if (curve !== undefined) {
      pickedCurves.push(curve);
      continue;
    }
    const curveGroup = curvesByFeature.get(reference.featureId);
    if (curveGroup !== undefined) {
      if (reference.index === undefined) {
        pickedCurves.push(...curveGroup);
        continue;
      }
      const selected = curveGroup[reference.index];
      if (selected === undefined) {
        return {
          ok: false,
          error: error(
            feature.id,
            'missingBase',
            `境界の曲線が見つかりません: ${reference.featureId}#${String(reference.index)}`,
          ),
        };
      }
      pickedCurves.push(selected);
      continue;
    }
    const group = pointsByFeature.get(reference.featureId);
    if (group === undefined) {
      return {
        ok: false,
        error: error(
          feature.id,
          'missingBase',
          `境界の要素が見つかりません: ${reference.featureId}`,
        ),
      };
    }
    // 点列の中の 1 点を指すときだけ index を付ける。省略なら先頭。
    const point = group[reference.index ?? 0];
    if (point === undefined) {
      return {
        ok: false,
        error: error(feature.id, 'missingBase', `境界の点が見つかりません: ${reference.featureId}`),
      };
    }
    pickedPoints.push(point.position);
  }

  if (pickedPoints.length > 0 && pickedCurves.length > 0) {
    return {
      ok: false,
      error: error(feature.id, 'mixedBoundary', '点と線を混ぜて面を張ることはできません。'),
    };
  }

  if (pickedCurves.length > 0) {
    return resolveCurveLoop(feature, pickedCurves);
  }

  if (pickedPoints.length < 3) {
    return {
      ok: false,
      error: error(feature.id, 'tooFewPoints', '面を張るには点が 3 個以上必要です。'),
    };
  }

  // 隣り合う点の間に線分を作り、最後と最初もつなぐ(FR-309)。
  const curves: ResolvedCurve[] = [];
  for (let index = 0; index < pickedPoints.length; index += 1) {
    const from = pickedPoints[index];
    const to = pickedPoints[(index + 1) % pickedPoints.length];
    if (isSamePoint(from, to)) {
      return { ok: false, error: error(feature.id, 'degenerate', '同じ点が続いています。') };
    }
    curves.push({ kind: 'segment', featureId: feature.id, from, to });
  }
  // 一直線上の点だけでは平面が定まらない。同じ平面に乗らない(notPlanar)とは分けて伝える。
  if (fitPlaneNormal(pickedPoints) === null) {
    return {
      ok: false,
      error: error(
        feature.id,
        'collinear',
        '選んだ点が一直線に並んでいるため、面を張れませんでした。3 点目を線から外してください。',
      ),
    };
  }
  if (!isPlanar(pickedPoints)) {
    return {
      ok: false,
      error: error(feature.id, 'notPlanar', '選んだ点が同じ平面に乗っていません。'),
    };
  }
  return { ok: true, value: { featureId: feature.id, color: feature.color, curves } };
}

/**
 * 関数の閉じた輪(明示した節点の 3 次、`closed: false`)が 1 本で輪になるか。`splineCurveData` が
 * 両端の多重度 4 の固定端として解けるときだけ、最初と最後の極が曲線の両端になる。その 2 点が同じ座標
 * (+0 と −0 は同じ)なら輪になる。許容差では閉じたことにせず、継ぎ目の滑らかさ(周期・C2)も主張しない。
 */
function isClampedClosedLoop(spline: ResolvedSpline): boolean {
  if (spline.knots === undefined || splineCurveData(spline) === null) return false;
  const start = spline.points[0], end = spline.points[spline.points.length - 1];
  return start[0] === end[0] && start[1] === end[1] && start[2] === end[2];
}

/** 線・円弧を端点のつながりでたどり、閉ループになっているか確かめる(FR-309)。 */
function resolveCurveLoop(
  feature: SketchFaceFeature,
  curves: readonly ResolvedCurve[],
): FaceOutcome {
  const first = curves[0];
  if (curves.length === 1) {
    // 1 本で輪になるのは、全周の円・全周の楕円・閉じたスプラインの 3 つ。
    if (first.kind === 'arc' && isFullCircle(first)) {
      return { ok: true, value: { featureId: feature.id, color: feature.color, curves } };
    }
    if (first.kind === 'ellipse' && isFullEllipse(first)) {
      return { ok: true, value: { featureId: feature.id, color: feature.color, curves } };
    }
    if (first.kind === 'spline' && (first.closed || isClampedClosedLoop(first))) {
      // 円・楕円と違い、閉じたスプラインは平面に乗るとは限らない(FR-309 は平面の面だけ)。
      if (!isPlanar(curveSamplePoints(first))) {
        return {
          ok: false,
          error: error(feature.id, 'notPlanar', '選んだ線が同じ平面に乗っていません。'),
        };
      }
      return { ok: true, value: { featureId: feature.id, color: feature.color, curves } };
    }
    return { ok: false, error: error(feature.id, 'notClosed', '1 本では閉じた形になりません。') };
  }

  // 2 本目以降は選んだ向きが逆でもつながっていれば受け入れる。1 本目は選んだ向きのまま
  // 歩き始める(たどり方そのものは `intersectionMath.ts` の `traceCurveChain`)。
  const traced = traceCurveChain(curves);
  if (!traced.ok) {
    return {
      ok: false,
      error: error(feature.id, 'notClosed', '選んだ線・円弧の端がつながっていません。'),
    };
  }
  if (!traced.chain.closed) {
    return {
      ok: false,
      error: error(feature.id, 'notClosed', '最後の端が最初の端に戻っていません。'),
    };
  }
  const samples = curves.flatMap((curve) => curveSamplePoints(curve));
  if (!isPlanar(samples)) {
    return {
      ok: false,
      error: error(feature.id, 'notPlanar', '選んだ線が同じ平面に乗っていません。'),
    };
  }
  return { ok: true, value: { featureId: feature.id, color: feature.color, curves } };
}
