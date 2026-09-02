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

import { degreesToRadians, directionInPlane, WORK_PLANES } from './planeMath.js';
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

    const face = resolveFace(feature, pointsByFeature, curveByFeature);
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
 */
function resolveFace(
  feature: SketchFaceFeature,
  pointsByFeature: ReadonlyMap<string, readonly ResolvedPoint[]>,
  curveByFeature: ReadonlyMap<string, ResolvedCurve>,
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
