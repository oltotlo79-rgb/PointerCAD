/**
 * ビューの断面表示(FR-111)の純関数
 * (計画書 docs/plans/P6-入出力.md §2.12、タスク34、§0.40)。
 *
 * 対応要件: FR-111(形を切らずに、見た目だけをクリップして中を確かめる)、
 * NFR-PF-1(60fps。1 コマの中で作り直せる軽さ)、NFR-UX-5(できないときは理由を示す)。
 *
 * **three.js に触れない。** ここが返すのは素の数(法線 3 個と定数 1 個)だけで、
 * `new THREE.Plane(...)` を作って材質の `clippingPlanes` へ配るのは
 * `ViewportCanvas.tsx` / `createSolidLayer.ts`(タスク35)が受け持つ。
 * こうしておくと Node の単体検査で値をそのまま確かめられる
 * (P5 §0.a-0.61 の `buildCutPreview.ts` と同じ流儀)。
 *
 * **形は変えない。** 切断面の指定は P5 の `PlaneSpec` / `resolvePlaneSpec`(FR-432)を
 * そのまま共有し、ここではその結果(`ResolvedPlane`)を見た目のクリップ用の数へ写すだけ。
 * 再計算(`affectsShape`)の経路には乗らない。
 *
 * 例外を投げず、断る理由も戻り値で返す(FR-504、NFR-RE-1)。文言は日本語にする。
 */

import {
  cleanZeroVec3,
  lengthVec3,
  scaleVec3,
  type ResolvedPlane,
  type Vec3,
} from '@pointercad/model';

/**
 * three.js の `Plane` に渡す素の数。
 *
 * three の `Plane` は **`normal · p + constant = 0`** で平面を表す(`normal` は単位)。
 * `new THREE.Plane(new THREE.Vector3(...normal), constant)` にそのまま渡せる形にしてある。
 * 残る(描かれる)のは `normal · p + constant > 0` の側、つまり**法線の向いている側**で、
 * P5 の切断の `keep === 'positive'` と同じ規約になる(§0.40)。
 */
export interface SectionPlaneNumbers {
  /** 単位法線。描かれる側を向く。 */
  readonly normal: readonly [number, number, number];
  /** 原点からの符号つき距離の逆符号。`constant = −(normal · origin) − offset`。 */
  readonly constant: number;
}

/**
 * 断面表示の平面を作れなかった理由。
 * `planeSpec.ts` の `PlaneErrorKey` と同じ語を使い、断り方の語彙を 2 つに分けない。
 */
export type SectionPlaneErrorKey =
  /** 法線の長さが 0(向きが定まらない)。 */
  | 'degenerate'
  /** オフセットや原点が数になっていない(NaN・無限大)。 */
  | 'invalidValue';

/** `toThreePlane` の結果。`planeSpec.ts` の `PlaneOutcome` と同じ形にしてある。 */
export type SectionPlaneOutcome =
  | { readonly ok: true; readonly plane: SectionPlaneNumbers }
  | { readonly ok: false; readonly reason: SectionPlaneErrorKey; readonly message: string };

/**
 * 向きが定まったとみなす最小の長さ。`planeSpec.ts` の `DIRECTION_EPSILON` と同じ値で、
 * 「長さ 0 の法線は退化」という判定の線引きを 2 か所で食い違わせない。
 */
const DIRECTION_EPSILON = 1e-9;

function failure(reason: SectionPlaneErrorKey, message: string): SectionPlaneOutcome {
  return { ok: false, reason, message };
}

/** −0 を +0 へ揃える(裏返したときに `-0` が出ないようにする後始末)。 */
function cleanZero(value: number): number {
  return value === 0 ? 0 : value;
}

/**
 * 解決した平面を、three.js のクリッピング平面に渡す素の数へ写す(§2.12)。
 *
 * ## 式の導出
 *
 * three の `Plane` は `n · x + constant = 0`(`n` は単位法線)。平面が点 `p` を通るので、
 * `x = p` を入れて `n · p + constant = 0`、すなわち **`constant = −(n · p)`**。
 *
 * オフセット `d`(mm)は**法線の向きへ平面を平行移動する**量なので、動いた後の平面は
 * 点 `p + d·n` を通る。`n` は単位だから `n · (p + d·n) = n · p + d` となり、
 * **`constant = −(n · p) − d`**。`d` が正なら平面は法線の側へ進み、切り残る量が減る。
 *
 * 裏返し(`flipped`)は「残す側を反対にする」操作で、平面そのものは動かさない。
 * 同じ平面の方程式を −1 倍した `(−n) · x + (−constant) = 0` は同じ点の集合を表すが、
 * 「正の側」だけが入れ替わる。だから **`normal` と `constant` の符号を両方反転**する。
 *
 * ## 断る場合(0 除算をしない)
 *
 * - 法線の長さが 0(または NaN・無限大)なら向きが決まらないので、正規化する前に断る。
 * - オフセットが NaN・無限大(式が解けなかったとき)なら断る。
 * - 平面の原点が NaN・無限大なら `constant` が数にならないので断る。
 *
 * @param resolved 解決した平面(`resolvePlaneSpec` の結果。法線は単位の想定だが確かめる)。
 * @param offsetMm 法線方向へずらす量(mm)。既定は 0(§0.42)。
 * @param flipped 残す側を反対にするか(つまみの裏返し)。
 */
export function toThreePlane(
  resolved: ResolvedPlane,
  offsetMm: number,
  flipped: boolean,
): SectionPlaneOutcome {
  if (!Number.isFinite(offsetMm)) {
    return failure(
      'invalidValue',
      '断面の位置が数になっていません。切る位置に数値または解ける式を入れてください。',
    );
  }
  const { origin, normal } = resolved;
  if (!origin.every((value) => Number.isFinite(value))) {
    return failure(
      'invalidValue',
      '断面の平面の位置が数になっていません。平面の指定をやり直してください。',
    );
  }
  const length = lengthVec3(normal);
  if (!Number.isFinite(length) || length <= DIRECTION_EPSILON) {
    return failure(
      'degenerate',
      '断面の向きが定まりません。向きの決まる平面を選び直してください。',
    );
  }
  // 単位でない法線が来ても正しく切れるよう、ここで長さ 1 に揃える。
  // 法線を 1/length 倍すると n · p も同じ 1/length 倍になるので、constant も同じ縮尺で揃う。
  const unit: Vec3 = length === 1 ? normal : scaleVec3(normal, 1 / length);
  const distance = unit[0] * origin[0] + unit[1] * origin[1] + unit[2] * origin[2];
  const constant = -distance - offsetMm;
  const sign = flipped ? -1 : 1;
  return {
    ok: true,
    plane: {
      normal: cleanZeroVec3(scaleVec3(unit, sign)),
      constant: cleanZero(constant * sign),
    },
  };
}
