/**
 * スケッチの履歴全体をワールド座標へ解決する(計画書 docs/plans/P1-式とスケッチ.md タスク11)。
 *
 * 履歴を先頭から順にたどり、点・線分・円弧・点列・面を組み立てる(要件§6.3)。
 * 途中のフィーチャーが解決できなくても止めず、そのフィーチャーだけを errors へ入れて
 * 先へ進む(FR-504、NFR-RE-1)。解決できなかったフィーチャーは以後の参照先にならない。
 *
 * 座標 1 点の解決は resolveCoordinate.ts の担当で、ここは
 * 「そこまでに解決できたもの」(ResolveContext)を育てながら順に渡す。
 *
 * 作図面は 3 通りある(P4)。基準の 3 面(`WORK_PLANES`)、部品文書の作業平面
 * (FR-328、タスク9。`SketchResolveOptions.workPlane` で引く)、そして
 * **作図面を持たない 3D スケッチ**(FR-330、タスク10。`isFreeWorkPlaneId`)。
 * 3D スケッチで作れるのは点・線分・円弧・スプライン・面の 5 つで、円弧だけは
 * 向き(法線・角度 0 の向き)をフィーチャー自身が持つ。面は境界が同じ平面に乗るときだけ
 * 張れ、乗らなければ `notPlanar` で断る(非平面の面張りはタスク10b)。
 */

import type { ResolvedSubShape } from '../geometry/planeSpec.js';
import type { SubShapeRef } from '../geometry/subShapeRef.js';
import {
  arcPointAt,
  curveEnd,
  curveStart,
  ellipsePointAt,
  FULL_TURN,
  FULL_TURN_EPSILON,
  isFullCircle,
  isFullEllipse,
  traceCurveChain,
} from './intersectionMath.js';
import { resolveCopyFeature } from './copyMath.js';
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
import { offsetCacheKey } from './offsetMath.js';
import {
  resolveCoordinate,
  vertexKey,
  type ResolveContext,
  type ResolveOutcome,
} from './resolveCoordinate.js';
import {
  hasDuplicateSplinePoint,
  MAX_SPLINE_POINTS,
  MIN_CLOSED_SPLINE_POINTS,
  MIN_SPLINE_POINTS,
  SPLINE_DUPLICATE_POINT_MESSAGE,
  SPLINE_TOO_FEW_CLOSED_MESSAGE,
  SPLINE_TOO_FEW_OPEN_MESSAGE,
  SPLINE_TOO_MANY_MESSAGE,
} from './splineMath.js';
import type {
  FreeArcOrientation,
  OffsetContourShape,
  PendingOffset,
  PendingProjection,
  PointArrayLayout,
  ResolvedArc,
  ResolvedCurve,
  ResolvedEllipse,
  ResolvedFace,
  ResolvedPoint,
  ResolvedSegment,
  ResolvedSketch,
  ResolvedSpline,
  SketchDocument,
  SketchElementRef,
  SketchError,
  SketchErrorCode,
  SketchFaceFeature,
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

/** 点列で一度に作れる点の上限。打ち間違いで莫大な数を作らないための歯止め。 */
export const MAX_POINT_ARRAY_COUNT = 1000;

/** 点列の個数の下限。1 個でも点列として成立させる(統括の指示、2026-09-02)。 */
const MIN_POINT_ARRAY_COUNT = 1;

/** 平面の当てはめに使う円弧の標本点の数(両端を含む)。 */
const ARC_PLANE_SAMPLES = 5;

/**
 * 曲線の上の点・全周の判定は `intersectionMath.ts` にある(交点の計算がこれらを使うため
 * そちらへ移した。タスク17)。ここから再輸出して、呼び出し側の import を変えずに済ませる。
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
 * 楕円の径数方程式のパラメータ角へ直す(統括の指示 2026-09-04、計画書 §1.4-8)。
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

/** すべての点が同じ平面に乗っているか(FR-309。非平面は FR-312 で Could なので P1 は断る)。 */
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

function error(featureId: string, code: SketchErrorCode, message: string): SketchError {
  return { featureId, code, message };
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
 * 複数曲線フィーチャー(矩形・正多角形・長穴)の曲線を、種類ごとに `segments` / `arcs` へ積む。
 * 線分・円弧の単体フィーチャーと同じ配列に並ぶことで、UI 側(pickMath.ts 等、タスク11・12)が
 * 既存の `sketch.segments` / `sketch.arcs` の走査をそのまま使える(§2.3)。
 */
function pushCurves(
  curves: readonly PolylineCurve[],
  segments: ResolvedSegment[],
  arcs: ResolvedArc[],
): void {
  for (const curve of curves) {
    if (curve.kind === 'segment') {
      segments.push(curve);
    } else {
      arcs.push(curve);
    }
  }
}

/**
 * 矩形(FR-314)の 4 辺を対角 2 点から作る(§0.a-0.8、タスク4)。対角の 2 点を作図面へ
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
 * 正多角形(FR-315)の n 辺を中心・半径・辺数から作る(タスク4)。半径は円周(外接、頂点円)
 * かアポテム(内接、辺の中点までの距離)かで扱いが違うため、内接のときだけ
 * 外接半径 = 内接半径 ÷ cos(π/n) で頂点円の半径へ変換してから頂点を並べる。
 * 角度 0 は作図面の第1軸(円弧・点列と同じ規約、§2.8)。
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
 * 長穴(FR-316)を 2 中心点+幅から作る(タスク4)。直線区間 2 本(中心を結ぶ向きに平行)+
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
      position: addVec3(base.value, scaleVec3(direction, spacing * index)),
    });
  }
  return { ok: true, points };
}

/**
 * 円周上の点列(FR-327)。中心・半径・個数で等角度に並べる。開始角は常に作図面の
 * 第1軸(角度 0、正多角形 `resolvePolygonCurves` と同じ規約)で、利用者に開始角の
 * 指定は持たせない(計画書 §0.a-0.9 のタスク6 実装内容の型のとおり)。
 */
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
    points.push({ id: `${featureId}#${String(index)}`, featureId, position });
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
      points.push({ id: `${featureId}#${String(index)}`, featureId, position });
    }
  }
  return { ok: true, points };
}

