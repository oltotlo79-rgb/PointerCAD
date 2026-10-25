/**
 * 下絵の四隅補正。出力矩形の正規化座標(s,t)から、元画像の正規化座標(u,v)へ写す。
 * 画像バイト・画素寸法・作図面mmには依存しない。左上(0,0)、右下(1,1)で、vは下向き。
 */

export type CanvasNormalizedPoint = readonly [number, number];

/** 元画像内の左上、右上、右下、左下。補正画像ではこの四隅を矩形全体へ広げる。 */
export type CanvasSourceQuad = readonly [
  CanvasNormalizedPoint,
  CanvasNormalizedPoint,
  CanvasNormalizedPoint,
  CanvasNormalizedPoint,
];

/** SketchCanvasに保存する入力条件。行列は導出できるため保存しない。 */
export interface CanvasRectification {
  readonly sourceQuad: CanvasSourceQuad;
}

/** 行優先の3x3行列。h22は1。GLSLのmat3へ渡す側は列優先へ転置する。 */
export type CanvasHomography = readonly [
  number, number, number,
  number, number, number,
  number, number, number,
];

export type CanvasHomographyRefusal =
  | 'nonFinite'
  | 'outOfImage'
  | 'duplicate'
  | 'collinear'
  | 'selfIntersection'
  | 'singular';

export type CanvasHomographyResult =
  | { readonly ok: true; readonly homography: CanvasHomography }
  | { readonly ok: false; readonly reason: CanvasHomographyRefusal };

const DESTINATION: CanvasSourceQuad = [[0, 0], [1, 0], [1, 1], [0, 1]];

// 正規化画像の対角長を1前後にした無次元閾値。通常の1画素離れた点を拒否しない。
// 以下はすべて画像幅・高さを1とする正規化座標上の無次元閾値。
// 1px程度離れた点を拒否せず、浮動小数点の丸めやほぼ特異な入力を拒む。
const MIN_POINT_DISTANCE = 1e-9;
const MIN_TRIANGLE_CROSS = 1e-10;
const MIN_PIVOT = 1e-12;
const MIN_DENOMINATOR = 1e-10;
const MAX_CORNER_RESIDUAL = 1e-7;

function cross(a: CanvasNormalizedPoint, b: CanvasNormalizedPoint, c: CanvasNormalizedPoint): number {
  return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
}

/**
 * 4対応の8元一次系を部分ピボット付きGauss-Jordan法で解く。
 * h22=1への規格化は、有限の左上対応で必ず可能。
 */
function solveEight(rows: number[][]): readonly number[] | null {
  const width = 8;
  for (let column = 0; column < width; column += 1) {
    let pivot = column;
    for (let row = column + 1; row < width; row += 1) {
      if (Math.abs(rows[row]?.[column] ?? 0) > Math.abs(rows[pivot]?.[column] ?? 0)) pivot = row;
    }
    const pivotValue = rows[pivot]?.[column];
    if (pivotValue === undefined || !Number.isFinite(pivotValue) || Math.abs(pivotValue) < MIN_PIVOT) return null;
    const current = rows[column];
    const chosen = rows[pivot];
    if (current === undefined || chosen === undefined) return null;
    rows[column] = chosen;
    rows[pivot] = current;
    const pivotRow = rows[column];
    const divisor = pivotRow?.[column];
    if (divisor === undefined) return null;
    for (let index = column; index <= width; index += 1) {
      const value = pivotRow[index];
      if (value === undefined) return null;
      pivotRow[index] = value / divisor;
    }
    for (let row = 0; row < width; row += 1) {
      if (row === column) continue;
      const factor = rows[row]?.[column];
      if (factor === undefined) return null;
      const rowValues = rows[row];
      if (rowValues === undefined) return null;
      for (let index = column; index <= width; index += 1) {
        const value = rows[row]?.[index];
        const leading = pivotRow[index];
        if (value === undefined || leading === undefined) return null;
        rowValues[index] = value - factor * leading;
      }
    }
  }
  const answer = rows.map(row => row[width]);
  return answer.every((value): value is number => value !== undefined && Number.isFinite(value)) ? answer : null;
}

