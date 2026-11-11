/**
 * スプライン(FR-317)の曲線の形を解く純関数(計画書 docs/plans/P4-スケッチ拡張.md §2.3、タスク5)。
 *
 * 通過点方式は「与えた点をぴったり通る B スプライン」を連立一次方程式で解いて求め、
 * 制御点方式は与えた点をそのまま極(poles)にする(統括の決定 §0.a-0.17)。
 * 次数は min(点の数 − 1, 3)。2 点なら 1 次(直線)、3 点なら 2 次、4 点以上なら 3 次。
 *
 * 下描きはWorkerを往復せずに描く(NFR-PF-1)。補間の純数値処理は、専用の
 * kernelBridge/splineMath adapterを通してimportを持たないkernel数値subpathへ委譲する。
 * この限定入口はWorker/OCCTやkernelBridge.ts本体へ依存せず、既存のCurveSpec・保存形式を変えない。
 * modelのnullと点数上限、kernelの日本語Errorと検証順序は各adapterに残す。
 *
 * DOM にもカーネルにも触れない純関数だけを置く。
 */

import { basisValues, findSpan, interpolateOpen, interpolateClosed, controlPointData,
  explicitCubicData as numericExplicitCubicData, splineDegree as numericSplineDegree,
  hasDuplicateSplinePoint as numericHasDuplicateSplinePoint, expandKnots, SPLINE_MIN_SPAN_MM as numericMinSpanMm } from '../kernelBridge/splineMath.js';
import type { ResolvedSpline } from './types.js';
import { addVec3, scaleVec3, type Vec3 } from './vec3.js';

/**
 * 1 本のスプラインに置ける点の上限(統括の決定 §0.a-0.17)。
 * 極を解く連立一次方程式は点の数の 3 乗に比例するので、打ち間違いで莫大な数を
 * 置かれないための歯止めにする(点列の `MAX_POINT_ARRAY_COUNT` と同じ考え方)。
 */
export const MAX_SPLINE_POINTS = 100;

/** Linear generated curves need no interpolation solver; keep the function sampling ceiling. */
export const MAX_LINEAR_SPLINE_POINTS = 200_000;

/** 開いた曲線の点の下限。2 点は直線として許す(§0.a-0.17)。 */
export const MIN_SPLINE_POINTS = 2;

/** 閉じた曲線の点の下限。2 点では輪にならない。 */
export const MIN_CLOSED_SPLINE_POINTS = 3;


/** 連続する 2 点がこの距離(mm)より近ければ「同じ位置」とみなす。カーネルと同じ値。 */
export const SPLINE_MIN_SPAN_MM = numericMinSpanMm;


/** 節点と節点の間(1 スパン)を何本の線分で描くか。表示と当たり判定の粗さ。 */
export const SPLINE_SEGMENTS_PER_SPAN = 16;

// 断りの文言はカーネル(packages/kernel/src/occt/makeSplineEdge.ts)と揃える。
// 同じ入力に対して下描きと本物の曲線が同じ理由で断るようにするため。
export const SPLINE_TOO_FEW_OPEN_MESSAGE = 'スプラインには点が 2 個以上必要です。';
export const SPLINE_TOO_FEW_CLOSED_MESSAGE = '閉じたスプラインには点が 3 個以上必要です。';
export const SPLINE_DUPLICATE_POINT_MESSAGE =
  '同じ位置の点が続いているため、通過点のスプラインを作れません。点をずらしてください。';
export const SPLINE_TOO_MANY_MESSAGE = `スプラインの点は ${String(MAX_SPLINE_POINTS)} 個以下にしてください。`;

/**
 * OCCT の `Geom_BSplineCurve` へそのまま渡せる形。
 * 節点は**同じ値をまとめた並び**で、`multiplicities` がその重なり回数を持つ。
 */
export interface SplineCurveData {
  readonly poles: readonly Vec3[];
  readonly knots: readonly number[];
  readonly multiplicities: readonly number[];
  readonly degree: number;
  readonly periodic: boolean;
}

