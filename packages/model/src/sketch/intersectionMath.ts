/**
 * 曲線の上の点・曲線どうしの交点・曲線の並びの連結(FR-322、計画書 P4 §2.5・タスク17)。
 *
 * ここに 3 つを集める。
 *
 * 1. **曲線の上の点**: 線分・円弧・楕円・スプラインを「0(始点)〜1(終点)」という
 *    1 つのものさしで扱えるようにする(`curvePointAt` / `curveParameterNear`)。
 *    トリム・延長(`trimExtend.ts`)はこのものさしの上で区間を切る。
 * 2. **交点**: 線分×線分・線分×円弧・円弧×円弧は**式で解く**(近似しない)。
 *    楕円・スプラインが混じる組は折れ線で当たりを付けてから区間を狭めて追い込む
 *    (`REFINE_ROUNDS` 回で最初の区間の 4^-12 まで狭まるので、mm 単位では 1e-6 より
 *    細かくなる)。楕円・スプラインには閉じた形の交点の式が無いため。
 * 3. **連結のたどり**: 「並べた曲線が端でつながっているか、輪になっているか」に
 *    1 か所で答える(`traceCurveChain`)。面の境界(`resolveSketch.ts` の
 *    `resolveCurveLoop`)とオフセット元の輪郭(同 `analyzeOffsetContour`)が
 *    同じ歩き方を別々に持っていたのをここへまとめた(2026-09-04 の申し送り)。
 *
 * **`curveStart` / `curveEnd` / `arcPointAt` / `ellipsePointAt` / `isFullCircle` /
 * `isFullEllipse` は `resolveSketch.ts` から移してきた。** 交点の計算がこれらを使うので、
 * 置いたままだと `resolveSketch` ↔ このファイルの相互 import になるため
 * (相互 import は読み込み順で壊れうるので作らない)。`resolveSketch.ts` は同じ名前を
 * そのまま再輸出するので、呼び出し側の import は 1 つも変わらない。
 *
 * DOM にもカーネルにも触れない純関数だけを置く。
 */

import { SPLINE_SEGMENTS_PER_SPAN, splineCurveData, splinePointAt } from './splineMath.js';
import type {
  ResolvedArc,
  ResolvedCurve,
  ResolvedEllipse,
  ResolvedSegment,
  ResolvedSpline,
} from './types.js';
import {
  addVec3,
  crossVec3,
  distanceVec3,
  dotVec3,
  isSamePoint,
  lerpVec3,
  ORIGIN,
  scaleVec3,
  SKETCH_TOLERANCE_MM,
  subVec3,
  type Vec3,
} from './vec3.js';

/** 1 周(ラジアン)。 */
export const FULL_TURN = 2 * Math.PI;

/** 全周とみなす角度の幅の遊び。これ以上の開きがあれば円・楕円として扱う(FR-305)。 */
export const FULL_TURN_EPSILON = 1e-9;

/**
 * 交点とみなす 2 直線の最短距離(mm)。これより離れていればねじれの位置。
 * P1 から `ui/src/sketch/snapMath.ts` にあった値をそのまま持ち上げたもので、
 * 吸着(FR-107)の見え方を変えないために数値は変えない。
 */
export const INTERSECTION_TOLERANCE_MM = 1e-3;

/** 同じ平面に乗っているとみなす距離(mm)。スケッチ全体の許容誤差と同じ。 */
const PLANE_TOLERANCE_MM = SKETCH_TOLERANCE_MM;

/** 2 つの法線が同じ向き(または真逆)とみなす内積の遊び。 */
const NORMAL_TOLERANCE = 1e-9;

/** 0〜1 のものさしの上での遊び。端ちょうどの交点を取りこぼさないために使う。 */
const PARAMETER_EPSILON = 1e-9;

/** 連立の分母がこれ以下なら平行とみなす。 */
const DENOMINATOR_EPSILON = 1e-12;

/** 折れ線で当たりを付けるときの、1 周あたりの区間数。 */
const COARSE_DIVISIONS_PER_TURN = 64;

/** 追い込みで区間を何等分するか。 */
const REFINE_DIVISIONS = 4;

/** 追い込みを何回くり返すか。4^12 ≈ 1.7e7 まで区間が狭まる。 */
const REFINE_ROUNDS = 12;

