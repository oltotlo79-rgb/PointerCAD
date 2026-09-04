import type { SegmentSpec, Vec3Tuple } from '../types.js';

/**
 * スケッチのフィレット・面取り(FR-323)が共通で使う「角の分析」。
 *
 * 角とは、端点を 1 つ共有する 2 本の線分が作る折れのこと。フィレット
 * (makeSketchFillet2d.ts)も面取り(makeSketchChamfer2d.ts)も、まずここで
 * 「どちらの端点を共有しているか」「角からそれぞれの線がどちらへ何 mm 伸びているか」
 * 「なす角は何ラジアンか」を求め、その上で接点を計算する。同じ判定を 2 か所に
 * 書かないために切り出してある。
 *
 * **このファイルは OCCT を呼ばない。** 置き場を occt/ にしているのは、呼び出し元の
 * makeSketchFillet2d.ts / makeSketchChamfer2d.ts と、材料になる SegmentSpec を使う
 * makeSketchEdges.ts が同じ場所にあり、探すときにひと続きで見つかるようにするため。
 * OCCT を使わない理由は makeSketchFillet2d.ts の冒頭に記す。
 */

/** 2 点が同じ位置とみなせる距離(mm)。OCCT 既定の 1e-7 より一桁ゆるく取る。 */
export const CORNER_TOLERANCE_MM = 1e-6;

/**
 * これ未満(ラジアン)の折れは角とみなさない。
 * なす角が 0 に近ければ 2 本が重なっており、π に近ければ一直線で、
 * どちらもフィレット・面取りの接点が数値誤差に埋もれて意味を持たない。
 */
const MIN_CORNER_ANGLE_RAD = 1e-6;

const NO_SHARED_ENDPOINT_MESSAGE =
  '2 本の線が端点を共有していません。角を作っている 2 本を選んでください。';
const ZERO_LENGTH_MESSAGE = '線の長さが 0 のため、角を作れません。';
const OVERLAPPING_MESSAGE = '2 本の線が重なっているため、角を作れません。';
const STRAIGHT_MESSAGE = '2 本の線が一直線のため、角がありません。';

/** 角を作る 2 本の線分の関係。角の点から見た形で持つ。 */
export interface SketchCorner {
  /** 2 本が共有している端点(2 点の中点。どちらも書き換える前提なので一方に寄せない)。 */
  readonly corner: Vec3Tuple;
  /** 角から line1 のもう一方の端へ向かう単位ベクトル。 */
  readonly direction1: Vec3Tuple;
  readonly direction2: Vec3Tuple;
  /** 角から line1 のもう一方の端までの長さ(mm)。 */
  readonly length1: number;
  readonly length2: number;
  /** 角から見た line1 のもう一方の端。線分を書き換えるとき、動かさない側の端点になる。 */
  readonly far1: Vec3Tuple;
  readonly far2: Vec3Tuple;
  /** 2 本のなす角(ラジアン)。0 < angle < π。 */
  readonly angle: number;
  /**
   * なす角の余弦・正弦(単位ベクトルの内積と外積の大きさ)。
   * 接点までの距離は tan(angle/2) = sinAngle / (1 + cosAngle) の半角の公式で出すので、
   * 角度へ直して三角関数を往復させるより桁が落ちない(直角なら丁度 1 になる)。
   */
  readonly cosAngle: number;
  readonly sinAngle: number;
}

export function subVec(a: Vec3Tuple, b: Vec3Tuple): Vec3Tuple {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

export function addVec(a: Vec3Tuple, b: Vec3Tuple): Vec3Tuple {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

export function scaleVec(v: Vec3Tuple, factor: number): Vec3Tuple {
  return [v[0] * factor, v[1] * factor, v[2] * factor];
}

export function dotVec(a: Vec3Tuple, b: Vec3Tuple): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

export function crossVec(a: Vec3Tuple, b: Vec3Tuple): Vec3Tuple {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

export function lengthVec(v: Vec3Tuple): number {
  return Math.hypot(v[0], v[1], v[2]);
}

/** 長さ 1 に直す。長さが 0(に埋もれる)なら null。 */
export function unitVec(v: Vec3Tuple): Vec3Tuple | null {
  const size = lengthVec(v);
  return size <= CORNER_TOLERANCE_MM ? null : scaleVec(v, 1 / size);
}

/** 2 点の中点。 */
function midpoint(a: Vec3Tuple, b: Vec3Tuple): Vec3Tuple {
  return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
}

function isSamePoint(a: Vec3Tuple, b: Vec3Tuple): boolean {
  return lengthVec(subVec(a, b)) <= CORNER_TOLERANCE_MM;
}

/**
 * 2 本の線分が共有している端点と、そこから見たそれぞれの反対の端を探す。
 *
 * 4 通り(to-from / to-to / from-from / from-to)を順に調べ、最初に見つかった
 * 組を採る。線分の向き(from と to のどちらが先か)は利用者の描いた順で決まり、
 * 角の意味には関わらないので、どの組で一致しても同じ角として扱う。
 */
function findSharedEndpoint(
  line1: SegmentSpec,
  line2: SegmentSpec,
): { corner: Vec3Tuple; far1: Vec3Tuple; far2: Vec3Tuple } | null {
  const ends1: readonly (readonly [Vec3Tuple, Vec3Tuple])[] = [
    [line1.to, line1.from],
    [line1.from, line1.to],
  ];
  const ends2: readonly (readonly [Vec3Tuple, Vec3Tuple])[] = [
    [line2.from, line2.to],
    [line2.to, line2.from],
  ];
  for (const [shared1, far1] of ends1) {
    for (const [shared2, far2] of ends2) {
      if (isSamePoint(shared1, shared2)) {
        return { corner: midpoint(shared1, shared2), far1, far2 };
      }
    }
  }
  return null;
}

/**
 * 角を作る 2 本の線分を分析する。角として成り立たないときは、
 * 利用者へそのまま見せる日本語の Error で断る(FR-504、NFR-RE-1)。
 *
 * なす角は atan2(|u1×u2|, u1·u2) で求める。acos(u1·u2) は角が 0 や π に近いとき
 * 引数が ±1 に張り付いて桁が落ちるが、atan2 は外積の大きさを併せて見るので
 * 端でも安定する(0 と π の近傍こそ、ここで断りたい領域である)。
 */
export function analyzeSketchCorner(line1: SegmentSpec, line2: SegmentSpec): SketchCorner {
  const shared = findSharedEndpoint(line1, line2);
  if (shared === null) {
    throw new Error(NO_SHARED_ENDPOINT_MESSAGE);
  }

  const vector1 = subVec(shared.far1, shared.corner);
  const vector2 = subVec(shared.far2, shared.corner);
  const direction1 = unitVec(vector1);
  const direction2 = unitVec(vector2);
  if (direction1 === null || direction2 === null) {
    throw new Error(ZERO_LENGTH_MESSAGE);
  }

  const cosAngle = dotVec(direction1, direction2);
  const sinAngle = lengthVec(crossVec(direction1, direction2));
  const angle = Math.atan2(sinAngle, cosAngle);
  if (angle <= MIN_CORNER_ANGLE_RAD) {
    throw new Error(OVERLAPPING_MESSAGE);
  }
  if (Math.PI - angle <= MIN_CORNER_ANGLE_RAD) {
    throw new Error(STRAIGHT_MESSAGE);
  }

  return {
    corner: shared.corner,
    direction1,
    direction2,
    length1: lengthVec(vector1),
    length2: lengthVec(vector2),
    far1: shared.far1,
    far2: shared.far2,
    angle,
    cosAngle,
    sinAngle,
  };
}
