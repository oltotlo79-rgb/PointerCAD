/**
 * スプラインの辺(FR-317、計画書 P4 §2.3、タスク8)。
 *
 * 「通過点」方式(与えた点を必ず通る)と「制御点」方式(与えた点が曲線を引っぱる)の
 * 2 とおりを、開いた曲線と閉じた曲線の両方について作る。
 *
 * **カーネルへ渡すのは `Geom_BSplineCurve_1`(極・節点・多重度・次数)だけで、
 * 通過点方式の補間そのものは、この場で自前に解く。** 理由を残す。
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

/** スプラインの次数の上限。3 次までにするのは、これ以上を上げても見た目が良くならず、
 *  点数が増えたときに曲線が波打つため(高次の 1 スパンより、3 次の多スパンのほうが素直)。 */
const MAX_DEGREE = 3;

/** 通過点方式で、連続する 2 点がこの距離(mm)より近ければ「同じ位置」とみなす。 */
const MIN_SPAN_LENGTH = 1e-9;

/** 連立一次方程式でこの大きさ未満の主成分しか残らなければ、解けないと判断する。 */
const MIN_PIVOT = 1e-14;

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
  return Math.min(pointCount - 1, MAX_DEGREE);
}

function isFiniteVec3(point: Vec3Tuple): boolean {
  return Number.isFinite(point[0]) && Number.isFinite(point[1]) && Number.isFinite(point[2]);
}

function distance(a: Vec3Tuple, b: Vec3Tuple): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

/**
 * B スプラインの基底関数の値(NURBS Book のアルゴリズム A2.2)。
 * `span` は `knots[span] <= u < knots[span + 1]` を満たす添字。
 * 戻り値の `j` 番目は、極 `span - degree + j` に掛かる重み。
 *
 * 割り算の分母 `right[r + 1] + left[j - r]` は隣り合う節点の差の和なので、
 * 節点が単調で `span` が正しければ 0 にならない(この関数の呼び出しはすべて内部)。
 */
function basisValues(
  span: number,
  parameter: number,
  degree: number,
  knots: readonly number[],
): number[] {
  const values = new Array<number>(degree + 1).fill(0);
  const left = new Array<number>(degree + 1).fill(0);
  const right = new Array<number>(degree + 1).fill(0);
  values[0] = 1;
  for (let step = 1; step <= degree; step += 1) {
    left[step] = parameter - knots[span + 1 - step];
    right[step] = knots[span + step] - parameter;
    let saved = 0;
    for (let index = 0; index < step; index += 1) {
      const share = values[index] / (right[index + 1] + left[step - index]);
      values[index] = saved + right[index + 1] * share;
      saved = left[step - index] * share;
    }
    values[step] = saved;
  }
  return values;
}

/**
 * 連立一次方程式 `matrix · X = rows` を解く(部分ピボット付きのガウス・ジョルダン消去)。
 * 右辺は x・y・z の 3 列をまとめて解く。解けなければ `null`。
 *
 * 計算量は点の数の 3 乗に比例する。スプラインの点は多くても数十個なので実用上は問題にならない。
 */
function solveLinearSystem(
  matrix: readonly (readonly number[])[],
  rows: readonly Vec3Tuple[],
): Vec3Tuple[] | null {
  const size = matrix.length;
  const width = size + 3;
  const work: number[][] = matrix.map((row, index) => [...row, ...rows[index]]);

  for (let column = 0; column < size; column += 1) {
    let pivot = column;
    for (let row = column + 1; row < size; row += 1) {
      if (Math.abs(work[row][column]) > Math.abs(work[pivot][column])) {
        pivot = row;
      }
    }
    if (Math.abs(work[pivot][column]) < MIN_PIVOT) {
      return null;
    }
    if (pivot !== column) {
      const swapped = work[pivot];
      work[pivot] = work[column];
      work[column] = swapped;
    }
    const head = work[column][column];
    for (let index = column; index < width; index += 1) {
      work[column][index] /= head;
    }
    for (let row = 0; row < size; row += 1) {
      if (row === column) {
        continue;
      }
      const factor = work[row][column];
      if (factor === 0) {
        continue;
      }
      for (let index = column; index < width; index += 1) {
        work[row][index] -= factor * work[column][index];
      }
    }
  }

  return work.map((row) => [row[size], row[size + 1], row[size + 2]]);
}