/* ------------------------------------------------------------------ *
 * 曲線の上の点(resolveSketch.ts から移設)
 * ------------------------------------------------------------------ */

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

/**
 * 楕円の上の点(FR-318)。**角度は径数方程式のパラメータ角**(ラジアン)で、
 * 中心から見た幾何の方位角ではない(`ResolvedEllipse` の注釈)。
 *   P(u) = center + majorRadius·cos(u)·majorAxis + minorRadius·sin(u)·(normal × majorAxis)
 * 円弧の `arcPointAt` と同じ式で、半径だけを長軸・短軸に分けた形になっている。
 */
export function ellipsePointAt(ellipse: ResolvedEllipse, parameter: number): Vec3 {
  const minorAxis = crossVec3(ellipse.normal, ellipse.majorAxis);
  return addVec3(
    ellipse.center,
    addVec3(
      scaleVec3(ellipse.majorAxis, ellipse.majorRadius * Math.cos(parameter)),
      scaleVec3(minorAxis, ellipse.minorRadius * Math.sin(parameter)),
    ),
  );
}

/**
 * 曲線の始点。
 *
 * スプラインは、通過点方式なら `points[0]` をぴったり通り、制御点方式でも
 * 開いた曲線は両端の節点を次数+1 重ねてあるので `points[0]` から始まる。
 * 閉じたスプラインだけは輪なので「始まり = 終わり」で、`points[0]` は
 * 制御点方式では曲線の上に無い(輪の中では端のつながりを見ないので影響しない)。
 */
export function curveStart(curve: ResolvedCurve): Vec3 {
  switch (curve.kind) {
    case 'segment':
      return curve.from;
    case 'arc':
      return arcPointAt(curve, curve.startAngle);
    case 'ellipse':
      return ellipsePointAt(curve, curve.startAngle);
    case 'spline':
      return curve.points[0];
  }
}

/** 曲線の終点(閉じたスプラインは始点へ戻る)。 */
export function curveEnd(curve: ResolvedCurve): Vec3 {
  switch (curve.kind) {
    case 'segment':
      return curve.to;
    case 'arc':
      return arcPointAt(curve, curve.endAngle);
    case 'ellipse':
      return ellipsePointAt(curve, curve.endAngle);
    case 'spline':
      return curve.closed ? curve.points[0] : curve.points[curve.points.length - 1];
  }
}

/** 開始角と終了角の差が ±360 度以上なら全周の円(FR-305、§0.a-0.4)。 */
export function isFullCircle(arc: ResolvedArc): boolean {
  return Math.abs(arc.endAngle - arc.startAngle) >= FULL_TURN - FULL_TURN_EPSILON;
}

/** 全周の楕円か(円弧の `isFullCircle` と同じ約束、FR-318)。 */
export function isFullEllipse(ellipse: ResolvedEllipse): boolean {
  return Math.abs(ellipse.endAngle - ellipse.startAngle) >= FULL_TURN - FULL_TURN_EPSILON;
}

/** 1 本だけで輪になる曲線(全周の円・全周の楕円・閉じたスプライン)か。 */
export function isClosedCurve(curve: ResolvedCurve): boolean {
  switch (curve.kind) {
    case 'segment':
      return false;
    case 'arc':
      return isFullCircle(curve);
    case 'ellipse':
      return isFullEllipse(curve);
    case 'spline':
      return curve.closed;
  }
}

/* ------------------------------------------------------------------ *
 * 0〜1 のものさし
 * ------------------------------------------------------------------ */

/**
 * 曲線 1 本を「0(始点)〜1(終点)」で読み書きする道具。
 *
 * スプラインの極(poles)を解くのは点の数の 3 乗に比例する計算なので、
 * **曲線 1 本につき 1 つ作って使い回す**(追い込みは 1 か所で数十回呼ぶ)。
 */
export interface CurveEvaluator {
  /** 0〜1 の位置の点。範囲の外は端に丸める。 */
  at(ratio: number): Vec3;
  /** 折れ線で当たりを付けるときの区間数。 */
  readonly divisions: number;
}

