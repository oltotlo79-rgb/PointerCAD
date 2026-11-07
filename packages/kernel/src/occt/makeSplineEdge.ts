import { interpolateOpen, interpolateClosed, controlPointData,
  explicitCubicData as numericExplicitCubicData, splineDegree as numericSplineDegree,
  hasDuplicateSplinePoint as numericHasDuplicateSplinePoint } from '../math/splineInterpolation.js';
/**
 * スプラインの辺(FR-317、計画書 P4 §2.3、タスク8)。
 *
 * 「通過点」方式(与えた点を必ず通る)と「制御点」方式(与えた点が曲線を引っぱる)の
 * 2 とおりを、開いた曲線と閉じた曲線の両方について作る。
 *
 * **カーネルへ渡すのは `Geom_BSplineCurve_1`(極・節点・多重度・次数)だけで、
 * 通過点方式の補間そのものは、importを持たない純数値subpathで自前に解く。** 理由を残す。
 *
 * 1. 計画書 §0.a-0.17 が第一候補にした `GeomAPI_PointsToBSpline_2` は、引数に
 *    連続性の列挙 `GeomAbs_Shape` を取る。opencascade.js の型定義では列挙の各値が
 *    空の型 `{}` なので、そのままでは型検査を通らず、`makeFillet.ts` と同じ
 *    「`unknown` を経由する述語ガード」を新しく 1 か所増やすことになる。
 *    計画書 §0.a-0.23 はその書き方を 2 か所(オフセットと面張り)に限って承認しており、
 *    ここは含まれていない。**自前で解けば列挙を 1 つも触らずに済む。**
 * 2. 厳密な通過点補間の `GeomAPI_Interpolate` は使えない。構築に要る
 *    `Handle_TColgp_HArray1OfPnt` の中身 `TColgp_HArray1OfPnt` が、型定義にも
 *    実行時の実体にも無い(2026-09-04 に Node 上で実測。計画書 §1.4-1 の裏づけ)。
 * 3. `GeomAPI_PointsToBSpline_2` は「許容誤差内の近似」なので、そもそも点を通る保証がない。
 *    自前で解けば連立一次方程式の解の精度(実測 1e-14mm 以下)でぴったり通る。
 *
 * 使う OCCT は `Geom_BSplineCurve_1` と `BRepBuilderAPI_MakeEdge_24` の 2 つだけで、
 * どちらも列挙を引数に取らない。
 *
 * **`BRepBuilderAPI_MakeEdge_24` は `Handle_Geom_Curve` を要る。**
 * `Handle_Geom_BSplineCurve` をそのまま渡すと実行時に
 * 「Expected null or instance of Handle_Geom_Curve」で落ちる(2026-09-04 実測)。
 * `Handle_Geom_BSplineCurve` は `Handle_Geom_Curve` を継承していないためで、
 * `Handle_Geom2d_Line` と `Handle_Geom2d_Curve` の関係(makeHelix.ts の注釈)と同じ落とし穴。
 * したがって親の Handle(`Handle_Geom_Curve_2`)を直に作って渡す。
 */

import type { OpenCascadeInstance } from 'opencascade.js/dist/opencascade.full.js';

import type { Vec3Tuple } from '../types.js';
import { createAllocations } from './allocations.js';
import type { OcctEdgeHandle } from './makeSketchEdges.js';

const TOO_FEW_OPEN_MESSAGE = 'スプラインには点が 2 個以上必要です。';
const TOO_FEW_CLOSED_MESSAGE = '閉じたスプラインには点が 3 個以上必要です。';
const BAD_NUMBER_MESSAGE = 'スプラインの点に使えない数値が含まれています。';
const DUPLICATE_POINT_MESSAGE =
  '同じ位置の点が続いているため、通過点のスプラインを作れません。点をずらしてください。';
const UNSOLVABLE_MESSAGE =
  'スプラインの曲線を計算できませんでした。点の並びを見直してください。';
const BUILD_FAILED_MESSAGE = 'スプラインの辺を作れませんでした。';

/** スプライン 1 本の指定。単位は mm(NFR-RE-3)。 */
export interface SplineSpec {
  /** `interpolate` は与えた点を通る曲線、`control` は与えた点を極(制御点)とする曲線。 */
  readonly mode: 'interpolate' | 'control';
  /** 通過点または制御点。並び順が曲線の向きになる。 */
  readonly points: readonly Vec3Tuple[];
  /**
   * true なら閉じた曲線(最後の点から最初の点へ戻ってつながる)。省略時は開いた曲線。
   * **閉じるための重複点(最後にもう一度 `points[0]`)は入れない。**
   * 通過点方式では重なった点として断る。
   */
  readonly closed?: boolean;
  /**
   * Only control splines may override the ordinary automatic degree: 1 for certified function chords, 3 for a
   * certified smooth function curve, which must also carry its explicit knots.
   */
  readonly degree?: 1 | 3;
  /**
   * Distinct, strictly increasing knots of a smooth function curve (degree 3, open). Multiplicities are implied:
   * 4 at both ends and 2 inside, so the curve is C1 and `points` holds exactly 2 * knots.length poles.
   */
  readonly knots?: readonly number[];
}

/**
 * OCCT の `Geom_BSplineCurve_1` へそのまま渡せる形。
 * 節点は**同じ値をまとめた並び**で、`multiplicities` がその重なり回数を持つ。
 */