/** 同じ値が続く節点の並びを、値と重なり回数へ畳む。 */
function compressKnots(fullKnots: readonly number[]): {
  knots: number[];
  multiplicities: number[];
} {
  const knots: number[] = [];
  const multiplicities: number[] = [];
  for (const value of fullKnots) {
    const last = knots.length - 1;
    if (last >= 0 && Math.abs(knots[last] - value) < 1e-12) {
      multiplicities[last] += 1;
    } else {
      knots.push(value);
      multiplicities.push(1);
    }
  }
  return { knots, multiplicities };
}

/** 点列の弦の長さを先頭から積み上げた並び(通過点方式のパラメータの素)。 */
function chordLengths(points: readonly Vec3Tuple[]): number[] {
  const lengths = [0];
  let total = 0;
  for (let index = 1; index < points.length; index += 1) {
    total += distance(points[index], points[index - 1]);
    lengths.push(total);
  }
  return lengths;
}

/**
 * `knots[span] <= parameter < knots[span + 1]` を満たす添字を二分探索で探す
 * (NURBS Book のアルゴリズム A2.1)。`lastPole` は極の添字の最大値。
 */
function findSpan(
  knots: readonly number[],
  degree: number,
  lastPole: number,
  parameter: number,
): number {
  if (parameter >= knots[lastPole + 1]) {
    return lastPole;
  }
  if (parameter <= knots[degree]) {
    return degree;
  }
  let low = degree;
  let high = lastPole + 1;
  let middle = Math.floor((low + high) / 2);
  while (parameter < knots[middle] || parameter >= knots[middle + 1]) {
    if (parameter < knots[middle]) {
      high = middle;
    } else {
      low = middle;
    }
    middle = Math.floor((low + high) / 2);
  }
  return middle;
}

/**
 * 開いた通過点補間(NURBS Book のアルゴリズム A9.1)。
 *
 * 1. 各点のパラメータを弦の長さの割合で決める(等間隔ではなく、離れた点の間を長く取る)。
 * 2. 節点をパラメータの移動平均で決める。こうすると係数行列が必ず対角優位になる。
 * 3. 「点 k での曲線の値 = 点 k」を並べた連立一次方程式を解いて極を得る。
 */
function interpolateOpen(points: readonly Vec3Tuple[], degree: number): BSplineData | null {
  const count = points.length;
  const last = count - 1;
  const chords = chordLengths(points);
  const total = chords[last];
  const parameters = chords.map((value) => value / total);
  parameters[last] = 1;

  const fullKnots = new Array<number>(count + degree + 1).fill(0);
  for (let index = last + 1; index < fullKnots.length; index += 1) {
    fullKnots[index] = 1;
  }
  for (let start = 1; start <= last - degree; start += 1) {
    let sum = 0;
    for (let index = start; index <= start + degree - 1; index += 1) {
      sum += parameters[index];
    }
    fullKnots[start + degree] = sum / degree;
  }

  const matrix: number[][] = [];
  for (let row = 0; row < count; row += 1) {
    const coefficients = new Array<number>(count).fill(0);
    const span = findSpan(fullKnots, degree, last, parameters[row]);
    const values = basisValues(span, parameters[row], degree, fullKnots);
    for (let offset = 0; offset <= degree; offset += 1) {
      coefficients[span - degree + offset] = values[offset];
    }
    matrix.push(coefficients);
  }

  const poles = solveLinearSystem(matrix, points);
  if (poles === null) {
    return null;
  }
  const { knots, multiplicities } = compressKnots(fullKnots);
  return { poles, knots, multiplicities, degree, periodic: false };
}