/** 掃く角度の大きさに見合った区間数(短い弧を無駄に細かく刻まない)。 */
function sweepDivisions(span: number): number {
  return Math.max(4, Math.ceil((COARSE_DIVISIONS_PER_TURN * Math.abs(span)) / FULL_TURN));
}

/** 折れ線の上の点。位置は「区間の数」で等分する(弧長ではない)。 */
function polylinePointAt(points: readonly Vec3[], ratio: number): Vec3 {
  if (points.length === 0) {
    return ORIGIN;
  }
  if (points.length === 1) {
    return points[0];
  }
  const spans = points.length - 1;
  const scaled = Math.min(Math.max(ratio, 0), 1) * spans;
  const index = Math.min(spans - 1, Math.floor(scaled));
  return lerpVec3(points[index], points[index + 1], scaled - index);
}

/** スプラインを解けなかったときに使う、置いた点をそのまま結んだ折れ線。 */
function splineFallbackPoints(spline: ResolvedSpline): readonly Vec3[] {
  if (spline.points.length === 0) {
    return [];
  }
  return spline.closed ? [...spline.points, spline.points[0]] : [...spline.points];
}

/** 曲線 1 本ぶんの道具を作る。 */
export function curveEvaluator(curve: ResolvedCurve): CurveEvaluator {
  switch (curve.kind) {
    case 'segment':
      return { divisions: 1, at: (ratio): Vec3 => lerpVec3(curve.from, curve.to, ratio) };
    case 'arc': {
      const span = curve.endAngle - curve.startAngle;
      return {
        divisions: sweepDivisions(span),
        at: (ratio): Vec3 => arcPointAt(curve, curve.startAngle + span * ratio),
      };
    }
    case 'ellipse': {
      const span = curve.endAngle - curve.startAngle;
      return {
        divisions: sweepDivisions(span),
        at: (ratio): Vec3 => ellipsePointAt(curve, curve.startAngle + span * ratio),
      };
    }
    case 'spline': {
      const data = splineCurveData(curve);
      if (data === null) {
        const fallback = splineFallbackPoints(curve);
        return {
          divisions: Math.max(1, fallback.length - 1),
          at: (ratio): Vec3 => polylinePointAt(fallback, ratio),
        };
      }
      const spans = curve.closed ? curve.points.length : curve.points.length - 1;
      return {
        divisions: Math.max(1, SPLINE_SEGMENTS_PER_SPAN * spans),
        at: (ratio): Vec3 => splinePointAt(data, ratio),
      };
    }
  }
}

/**
 * 曲線の上の点を 0〜1 の位置で拾う。
 *
 * スプラインでは呼ぶたびに極を解き直すので、何度も呼ぶときは
 * `curveEvaluator` を 1 つ作って使い回す。
 */
export function curvePointAt(curve: ResolvedCurve, ratio: number): Vec3 {
  return curveEvaluator(curve).at(ratio);
}

/**
 * 角度を「開始角から進む向きに測った 0〜1 の位置」へ直す。掃く範囲の外なら null。
 *
 * `atan2` は (−π, π] しか返さないので、開始角から見て**進む向きへ 1 周ぶんの中**へ
 * 載せ直してから割合にする。終了角が開始角より小さい(時計回りの)円弧でも同じ式で扱える。
 */
function sweepRatio(angle: number, startAngle: number, endAngle: number): number | null {
  const span = endAngle - startAngle;
  if (Math.abs(span) <= FULL_TURN_EPSILON) {
    return null;
  }
  const raw = angle - startAngle;
  const delta =
    span > 0
      ? raw - FULL_TURN * Math.floor(raw / FULL_TURN)
      : raw - FULL_TURN * Math.ceil(raw / FULL_TURN);
  const ratio = delta / span;
  if (ratio < -PARAMETER_EPSILON || ratio > 1 + PARAMETER_EPSILON) {
    return null;
  }
  return Math.min(1, Math.max(0, ratio));
}

/** 円弧の平面の中での角度(xAxis から normal まわりに正)。 */
function circleAngleOf(arc: ResolvedArc, point: Vec3): number {
  const yAxis = crossVec3(arc.normal, arc.xAxis);
  const offset = subVec3(point, arc.center);
  return Math.atan2(dotVec3(offset, yAxis), dotVec3(offset, arc.xAxis));
}

