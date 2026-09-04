/**
 * スケッチの履歴全体をワールド座標へ解決する(計画書 docs/plans/P1-式とスケッチ.md タスク11)。
 *
 * 履歴を先頭から順にたどり、点・線分・円弧・点列・面を組み立てる(要件§6.3)。
 * 途中のフィーチャーが解決できなくても止めず、そのフィーチャーだけを errors へ入れて
 * 先へ進む(FR-504、NFR-RE-1)。解決できなかったフィーチャーは以後の参照先にならない。
 *
 * 座標 1 点の解決は resolveCoordinate.ts の担当で、ここは
 * 「そこまでに解決できたもの」(ResolveContext)を育てながら順に渡す。
 */

import {
  degreesToRadians,
  directionInPlane,
  planeToWorld,
  WORK_PLANES,
  worldToPlane,
  type WorkPlane,
} from './planeMath.js';
import { resolveCoordinate, vertexKey, type ResolveContext } from './resolveCoordinate.js';
import type {
  ResolvedArc,
  ResolvedCurve,
  ResolvedFace,
  ResolvedPoint,
  ResolvedSegment,
  ResolvedSketch,
  SketchDocument,
  SketchError,
  SketchErrorCode,
  SketchFaceFeature,
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

/** 全周とみなす角度の幅(ラジアン)。これ以上なら円として扱う(FR-305)。 */
const FULL_TURN = 2 * Math.PI;
const FULL_TURN_EPSILON = 1e-9;

/** 平面の当てはめに使う円弧の標本点の数(両端を含む)。 */
const ARC_PLANE_SAMPLES = 5;

/** 曲線の始点。 */
export function curveStart(curve: ResolvedCurve): Vec3 {
  return curve.kind === 'segment' ? curve.from : arcPointAt(curve, curve.startAngle);
}

/** 曲線の終点。 */
export function curveEnd(curve: ResolvedCurve): Vec3 {
  return curve.kind === 'segment' ? curve.to : arcPointAt(curve, curve.endAngle);
}

/** 円弧の上の点。角度は xAxis から normal まわりに正(ラジアン)。 */
export function arcPointAt(arc: ResolvedArc, angle: number): Vec3 {
  const yAxis = crossVec3(arc.normal, arc.xAxis);
  return addVec3(
    arc.center,
    addVec3(
      scaleVec3(arc.xAxis, arc.radius * Math.cos(angle)),
      scaleVec3(yAxis, arc.radius * Math.sin(angle)),
    ),
  );
}

/** 開始角と終了角の差が ±360 度以上なら全周の円(FR-305、§0.a-0.4)。 */
export function isFullCircle(arc: ResolvedArc): boolean {
  return Math.abs(arc.endAngle - arc.startAngle) >= FULL_TURN - FULL_TURN_EPSILON;
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
  if (curve.kind === 'segment') {
    return [curve.from, curve.to];
  }
  const span = curve.endAngle - curve.startAngle;
  const samples: Vec3[] = [curve.center];
  for (let index = 0; index < ARC_PLANE_SAMPLES; index += 1) {
    samples.push(arcPointAt(curve, curve.startAngle + (span * index) / (ARC_PLANE_SAMPLES - 1)));
  }
  return samples;
}

function error(featureId: string, code: SketchErrorCode, message: string): SketchError {
  return { featureId, code, message };
}

/** 直角(ラジアン)。長穴の半円弧の開始角・終了角(中心の xAxis から ±90°)に使う。 */
const QUARTER_TURN = Math.PI / 2;

type CurvesOutcome =
  | { readonly ok: true; readonly curves: readonly ResolvedCurve[] }
  | { readonly ok: false; readonly error: SketchError };

/**
 * 複数曲線フィーチャー(矩形・正多角形・長穴)の曲線を、種類ごとに `segments` / `arcs` へ積む。
 * 線分・円弧の単体フィーチャーと同じ配列に並ぶことで、UI 側(pickMath.ts 等、タスク11・12)が
 * 既存の `sketch.segments` / `sketch.arcs` の走査をそのまま使える(§2.3)。
 */
function pushCurves(
  curves: readonly ResolvedCurve[],
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

/**
 * スケッチの履歴を先頭から順に解決する(要件§6.3)。
 * 途中のフィーチャーが解決できなくても止めず、そのフィーチャーだけを errors に入れて先へ進む
 * (FR-504、NFR-RE-1)。解決できなかったフィーチャーは以後の参照先にならない。
 */
export function resolveSketch(document: SketchDocument): ResolvedSketch {
  const points: ResolvedPoint[] = [];
  const segments: ResolvedSegment[] = [];
  const arcs: ResolvedArc[] = [];
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
  /** 「直前の点」(FR-302)。点を作ったフィーチャーと線・円弧の終点で更新する。 */
  let previous: Vec3 | null = null;

  for (const feature of document.features) {
    const plane = WORK_PLANES[feature.planeId];
    const context: ResolveContext = { plane, points, previous, vertices };

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
      const arc: ResolvedArc = {
        kind: 'arc',
        featureId: feature.id,
        center: center.value,
        normal: plane.normal,
        xAxis: plane.axisU,
        radius,
        startAngle,
        endAngle,
      };
      arcs.push(arc);
      curveByFeature.set(feature.id, arc);
      vertices.set(vertexKey(feature.id, 'center'), center.value);
      vertices.set(vertexKey(feature.id, 'start'), curveStart(arc));
      vertices.set(vertexKey(feature.id, 'end'), curveEnd(arc));
      previous = curveEnd(arc);
      continue;
    }

    if (feature.kind === 'pointArray') {
      const base = resolveCoordinate(feature.base, context, feature.id);
      if (!base.ok) {
        errors.push(base.error);
        continue;
      }
      const count = feature.count.value;
      if (
        !Number.isInteger(count) ||
        count < MIN_POINT_ARRAY_COUNT ||
        count > MAX_POINT_ARRAY_COUNT
      ) {
        errors.push(
          error(
            feature.id,
            'invalidValue',
            `個数は ${String(MIN_POINT_ARRAY_COUNT)} 以上 ${String(MAX_POINT_ARRAY_COUNT)} 以下の整数にしてください。`,
          ),
        );
        continue;
      }
      const spacing = feature.spacing.value;
      if (!Number.isFinite(spacing) || spacing === 0) {
        errors.push(error(feature.id, 'invalidValue', '間隔に 0 は指定できません。'));
        continue;
      }
      const azimuth = feature.azimuth.value;
      if (!Number.isFinite(azimuth)) {
        errors.push(error(feature.id, 'invalidValue', '方向の角度が数になっていません。'));
        continue;
      }
      // 方位角は作図面内の向き(第1軸から第2軸へ向かう向きが正、§2.8)。
      const direction = directionInPlane(plane, azimuth);
      const created: ResolvedPoint[] = [];
      for (let index = 0; index < count; index += 1) {
        created.push({
          id: `${feature.id}#${String(index)}`,
          featureId: feature.id,
          position: addVec3(base.value, scaleVec3(direction, spacing * index)),
        });
      }
      points.push(...created);
      pointsByFeature.set(feature.id, created);
      const last = created[created.length - 1];
      vertices.set(vertexKey(feature.id, 'start'), created[0].position);
      vertices.set(vertexKey(feature.id, 'end'), last.position);
      previous = last.position;
      continue;
    }

    if (feature.kind === 'rectangle') {
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
      const first = rectangle.curves[0];
      const last = rectangle.curves[rectangle.curves.length - 1];
      vertices.set(vertexKey(feature.id, 'start'), curveStart(first));
      vertices.set(vertexKey(feature.id, 'end'), curveEnd(last));
      previous = curveEnd(last);
      continue;
    }

    if (feature.kind === 'polygon') {
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
      const first = polygon.curves[0];
      const last = polygon.curves[polygon.curves.length - 1];
      vertices.set(vertexKey(feature.id, 'center'), center.value);
      vertices.set(vertexKey(feature.id, 'start'), curveStart(first));
      vertices.set(vertexKey(feature.id, 'end'), curveEnd(last));
      previous = curveEnd(last);
      continue;
    }

    if (feature.kind === 'slot') {
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
      const first = slot.curves[0];
      const last = slot.curves[slot.curves.length - 1];
      vertices.set(vertexKey(feature.id, 'start'), curveStart(first));
      vertices.set(vertexKey(feature.id, 'end'), curveEnd(last));
      previous = curveEnd(last);
      continue;
    }

    const face = resolveFace(feature, pointsByFeature, curveByFeature, curvesByFeature);
    if (!face.ok) {
      errors.push(face.error);
      continue;
    }
    faces.push(face.value);
  }

  return { points, segments, arcs, faces, errors };
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
 */
function resolveFace(
  feature: SketchFaceFeature,
  pointsByFeature: ReadonlyMap<string, readonly ResolvedPoint[]>,
  curveByFeature: ReadonlyMap<string, ResolvedCurve>,
  curvesByFeature: ReadonlyMap<string, readonly ResolvedCurve[]>,
): FaceOutcome {
  if (feature.boundary.length === 0) {
    return { ok: false, error: error(feature.id, 'tooFewPoints', '面の境界が選ばれていません。') };
  }

  const pickedPoints: Vec3[] = [];
  const pickedCurves: ResolvedCurve[] = [];

  for (const reference of feature.boundary) {
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
    if (first.kind === 'arc' && isFullCircle(first)) {
      return { ok: true, value: { featureId: feature.id, color: feature.color, curves } };
    }
    return { ok: false, error: error(feature.id, 'notClosed', '1 本では閉じた形になりません。') };
  }

  const loopStart = curveStart(first);
  let tip = curveEnd(first);
  for (let index = 1; index < curves.length; index += 1) {
    const curve = curves[index];
    const start = curveStart(curve);
    const end = curveEnd(curve);
    // 選んだ向きが逆でもつながっていれば受け入れる。
    if (isSamePoint(start, tip)) {
      tip = end;
    } else if (isSamePoint(end, tip)) {
      tip = start;
    } else {
      return {
        ok: false,
        error: error(feature.id, 'notClosed', '選んだ線・円弧の端がつながっていません。'),
      };
    }
  }

  if (!isSamePoint(tip, loopStart)) {
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