/** 点の数から次数を決める。**min(点の数 − 1, 3)。** */
export function splineDegree(pointCount: number): number {
  return numericSplineDegree(pointCount);
}

/**
 * 通過点方式で使えない「同じ位置の点の並び」があるか。
 * 通過点方式は弦の長さでパラメータを決めるので、重なった点があると割り算が壊れる。
 * 制御点方式では重なっていても構わないため、呼び出し側は通過点方式にだけ掛ける。
 */
export function hasDuplicateSplinePoint(points: readonly Vec3[], closed: boolean): boolean {
  return numericHasDuplicateSplinePoint(points, closed);
}

/**
 * 関数の滑らかな曲線(明示した節点を持つ C1 の 3 次)。カーネルの `makeSplineEdge.ts` と同じ決まりで、
 * 節点は与えられたまま、多重度は両端 4・内側 2、極は節点の 2 倍。形の崩れた記録は一様な曲線として読まずに断る。
 */
function explicitCubicData(spline: ResolvedSpline): SplineCurveData | null {
  const knots = spline.knots;
  if (spline.mode !== 'control' || spline.degree !== 3 || spline.closed || knots === undefined || knots.length < 2
    || spline.points.length !== 2 * knots.length || spline.points.length > MAX_LINEAR_SPLINE_POINTS) return null;
  for (let index = 0; index < knots.length; index += 1) {
    if (!Number.isFinite(knots[index]) || (index > 0 && !(knots[index] > knots[index - 1]))) return null;
  }
  // Like the kernel's makeSplineEdge, a pole that is not a finite XYZ point makes the record unsolvable.
  if (!spline.points.every((point) => point.length === 3 && point.every(Number.isFinite))) return null;
  return numericExplicitCubicData(spline.points, knots);
}

/**
 * 向きを逆にしたスプライン。明示した節点を持つ曲線は節点も `first + last − t` で写して並べ替える
 * (点だけを逆に並べると、不等間隔の節点では形が変わる)。曲線を逆向きにする処理はここを使う。
 */
export function reverseSpline(spline: ResolvedSpline): ResolvedSpline {
  const points = [...spline.points].reverse();
  const knots = spline.knots;
  if (knots === undefined) return { ...spline, points };
  const total = knots[0] + knots[knots.length - 1];
  return { ...spline, points, knots: knots.map((knot) => total - knot).reverse() };
}

/**
 * スプラインの曲線の形(極・節点・多重度・次数)を解く。
 * 使えない指定(点が足りない、通過点が重なっている、方程式が解けない)は `null` を返す。
 * どこが悪いかを利用者へ伝えるのは解決の側(`resolveSketch.ts`)の担当で、
 * ここは「解けたか解けなかったか」だけを返す。
 */
export function splineCurveData(spline: ResolvedSpline): SplineCurveData | null {
  if (spline.degree === 3 || spline.knots !== undefined) return explicitCubicData(spline);
  const points = spline.points;
  const minimum = spline.closed ? MIN_CLOSED_SPLINE_POINTS : MIN_SPLINE_POINTS;
  const linear = spline.degree === 1 && spline.mode === 'control';
  if (spline.degree !== undefined && !linear) return null;
  if (points.length < minimum || points.length > (linear ? MAX_LINEAR_SPLINE_POINTS : MAX_SPLINE_POINTS)) {
    return null;
  }
  const degree = spline.degree ?? splineDegree(points.length);
  if (spline.mode === 'control') {
    return controlPointData(points, degree, spline.closed);
  }
  if (hasDuplicateSplinePoint(points, spline.closed)) {
    return null;
  }
  return spline.closed ? interpolateClosed(points, degree) : interpolateOpen(points, degree);
}