/** 楕円の径数方程式のパラメータ角(`ResolvedEllipse` の注釈の逆算)。 */
function ellipseParameterOf(ellipse: ResolvedEllipse, point: Vec3): number {
  const minorAxis = crossVec3(ellipse.normal, ellipse.majorAxis);
  const offset = subVec3(point, ellipse.center);
  return Math.atan2(
    dotVec3(offset, minorAxis) / ellipse.minorRadius,
    dotVec3(offset, ellipse.majorAxis) / ellipse.majorRadius,
  );
}

/** 掃く範囲の外に落ちた角度を、近いほうの端(0 か 1)へ寄せる。 */
function clampToNearerEnd(curve: ResolvedCurve, point: Vec3): number {
  return distanceVec3(point, curveStart(curve)) <= distanceVec3(point, curveEnd(curve)) ? 0 : 1;
}

/**
 * 曲線の上で、指定した点にいちばん近い位置(0〜1)。
 *
 * 利用者がクリックした場所から「曲線のどのあたりを指したか」を決めるのに使う
 * (トリムで消す区間の選び方、FR-322)。線分・円弧・楕円は式で解き、スプラインだけは
 * 折れ線の上でいちばん近い位置を返す(曲線の最近点を解く式が無いため)。
 */
export function curveParameterNear(curve: ResolvedCurve, point: Vec3): number {
  switch (curve.kind) {
    case 'segment': {
      const along = subVec3(curve.to, curve.from);
      const lengthSquared = dotVec3(along, along);
      if (lengthSquared <= DENOMINATOR_EPSILON) {
        return 0;
      }
      const ratio = dotVec3(subVec3(point, curve.from), along) / lengthSquared;
      return Math.min(1, Math.max(0, ratio));
    }
    case 'arc':
      return sweepRatio(circleAngleOf(curve, point), curve.startAngle, curve.endAngle)
        ?? clampToNearerEnd(curve, point);
    case 'ellipse':
      return sweepRatio(ellipseParameterOf(curve, point), curve.startAngle, curve.endAngle)
        ?? clampToNearerEnd(curve, point);
    case 'spline': {
      const evaluator = curveEvaluator(curve);
      let best = 0;
      let bestDistance = Number.POSITIVE_INFINITY;
      for (let index = 0; index <= evaluator.divisions; index += 1) {
        const ratio = index / evaluator.divisions;
        const distance = distanceVec3(point, evaluator.at(ratio));
        if (distance < bestDistance) {
          bestDistance = distance;
          best = ratio;
        }
      }
      return best;
    }
  }
}

/* ------------------------------------------------------------------ *
 * 交点
 * ------------------------------------------------------------------ */

/** 交点 1 つ。位置は 2 本それぞれの上の 0〜1 で持つ。 */
export interface CurveIntersection {
  readonly point: Vec3;
  /** 1 本目の上の位置(0〜1)。 */
  readonly onFirst: number;
  /** 2 本目の上の位置(0〜1)。 */
  readonly onSecond: number;
}

interface SegmentCrossing {
  readonly s: number;
  readonly t: number;
  readonly point: Vec3;
}

/**
 * 線分どうしの交わり。平行・ねじれ・線分の外側なら null。
 * 最短距離を与える媒介変数を解いて、両方が [0,1] に入り、かつ 2 点が十分近いときだけ交点とする。
 */
function segmentCrossing(
  aFrom: Vec3,
  aTo: Vec3,
  bFrom: Vec3,
  bTo: Vec3,
  tolerance: number,
): SegmentCrossing | null {
  const u = subVec3(aTo, aFrom);
  const v = subVec3(bTo, bFrom);
  const w = subVec3(aFrom, bFrom);
  const uu = dotVec3(u, u);
  const uv = dotVec3(u, v);
  const vv = dotVec3(v, v);
  const uw = dotVec3(u, w);
  const vw = dotVec3(v, w);
  const denominator = uu * vv - uv * uv;
  if (Math.abs(denominator) <= DENOMINATOR_EPSILON) {
    return null;
  }
  const s = (uv * vw - vv * uw) / denominator;
  const t = (uu * vw - uv * uw) / denominator;
  if (s < 0 || s > 1 || t < 0 || t > 1) {
    return null;
  }
  const onA = addVec3(aFrom, scaleVec3(u, s));
  const onB = addVec3(bFrom, scaleVec3(v, t));
  if (distanceVec3(onA, onB) > tolerance) {
    return null;
  }
  return { s, t, point: lerpVec3(onA, onB, 0.5) };
}

