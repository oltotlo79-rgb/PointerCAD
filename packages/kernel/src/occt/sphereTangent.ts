/**
 * 球への外接直線(FR-430、計画書 P5 §2.9.3、タスク23)。
 *
 * 面と面をつなぐ立体(罫線面)で球が選ばれたときに使う、**OCCT を使わない純粋な数学**。
 * ここには形を作る処理を置かず、数値だけを返す(検算が手計算でできるようにするため)。
 * 断り方(利用者へ出す日本語の文言)は形を組み立てる側(`makeThruSections.ts`、タスク24)が
 * 決めるので、この段では成り立たない入力に対して `null` を返すにとどめる。
 *
 * **2 つの経路がある。**
 *
 * - (a) `tangentConeThroughCircle`: 相手の輪郭が円で、その中心が球の中心を通る軸の上に
 *   あるとき。球に外接し、その円を通る回転円錐が 1 つに決まる(§0.a-0.26-(a))。
 * - (b) `tangentPointOnSphere`: 一般の輪郭。輪郭を点に割ってから、点ごとに接点を 1 つ選ぶ
 *   (§0.a-0.26-(b))。**どの接点を選ぶかは「輪郭の平面の法線 n の側」で決める**
 *   (下の「方位の決め方」)。
 *
 * **(a) の導出(自分で解き直したもの。計画書 §2.9.3 と一致することを確かめた)。**
 * 球の中心を原点、円の側を −z、頂点を z 軸上の z₀(> 0)、円を平面 z = −h 上の半径 a とすると
 *
 * ```
 *   sin α = r / z₀                     円錐の母線が球に接する条件
 *   tan α = r / √(z₀² − r²)
 *   a = (z₀ + h)·tan α                 円錐の z = −h での半径
 * ⇒ a·√(z₀² − r²) = r·(z₀ + h)
 * ⇒ (a² − r²)·z₀² − 2r²h·z₀ − r²(a² + h²) = 0
 * ```
 *
 * 実測(r=10、a=20、h=30): z₀ = 33.094010767585026、半角 = 17.587953773993775 度、
 * 接触円の中心 z = 3.021694792519623、接触円の半径 = 9.532542188779432、
 * 検算 (z₀+h)·tanα = 20.000000000000004(与えた a に戻る)。
 * 計画書 §2.9.3 の表とは 1e-13 ほどしか違わず(浮動小数の丸めの差)、許容 1e-9 の中で一致する。
 *
 * **(b) の導出。** 点 P、球の中心 C、r とすると d = |P − C|、u = (P − C)/d。
 * 接点 T は「T が球面上」かつ「(T − C) ⊥ (T − P)」を満たすので
 * `T = C + (r²/d)·u + (r·√(d²−r²)/d)·w`(w は u に垂直な単位ベクトル)。
 * 実測(r=10、d=25): 接線の長さ √(d²−r²) = 22.9128784747792、
 * 接点の軸方向の位置 r²/d = 4、軸からの距離 r√(d²−r²)/d = 9.16515138991168。
 *
 * **方位の決め方(接点を 1 つに絞る規則)。** 接点は u を軸とする円をなすので 1 つに決まらない。
 * ここでは**輪郭の平面の法線 n を使い、u と n が張る平面の中で n の側にある接点**を採る
 * (§2.9.3 の `w = 正規化((u × n) × u) = 正規化(n − (n·u)u)`)。
 * 罫線面では輪郭のすべての点で同じ規則を使うので、接点の列が輪郭と同じ向きに並び、
 * ねじれずに結べる。n が u と平行なとき(輪郭の平面の法線が球の中心を向いているとき)は
 * 方位が決まらないので `null` を返す。
 */

import type { Vec3Tuple } from '../types.js';

/**
 * 位置の許容誤差(mm)。円の中心が軸の上に乗っているか、方位が決まるか、の判定に使う
 * (計画書タスク23 の手順 2「許容 1e-9」)。幾何計算は double + 明示的な許容誤差で行う
 * (`rules/04-設計の規律.md`)。
 */
const TOLERANCE = 1e-9;