/** 点列を並べ方(`layout.kind`)で分岐して解決する(FR-308、FR-327、タスク6)。 */
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

type OffsetSourceOutcome =
  | { readonly ok: true; readonly curves: readonly ResolvedCurve[] }
  | { readonly ok: false; readonly error: SketchError };

/**
 * オフセット元(FR-321、タスク15)の要素を、選んだ順に曲線の列へ広げる。
 *
 * 参照の解き方は面の境界(`resolveFace`)と同じ約束にそろえる: 単体の線・円弧・楕円・
 * スプラインはそのまま 1 本、矩形などの複数曲線フィーチャーは `index` を省けば全周、
 * 指定すれば n 番目だけ(§0.a-0.8)。点・点列は線ではないので選べない。
 */
function collectOffsetSource(
  featureId: string,
  source: readonly SketchElementRef[],
  curveByFeature: ReadonlyMap<string, ResolvedCurve>,
  curvesByFeature: ReadonlyMap<string, readonly ResolvedCurve[]>,
): OffsetSourceOutcome {
  if (source.length === 0) {
    return {
      ok: false,
      error: error(featureId, 'tooFewPoints', 'ずらす線・円弧が選ばれていません。'),
    };
  }
  const curves: ResolvedCurve[] = [];
  for (const reference of source) {
    const single = curveByFeature.get(reference.featureId);
    if (single !== undefined) {
      curves.push(single);
      continue;
    }
    const group = curvesByFeature.get(reference.featureId);
    if (group === undefined) {
      return {
        ok: false,
        error: error(
          featureId,
          'missingBase',
          `ずらすもとの線が見つかりません: ${reference.featureId}`,
        ),
      };
    }
    if (reference.index === undefined) {
      curves.push(...group);
      continue;
    }
    const selected = group[reference.index];
    if (selected === undefined) {
      return {
        ok: false,
        error: error(
          featureId,
          'missingBase',
          `ずらすもとの線が見つかりません: ${reference.featureId}#${String(reference.index)}`,
        ),
      };
    }
    curves.push(selected);
  }
  return { ok: true, curves };
}

type ContourOutcome =
  | { readonly ok: true; readonly shape: OffsetContourShape }
  | { readonly ok: false; readonly error: SketchError };

/** 開いた輪郭の起点と進む向きをまとめる。向きが定まらなければ断る。 */
function openContour(
  featureId: string,
  startPoint: Vec3,
  towards: Vec3,
  normal: Vec3,
): ContourOutcome {
  const along = subVec3(towards, startPoint);
  if (lengthVec3(along) <= SKETCH_TOLERANCE_MM) {
    return {
      ok: false,
      error: error(featureId, 'degenerate', 'ずらすもとの線の向きが定まりません。'),
    };
  }
  return {
    ok: true,
    shape: {
      closed: false,
      startPoint,
      startDirection: normalizeVec3(along),
      normal,
    },
  };
}

/**
 * オフセット元の曲線の列が並んだ順につながっているかを確かめ、輪になっているか・
 * 開いているならどこからどちら向きにたどり始めるかを返す(FR-321、タスク15)。
 *
 * たどり方は `resolveCurveLoop`(面の境界)と同じなので、歩き方そのものは
 * `intersectionMath.ts` の `traceCurveChain` に 1 つだけ置いてある(タスク17 で共通化)。
 * 違うのは**閉じていなくてもよい**ところと、**1 本目を逆向きにたどってよい**ところで、
 * 開いた輪郭は片側へずらした 1 本の曲線になる(`makeOffsetWire.ts` の `IsOpenResult`)。
 *
 * 進む向きは 1 本目の**端から端への向き**(弦)で近似する。ずらした側の左右を見分ける
 * のに使うだけなので、接線との差が 90 度未満であれば判定は変わらない(半周までの
 * 円弧・楕円弧はこれを満たす)。
 */