/**
 * 2 線分の交点。平行・ねじれ・線分の外側なら null(FR-107 の吸着で P1 から使っている形)。
 * `ui/src/sketch/snapMath.ts` の `segmentIntersection` はこれをそのまま呼ぶ。
 */
export function segmentSegmentIntersection(a: ResolvedSegment, b: ResolvedSegment): Vec3 | null {
  const crossing = segmentCrossing(a.from, a.to, b.from, b.to, INTERSECTION_TOLERANCE_MM);
  return crossing === null ? null : crossing.point;
}

function segmentIntersections(a: ResolvedSegment, b: ResolvedSegment): CurveIntersection[] {
  const crossing = segmentCrossing(a.from, a.to, b.from, b.to, INTERSECTION_TOLERANCE_MM);
  if (crossing === null) {
    return [];
  }
  return [{ point: crossing.point, onFirst: crossing.s, onSecond: crossing.t }];
}

/** 円弧の平面の中の座標(x は xAxis 方向、y は normal × xAxis 方向、z は法線方向)。 */
function arcLocalOf(arc: ResolvedArc, point: Vec3): readonly [number, number, number] {
  const yAxis = crossVec3(arc.normal, arc.xAxis);
  const offset = subVec3(point, arc.center);
  return [dotVec3(offset, arc.xAxis), dotVec3(offset, yAxis), dotVec3(offset, arc.normal)];
}

/** 線分の上の位置から、円弧の上の位置を求めて交点にまとめる。範囲の外なら null。 */
function crossingAt(
  segment: ResolvedSegment,
  arc: ResolvedArc,
  ratioOnSegment: number,
): CurveIntersection | null {
  if (ratioOnSegment < -PARAMETER_EPSILON || ratioOnSegment > 1 + PARAMETER_EPSILON) {
    return null;
  }
  const clamped = Math.min(1, Math.max(0, ratioOnSegment));
  const point = lerpVec3(segment.from, segment.to, clamped);
  const onArc = sweepRatio(circleAngleOf(arc, point), arc.startAngle, arc.endAngle);
  if (onArc === null) {
    return null;
  }
  return { point, onFirst: clamped, onSecond: onArc };
}

/**
 * 線分と円弧の交点(最大 2 つ)。
 *
 * 円弧の平面へ落とした 2 次方程式 |P₀ + s·D|² = r² を解く。
 * **接する場合(判別式が 0)は交点として報せない**: 接点で切っても区間が分かれず、
 * トリムの役に立たないうえ、丸め誤差で有無が揺れるため。
 * 線分が円弧の平面に乗っていないときは、平面を突き抜ける 1 点だけを調べる。
 */
function segmentArcIntersections(segment: ResolvedSegment, arc: ResolvedArc): CurveIntersection[] {
  const [x0, y0, z0] = arcLocalOf(arc, segment.from);
  const [x1, y1, z1] = arcLocalOf(arc, segment.to);
  if (Math.abs(z0) > PLANE_TOLERANCE_MM || Math.abs(z1) > PLANE_TOLERANCE_MM) {
    // 平面に乗っていない線分。平面を突き抜けるならその 1 点だけが交点になりうる。
    const gap = z0 - z1;
    if (Math.abs(gap) <= DENOMINATOR_EPSILON) {
      return [];
    }
    const ratio = z0 / gap;
    const point = lerpVec3(segment.from, segment.to, Math.min(1, Math.max(0, ratio)));
    const [px, py] = arcLocalOf(arc, point);
    if (Math.abs(Math.hypot(px, py) - arc.radius) > INTERSECTION_TOLERANCE_MM) {
      return [];
    }
    const crossing = crossingAt(segment, arc, ratio);
    return crossing === null ? [] : [crossing];
  }
  const dx = x1 - x0;
  const dy = y1 - y0;
  const a = dx * dx + dy * dy;
  if (a <= DENOMINATOR_EPSILON) {
    return [];
  }
  const b = 2 * (x0 * dx + y0 * dy);
  const c = x0 * x0 + y0 * y0 - arc.radius * arc.radius;
  const discriminant = b * b - 4 * a * c;
  if (discriminant <= 0) {
    return [];
  }
  const root = Math.sqrt(discriminant);
  const found: CurveIntersection[] = [];
  for (const ratio of [(-b - root) / (2 * a), (-b + root) / (2 * a)]) {
    const crossing = crossingAt(segment, arc, ratio);
    if (crossing !== null) {
      found.push(crossing);
    }
  }
  return found;
}