export interface BSplineData {
  readonly poles: readonly Vec3Tuple[];
  readonly knots: readonly number[];
  readonly multiplicities: readonly number[];
  readonly degree: number;
  readonly periodic: boolean;
}

/**
 * 点の数から次数を決める。**min(点の数 - 1, 3)。**
 * 点が 2 個なら 1 次(直線)、3 個なら 2 次、4 個以上なら 3 次になる。
 */
export function splineDegree(pointCount: number): number {
  return numericSplineDegree(pointCount);
}

function isFiniteVec3(point: Vec3Tuple): boolean {
  return Number.isFinite(point[0]) && Number.isFinite(point[1]) && Number.isFinite(point[2]);
}

/**
 * 関数の滑らかな曲線(C1 の 3 次)。節点は与えられたまま使い、多重度は両端 4・内側 2 に固定する。
 * 一様な節点へ直すと曲線の形が変わるため、ここでは何も解き直さない。
 */
function explicitCubicData(spec: SplineSpec): BSplineData {
  const knots = spec.knots;
  if (spec.mode !== 'control' || spec.degree !== 3 || spec.closed === true || knots === undefined
    || knots.length < 2 || spec.points.length !== 2 * knots.length) {
    throw new Error('滑らかな関数曲線は、節点と制御点を組にした開いた3次の曲線として指定してください。');
  }
  for (let index = 0; index < knots.length; index += 1) {
    if (!Number.isFinite(knots[index]) || (index > 0 && !(knots[index] > knots[index - 1]))) {
      throw new Error('滑らかな関数曲線の節点は増加する有限の実数にしてください。');
    }
  }
  return numericExplicitCubicData(spec.points, knots);
}

/**
 * スプラインの指定を、OCCT へ渡す極・節点・多重度・次数へ直す(OCCT を使わない純関数)。
 * 使えない指定は日本語の `Error` で断る。
 */
export function bsplineDataForSpline(spec: SplineSpec): BSplineData {
  const points = spec.points;
  const closed = spec.closed === true;
  if (points.length < (closed ? 3 : 2)) {
    throw new Error(closed ? TOO_FEW_CLOSED_MESSAGE : TOO_FEW_OPEN_MESSAGE);
  }
  for (const point of points) {
    if (!isFiniteVec3(point)) {
      throw new Error(BAD_NUMBER_MESSAGE);
    }
  }

  if (spec.degree === 3 || spec.knots !== undefined) {
    return explicitCubicData(spec);
  }
  if (spec.degree !== undefined && (spec.degree !== 1 || spec.mode !== 'control')) {
    throw new Error('一次のスプラインは制御点の折れ線として指定してください。');
  }
  const degree = spec.degree ?? splineDegree(points.length);

  if (spec.mode === 'control') {
    return controlPointData(points, degree, closed);
  }

  // 通過点方式は弦の長さでパラメータを決めるので、重なった点があると割り算が壊れる。
  // 制御点方式では重なっていても構わないため、この検査は通過点方式だけに掛ける。
  if (numericHasDuplicateSplinePoint(points, closed)) {
    throw new Error(DUPLICATE_POINT_MESSAGE);
  }

  const data = closed ? interpolateClosed(points, degree) : interpolateOpen(points, degree);
  if (data === null) {
    throw new Error(UNSOLVABLE_MESSAGE);
  }
  return data;
}

/**
 * スプラインの辺を作る(FR-317)。
 * 通過点方式は与えた点をぴったり通り(実測 1e-14mm 以下)、制御点方式は与えた点を極にする。
 * `closed` が true なら閉じた曲線になり、そのまま面の境界に使える。
 */
export function makeSplineEdge(oc: OpenCascadeInstance, spec: SplineSpec): OcctEdgeHandle {
  const data = bsplineDataForSpline(spec);
  const { keep, release } = createAllocations();

  try {
    const poles = keep(new oc.TColgp_Array1OfPnt_2(1, data.poles.length));
    for (let index = 0; index < data.poles.length; index += 1) {
      const pole = data.poles[index];
      poles.SetValue(index + 1, keep(new oc.gp_Pnt_3(pole[0], pole[1], pole[2])));
    }

    // 節点の型は宣言上 IntTools_CArray1OfReal だが、その名前の実体は型定義にも
    // 実行時にも無い。中身が同じ TColStd_Array1OfReal が実際に受け取られる
    // (2026-09-04 に Node 上で実測)。
    const knots = keep(new oc.TColStd_Array1OfReal_2(1, data.knots.length));
    for (let index = 0; index < data.knots.length; index += 1) {
      knots.SetValue(index + 1, data.knots[index]);
    }

    const multiplicities = keep(
      new oc.TColStd_Array1OfInteger_2(1, data.multiplicities.length),
    );
    for (let index = 0; index < data.multiplicities.length; index += 1) {
      multiplicities.SetValue(index + 1, data.multiplicities[index]);
    }

    const curve = keep(
      new oc.Geom_BSplineCurve_1(poles, knots, multiplicities, data.degree, data.periodic),
    );
    // Handle_Geom_BSplineCurve では MakeEdge_24 が受け取らない(冒頭の注釈)。
    const curveHandle = keep(new oc.Handle_Geom_Curve_2(curve));
    const maker = keep(new oc.BRepBuilderAPI_MakeEdge_24(curveHandle));
    if (!maker.IsDone()) {
      throw new Error(BUILD_FAILED_MESSAGE);
    }
    const edge = keep(maker.Edge());
    return { edge, delete: release };
  } catch (error) {
    release();
    throw error;
  }
}