function analyzeOffsetContour(
  featureId: string,
  curves: readonly ResolvedCurve[],
  normal: Vec3,
): ContourOutcome {
  // 1 本だけのときは `traceCurveChain` が「1 本で輪になるか」(全周の円・全周の楕円・
  // 閉じたスプライン)をそのまま答えるので、ここで分けなくてよい。
  const traced = traceCurveChain(curves, { allowReversedFirst: true });
  if (!traced.ok) {
    return {
      ok: false,
      error: error(featureId, 'notClosed', '選んだ線・円弧の端がつながっていません。'),
    };
  }
  if (traced.chain.closed) {
    return { ok: true, shape: { closed: true } };
  }
  return openContour(featureId, traced.chain.start, traced.chain.afterFirst, normal);
}

/** 覚え書きから来た曲線に、いまのオフセットフィーチャーの id を付け直す。 */
function retagCurve(curve: ResolvedCurve, featureId: string): ResolvedCurve {
  switch (curve.kind) {
    case 'segment':
      return { ...curve, featureId };
    case 'arc':
      return { ...curve, featureId };
    case 'ellipse':
      return { ...curve, featureId };
    case 'spline':
      return { ...curve, featureId };
  }
}

/**
 * 解決済みの曲線を種類ごとの配列へ積む。オフセットの結果は線分・円弧しか返らない
 * (`makeOffsetWire.ts`)が、型の上では 4 種すべて来うるので全部を受ける。
 */
function pushResolvedCurves(
  curves: readonly ResolvedCurve[],
  segments: ResolvedSegment[],
  arcs: ResolvedArc[],
  ellipses: ResolvedEllipse[],
  splines: ResolvedSpline[],
): void {
  for (const curve of curves) {
    switch (curve.kind) {
      case 'segment':
        segments.push(curve);
        break;
      case 'arc':
        arcs.push(curve);
        break;
      case 'ellipse':
        ellipses.push(curve);
        break;
      case 'spline':
        splines.push(curve);
        break;
    }
  }
}

/**
 * 解決のときに外から渡せる手掛かり(P4 タスク9)。
 *
 * 基準の 3 面(`WORK_PLANES`)はこのファイルだけで引けるが、任意の作業平面(FR-328)は
 * 部品文書の基準ジオメトリを見ないと決まらない。スケッチ 1 本は部品文書を知らないので、
 * 「作図面の id から平面を引く関数」を外から受け取る形にする(`resolvePart` が渡す)。
 * 渡されなければ基準の 3 面だけを引き、任意平面の id は `missingBase` で断る。
 */
export interface SketchResolveOptions {
  readonly workPlane?: (planeId: WorkPlaneId) => WorkPlane | null;
  /**
   * 立体の部分形状(頂点・辺・面)の選び直し(FR-330、タスク10)。
   * 渡されなければ保存された指紋の位置をそのまま使う(`resolveCoordinate.ts` の注釈)。
   * 上流の立体の変化への追従は部品文書の側が担う(タスク25 で配線する)。
   */
  readonly subShape?: (reference: SubShapeRef) => ResolvedSubShape | null;
  /**
   * 計算済みのオフセット(FR-321、タスク15)の曲線を鍵で引く。
   *
   * オフセットの形は OCCT に解いてもらうので、ここでは**読むだけ**にして解決を
   * 純関数のまま保つ。引けなければ「まだ計算していない」として `pendingOffsets` へ
   * 積み、カーネルへ頼むのは `recomputeSketch` の役目(`offsetMath.ts` の注釈)。
   */
  readonly offsetCurves?: (key: string) => readonly ResolvedCurve[] | null;
  /**
   * 計算済みの投影・交差(FR-325、タスク25)の曲線を**フィーチャーの id で**引く。
   *
   * オフセット(`offsetCurves`)が鍵で引くのに対してこちらが id で引くのは、
   * 投影の鍵の材料に「もとの立体の段の鍵」が要り、それはスケッチ 1 本からは
   * 分からないため(`projectionMath.ts` の `ProjectionKeyMaterial` の注釈)。
   * 鍵を組み立てて覚え書きを引き、この関数を作るのは `resolvePart` の役目である。
   * 引けなければ「まだ計算していない」として `pendingProjections` へ積む。
   */
  readonly projectedCurves?: (featureId: string) => readonly ResolvedCurve[] | null;
}