/**
 * 円弧どうしの交点(最大 2 つ)。同じ平面に乗っていなければ交点無しとする。
 *
 * 中心間の距離 d と 2 つの半径から、交点までの「中心線に沿った距離」
 * a = (d² + r₁² − r₂²) / 2d と「中心線からの高さ」h = √(r₁² − a²) を出す。
 * 接する場合(h = 0)は線分×円弧と同じ理由で報せない。
 * 同心(d ≈ 0)は交わらないか完全に重なるかのどちらかなので、これも報せない。
 */
function arcArcIntersections(first: ResolvedArc, second: ResolvedArc): CurveIntersection[] {
  if (Math.abs(dotVec3(first.normal, second.normal)) < 1 - NORMAL_TOLERANCE) {
    return [];
  }
  const [cx, cy, cz] = arcLocalOf(first, second.center);
  if (Math.abs(cz) > PLANE_TOLERANCE_MM) {
    return [];
  }
  const distance = Math.hypot(cx, cy);
  if (distance <= PLANE_TOLERANCE_MM) {
    return [];
  }
  if (
    distance > first.radius + second.radius ||
    distance < Math.abs(first.radius - second.radius)
  ) {
    return [];
  }
  const along = (distance * distance + first.radius * first.radius - second.radius * second.radius)
    / (2 * distance);
  const heightSquared = first.radius * first.radius - along * along;
  if (heightSquared <= 0) {
    return [];
  }
  const height = Math.sqrt(heightSquared);
  const unitX = cx / distance;
  const unitY = cy / distance;
  const yAxis = crossVec3(first.normal, first.xAxis);
  const found: CurveIntersection[] = [];
  for (const sign of [1, -1]) {
    const localX = along * unitX - sign * height * unitY;
    const localY = along * unitY + sign * height * unitX;
    const point = addVec3(
      first.center,
      addVec3(scaleVec3(first.xAxis, localX), scaleVec3(yAxis, localY)),
    );
    const onFirst = sweepRatio(Math.atan2(localY, localX), first.startAngle, first.endAngle);
    if (onFirst === null) {
      continue;
    }
    const onSecond = sweepRatio(
      circleAngleOf(second, point),
      second.startAngle,
      second.endAngle,
    );
    if (onSecond === null) {
      continue;
    }
    found.push({ point, onFirst, onSecond });
  }
  return found;
}

/** 区間 [from, to] を等分して曲線の上の点を拾う(両端を含む)。 */
function sampleRange(
  evaluator: CurveEvaluator,
  from: number,
  to: number,
  divisions: number,
): Vec3[] {
  const points: Vec3[] = [];
  for (let index = 0; index <= divisions; index += 1) {
    points.push(evaluator.at(from + ((to - from) * index) / divisions));
  }
  return points;
}

interface CellHit {
  readonly first: number;
  readonly second: number;
  readonly crossing: SegmentCrossing;
}

/** 2 つの折れ線の中から、最初に交わる区間の組を探す。 */
function findCell(a: readonly Vec3[], b: readonly Vec3[]): CellHit | null {
  for (let i = 0; i + 1 < a.length; i += 1) {
    for (let j = 0; j + 1 < b.length; j += 1) {
      const crossing = segmentCrossing(a[i], a[i + 1], b[j], b[j + 1], INTERSECTION_TOLERANCE_MM);
      if (crossing !== null) {
        return { first: i, second: j, crossing };
      }
    }
  }
  return null;
}

/**
 * 折れ線で見つけた交わりを、区間を狭めながら曲線そのものへ追い込む。
 *
 * 見つけた区間をさらに `REFINE_DIVISIONS` 等分して交わる区間を選び直す、を
 * `REFINE_ROUNDS` 回くり返す。狭められなくなったらそこで止めて、その時点の値を返す。
 */