/** 同じ行列をCPUの座標変換とGPUへの係数渡しの両方で使う。分母0/非有限は採用しない。 */
export function projectCanvasHomography(
  homography: CanvasHomography,
  point: CanvasNormalizedPoint,
): CanvasNormalizedPoint | null {
  const [s, t] = point;
  const denominator = homography[6] * s + homography[7] * t + homography[8];
  if (!Number.isFinite(denominator) || Math.abs(denominator) < MIN_DENOMINATOR) return null;
  const u = (homography[0] * s + homography[1] * t + homography[2]) / denominator;
  const v = (homography[3] * s + homography[4] * t + homography[5]) / denominator;
  return Number.isFinite(u) && Number.isFinite(v) ? [u, v] : null;
}

/**
 * 原画像の4隅から矩形→原画像の真の射影を解く。退化入力なら行列を一切返さない。
 * sourceQuadは左上/右上/右下/左下で、範囲0..1の正規化元画像座標。
 */
export function solveCanvasHomography(sourceQuad: CanvasSourceQuad): CanvasHomographyResult {
  for (const [u, v] of sourceQuad) {
    if (!Number.isFinite(u) || !Number.isFinite(v)) return { ok: false, reason: 'nonFinite' };
    if (u < 0 || u > 1 || v < 0 || v > 1) return { ok: false, reason: 'outOfImage' };
  }
  for (let first = 0; first < 4; first += 1) {
    for (let second = first + 1; second < 4; second += 1) {
      const a = sourceQuad[first];
      const b = sourceQuad[second];
      if (a === undefined || b === undefined) return { ok: false, reason: 'singular' };
      if (Math.hypot(a[0] - b[0], a[1] - b[1]) <= MIN_POINT_DISTANCE) {
        return { ok: false, reason: 'duplicate' };
      }
    }
  }
  for (let first = 0; first < 4; first += 1) {
    for (let second = first + 1; second < 4; second += 1) {
      for (let third = second + 1; third < 4; third += 1) {
        const a = sourceQuad[first];
        const b = sourceQuad[second];
        const c = sourceQuad[third];
        if (a === undefined || b === undefined || c === undefined) return { ok: false, reason: 'singular' };
        if (Math.abs(cross(a, b, c)) <= MIN_TRIANGLE_CROSS) {
          return { ok: false, reason: 'collinear' };
        }
      }
    }
  }
  // 左上→右上→右下→左下は画面の下向きvで正。凹・交差・逆順は拒否する。
  for (let index = 0; index < 4; index += 1) {
    const a = sourceQuad[index];
    const b = sourceQuad[(index + 1) % 4];
    const c = sourceQuad[(index + 2) % 4];
    if (a === undefined || b === undefined || c === undefined || cross(a, b, c) <= MIN_TRIANGLE_CROSS) {
      return { ok: false, reason: 'selfIntersection' };
    }
  }

  const rows: number[][] = [];
  for (let index = 0; index < 4; index += 1) {
    const destination = DESTINATION[index];
    const source = sourceQuad[index];
    if (destination === undefined || source === undefined) return { ok: false, reason: 'singular' };
    const [s, t] = destination;
    const [u, v] = source;
    rows.push([s, t, 1, 0, 0, 0, -u * s, -u * t, u]);
    rows.push([0, 0, 0, s, t, 1, -v * s, -v * t, v]);
  }
  const solved = solveEight(rows);
  if (solved === null) return { ok: false, reason: 'singular' };
  const [h0, h1, h2, h3, h4, h5, h6, h7] = solved;
  if (h0 === undefined || h1 === undefined || h2 === undefined || h3 === undefined
    || h4 === undefined || h5 === undefined || h6 === undefined || h7 === undefined) {
    return { ok: false, reason: 'singular' };
  }
  const homography: CanvasHomography = [h0, h1, h2, h3, h4, h5, h6, h7, 1];
  for (let index = 0; index < 4; index += 1) {
    const destination = DESTINATION[index];
    const source = sourceQuad[index];
    if (destination === undefined || source === undefined) return { ok: false, reason: 'singular' };
    const denominator = homography[6] * destination[0] + homography[7] * destination[1] + 1;
    const projected = projectCanvasHomography(homography, destination);
    if (denominator <= MIN_DENOMINATOR || projected === null
      || Math.hypot(projected[0] - source[0], projected[1] - source[1]) > MAX_CORNER_RESIDUAL) {
      return { ok: false, reason: 'singular' };
    }
  }
  return { ok: true, homography };
}
