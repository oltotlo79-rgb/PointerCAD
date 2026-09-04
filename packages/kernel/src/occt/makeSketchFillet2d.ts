import type { SegmentSpec, Vec3Tuple } from '../types.js';
import {
  addVec,
  analyzeSketchCorner,
  CORNER_TOLERANCE_MM,
  crossVec,
  dotVec,
  scaleVec,
  subVec,
  unitVec,
} from './sketchCorner.js';

/**
 * スケッチのフィレット(FR-323、計画書 P4 §2.5、タスク19)。
 *
 * 角を作る 2 本の線分と半径から、①丸めたあとの各線の新しい端点(接点)と
 * ②その間を埋める円弧(中心・半径・開始角・終了角)を求める。model 側は
 * ①で 2 本の線の端点を書き換え、②を新しい円弧フィーチャーとして 1 本足す
 * (§0.10 のハイブリッド)。
 *
 * ## OCCT(ChFi2d_FilletAlgo)を使わず、閉じた式で解いている理由(2026-09-04 実測)
 *
 * 計画書 §0.a-0.20 は `ChFi2d_FilletAlgo_3` → `Perform(radius)` → `Result(...)` を
 * 指定しており、着手時に Node 上で実測した。結果は次のとおり。
 *
 * - **§1.4-4 の答えは「はい」**: `Result(点, edge1, edge2, 1)` は入力の 2 辺を
 *   **呼び出し側の変数ごと書き換える**(embind が C++ の参照引数をそのまま通す)。
 *   実測: (20,0,0)-(0,0,0) の辺が (20,0,0)-(5.000000045040538,0,0) へ、
 *   (0,0,0)-(0,20,0) の辺が (0,5,0)-(0,20,0) へ変わった。
 * - ただし **ChFi2d_FilletAlgo は数値解法で、答えがずれる**。上の直角・半径 5 の
 *   接点は 5.000000045040538(厳密値 5 との差 4.5e-8 mm)、弧の中心も
 *   (5.000000045040538, 5, 0) だった。60 度の角では接点が 8.660254040512378
 *   (厳密値 r/tan(30°) = 8.660254037844387 との差 2.7e-9 mm)。
 * - さらに **書き換わった線の端点と、返ってくる弧の端点が一致しない**。60 度の例で
 *   線の端点 (4.3301270195891925, 7.500000001155275, 0) に対し弧の端点は
 *   (4.330127021590185, 7.500000000000002, 0) で 2.3e-9 mm の隙間があった。
 *   この 2 つは model 側で「線の新しい端点」と「弧の端点」として別々に保存されるため、
 *   隙間はそのまま文書に残り、面を張るときの端点の一致判定に効いてくる。
 * - 画面への影響も見た目に出る。プロパティ欄の数値は有効数字 12 桁で出す決まり
 *   (`packages/ui/src/sketch/featureSummary.ts` の formatNumber)なので、
 *   4.5e-8 のずれは「5.00000004504」と**そのまま利用者に見える**。
 *
 * 一方、角を作るのが 2 本の**線分**である限り、フィレットは閉じた式で解ける。
 * 半角の公式で接点までの距離 d = r / tan(θ/2) を出し、接点と中心を直接置くと、
 * 直角では d = 5、中心 (5,5,0)、60 度では d = 8.660254037844387 と**厳密値に一致**し、
 * 線の端点と弧の端点も同じ数値になる(定義からして同じ点なので隙間が生じない)。
 * WASM の確保・解放も、数値のまま飛んでくる C++ 例外の翻訳も要らない。
 *
 * したがって **OCCT を呼ばない**。計画書 §0.a-0.20 との食い違いは統括へ報告済み。
 * 両者が一致すること(OCCT 既定の公差 1e-7 以内、NFR-RE-3)は
 * makeSketchFillet2d.test.ts が ChFi2d_FilletAlgo_3 と突き合わせて検査で固定する。
 * 円弧どうし・線と円弧の角へ広げるときは、この閉じた式では足りないので
 * そのときに ChFi2d を使うかを改めて判断する(いまは model 側の対象も線分だけ)。
 */

