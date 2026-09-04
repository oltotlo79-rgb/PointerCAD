/**
 * スプライン(FR-317)の曲線の形を解く純関数(計画書 docs/plans/P4-スケッチ拡張.md §2.3、タスク5)。
 *
 * 通過点方式は「与えた点をぴったり通る B スプライン」を連立一次方程式で解いて求め、
 * 制御点方式は与えた点をそのまま極(poles)にする(統括の決定 §0.a-0.17)。
 * 次数は min(点の数 − 1, 3)。2 点なら 1 次(直線)、3 点なら 2 次、4 点以上なら 3 次。
 *
 * ## カーネルと同じ数式をここへ置いている理由
 *
 * 面を張るときの本物の曲線は OCCT(`packages/kernel/src/occt/makeSplineEdge.ts`)が作る。
 * しかし**画面の下描きは Worker を往復せずに描けなければならない**(マウスが動くたびの
 * 往復を無くす、NFR-PF-1、計画書 §2.7)。model からカーネルを呼べるのは `kernelBridge.ts`
 * だけと決まっている(同ファイル冒頭の決め、`rules/04-設計の規律.md` の依存方向)ので、
 * 解決や描画の経路からカーネルの純関数を借りることはできない。そこで同じ定義をここへ置く。
 *
 * 二重定義が食い違わないように、**「通過点をぴったり通る」という方式の定義そのもの**を
 * `splineMath.test.ts` が検査で固定する。将来カーネルの `CurveSpec` を
 * 「点の並び」ではなく「ここで解いた極・節点」を運ぶ形に変えれば、カーネル側の
 * 解き直しを消して 1 か所へ戻せる(タスク11・12・31 への申し送り)。
 *
 * DOM にもカーネルにも触れない純関数だけを置く。
 */

import type { ResolvedSpline } from './types.js';
import { addVec3, distanceVec3, scaleVec3, type Vec3 } from './vec3.js';

/**
 * 1 本のスプラインに置ける点の上限(統括の決定 §0.a-0.17)。
 * 極を解く連立一次方程式は点の数の 3 乗に比例するので、打ち間違いで莫大な数を
 * 置かれないための歯止めにする(点列の `MAX_POINT_ARRAY_COUNT` と同じ考え方)。
 */
export const MAX_SPLINE_POINTS = 100;

/** 開いた曲線の点の下限。2 点は直線として許す(§0.a-0.17)。 */
export const MIN_SPLINE_POINTS = 2;

/** 閉じた曲線の点の下限。2 点では輪にならない。 */
export const MIN_CLOSED_SPLINE_POINTS = 3;

/**
 * 次数の上限。3 次までにするのは、これ以上上げても見た目が良くならず、
 * 点数が増えたときに曲線が波打つため(高次の 1 スパンより 3 次の多スパンのほうが素直)。
 */
const MAX_DEGREE = 3;

/** 連続する 2 点がこの距離(mm)より近ければ「同じ位置」とみなす。カーネルと同じ値。 */
export const SPLINE_MIN_SPAN_MM = 1e-9;

/** 連立一次方程式でこの大きさ未満の主成分しか残らなければ、解けないと判断する。 */
const MIN_PIVOT = 1e-14;

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
  return Math.min(pointCount - 1, MAX_DEGREE);
}

/**
 * 通過点方式で使えない「同じ位置の点の並び」があるか。
 * 通過点方式は弦の長さでパラメータを決めるので、重なった点があると割り算が壊れる。
 * 制御点方式では重なっていても構わないため、呼び出し側は通過点方式にだけ掛ける。
 */
export function hasDuplicateSplinePoint(points: readonly Vec3[], closed: boolean): boolean {
  for (let index = 1; index < points.length; index += 1) {
    if (distanceVec3(points[index], points[index - 1]) < SPLINE_MIN_SPAN_MM) {
      return true;
    }
  }
  if (closed && points.length > 0) {
    return distanceVec3(points[0], points[points.length - 1]) < SPLINE_MIN_SPAN_MM;
  }
  return false;
}

/**
 * B スプラインの基底関数の値(NURBS Book のアルゴリズム A2.2)。
 * `span` は `knots[span] <= parameter < knots[span + 1]` を満たす添字。
 * 戻り値の `j` 番目は、極 `span − degree + j` に掛かる重み。
 *
 * 割り算の分母 `right[r + 1] + left[j − r]` は隣り合う節点の差の和なので、
 * 節点が単調で `span` が正しければ 0 にならない(この関数の呼び出しはすべてこのファイルの中)。
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
 * 連立一次方程式 `matrix · X = rows` を解く(部分ピボット付きのガウス・ジョルダン消去)。
 * 右辺は x・y・z の 3 列をまとめて解く。解けなければ `null`。
 *
 * 計算量は点の数の 3 乗に比例する。点の数は `MAX_SPLINE_POINTS` で抑えてある。
 */