/** 球に外接し、指定の円を通る回転円錐。長さの単位は mm、角度はラジアン。 */
export interface TangentCone {
  /** 円錐の頂点(軸上)。 */
  readonly apex: Vec3Tuple;
  /** 半角(ラジアン)。 */
  readonly halfAngle: number;
  /** 接触円の中心と半径。 */
  readonly contactCenter: Vec3Tuple;
  readonly contactRadius: number;
}

function isFiniteVector(value: Vec3Tuple): boolean {
  return Number.isFinite(value[0]) && Number.isFinite(value[1]) && Number.isFinite(value[2]);
}

function subtract(a: Vec3Tuple, b: Vec3Tuple): Vec3Tuple {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function scale(value: Vec3Tuple, factor: number): Vec3Tuple {
  return [value[0] * factor, value[1] * factor, value[2] * factor];
}

function dot(a: Vec3Tuple, b: Vec3Tuple): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function magnitude(value: Vec3Tuple): number {
  return Math.hypot(value[0], value[1], value[2]);
}

/** base + direction × distance。頂点と接触円の中心を同じ式で作るための小さな道具。 */
function addScaled(base: Vec3Tuple, direction: Vec3Tuple, distance: number): Vec3Tuple {
  return [
    base[0] + direction[0] * distance,
    base[1] + direction[1] * distance,
    base[2] + direction[2] * distance,
  ];
}

/** 長さが取れない(0・非数)ときは null。他の make*.ts の toUnit と同じ考え。 */
function toUnit(value: Vec3Tuple): Vec3Tuple | null {
  if (!isFiniteVector(value)) {
    return null;
  }
  const size = magnitude(value);
  if (size <= 0) {
    return null;
  }
  return scale(value, 1 / size);
}

/**
 * 球に外接し、軸上の円(中心 circleCenter、半径 circleRadius)を通る回転円錐を求める
 * (§0.a-0.26-(a))。解が無ければ null。
 *
 * `axis` は円の平面の法線でもあり、球の中心を通る回転軸でもある。向きは問わない
 * (頂点は必ず円と反対の側に取るので、軸を逆向きに渡しても同じ答えになる)。
 *
 * null を返すのは次のとき。
 * - 値が非数、球や円の半径が 0 以下、軸の長さが 0。
 * - 円の中心が軸の上に無い(許容 `TOLERANCE`)。回転体にならない。
 * - 円の平面が球を切っている(平面から球の中心までの距離が球の半径より小さい)。
 *   このとき円錐そのものは求まるが、球が円の平面からはみ出すので
 *   「円錐台+球冠」では立体にならない。
 * - 円の半径が球の半径以下。a = r は円錐が閉じず円柱に退化し、a < r は円錐が
 *   円の側へ開かない(z₀ > 0 の解が無い)。
 */
export function tangentConeThroughCircle(
  sphereCenter: Vec3Tuple,
  sphereRadius: number,
  axis: Vec3Tuple,
  circleCenter: Vec3Tuple,
  circleRadius: number,
): TangentCone | null {
  if (!isFiniteVector(sphereCenter) || !isFiniteVector(circleCenter)) {
    return null;
  }
  if (!Number.isFinite(sphereRadius) || sphereRadius <= 0) {
    return null;
  }
  if (!Number.isFinite(circleRadius) || circleRadius <= 0) {
    return null;
  }
  const unitAxis = toUnit(axis);
  if (unitAxis === null) {
    return null;
  }

  const offset = subtract(circleCenter, sphereCenter);
  const along = dot(offset, unitAxis);
  // 軸から外れている分。円の中心が軸の上に無ければ球と円は同じ軸の回転体にならず、
  // 1 つの回転円錐では結べない((b) の経路が受け持つ)。
  if (magnitude(subtract(offset, scale(unitAxis, along))) > TOLERANCE) {
    return null;
  }

  // 円の平面から球の中心までの距離。これが球の半径より小さいと平面が球を切るので、
  // 接触円より上の球冠と円錐台をつないでも球の残りがはみ出してしまう。
  const planeDistance = Math.abs(along);
  if (planeDistance + TOLERANCE < sphereRadius) {
    return null;
  }
  // ここまで来れば planeDistance ≧ sphereRadius > 0 なので along は 0 でなく、
  // 「円と反対の側」として頂点の向きが 1 つに決まる。
  const apexDirection = along < 0 ? unitAxis : scale(unitAxis, -1);

  const r = sphereRadius;
  const a = circleRadius;
  const h = planeDistance;
  // (a² − r²)z₀² − 2r²h·z₀ − r²(a² + h²) = 0。
  // a = r では 1 次式になり z₀ = −(a²+h²)/(2h) < 0、a < r では 2 解とも負になる。
  // どちらも「頂点が円と反対の側にある円錐」にならないので、先に断る。
  if (a <= r) {
    return null;
  }
  const quadratic = a * a - r * r;
  const linear = -2 * r * r * h;
  const constant = -r * r * (a * a + h * h);
  const discriminant = linear * linear - 4 * quadratic * constant;
  if (!(discriminant > 0)) {
    return null;
  }
  // 2 解は符号が異なる(積 = constant/quadratic < 0)。正のほうが求める頂点。
  const apexDistance = (-linear + Math.sqrt(discriminant)) / (2 * quadratic);
  if (!Number.isFinite(apexDistance) || apexDistance <= r) {
    return null;
  }

  const contactDistance = (r * r) / apexDistance;
  return {
    apex: addScaled(sphereCenter, apexDirection, apexDistance),
    halfAngle: Math.asin(r / apexDistance),
    contactCenter: addScaled(sphereCenter, apexDirection, contactDistance),
    contactRadius: (r * Math.sqrt(apexDistance * apexDistance - r * r)) / apexDistance,
  };
}

/**
 * 一般の輪郭に対する接点(§0.a-0.26-(b))。
 * 点 P から球への接線のうち、輪郭の平面の法線 n を含む平面内のものを取る。
 *
 * 接点は P・球の中心 C を結ぶ向き u のまわりに円をなすので、`planeNormal` の側という
 * 方位で 1 つに絞る(ファイル冒頭の「方位の決め方」)。
 *
 * null を返すのは次のとき。
 * - 値が非数、球の半径が 0 以下、法線の長さが 0。
 * - 点が球の中、または球面上(|P − C| ≦ r)。接線が引けない。
 * - 法線が u と平行(許容 `TOLERANCE`)。接点を絞る方位が決まらない。
 */
export function tangentPointOnSphere(
  sphereCenter: Vec3Tuple,
  sphereRadius: number,
  planeNormal: Vec3Tuple,
  point: Vec3Tuple,
): Vec3Tuple | null {
  if (!isFiniteVector(sphereCenter) || !isFiniteVector(point)) {
    return null;
  }
  if (!Number.isFinite(sphereRadius) || sphereRadius <= 0) {
    return null;
  }
  const normal = toUnit(planeNormal);
  if (normal === null) {
    return null;
  }

  const offset = subtract(point, sphereCenter);
  const distance = magnitude(offset);
  // 点が球の中・球面上のときは接線が引けない(球面上は接線の長さが 0 になる退化)。
  if (!(distance > sphereRadius)) {
    return null;
  }
  const unitToPoint = scale(offset, 1 / distance);

  // n から u の成分を抜いた向き = (u × n) × u。u に垂直で n の側を向く。
  const perpendicular = subtract(normal, scale(unitToPoint, dot(normal, unitToPoint)));
  // 長さは n と u のなす角の sin。平行なら 0 になり、方位が決まらない。
  const perpendicularLength = magnitude(perpendicular);
  if (perpendicularLength <= TOLERANCE) {
    return null;
  }
  const unitSideways = scale(perpendicular, 1 / perpendicularLength);

  // T = C + (r²/d)·u + (r√(d²−r²)/d)·w。|T − C| = r かつ (T−C)·(T−P) = 0 を満たす。
  const alongPart = (sphereRadius * sphereRadius) / distance;
  const sidewaysPart =
    (sphereRadius * Math.sqrt(distance * distance - sphereRadius * sphereRadius)) / distance;
  return [
    sphereCenter[0] + unitToPoint[0] * alongPart + unitSideways[0] * sidewaysPart,
    sphereCenter[1] + unitToPoint[1] * alongPart + unitSideways[1] * sidewaysPart,
    sphereCenter[2] + unitToPoint[2] * alongPart + unitSideways[2] * sidewaysPart,
  ];
}