/** 曲線の上の 1 点。`parameter` は `curveDomain` が返す範囲の中の値。 */
function pointAt(data: SplineCurveData, fullKnots: readonly number[], parameter: number): Vec3 {
  const count = data.poles.length;
  const { degree } = data;
  let span: number;
  if (data.periodic) {
    // 周期曲線の節点は重なりが無いので、1 周ぶんの並びを前から見れば区間が決まる。
    let index = 0;
    while (index + 1 < count && parameter >= data.knots[index + 1]) {
      index += 1;
    }
    span = degree + index;
  } else {
    span = findSpan(fullKnots, degree, count - 1, parameter);
  }
  const values = basisValues(span, parameter, degree, fullKnots);
  let point: Vec3 = [0, 0, 0];
  for (let offset = 0; offset <= degree; offset += 1) {
    const raw = span - degree + offset;
    const pole = data.periodic ? ((raw % count) + count) % count : raw;
    point = addVec3(point, scaleVec3(data.poles[pole], values[offset]));
  }
  return point;
}

/** 曲線のパラメータの始まりと終わり。 */
function curveDomain(data: SplineCurveData): readonly [number, number] {
  return data.periodic
    ? [data.knots[0], data.knots[data.poles.length]]
    : [data.knots[0], data.knots[data.knots.length - 1]];
}

/**
 * 曲線の上の点を等間隔のパラメータで拾う(`divisions` 区間、両端を含む `divisions + 1` 点)。
 * 表示用の折れ線と、検査で「通過点を通っているか」を測るのに使う。
 */
export function sampleSplineCurve(data: SplineCurveData, divisions: number): Vec3[] {
  const fullKnots = expandKnots(data);
  const [start, end] = curveDomain(data);
  const points: Vec3[] = [];
  for (let index = 0; index <= divisions; index += 1) {
    points.push(pointAt(data, fullKnots, start + ((end - start) * index) / divisions));
  }
  return points;
}

/**
 * 曲線の上の 1 点を「0(始まり)〜1(終わり)」の割合で拾う(FR-322、タスク17)。
 *
 * `sampleSplineCurve` が全体を等間隔で拾うのに対し、こちらは**狭めた区間の中だけを
 * 拾い直す**のに使う(`intersectionMath.ts` の交点の追い込み)。等間隔の並びを
 * 何度も作り直さずに済むよう、点 1 つを返す形にしてある。
 * 割合は 0〜1 に収めてから使う(範囲の外を渡しても曲線の外へは出ない)。
 */
export function splinePointAt(data: SplineCurveData, ratio: number): Vec3 {
  const fullKnots = expandKnots(data);
  const [start, end] = curveDomain(data);
  const clamped = Math.min(Math.max(ratio, 0), 1);
  return pointAt(data, fullKnots, start + (end - start) * clamped);
}

/**
 * 表示用の折れ線(FR-317)。両端を必ず含める。
 *
 * 曲線を解けなかったときは、与えられた点をそのまま結んだ折れ線を返す。
 * 何も描かずに消えるより、置いた点の並びが見えるほうが直しやすいため
 * (FR-504、NFR-RE-1「止めずに警告する」。断りの文言は解決の側が出す)。
 */
export function sampleSpline(
  spline: ResolvedSpline,
  segmentsPerSpan = SPLINE_SEGMENTS_PER_SPAN,
): Vec3[] {
  const data = splineCurveData(spline);
  if (data === null) {
    if (spline.points.length === 0) {
      return [];
    }
    return spline.closed ? [...spline.points, spline.points[0]] : [...spline.points];
  }
  // Every knot is a real corner. Keep them exactly and avoid making 16 redundant points per span.
  if (data.degree === 1) return spline.closed ? [...data.poles, data.poles[0]] : [...data.poles];
  if (spline.knots !== undefined) {
    // Nonuniform knots: divide each span separately so a short span is not skipped by an even global step.
    const fullKnots = expandKnots(data);
    const points: Vec3[] = [];
    for (let span = 0; span < data.knots.length - 1; span += 1) {
      const lower = data.knots[span], upper = data.knots[span + 1];
      for (let step = span === 0 ? 0 : 1; step <= segmentsPerSpan; step += 1) {
        points.push(pointAt(data, fullKnots, lower + ((upper - lower) * step) / segmentsPerSpan));
      }
    }
    return points;
  }
  const spans = spline.closed ? spline.points.length : spline.points.length - 1;
  return sampleSplineCurve(data, Math.max(1, segmentsPerSpan * spans));
}