function refineCell(
  first: CurveEvaluator,
  second: CurveEvaluator,
  cell: readonly [number, number, number, number],
  hit: CellHit,
  cellDivisions: readonly [number, number],
): CurveIntersection {
  let [firstFrom, firstTo, secondFrom, secondTo] = cell;
  let best: CurveIntersection = {
    point: hit.crossing.point,
    onFirst: firstFrom + (firstTo - firstFrom) * hit.crossing.s,
    onSecond: secondFrom + (secondTo - secondFrom) * hit.crossing.t,
  };
  // 最初の 1 回は呼び出し側が見つけた区間から始める。
  let divisions = cellDivisions;
  let current: CellHit | null = hit;
  for (let round = 0; round < REFINE_ROUNDS; round += 1) {
    if (current === null) {
      return best;
    }
    const firstStep = (firstTo - firstFrom) / divisions[0];
    const secondStep = (secondTo - secondFrom) / divisions[1];
    const nextFirstFrom = firstFrom + firstStep * current.first;
    const nextSecondFrom = secondFrom + secondStep * current.second;
    firstTo = nextFirstFrom + firstStep;
    secondTo = nextSecondFrom + secondStep;
    firstFrom = nextFirstFrom;
    secondFrom = nextSecondFrom;
    best = {
      point: current.crossing.point,
      onFirst: firstFrom + (firstTo - firstFrom) * current.crossing.s,
      onSecond: secondFrom + (secondTo - secondFrom) * current.crossing.t,
    };
    divisions = [REFINE_DIVISIONS, REFINE_DIVISIONS];
    current = findCell(
      sampleRange(first, firstFrom, firstTo, REFINE_DIVISIONS),
      sampleRange(second, secondFrom, secondTo, REFINE_DIVISIONS),
    );
  }
  return best;
}

/** 同じ交点を二度数えない(隣り合う区間が同じ点を報せることがある)。 */
function pushUnique(found: CurveIntersection[], candidate: CurveIntersection): void {
  for (const existing of found) {
    if (distanceVec3(existing.point, candidate.point) <= SKETCH_TOLERANCE_MM) {
      return;
    }
  }
  found.push(candidate);
}

/**
 * 楕円・スプラインが混じる組の交点。折れ線で当たりを付けてから追い込む。
 * 1 つの区間の中で 2 回交わる形(ごく細かい波)は取りこぼす。
 */
function sampledIntersections(first: ResolvedCurve, second: ResolvedCurve): CurveIntersection[] {
  const a = curveEvaluator(first);
  const b = curveEvaluator(second);
  const pointsA = sampleRange(a, 0, 1, a.divisions);
  const pointsB = sampleRange(b, 0, 1, b.divisions);
  const found: CurveIntersection[] = [];
  for (let i = 0; i + 1 < pointsA.length; i += 1) {
    for (let j = 0; j + 1 < pointsB.length; j += 1) {
      const crossing = segmentCrossing(
        pointsA[i],
        pointsA[i + 1],
        pointsB[j],
        pointsB[j + 1],
        INTERSECTION_TOLERANCE_MM,
      );
      if (crossing === null) {
        continue;
      }
      pushUnique(
        found,
        refineCell(a, b, [0, 1, 0, 1], { first: i, second: j, crossing }, [
          a.divisions,
          b.divisions,
        ]),
      );
    }
  }
  return found;
}

/** 位置の 1 本目と 2 本目を入れ替える(向きを揃えて呼び出すため)。 */
function swapped(intersections: readonly CurveIntersection[]): CurveIntersection[] {
  return intersections.map((found) => ({
    point: found.point,
    onFirst: found.onSecond,
    onSecond: found.onFirst,
  }));
}

/**
 * 曲線どうしの交点(FR-322)。位置は 2 本それぞれの上の 0〜1 で返す。
 *
 * 線分×線分・線分×円弧・円弧×円弧は式で解き、楕円・スプラインが混じる組だけ
 * 折れ線で当たりを付けてから追い込む(このファイル冒頭)。
 */
