/**
 * 3D スケッチの 3 点(始点・終点・通過点)の円弧(P4 計画書 §2.4・タスク36、FR-330)。
 *
 * 3 点は互いに独立な絶対座標として与えられ、通る円の中心・半径・法線・第1軸・角度を
 * 一意に求める。既存の `SketchArcFeature`(中心+半径+開始角/終了角+`freeOrientation`)
 * へそのまま渡せる形で返すので、新しい `SketchFeatureKind` は増やさない
 * (計画書タスク36「model には既存の `SketchArcFeature` として保存」)。
 *
 * DOM にもストアにも触れない純関数。3 点が同一直線上にあるときは例外を投げず `null` を
 * 返す(FR-504)。
 */

import {
  addVec3,
  crossVec3,
  dotVec3,
  lengthVec3,
  normalizeVec3,
  scaleVec3,
  subVec3,
  type Vec3,
} from '../sketch/vec3.js';

export interface ArcThroughPointsResult {
  readonly center: Vec3;
  readonly radius: number;
  /** 円が乗る平面の法線(正規化)。`(p1 − p0) × (p2 − p0)` の向き。 */
  readonly normal: Vec3;
  /** 角度 0 の基準方向(中心 → p0、正規化)。 */
  readonly xAxis: Vec3;
  /** ラジアン。常に 0(p0 を角度の基準にするため)。 */
  readonly startAngle: number;
  /** ラジアン。p0 → p2 → p1 の順に回る向きで正(通過点 p2 を経由する側の弧を選ぶ)。 */
  readonly endAngle: number;
}

/**
 * 3 点の外接円が求まらないとみなす閾値(mm²)。`(p1−p0) × (p2−p0)` の長さは三角形の面積の
 * 2 倍に等しく、3 点が同一直線上(または 2 点以上が重なる)ときに 0 へ近づく。
 * `SKETCH_TOLERANCE_MM`(1e-6mm)より一桁ゆるく、長さの 2 乗のオーダーに合わせた値にする。
 */
const COLLINEAR_AREA_TOLERANCE = 1e-9;

const FULL_TURN_RADIANS = 2 * Math.PI;

/** 角度を [0, 2π) へ畳み込む。 */
function toPositiveAngle(angle: number): number {
  const wrapped = angle % FULL_TURN_RADIANS;
  return wrapped < 0 ? wrapped + FULL_TURN_RADIANS : wrapped;
}

/**
 * 3 点(始点 `p0`・終点 `p1`・通過点 `p2`)を通る円弧を求める(FR-330、タスク36)。
 *
 * 中心は 3 点が乗る平面の中で、2 本の弦(p0-p1, p0-p2)の垂直二等分線の交点として求める
 * (平面内の 2 元 1 次連立方程式、計画書タスク36 の指定どおり)。平面の中の直交基底を
 * `u = normalize(p1 − p0)`・`v = normal × u` に取り、p0 を原点とした 2 次元座標へ落として
 * 円の中心の公式を解いてから 3 次元へ戻す。
 *
 * 終了角は、p0(角度 0)から p1 までを、**p2 を経由する側**へ回った角度にする。p1・p2 の
 * 角度をどちらも [0, 2π) へ畳み込み、p2 の角度が p1 の角度より小さければ正方向
 * (0 → p1)がそのまま p2 を経由するのでその角度を採り、そうでなければ逆方向
 * (0 → p1 − 2π)を採る。
 */
export function arcThroughPoints(p0: Vec3, p1: Vec3, p2: Vec3): ArcThroughPointsResult | null {
  const a = subVec3(p1, p0);
  const b = subVec3(p2, p0);
  const crossAB = crossVec3(a, b);
  const crossLength = lengthVec3(crossAB);
  if (crossLength <= COLLINEAR_AREA_TOLERANCE) {
    // 3 点が同一直線上(または 2 点以上が重なる)。外接円の中心が発散するので断る。
    return null;
  }
  const normal = scaleVec3(crossAB, 1 / crossLength);
  const u = normalizeVec3(a);
  const v = crossVec3(normal, u);

  // p0 を原点とした平面内の 2 次元座標。
  const bx = dotVec3(a, u);
  const by = dotVec3(a, v);
  const cx = dotVec3(b, u);
  const cy = dotVec3(b, v);

  // 2 元 1 次連立方程式(標準的な 2 次元の外接円の公式)。crossLength > 0 を確かめた
  // 直後なので、行列式 d はこの後で 0 にならない。
  const d = 2 * (bx * cy - by * cx);
  const bSquared = bx * bx + by * by;
  const cSquared = cx * cx + cy * cy;
  const centerX = (cy * bSquared - by * cSquared) / d;
  const centerY = (bx * cSquared - cx * bSquared) / d;

  const center = addVec3(p0, addVec3(scaleVec3(u, centerX), scaleVec3(v, centerY)));
  const radius = lengthVec3(subVec3(p0, center));
  const xAxis = normalizeVec3(subVec3(p0, center));
  const yAxis = crossVec3(normal, xAxis);

  const angleOf = (point: Vec3): number => {
    const relative = subVec3(point, center);
    return Math.atan2(dotVec3(relative, yAxis), dotVec3(relative, xAxis));
  };

  const angle1 = toPositiveAngle(angleOf(p1));
  const angle2 = toPositiveAngle(angleOf(p2));
  const endAngle = angle2 < angle1 ? angle1 : angle1 - FULL_TURN_RADIANS;

  return { center, radius, normal, xAxis, startAngle: 0, endAngle };
}