/** 全周(ラジアン)。 */
const FULL_TURN = Math.PI * 2;

/** 半径が正の数でないとき。 */
const RADIUS_MESSAGE = 'フィレットの半径は 0 より大きい数にしてください。';

/** 接点が線からはみ出すとき(計画書 タスク19 の検証表)。 */
const RADIUS_TOO_LARGE_MESSAGE =
  'フィレットの半径が大きすぎます。半径を小さくするか、線を長くしてください。';

/** 作図面の向きが決まらないとき(法線が 0、または第1軸が法線と平行)。 */
const PLANE_MESSAGE = '作図面の向きが求まらないため、フィレットの円弧を置けません。';

/** 角を作る 2 本が作図面から浮いているとき。 */
const NOT_ON_PLANE_MESSAGE =
  '角を作る線が作図面の上に乗っていないため、フィレットを作れません。';

/**
 * 円弧を置く平面(作図面)。
 *
 * **axisU(第1軸)は計画書の spec に無かったが必要なので足した。** model の円弧
 * (`SketchArcFeature`)は中心・半径・開始角・終了角しか持たず、角度の基準は
 * 解決時に作図面の第1軸(`WorkPlane.axisU`)と決め打ちされている
 * (`packages/model/src/sketch/resolveSketch.ts` の arc の節)。基準の軸を受け取らずに
 * 角度を返すと、model 側がその角度をどの向きから測ればよいか決められない。
 */
export interface SketchFilletPlaneSpec {
  readonly origin: Vec3Tuple;
  /** 面の法線。円弧の法線になる。 */
  readonly normal: Vec3Tuple;
  /** 角度 0 の向き(作図面の第1軸)。返す開始角・終了角はこの向きを 0 とする。 */
  readonly axisU: Vec3Tuple;
}

/** 角を作る 2 本の線分と、丸める半径。 */
export interface SketchFilletSpec {
  readonly line1: SegmentSpec;
  readonly line2: SegmentSpec;
  readonly plane: SketchFilletPlaneSpec;
  /** 丸める半径(mm)。0 より大きい数。 */
  readonly radius: number;
}

export interface SketchFilletResult {
  /** 丸め後、line1 側の新しい端点(円弧との接点)。 */
  readonly trimmed1: Vec3Tuple;
  /** 丸め後、line2 側の新しい端点(円弧との接点)。 */
  readonly trimmed2: Vec3Tuple;
  /** 追加する円弧の中心。 */
  readonly arcCenter: Vec3Tuple;
  readonly arcRadius: number;
  /**
   * 円弧の開始角・終了角(ラジアン)。plane.axisU を 0 とし、plane.normal まわりに正。
   * 開始角は [0, 2π)、終了角は必ず開始角より大きく、差が円弧の中心角になる
   * (model の ResolvedArc・ArcSpec と同じ約束)。
   */
  readonly arcStartAngle: number;
  readonly arcEndAngle: number;
}

/** 作図面の直交する 3 軸。呼び出し側の第1軸が少し傾いていても直交させ直す。 */
interface PlaneFrame {
  readonly normal: Vec3Tuple;
  readonly axisU: Vec3Tuple;
  readonly axisV: Vec3Tuple;
}

function planeFrame(plane: SketchFilletPlaneSpec): PlaneFrame {
  const normal = unitVec(plane.normal);
  if (normal === null) {
    throw new Error(PLANE_MESSAGE);
  }
  // 第1軸から法線の成分を抜いてから正規化する(直交していない軸を渡されても、
  // 角度の基準が法線まわりの回転としてぶれないようにするため)。
  const flattened = subVec(plane.axisU, scaleVec(normal, dotVec(plane.axisU, normal)));
  const axisU = unitVec(flattened);
  if (axisU === null) {
    throw new Error(PLANE_MESSAGE);
  }
  return { normal, axisU, axisV: crossVec(normal, axisU) };
}