export function curveIntersections(
  first: ResolvedCurve,
  second: ResolvedCurve,
): readonly CurveIntersection[] {
  if (first.kind === 'segment' && second.kind === 'segment') {
    return segmentIntersections(first, second);
  }
  if (first.kind === 'segment' && second.kind === 'arc') {
    return segmentArcIntersections(first, second);
  }
  if (first.kind === 'arc' && second.kind === 'segment') {
    return swapped(segmentArcIntersections(second, first));
  }
  if (first.kind === 'arc' && second.kind === 'arc') {
    return arcArcIntersections(first, second);
  }
  return sampledIntersections(first, second);
}

/* ------------------------------------------------------------------ *
 * 連結のたどり
 * ------------------------------------------------------------------ */

/** 並べた曲線をたどった結果。 */
export interface CurveChain {
  /** 輪になっているか(最後の端が最初の端へ戻る)。 */
  readonly closed: boolean;
  /** たどり始めた点。 */
  readonly start: Vec3;
  /** たどり終えた点(輪なら `start` と同じ位置)。 */
  readonly end: Vec3;
  /** 1 本目をたどり終えた点。開いた輪郭の「進む向き」を出すのに使う。 */
  readonly afterFirst: Vec3;
  /** 1 本目を逆向きにたどったか。 */
  readonly firstReversed: boolean;
}

export type CurveChainOutcome =
  | { readonly ok: true; readonly chain: CurveChain }
  | {
      readonly ok: false;
      /** つながらなかった曲線の位置(0 始まり)。 */
      readonly brokenAt: number;
    };

export interface CurveChainOptions {
  /**
   * 1 本目を逆向きにたどってよいか(既定 false)。
   *
   * 面の境界(`resolveCurveLoop`)は選んだ向きのまま「1 本目の終わり」から歩き始める。
   * オフセット元の輪郭(`analyzeOffsetContour`)は、2 本目とつながっているほうの端を
   * 1 本目の終わりとみなすので true にする。
   */
  readonly allowReversedFirst?: boolean;
}

/**
 * 並べた曲線が端でつながっているか、輪になっているかをたどる(FR-309、FR-321)。
 *
 * 選んだ向きが逆でもつながっていれば受け入れる(2 本目以降は常に、1 本目は
 * `allowReversedFirst` のときだけ)。**曲線が 1 本のときは呼ばない**:
 * 1 本で輪になるか(全周の円・全周の楕円・閉じたスプライン)の判定は
 * 呼び出し側の事情(面かオフセットか)で扱いが違うため、`isClosedCurve` を
 * 呼び出し側が先に見る。
 */
export function traceCurveChain(
  curves: readonly ResolvedCurve[],
  options: CurveChainOptions = {},
): CurveChainOutcome {
  const first = curves[0];
  const firstStart = curveStart(first);
  const firstEnd = curveEnd(first);
  if (curves.length === 1) {
    return {
      ok: true,
      chain: {
        closed: isClosedCurve(first),
        start: firstStart,
        end: firstEnd,
        afterFirst: firstEnd,
        firstReversed: false,
      },
    };
  }

  const second = curves[1];
  const touchesEnd =
    isSamePoint(firstEnd, curveStart(second)) || isSamePoint(firstEnd, curveEnd(second));
  if (!touchesEnd && !(options.allowReversedFirst ?? false)) {
    return { ok: false, brokenAt: 1 };
  }
  const touchesStart =
    isSamePoint(firstStart, curveStart(second)) || isSamePoint(firstStart, curveEnd(second));
  if (!touchesEnd && !touchesStart) {
    return { ok: false, brokenAt: 1 };
  }
  const forward = touchesEnd;
  const chainStart = forward ? firstStart : firstEnd;
  const afterFirst = forward ? firstEnd : firstStart;
  let tip = afterFirst;
  for (let index = 1; index < curves.length; index += 1) {
    const curve = curves[index];
    const start = curveStart(curve);
    const end = curveEnd(curve);
    if (isSamePoint(start, tip)) {
      tip = end;
    } else if (isSamePoint(end, tip)) {
      tip = start;
    } else {
      return { ok: false, brokenAt: index };
    }
  }
  return {
    ok: true,
    chain: {
      closed: isSamePoint(tip, chainStart),
      start: chainStart,
      end: tip,
      afterFirst,
      firstReversed: !forward,
    },
  };
}
