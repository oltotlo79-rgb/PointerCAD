import type { SegmentSpec, Vec3Tuple } from '../types.js';
import { addVec, analyzeSketchCorner, CORNER_TOLERANCE_MM, scaleVec } from './sketchCorner.js';

/**
 * スケッチの面取り(FR-323、計画書 P4 §2.5、タスク19)。
 *
 * 角を作る 2 本の線分と 2 つの距離から、面取り後の各線の新しい端点を求める。
 * 新しく足す面取りの線は、**その 2 点をそのまま結んだ線分**になる。model 側は
 * 2 本の線の端点を書き換え、面取りの線を 1 本足す(§0.10 のハイブリッド)。
 *
 * ## OCCT(ChFi2d_ChamferAPI)を使わない理由(2026-09-04 実測)
 *
 * 計画書 §0.a-0.20 の `ChFi2d_ChamferAPI_3` → `Perform()` → `Result(edge1, edge2, 3, 4)` を
 * 着手時に Node 上で実測し、次を確かめた。
 *
 * - **§1.4-4 の答えは「はい」**: `Result` は入力の 2 辺を呼び出し側の変数ごと書き換える。
 *   実測: (20,0,0)-(0,0,0) の辺が (20,0,0)-(3,0,0) へ、(0,0,0)-(0,20,0) の辺が
 *   (0,4,0)-(0,20,0) へ変わり、戻り値は (3,0,0)-(0,4,0) の線分だった。
 * - 面取りの値は**厳密**(フィレットのような数値解法のずれは無い)。距離が線の長さを
 *   超えると `Perform()` は true のまま `Result` が数値の C++ 例外を投げる。
 *
 * つまり面取りは「角から各線に沿って距離のぶんだけ進んだ点」を置くだけであり、
 * OCCT に頼まなくても同じ値が出る。WASM への往復と、数値のまま飛んでくる例外の
 * 翻訳をしないぶん簡単で速いので **OCCT を呼ばない**。フィレット側と同じ判断で、
 * 計画書との食い違いは統括へ報告済み。両者が一致することは
 * makeSketchChamfer2d.test.ts が ChFi2d_ChamferAPI_3 と突き合わせて検査で固定する。
 *
 * **作図面を受け取らない。** 面取りの結果は 2 つの絶対座標だけで、円弧のように
 * 「どの平面のどの向きから測った角度か」を要らない。端点を共有する 2 本の線分は
 * 必ず同じ平面に乗るので、3D スケッチ(作図面なし、FR-330)の角でもそのまま働く。
 */

/** 距離が正の数でないとき。 */
const DISTANCE_MESSAGE = '面取りの距離は 0 より大きい数にしてください。';

/** 接点が線からはみ出すとき。 */
const DISTANCE_TOO_LARGE_MESSAGE =
  '面取りの距離が大きすぎます。距離を小さくするか、線を長くしてください。';

/** 角を作る 2 本の線分と、それぞれの線に沿って削る距離。 */
export interface SketchChamferSpec {
  readonly line1: SegmentSpec;
  readonly line2: SegmentSpec;
  /** 角から line1 に沿って削る距離(mm)。0 より大きい数。 */
  readonly distance1: number;
  /** 角から line2 に沿って削る距離(mm)。等距離の面取りなら distance1 と同じ値。 */
  readonly distance2: number;
}

export interface SketchChamferResult {
  /**
   * 面取り後、line1 側の新しい端点。
   * **追加する面取りの線は trimmed1 から trimmed2 へ引く。** 2 本の線の新しい端点
   * そのものなので、線と面取りの線の間に隙間が生じない(計画書の chamferPoint1 /
   * chamferPoint2 は同じ点を別名で 2 度持つことになるので、名前を分けていない)。
   */
  readonly trimmed1: Vec3Tuple;
  /** 面取り後、line2 側の新しい端点。 */
  readonly trimmed2: Vec3Tuple;
}

/**
 * スケッチの面取り(FR-323)。**OCCT を使わない純関数**(冒頭の注釈)。
 *
 * 角から line1 に沿って distance1、line2 に沿って distance2 進んだ点を返す。
 * 等距離(distance1 = distance2 = d)で直角の角なら、面取りの線の長さは d·√2 になる。
 */
export function makeSketchChamfer(spec: SketchChamferSpec): SketchChamferResult {
  if (!Number.isFinite(spec.distance1) || spec.distance1 <= 0) {
    throw new Error(DISTANCE_MESSAGE);
  }
  if (!Number.isFinite(spec.distance2) || spec.distance2 <= 0) {
    throw new Error(DISTANCE_MESSAGE);
  }

  const corner = analyzeSketchCorner(spec.line1, spec.line2);

  // 削る距離が線の反対の端に届く(または越える)と、書き換えた線の長さが 0 以下になる。
  if (
    spec.distance1 + CORNER_TOLERANCE_MM >= corner.length1 ||
    spec.distance2 + CORNER_TOLERANCE_MM >= corner.length2
  ) {
    throw new Error(DISTANCE_TOO_LARGE_MESSAGE);
  }

  return {
    trimmed1: addVec(corner.corner, scaleVec(corner.direction1, spec.distance1)),
    trimmed2: addVec(corner.corner, scaleVec(corner.direction2, spec.distance2)),
  };
}