/**
 * 3D スケッチ(FR-330)の円弧の向きを解く(タスク10)。作図面があればそこから借り、
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
 * 3D スケッチ(作図面なし、FR-330)では作れない図形を断る(タスク10)。
 *
 * 3D スケッチで作れるのは点・線分・円弧・スプライン・面の 5 つ(要件 FR-330)。
 * 矩形・正多角形・長穴・楕円・点列は「作図面の中の並び」で形が決まる図形なので、
 * 平面が無いと形自体が定まらない。作図面を選び直せば作れるので、そう伝える。
 */
function needsWorkPlane(featureId: string, label: string): SketchError {
  return error(
    featureId,
    'missingBase',
    `3D スケッチでは${label}を作れません。作図面を選んでから作ってください。`,
  );
}

/**
 * スケッチの履歴を先頭から順に解決する(要件§6.3)。
 * 途中のフィーチャーが解決できなくても止めず、そのフィーチャーだけを errors に入れて先へ進む
 * (FR-504、NFR-RE-1)。解決できなかったフィーチャーは以後の参照先にならない。
 */
export function resolveSketch(
  document: SketchDocument,
  options: SketchResolveOptions = {},
): ResolvedSketch {
  const lookupWorkPlane = options.workPlane ?? baseWorkPlane;
  // 渡されなければ `resolvePointReference` が保存された指紋の位置を使う(タスク10)。
  const subShape = options.subShape;
  // 渡されなければ、すべてのオフセットが「まだ計算していない」扱いになる(タスク15)。
  const lookupOffset = options.offsetCurves ?? ((): null => null);
  // 渡されなければ、すべての投影・交差が「まだ計算していない」扱いになる(タスク25)。
  const lookupProjection = options.projectedCurves ?? ((): null => null);
  const pendingOffsets: PendingOffset[] = [];
  const pendingProjections: PendingProjection[] = [];
  const points: ResolvedPoint[] = [];
  const segments: ResolvedSegment[] = [];
  const arcs: ResolvedArc[] = [];
  const ellipses: ResolvedEllipse[] = [];
  const splines: ResolvedSpline[] = [];
  const faces: ResolvedFace[] = [];
  const errors: SketchError[] = [];
  const vertices = new Map<string, Vec3>();
  const curveByFeature = new Map<string, ResolvedCurve>();
  const pointsByFeature = new Map<string, readonly ResolvedPoint[]>();
  /**
   * 矩形・正多角形・長穴のように「1 フィーチャーが複数の曲線を生む」結果(§0.a-0.8、タスク4)。
   * 既存の線分・円弧(1 フィーチャー = 1 曲線)は単数の curveByFeature のまま残す
   * (既存の呼び出し側を壊さないため)。
   */
  const curvesByFeature = new Map<string, readonly ResolvedCurve[]>();
  /**
   * 構築線(FR-320、タスク6)の featureId。線・円弧・矩形・正多角形・長穴・楕円・スプラインが
   * `construction: true` を持つときにここへ足す。`resolveFace` が面の境界に選ばれていないか
   * ここを見て断る(解決済みの曲線(`ResolvedCurve`)自体には construction を持たせない
   * ため、featureId で引く)。
   */
  const constructionFeatureIds = new Set<string>();
  /** 「直前の点」(FR-302)。点を作ったフィーチャーと線・円弧の終点で更新する。 */
  let previous: Vec3 | null = null;

  for (const feature of document.features) {
    // 面は作図面を使わない(境界に選んだ要素だけで決まる)ので、作図面を引く前に片づける。
    if (feature.kind === 'face') {
      const face = resolveFace(
        feature,
        pointsByFeature,
        curveByFeature,
        curvesByFeature,
        constructionFeatureIds,
      );
      if (!face.ok) {
        errors.push(face.error);
        continue;
      }
      faces.push(face.value);
      continue;
    }

    // 作図面は基準の 3 面か、部品文書の作業平面フィーチャー(FR-328、タスク9)。
    // 3D スケッチ(FR-330、タスク10)だけは「作図面が無い」ことが正しい状態なので、
    // 引く前に分ける。それ以外で見つからなければ、そのフィーチャーだけを断って先へ進む
    // (FR-504、NFR-RE-1)。
    const free = isFreeWorkPlaneId(feature.planeId);
    const plane = free ? null : lookupWorkPlane(feature.planeId);
    if (!free && plane === null) {
      errors.push(
        error(feature.id, 'missingBase', `作図面が見つかりません: ${feature.planeId}`),
      );
      continue;
    }
    const context: ResolveContext = { plane, points, previous, vertices, subShape };

    if (feature.kind === 'point') {
      const at = resolveCoordinate(feature.at, context, feature.id);
      if (!at.ok) {
        errors.push(at.error);
        continue;
      }
      const resolved: ResolvedPoint = { id: feature.id, featureId: feature.id, position: at.value };
      points.push(resolved);
      pointsByFeature.set(feature.id, [resolved]);
      vertices.set(vertexKey(feature.id, 'start'), at.value);
      vertices.set(vertexKey(feature.id, 'end'), at.value);
      previous = at.value;
      continue;
    }

    if (feature.kind === 'line') {
      const from = resolveCoordinate(feature.from, context, feature.id);
      if (!from.ok) {
        errors.push(from.error);
        continue;
      }
      // 終点は始点を「直前の点」として解決できるようにする(FR-307 の連続描画)。
      const to = resolveCoordinate(feature.to, { ...context, previous: from.value }, feature.id);
      if (!to.ok) {
        errors.push(to.error);
        continue;
      }
      if (isSamePoint(from.value, to.value)) {
        errors.push(error(feature.id, 'degenerate', '線分の長さが 0 です。'));
        continue;
      }
      const segment: ResolvedSegment = {
        kind: 'segment',
        featureId: feature.id,
        from: from.value,
        to: to.value,
      };
      segments.push(segment);
      curveByFeature.set(feature.id, segment);
      if (feature.construction) {
        constructionFeatureIds.add(feature.id);
      }
      vertices.set(vertexKey(feature.id, 'start'), from.value);
      vertices.set(vertexKey(feature.id, 'end'), to.value);
      previous = to.value;
      continue;
    }

    if (feature.kind === 'arc') {
      const center = resolveCoordinate(feature.center, context, feature.id);
      if (!center.ok) {
        errors.push(center.error);
        continue;
      }
      const radius = feature.radius.value;
      if (!Number.isFinite(radius) || radius < 0) {
        errors.push(error(feature.id, 'invalidValue', '半径は 0 より大きい必要があります。'));
        continue;
      }
      // 半径 0(と許容誤差に埋もれる大きさ)は円弧として成り立たない。
      if (radius <= SKETCH_TOLERANCE_MM) {
        errors.push(error(feature.id, 'degenerate', '半径が小さすぎて円弧になりません。'));
        continue;
      }
      if (!Number.isFinite(feature.startAngle.value) || !Number.isFinite(feature.endAngle.value)) {
        errors.push(error(feature.id, 'invalidValue', '角度の値が数になっていません。'));
        continue;
      }
      const startAngle = degreesToRadians(feature.startAngle.value);
      const endAngle = degreesToRadians(feature.endAngle.value);
      if (Math.abs(endAngle - startAngle) <= FULL_TURN_EPSILON) {
        errors.push(error(feature.id, 'degenerate', '開始角と終了角が同じです。'));
        continue;
      }
      // 向きは作図面から借りるか、3D スケッチなら円弧自身の指定から作る(FR-330、タスク10)。
      const orientation = resolveArcOrientation(
        feature.id,
        plane,
        feature.freeOrientation,
        context,
      );
      if (!orientation.ok) {
        errors.push(orientation.error);
        continue;
      }
      const arc: ResolvedArc = {
        kind: 'arc',
        featureId: feature.id,
        center: center.value,
        normal: orientation.value.normal,
        xAxis: orientation.value.xAxis,
        radius,
        startAngle,
        endAngle,
      };
      arcs.push(arc);
      curveByFeature.set(feature.id, arc);
      if (feature.construction) {
        constructionFeatureIds.add(feature.id);
      }
      vertices.set(vertexKey(feature.id, 'center'), center.value);
      vertices.set(vertexKey(feature.id, 'start'), curveStart(arc));
      vertices.set(vertexKey(feature.id, 'end'), curveEnd(arc));
      previous = curveEnd(arc);
      continue;
    }

    if (feature.kind === 'pointArray') {
      if (plane === null) {
        errors.push(needsWorkPlane(feature.id, '点列'));
        continue;
      }
      const outcome = resolvePointArrayFeature(feature.id, feature.layout, plane, context);
      if (!outcome.ok) {
        errors.push(outcome.error);
        continue;
      }
      const created = outcome.points;
      points.push(...created);
      pointsByFeature.set(feature.id, created);
      const last = created[created.length - 1];
      vertices.set(vertexKey(feature.id, 'start'), created[0].position);
      vertices.set(vertexKey(feature.id, 'end'), last.position);
      previous = last.position;
      continue;
    }

    if (feature.kind === 'rectangle') {
      if (plane === null) {
        errors.push(needsWorkPlane(feature.id, '矩形'));
        continue;
      }
      const corner1 = resolveCoordinate(feature.corner1, context, feature.id);
      if (!corner1.ok) {
        errors.push(corner1.error);
        continue;
      }
      // 2 点目は 1 点目を「直前の点」として解決できるようにする(FR-307 と同じ考え方)。
      const corner2 = resolveCoordinate(
        feature.corner2,
        { ...context, previous: corner1.value },
        feature.id,
      );
      if (!corner2.ok) {
        errors.push(corner2.error);
        continue;
      }
      const rectangle = resolveRectangleCurves(feature.id, plane, corner1.value, corner2.value);
      if (!rectangle.ok) {
        errors.push(rectangle.error);
        continue;
      }
      pushCurves(rectangle.curves, segments, arcs);
      curvesByFeature.set(feature.id, rectangle.curves);
      if (feature.construction) {
        constructionFeatureIds.add(feature.id);
      }
      const first = rectangle.curves[0];
      const last = rectangle.curves[rectangle.curves.length - 1];
      vertices.set(vertexKey(feature.id, 'start'), curveStart(first));
      vertices.set(vertexKey(feature.id, 'end'), curveEnd(last));
      previous = curveEnd(last);
      continue;
    }

    if (feature.kind === 'polygon') {
      if (plane === null) {
        errors.push(needsWorkPlane(feature.id, '正多角形'));
        continue;
      }
      const center = resolveCoordinate(feature.center, context, feature.id);
      if (!center.ok) {
        errors.push(center.error);
        continue;
      }
      const sides = feature.sides.value;
      if (!Number.isFinite(sides) || !Number.isInteger(sides) || sides < 3) {
        errors.push(error(feature.id, 'invalidValue', '辺の数は 3 以上にしてください。'));
        continue;
      }
      const radius = feature.radius.value;
      if (!Number.isFinite(radius) || radius < 0) {
        errors.push(error(feature.id, 'invalidValue', '半径は 0 より大きい必要があります。'));
        continue;
      }
      if (radius <= SKETCH_TOLERANCE_MM) {
        errors.push(error(feature.id, 'degenerate', '半径が小さすぎて正多角形になりません。'));
        continue;
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
        errors.push(polygon.error);
        continue;
      }
      pushCurves(polygon.curves, segments, arcs);
      curvesByFeature.set(feature.id, polygon.curves);
      if (feature.construction) {
        constructionFeatureIds.add(feature.id);
      }
      const first = polygon.curves[0];
      const last = polygon.curves[polygon.curves.length - 1];
      vertices.set(vertexKey(feature.id, 'center'), center.value);
      vertices.set(vertexKey(feature.id, 'start'), curveStart(first));
      vertices.set(vertexKey(feature.id, 'end'), curveEnd(last));
      previous = curveEnd(last);
      continue;
    }

    if (feature.kind === 'slot') {
      if (plane === null) {
        errors.push(needsWorkPlane(feature.id, '長穴'));
        continue;
      }
      const center1 = resolveCoordinate(feature.center1, context, feature.id);
      if (!center1.ok) {
        errors.push(center1.error);
        continue;
      }
      const center2 = resolveCoordinate(
        feature.center2,
        { ...context, previous: center1.value },
        feature.id,
      );
      if (!center2.ok) {
        errors.push(center2.error);
        continue;
      }
      const width = feature.width.value;
      if (!Number.isFinite(width) || width < 0) {
        errors.push(error(feature.id, 'invalidValue', '幅は 0 より大きい必要があります。'));
        continue;
      }
      const slot = resolveSlotCurves(feature.id, plane, center1.value, center2.value, width);
      if (!slot.ok) {
        errors.push(slot.error);
        continue;
      }
      pushCurves(slot.curves, segments, arcs);
      curvesByFeature.set(feature.id, slot.curves);
      if (feature.construction) {
        constructionFeatureIds.add(feature.id);
      }
      const first = slot.curves[0];
      const last = slot.curves[slot.curves.length - 1];
      vertices.set(vertexKey(feature.id, 'start'), curveStart(first));
      vertices.set(vertexKey(feature.id, 'end'), curveEnd(last));
      previous = curveEnd(last);
      continue;
    }

    if (feature.kind === 'ellipse') {
      if (plane === null) {
        errors.push(needsWorkPlane(feature.id, '楕円'));
        continue;
      }
      const center = resolveCoordinate(feature.center, context, feature.id);
      if (!center.ok) {
        errors.push(center.error);
        continue;
      }
      const majorRadius = feature.majorRadius.value;
      const minorRadius = feature.minorRadius.value;
      if (
        !Number.isFinite(majorRadius) ||
        !Number.isFinite(minorRadius) ||
        majorRadius < 0 ||
        minorRadius < 0
      ) {
        errors.push(error(feature.id, 'invalidValue', '半径は 0 より大きい必要があります。'));
        continue;
      }
      // 半径 0(と許容誤差に埋もれる大きさ)は楕円として成り立たない(円弧と同じ扱い)。
      if (majorRadius <= SKETCH_TOLERANCE_MM || minorRadius <= SKETCH_TOLERANCE_MM) {
        errors.push(error(feature.id, 'degenerate', '半径が小さすぎて楕円になりません。'));
        continue;
      }
      // 長軸と短軸が入れ替わっているとカーネルが断る(makeEllipseEdge.ts)ので、ここで先に伝える。
      if (majorRadius < minorRadius) {
        errors.push(
          error(feature.id, 'invalidValue', '長軸の半径は短軸の半径より大きくしてください。'),
        );
        continue;
      }
      if (
        !Number.isFinite(feature.rotation.value) ||
        !Number.isFinite(feature.startAngle.value) ||
        !Number.isFinite(feature.endAngle.value)
      ) {
        errors.push(error(feature.id, 'invalidValue', '角度の値が数になっていません。'));
        continue;
      }
      const startAzimuth = degreesToRadians(feature.startAngle.value);
      const endAzimuth = degreesToRadians(feature.endAngle.value);
      if (Math.abs(endAzimuth - startAzimuth) <= FULL_TURN_EPSILON) {
        errors.push(error(feature.id, 'degenerate', '開始角と終了角が同じです。'));
        continue;
      }
      const ellipse: ResolvedEllipse = {
        kind: 'ellipse',
        featureId: feature.id,
        center: center.value,
        normal: plane.normal,
        // 長軸の向きは作図面の第1軸から rotation だけ回した向き(円弧・点列と同じ規約)。
        majorAxis: directionInPlane(plane, feature.rotation.value),
        majorRadius,
        minorRadius,
        // 利用者が入れる方位角をパラメータ角へ直してから持つ(§1.4-8 の答え)。
        startAngle: azimuthToEllipseParameter(startAzimuth, majorRadius, minorRadius),
        endAngle: azimuthToEllipseParameter(endAzimuth, majorRadius, minorRadius),
      };
      ellipses.push(ellipse);
      curveByFeature.set(feature.id, ellipse);
      if (feature.construction) {
        constructionFeatureIds.add(feature.id);
      }
      vertices.set(vertexKey(feature.id, 'center'), center.value);
      vertices.set(vertexKey(feature.id, 'start'), curveStart(ellipse));
      vertices.set(vertexKey(feature.id, 'end'), curveEnd(ellipse));
      previous = curveEnd(ellipse);
      continue;
    }

    if (feature.kind === 'spline') {
      const spline = resolveSplineFeature(feature, context, previous);
      if (!spline.ok) {
        errors.push(spline.error);
        continue;
      }
      splines.push(spline.value);
      curveByFeature.set(feature.id, spline.value);
      if (feature.construction) {
        constructionFeatureIds.add(feature.id);
      }
      vertices.set(vertexKey(feature.id, 'start'), curveStart(spline.value));
      vertices.set(vertexKey(feature.id, 'end'), curveEnd(spline.value));
      previous = curveEnd(spline.value);
      continue;
    }

    if (feature.kind === 'offset') {
      // 左右の基準になる法線が要るので、オフセットは作図面のあるスケッチだけで作れる
      // (3D スケッチでの対応はタスク17 以降の申し送り)。
      if (plane === null) {
        errors.push(needsWorkPlane(feature.id, 'オフセット'));
        continue;
      }
      const source = collectOffsetSource(
        feature.id,
        feature.source,
        curveByFeature,
        curvesByFeature,
      );
      if (!source.ok) {
        errors.push(source.error);
        continue;
      }
      const distance = feature.distance.value;
      if (!Number.isFinite(distance) || distance < 0) {
        errors.push(
          error(feature.id, 'invalidValue', 'ずらす距離は 0 以上の数で指定してください。'),
        );
        continue;
      }
      const contour = analyzeOffsetContour(feature.id, source.curves, plane.normal);
      if (!contour.ok) {
        errors.push(contour.error);
        continue;
      }
      const key = offsetCacheKey({
        curves: source.curves,
        distance,
        side: feature.side,
        corner: feature.corner,
      });
      const remembered = lookupOffset(key);
      if (remembered === null) {
        // まだ形が無いだけで失敗ではないので errors には入れない(§2.7 と同じ扱い)。
        pendingOffsets.push({
          featureId: feature.id,
          key,
          curves: source.curves,
          distance,
          side: feature.side,
          corner: feature.corner,
          contour: contour.shape,
        });
        continue;
      }
      if (remembered.length === 0) {
        errors.push(error(feature.id, 'degenerate', 'ずらした結果が空になりました。'));
        continue;
      }
      const created = remembered.map((curve) => retagCurve(curve, feature.id));
      pushResolvedCurves(created, segments, arcs, ellipses, splines);
      curvesByFeature.set(feature.id, created);
      if (feature.construction) {
        constructionFeatureIds.add(feature.id);
      }
      const firstCreated = created[0];
      const lastCreated = created[created.length - 1];
      vertices.set(vertexKey(feature.id, 'start'), curveStart(firstCreated));
      vertices.set(vertexKey(feature.id, 'end'), curveEnd(lastCreated));
      previous = curveEnd(lastCreated);
      continue;
    }

    if (feature.kind === 'copy') {
      // 複製は「もとを id で参照する 1 フィーチャー」なので、ここまでに解決できた
      // 点・曲線をそのまま写す(FR-324、タスク20。`copyMath.ts` の注釈)。
      const copied = resolveCopyFeature(
        feature,
        plane,
        context,
        { curveByFeature, curvesByFeature, pointsByFeature },
        lookupWorkPlane,
      );
      if (!copied.ok) {
        errors.push(copied.error);
        continue;
      }
      if (feature.construction) {
        constructionFeatureIds.add(feature.id);
      }
      // 点の複製と曲線の複製は同時に起きない(`collectCopySource` が混在を断る)。
      if (copied.points.length > 0) {
        points.push(...copied.points);
        pointsByFeature.set(feature.id, copied.points);
        const lastPoint = copied.points[copied.points.length - 1];
        vertices.set(vertexKey(feature.id, 'start'), copied.points[0].position);
        vertices.set(vertexKey(feature.id, 'end'), lastPoint.position);
        previous = lastPoint.position;
        continue;
      }
      pushResolvedCurves(copied.curves, segments, arcs, ellipses, splines);
      curvesByFeature.set(feature.id, copied.curves);
      const firstCopy = copied.curves[0];
      const lastCopy = copied.curves[copied.curves.length - 1];
      vertices.set(vertexKey(feature.id, 'start'), curveStart(firstCopy));
      vertices.set(vertexKey(feature.id, 'end'), curveEnd(lastCopy));
      previous = curveEnd(lastCopy);
      continue;
    }

    if (feature.kind === 'projectedCurve' || feature.kind === 'planeSection') {
      // 投影先・切り口は作図面そのものなので、3D スケッチ(作図面なし)では作れない。
      if (plane === null) {
        errors.push(
          needsWorkPlane(feature.id, feature.kind === 'projectedCurve' ? '投影' : '交差'),
        );
        continue;
      }
      const remembered = lookupProjection(feature.id);
      if (remembered === null) {
        // まだ形が無いだけで失敗ではないので errors には入れない(オフセットと同じ扱い)。
        pendingProjections.push({
          featureId: feature.id,
          source:
            feature.kind === 'projectedCurve'
              ? { kind: 'subShape', ref: feature.source }
              : { kind: 'body', bodyFeatureId: feature.targetFeatureId },
          plane,
        });
        continue;
      }
      if (remembered.length === 0) {
        // 交差は「交わらなければ 0 本」が正しい結果なので、ここで理由を出して断る
        // (カーネルは例外を投げない。`makeSection.ts` の決め)。
        errors.push(
          error(
            feature.id,
            'degenerate',
            feature.kind === 'projectedCurve'
              ? '投影しても線になりませんでした。作図面の向きを見直してください。'
              : '立体と作図面が交わりません。作図面の位置を見直してください。',
          ),
        );
        continue;
      }
      const created = remembered.map((curve) => retagCurve(curve, feature.id));
      pushResolvedCurves(created, segments, arcs, ellipses, splines);
      curvesByFeature.set(feature.id, created);
      if (feature.construction) {
        constructionFeatureIds.add(feature.id);
      }
      const firstCreated = created[0];
      const lastCreated = created[created.length - 1];
      vertices.set(vertexKey(feature.id, 'start'), curveStart(firstCreated));
      vertices.set(vertexKey(feature.id, 'end'), curveEnd(lastCreated));
      previous = curveEnd(lastCreated);
      continue;
    }
  }

  return {
    points,
    segments,
    arcs,
    ellipses,
    splines,
    faces,
    errors,
    pendingOffsets,
    pendingProjections,
    curvesByFeature,
  };
}