/** 平面上の向きを、第1軸を 0 とする角度(ラジアン)へ直す。 */
function angleOf(frame: PlaneFrame, vector: Vec3Tuple): number {
  return Math.atan2(dotVec(vector, frame.axisV), dotVec(vector, frame.axisU));
}

/** 角度を [0, 2π) へ入れる。 */
function normalizeAngle(angle: number): number {
  const wrapped = angle % FULL_TURN;
  return wrapped < 0 ? wrapped + FULL_TURN : wrapped;
}

/** from から to への回り方のうち、短いほうの符号付きの差((-π, π])。 */
function shortestDelta(from: number, to: number): number {
  const delta = normalizeAngle(to - from);
  return delta > Math.PI ? delta - FULL_TURN : delta;
}

/**
 * スケッチのフィレット(FR-323)。**OCCT を使わない純関数**(冒頭の注釈)。
 *
 * 角のなす角を θ、丸める半径を r とすると、接点は角から d = r / tan(θ/2) の位置に来る。
 * 円弧の中心は接点から線に直角な向きへ r 進んだところで、両方の線から等距離になる。
 * 直角(θ = π/2)なら d = r、中心は角から r√2 の位置という、よく知られた形に一致する。
 */
export function makeSketchFillet(spec: SketchFilletSpec): SketchFilletResult {
  if (!Number.isFinite(spec.radius) || spec.radius <= 0) {
    throw new Error(RADIUS_MESSAGE);
  }

  const corner = analyzeSketchCorner(spec.line1, spec.line2);
  const frame = planeFrame(spec.plane);

  // 角を作る 3 点(角と、それぞれの反対の端)が作図面に乗っていることを確かめる。
  // 乗っていないと、返した中心と角度から model が組み立て直す円弧が
  // 元の線と接しない(model の円弧は必ず作図面の上に置かれるため)。
  for (const point of [corner.corner, corner.far1, corner.far2]) {
    if (Math.abs(dotVec(subVec(point, spec.plane.origin), frame.normal)) > CORNER_TOLERANCE_MM) {
      throw new Error(NOT_ON_PLANE_MESSAGE);
    }
  }

  // tan(θ/2) の半角の公式。分母は θ が π に近いときだけ 0 に近づくが、
  // その手前で analyzeSketchCorner が「一直線」として断っている。
  const tangentHalf = corner.sinAngle / (1 + corner.cosAngle);
  const tangentDistance = spec.radius / tangentHalf;

  // 接点が線の反対の端に届く(または越える)と、書き換えた線の長さが 0 以下になる。
  if (
    tangentDistance + CORNER_TOLERANCE_MM >= corner.length1 ||
    tangentDistance + CORNER_TOLERANCE_MM >= corner.length2
  ) {
    throw new Error(RADIUS_TOO_LARGE_MESSAGE);
  }

  const trimmed1 = addVec(corner.corner, scaleVec(corner.direction1, tangentDistance));
  const trimmed2 = addVec(corner.corner, scaleVec(corner.direction2, tangentDistance));

  // line1 に直角で、line2 の側(角の内側)を向く単位ベクトル。
  // direction2 から direction1 の成分を抜いた残りがちょうどそれで、長さは sinAngle。
  const inward = scaleVec(
    subVec(corner.direction2, scaleVec(corner.direction1, corner.cosAngle)),
    1 / corner.sinAngle,
  );
  const arcCenter = addVec(trimmed1, scaleVec(inward, spec.radius));

  const angle1 = angleOf(frame, subVec(trimmed1, arcCenter));
  const angle2 = angleOf(frame, subVec(trimmed2, arcCenter));
  // 円弧の中心角は π − θ で必ず π 未満なので、短いほうの回り方が丸めの弧そのものになる。
  const delta = shortestDelta(angle1, angle2);
  const start = normalizeAngle(delta >= 0 ? angle1 : angle2);

  return {
    trimmed1,
    trimmed2,
    arcCenter,
    arcRadius: spec.radius,
    arcStartAngle: start,
    arcEndAngle: start + Math.abs(delta),
  };
}