/**
 * 閉じた通過点補間(周期 B スプライン)。
 *
 * 閉じた曲線は極も節点も輪になっているので、開いた場合の「両端を固定する」やり方は使えない。
 * 代わりに節点を 1 周ぶん(最後の点から最初の点へ戻る弦を含む)並べ、
 * その前後へ 1 周ぶんずらした写しを足した並びで基底を求める。
 * 極は `次数` 個ぶん重なって現れるので、係数を同じ列へ足し込む。
 *
 * **極の添字の起点は「節点の並びの先頭 + 0」である。** OCCT の周期曲線は
 * 基底の添字 i に極 i を対応させる(2026-09-04 に Node 上で実測して確かめた。
 * 起点を `次数` ぶんずらすと、曲線の形は同じでも通る点の順が回ってしまう)。
 */
function interpolateClosed(points: readonly Vec3Tuple[], degree: number): BSplineData | null {
  const count = points.length;
  const chords = chordLengths(points);
  const period = chords[count - 1] + distance(points[0], points[count - 1]);
  // 1 周ぶんの節点(先頭 0 から、1 周して period まで)。
  const knots = [...chords, period];

  // 前後へ 1 周ずらした写しを足した並び。基底の計算にだけ使う。
  const fullKnots = new Array<number>(count + 1 + 2 * degree).fill(0);
  for (let index = 0; index <= count; index += 1) {
    fullKnots[index + degree] = knots[index];
  }
  for (let step = 1; step <= degree; step += 1) {
    fullKnots[degree - step] = knots[count - step] - period;
    fullKnots[count + degree + step] = knots[step] + period;
  }

  const matrix: number[][] = [];
  for (let row = 0; row < count; row += 1) {
    const coefficients = new Array<number>(count).fill(0);
    const span = degree + row;
    const values = basisValues(span, knots[row], degree, fullKnots);
    for (let offset = 0; offset <= degree; offset += 1) {
      const pole = (((span - degree + offset) % count) + count) % count;
      coefficients[pole] += values[offset];
    }
    matrix.push(coefficients);
  }

  const poles = solveLinearSystem(matrix, points);
  if (poles === null) {
    return null;
  }
  return {
    poles,
    knots,
    multiplicities: knots.map(() => 1),
    degree,
    periodic: true,
  };
}

/** 制御点方式(与えた点をそのまま極にする)の節点と多重度。 */
function controlPointData(points: readonly Vec3Tuple[], degree: number, closed: boolean): BSplineData {
  const count = points.length;
  if (closed) {
    // 周期曲線は「節点の重なりがすべて 1、節点の数 = 極の数 + 1」。
    const knots: number[] = [];
    for (let index = 0; index <= count; index += 1) {
      knots.push(index);
    }
    return { poles: [...points], knots, multiplicities: knots.map(() => 1), degree, periodic: true };
  }
  // 端を固定する曲線は「両端の重なりが 次数 + 1、内側は 1、重なりの合計 = 極の数 + 次数 + 1」。
  const interior = count - degree - 1;
  const knots: number[] = [];
  const multiplicities: number[] = [];
  for (let index = 0; index <= interior + 1; index += 1) {
    knots.push(index);
    multiplicities.push(index === 0 || index === interior + 1 ? degree + 1 : 1);
  }
  return { poles: [...points], knots, multiplicities, degree, periodic: false };
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

  const degree = splineDegree(points.length);

  if (spec.mode === 'control') {
    return controlPointData(points, degree, closed);
  }

  // 通過点方式は弦の長さでパラメータを決めるので、重なった点があると割り算が壊れる。
  // 制御点方式では重なっていても構わないため、この検査は通過点方式だけに掛ける。
  for (let index = 1; index < points.length; index += 1) {
    if (distance(points[index], points[index - 1]) < MIN_SPAN_LENGTH) {
      throw new Error(DUPLICATE_POINT_MESSAGE);
    }
  }
  if (closed && distance(points[0], points[points.length - 1]) < MIN_SPAN_LENGTH) {
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