type SplineOutcome =
  | { readonly ok: true; readonly value: ResolvedSpline }
  | { readonly ok: false; readonly error: SketchError };

/**
 * スプライン(FR-317)を解決する(タスク5)。点の数と重なりを先に確かめてから座標を解く。
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
    positions.push(resolved.value);
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
 * 面の境界を組み立てる(FR-309)。点だけ、または線・円弧だけを並べる(§0.a-0.13)。
 * 曲線の向きは変えない。ワイヤの向きはカーネル側の MakeWire が揃える。
 *
 * 矩形・正多角形・長穴(`curvesByFeature`)は、`index` を指定すれば n 番目の曲線だけ、
 * 省略すればそのフィーチャーの全曲線を順に展開して使う(§0.a-0.8、タスク4)。
 *
 * 構築線(FR-320、タスク6)は選べない: `constructionFeatureIds` に featureId があれば
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
    // 点列の中の 1 点を指すときだけ index を付ける(§2.6)。省略なら先頭。
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
  // 一直線上の点だけでは平面が定まらない。同じ平面に乗らない(notPlanar)とは分けて伝える(§2.3)。
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
    if (first.kind === 'spline' && first.closed) {
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
  // 歩き始める(たどり方そのものは `intersectionMath.ts` の `traceCurveChain`、タスク17)。
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