function solveLinearSystem(
  matrix: readonly (readonly number[])[],
  rows: readonly Vec3[],
): Vec3[] | null {
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

  return work.map((row): Vec3 => [row[size], row[size + 1], row[size + 2]]);
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
function chordLengths(points: readonly Vec3[]): number[] {
  const lengths = [0];
  let total = 0;
  for (let index = 1; index < points.length; index += 1) {
    total += distanceVec3(points[index], points[index - 1]);
    lengths.push(total);
  }
  return lengths;
}

/**
 * 開いた通過点補間(NURBS Book のアルゴリズム A9.1)。
 *
 * 1. 各点のパラメータを弦の長さの割合で決める(等間隔ではなく、離れた点の間を長く取る)。
 * 2. 節点をパラメータの移動平均で決める。こうすると係数行列が必ず対角優位になる。
 * 3. 「点 k での曲線の値 = 点 k」を並べた連立一次方程式を解いて極を得る。
 */
function interpolateOpen(points: readonly Vec3[], degree: number): SplineCurveData | null {
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
 * 極は次数ぶん重なって現れるので、係数を同じ列へ足し込む。
 *
 * 極の添字の起点は「節点の並びの先頭 + 0」で、基底の添字 i に極 i を対応させる
 * (カーネル側が 2026-09-04 に Node 上で OCCT と突き合わせて確かめた決め)。
 */
function interpolateClosed(points: readonly Vec3[], degree: number): SplineCurveData | null {
  const count = points.length;
  const chords = chordLengths(points);
  const period = chords[count - 1] + distanceVec3(points[0], points[count - 1]);
  // 1 周ぶんの節点(先頭 0 から、1 周して period まで)。
  const knots = [...chords, period];

  const fullKnots = periodicFullKnots(knots, count, degree, period);

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
function controlPointData(
  points: readonly Vec3[],
  degree: number,
  closed: boolean,
): SplineCurveData {
  const count = points.length;
  if (closed) {
    // 周期曲線は「節点の重なりがすべて 1、節点の数 = 極の数 + 1」。
    const knots: number[] = [];
    for (let index = 0; index <= count; index += 1) {
      knots.push(index);
    }
    return {
      poles: [...points],
      knots,
      multiplicities: knots.map(() => 1),
      degree,
      periodic: true,
    };
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

/** 周期曲線の基底を求めるための、前後へ 1 周ずらした写しを足した節点の並び。 */
function periodicFullKnots(
  knots: readonly number[],
  count: number,
  degree: number,
  period: number,
): number[] {
  const fullKnots = new Array<number>(count + 1 + 2 * degree).fill(0);
  for (let index = 0; index <= count; index += 1) {
    fullKnots[index + degree] = knots[index];
  }
  for (let step = 1; step <= degree; step += 1) {
    fullKnots[degree - step] = knots[count - step] - period;
    fullKnots[count + degree + step] = knots[step] + period;
  }
  return fullKnots;
}

/** 重なりをそのまま並べた節点の列(基底の計算に使う形)へ戻す。 */
function expandKnots(data: SplineCurveData): number[] {
  const count = data.poles.length;
  if (data.periodic) {
    const period = data.knots[data.knots.length - 1] - data.knots[0];
    return periodicFullKnots(data.knots, count, data.degree, period);
  }
  const fullKnots: number[] = [];
  for (let index = 0; index < data.knots.length; index += 1) {
    for (let repeat = 0; repeat < data.multiplicities[index]; repeat += 1) {
      fullKnots.push(data.knots[index]);
    }
  }
  return fullKnots;
}

/**
 * スプラインの曲線の形(極・節点・多重度・次数)を解く。
 * 使えない指定(点が足りない、通過点が重なっている、方程式が解けない)は `null` を返す。
 * どこが悪いかを利用者へ伝えるのは解決の側(`resolveSketch.ts`)の担当で、
 * ここは「解けたか解けなかったか」だけを返す。
 */
export function splineCurveData(spline: ResolvedSpline): SplineCurveData | null {
  const points = spline.points;
  const minimum = spline.closed ? MIN_CLOSED_SPLINE_POINTS : MIN_SPLINE_POINTS;
  if (points.length < minimum || points.length > MAX_SPLINE_POINTS) {
    return null;
  }
  const degree = splineDegree(points.length);
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
  const spans = spline.closed ? spline.points.length : spline.points.length - 1;
  return sampleSplineCurve(data, Math.max(1, segmentsPerSpan * spans));
}
