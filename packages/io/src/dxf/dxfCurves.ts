/**
 * DXF の曲線(bulge の円弧・ELLIPSE・SPLINE)を、スケッチが受けられる素の数値へ換算する
 * (要件 FR-813、計画書 docs/plans/P6-入出力.md §2.7 タスク23)。
 *
 * この段は **OCCT を呼ばない純関数だけ**で、`dxfTags.ts`(タスク22)が読んだ
 * 「コードと値の対」を、タスク24 の実体の読み取りが組み立てた数値として受け取り、
 * 中心・半径・角度のような**幾何の量**へ直す。`SketchFeature` へ写すのは
 * `model` 側(タスク26 の `dxfToSketch.ts`)の仕事なので、ここでは
 * `ExpressionValue`(式の文字列)にも `CoordinateInput` にも触れない。
 *
 * ## 単位と向きの約束(rules/04-設計の規律.md、`model` の流儀に合わせる)
 *
 * - **長さは mm**(DXF は無単位なので、`$INSUNITS` の換算はファイルの段の仕事)。
 * - **角度は度**で返す。`packages/model/src/sketch/types.ts` の `SketchArcFeature` /
 *   `SketchEllipseFeature` が角度を**度**で持つため(`resolveSketch.ts` が
 *   `degreesToRadians` で解決する)。**計算の途中だけラジアン**を使う。
 * - **角度は反時計回りが正。** 開始角と終了角の差がそのまま回る向きと量になる
 *   (`resolveSketch.ts` の `arc.endAngle >= arc.startAngle ? …` と同じ約束)。
 *   開始角は `[0, 360)` へ畳み、終了角は「開始角 + 符号つきの中心角」にする。
 * - **楕円の開始角・終了角は「長軸から測った方位角」(度)。** DXF が持つのは
 *   媒介変数(下記)なので、ここで方位角へ直す。`SketchEllipseFeature` の
 *   `startAngle` / `endAngle` が方位角だから(型定義の注釈)。
 * - **`-0` を作らない。** タグの段(タスク22)と揃える。`Object.is` の比較や
 *   文字にしたときの `"-0"` を避けるため。
 *
 * ## Z 座標について
 *
 * この段は 2D の点しか受け取らない。**Z ≠ 0 の実体を平らにして「平面から外れた図形が
 * N 個あります。」と案内する**のは、実体を数え上げられる 1 つ上の段
 * (タスク24・26)の仕事(計画書 §0.a-0.33)。
 */

import { DXF_UNSUPPORTED_FORMAT_MESSAGE } from './dxfTags.js';

/** 作図面の上の 2 次元の点(mm)。 */
export interface DxfPoint2d {
  readonly x: number;
  readonly y: number;
}

/** bulge から起こした円弧。角度は度で、`endAngle − startAngle` が符号つきの中心角になる。 */
export interface DxfArcGeometry {
  readonly center: DxfPoint2d;
  readonly radius: number;
  /** 度。`[0, 360)`。中心から始点を見た方位角。 */
  readonly startAngle: number;
  /** 度。`startAngle + 中心角`。反時計回りなら開始角より大きい。 */
  readonly endAngle: number;
}

/** ELLIPSE から起こした楕円(弧)。角度は度。 */
export interface DxfEllipseGeometry {
  readonly center: DxfPoint2d;
  readonly majorRadius: number;
  readonly minorRadius: number;
  /** 度。`[0, 360)`。第1軸から長軸までの傾き。 */
  readonly rotation: number;
  /** 度。`[0, 360)`。長軸から測った方位角。 */
  readonly startAngle: number;
  /** 度。`startAngle + 符号つきの掃過角`。全周なら差がちょうど 360。 */
  readonly endAngle: number;
}

/** SPLINE のタグから読み取った素の値(タスク24 が組み立て、この段が畳む)。 */
export interface DxfSplineInput {
  /** グループ 71。次数(1 以上の整数)。 */
  readonly degree: number;
  /** グループ 10/20。制御点。 */
  readonly controlPoints: readonly DxfPoint2d[];
  /** グループ 11/21。フィット点(通過点)。無ければ空。 */
  readonly fitPoints?: readonly DxfPoint2d[];
  /** グループ 41。重み。無ければ空(すべて 1 とみなす)。 */
  readonly weights?: readonly number[];
  /** グループ 70 の bit 1(閉じている)。 */
  readonly closed: boolean;
}

/** SPLINE から起こした自由曲線。`mode` は `SketchSplineFeature` の 2 通りと同じ意味。 */
export interface DxfSplineGeometry {
  readonly mode: 'control' | 'interpolate';
  readonly points: readonly DxfPoint2d[];
  readonly closed: boolean;
  /** 読み取れた次数。写し先の曲線は 3 次までなので、上の段が案内に使えるよう残す。 */
  readonly degree: number;
  /** 形が変わる読み替えをしたときの案内(NFR-UX-5、FR-504「止めずに警告する」)。 */
  readonly warnings: readonly string[];
}

/**
 * 重み付き(有理)スプラインの重みを捨てたときの案内(計画書 §2.7)。
 * 写し先の `SketchSplineFeature` は重みを持たないため、形がわずかに変わる。
 */
export const DXF_SPLINE_WEIGHT_IGNORED_MESSAGE = '重みの付いた曲線は形が少し変わります。';

const FULL_TURN_DEGREES = 360;
const HALF_TURN_DEGREES = 180;

/**
 * 10 進の実数として認める書き方。`Number('')` が `0`、`Number('0x10')` が `16` に
 * なってしまうので、`Number` へ渡す前にこの形だけへ絞る(16 進や空の値を
 * 「読めた」ことにしないため)。指数表記は DXF の実装が書くことがあるので認める。
 */
const DECIMAL_PATTERN = /^[+-]?(?:[0-9]+\.?[0-9]*|\.[0-9]+)(?:[eE][+-]?[0-9]+)?$/;

/** 10 進の整数として認める書き方(グループ 70 / 71 など)。 */
const INTEGER_PATTERN = /^[+-]?[0-9]+$/;

/** `-0` を `0` へ寄せる。タグの段(タスク22)の決めと揃える。 */
function normalizeZero(value: number): number {
  return value === 0 ? 0 : value;
}

/** 度を `[0, 360)` へ畳む。`-0` は作らない。 */
function foldDegrees(degrees: number): number {
  const wrapped = degrees % FULL_TURN_DEGREES;
  return normalizeZero(wrapped < 0 ? wrapped + FULL_TURN_DEGREES : wrapped);
}

function toDegrees(radians: number): number {
  return (radians * HALF_TURN_DEGREES) / Math.PI;
}

/** 2 次元の点を `-0` 無しで作る。 */
function makePoint(x: number, y: number): DxfPoint2d {
  return { x: normalizeZero(x), y: normalizeZero(y) };
}

/**
 * DXF の値の文字列を実数へ直す。
 *
 * `Number.parseFloat` を使わないのは、`'1.5abc'` を `1.5` として飲み込んでしまい、
 * 壊れたファイルを「読めた」ことにするため。`Number` + 形の点検 + `Number.isFinite` で、
 * **空・空白だけ・`NaN`・`Infinity`・16 進**をすべて断る。
 *
 * @throws {Error} `DXF_UNSUPPORTED_FORMAT_MESSAGE` を持つ例外。
 */
export function parseDxfNumber(value: string): number {
  const text = value.trim();
  if (!DECIMAL_PATTERN.test(text)) {
    throw new Error(DXF_UNSUPPORTED_FORMAT_MESSAGE);
  }
  const parsed = Number(text);
  if (!Number.isFinite(parsed)) {
    // 桁が大きすぎて `Infinity` になった場合(`'1e400'`)もここで断る。
    throw new Error(DXF_UNSUPPORTED_FORMAT_MESSAGE);
  }
  return normalizeZero(parsed);
}

/**
 * DXF の値の文字列を整数へ直す(グループ 70 の旗、71 の次数など)。
 * 小数点付きの値は認めない(旗や個数に小数が来るファイルは壊れているため)。
 *
 * @throws {Error} `DXF_UNSUPPORTED_FORMAT_MESSAGE` を持つ例外。
 */
export function parseDxfInteger(value: string): number {
  const text = value.trim();
  if (!INTEGER_PATTERN.test(text)) {
    throw new Error(DXF_UNSUPPORTED_FORMAT_MESSAGE);
  }
  const parsed = Number(text);
  if (!Number.isFinite(parsed)) {
    throw new Error(DXF_UNSUPPORTED_FORMAT_MESSAGE);
  }
  return normalizeZero(parsed);
}

/**
 * LWPOLYLINE / POLYLINE の bulge(グループ 42)から円弧を起こす。
 *
 * ## 導出
 *
 * DXF の定義は「**bulge は中心角の 4 分の 1 の正接**で、始点から終点へ**時計回り**に
 * 回るときに負」。中心角を `Δθ`、bulge を `t` と書くと `t = tan(Δθ/4)`、
 * したがって **`Δθ = 4·atan(t)`**(`t > 0` なら反時計回り)。`atan` の値域が
 * `(−π/2, π/2)` なので `Δθ` は `(−2π, 2π)` に収まり、`|t| = 1` はちょうど半円
 * (`4·atan(1) = π`)、`|t|` が大きいほど全周へ近づく。
 *
 * 弦の長さを `c`、半径を `r` とすると、中心から弦を見込む角が `Δθ` なので
 * `c = 2·r·|sin(Δθ/2)|`、すなわち **`r = c / (2·|sin(Δθ/2)|)`**。
 * 弦の中点から中心までの距離(垂線の足からの高さ)は **`r·cos(Δθ/2)`** で、
 * これは `Δθ > π` のとき負になり、中心が弦の反対側へ移ることを表す。
 *
 * 計算は `atan` を経由せず、**半角の公式で bulge から直に**求める。
 * `α = Δθ/4` と置くと `tan α = t` なので
 *
 * - `sin(Δθ/2) = sin 2α = 2·tan α / (1 + tan²α) = 2t / (1 + t²)`
 * - `cos(Δθ/2) = cos 2α = (1 − tan²α) / (1 + tan²α) = (1 − t²) / (1 + t²)`
 *
 * より
 *
 * - `r = c·(1 + t²) / (4·|t|)`
 * - `弦の中点からの高さ(符号つき) = c·(1 − t²) / (4t)`
 *
 * となる。**この形は `atan` と `sin` を通さないので、`t` から半径までの誤差が
 * 掛け算 3 つぶんで済む**(`c / (2·sin(4·atan(t)/2))` と同じ値を、丸めを重ねずに得る)。
 * `t²` は `|t| > 1e154` で桁あふれするが、それは `Δθ` が `2π` と区別できない
 * 潰れた円弧なので、半径が有限でないことを見て断る。
 *
 * 高さを測る向きは、弦の向き `u = (P₂ − P₁)/c` の**左**、つまり `(−u_y, u_x)` に取る。
 * 反時計回り(`t > 0`)で `Δθ < π` のとき中心は進行方向の左にあるため
 * (中心 → 始点のベクトルを `+Δθ` 回すと中心 → 終点になる、という定義から解ける)。
 * `Δθ > π` では高さが負になり、式のまま右側へ移る。
 *
 * @param start 始点。
 * @param end 終点。
 * @param bulge グループ 42 の値。
 * @returns 円弧。**`bulge` が 0 のときは `null`**(定義どおり直線区間なので、
 *   呼び出し側が線分として扱えるようにする)。**始点と終点が重なるときも `null`**
 *   (長さ 0 の区間は円弧が決まらない。重複した頂点として捨てられるようにする)。
 * @throws {Error} `DXF_UNSUPPORTED_FORMAT_MESSAGE` を持つ例外。座標か bulge が
 *   有限の数でないとき(`NaN` の幾何を下流へ流さないため)。
 */
export function bulgeToArc(
  start: DxfPoint2d,
  end: DxfPoint2d,
  bulge: number,
): DxfArcGeometry | null {
  if (
    !Number.isFinite(start.x) ||
    !Number.isFinite(start.y) ||
    !Number.isFinite(end.x) ||
    !Number.isFinite(end.y) ||
    !Number.isFinite(bulge)
  ) {
    throw new Error(DXF_UNSUPPORTED_FORMAT_MESSAGE);
  }
  if (bulge === 0) {
    return null;
  }

  const chordX = end.x - start.x;
  const chordY = end.y - start.y;
  const chordLength = Math.hypot(chordX, chordY);
  if (chordLength === 0) {
    return null;
  }

  const magnitude = Math.abs(bulge);
  const radius = (chordLength * (1 + bulge * bulge)) / (4 * magnitude);
  if (!Number.isFinite(radius)) {
    // `|bulge|` が極端(1e−154 未満か 1e154 超)で、半径が倍精度で表せないとき。
    // どちらも円弧として持てないので断る(`Infinity` の幾何を下流へ流さない)。
    throw new Error(DXF_UNSUPPORTED_FORMAT_MESSAGE);
  }
  // 弦の中点から中心までの符号つきの高さ。弦の左向きを正に取る。
  const height = (chordLength * (1 - bulge * bulge)) / (4 * bulge);

  const midX = (start.x + end.x) / 2;
  const midY = (start.y + end.y) / 2;
  // 弦の向きの左法線 `(−u_y, u_x)`。
  const leftX = -chordY / chordLength;
  const leftY = chordX / chordLength;
  const center = makePoint(midX + leftX * height, midY + leftY * height);

  const startAngle = foldDegrees(toDegrees(Math.atan2(start.y - center.y, start.x - center.x)));
  const sweepDegrees = toDegrees(4 * Math.atan(bulge));

  return {
    center,
    radius,
    startAngle,
    endAngle: normalizeZero(startAngle + sweepDegrees),
  };
}

/**
 * 円弧を LWPOLYLINE / POLYLINE の bulge(グループ 42)へ戻す(`bulgeToArc` の逆)。
 *
 * ## 導出
 *
 * `bulgeToArc` の定義そのままで、中心角 `Δθ = endAngle − startAngle`(符号つき)から
 * **`bulge = tan(Δθ/4)`**。反時計回り(`Δθ > 0`)が正で、`Δθ = 180°` がちょうど 1、
 * 中心角が大きいほど絶対値が大きくなる。中心と半径は使わない(bulge は始点・終点と
 * 合わせて円弧を決めるので、**弦の両端は呼び出し側が別に書く**)。
 *
 * ## 全周を返せない理由
 *
 * `tan(Δθ/4)` は `|Δθ| = 360°` で発散する。bulge は「弦の両端」と組でしか円弧を表せず、
 * 始点と終点が重なる全周の円は**弦が決まらない**ので、そもそも 1 つの bulge で書けない。
 * 全周は `CIRCLE` として書くか、半円 2 つに割る必要があるため、ここでは `null` を返して
 * 呼び出し側に決めさせる(`bulgeToArc` が直線・長さ 0 で `null` を返すのと同じ流儀)。
 *
 * @param arc 円弧(角度は度、`endAngle − startAngle` が符号つきの中心角)。
 * @returns グループ 42 に書く値。**中心角が 0 なら `0`**(bulge の定義どおり直線区間)。
 *   **全周以上(`|Δθ| ≥ 360°`)なら `null`。**
 * @throws {Error} `DXF_UNSUPPORTED_FORMAT_MESSAGE` を持つ例外。角度が有限の数でないとき。
 */
export function arcToBulge(arc: DxfArcGeometry): number | null {
  if (!Number.isFinite(arc.startAngle) || !Number.isFinite(arc.endAngle)) {
    throw new Error(DXF_UNSUPPORTED_FORMAT_MESSAGE);
  }
  const sweepDegrees = arc.endAngle - arc.startAngle;
  if (Math.abs(sweepDegrees) >= FULL_TURN_DEGREES) {
    return null;
  }
  return normalizeZero(Math.tan(toRadians(sweepDegrees) / 4));
}

/** 度をラジアンへ。`toDegrees` の逆で、`arcToBulge` だけが使う。 */
function toRadians(degrees: number): number {
  return (degrees * Math.PI) / HALF_TURN_DEGREES;
}

/**
 * ELLIPSE の媒介変数を、長軸から測った方位角(ラジアン)へ直す。
 *
 * ## 導出
 *
 * 楕円上の点は媒介変数 `t` で `(a·cos t, b·sin t)`(`a` = 長半径、`b` = 短半径)と書ける。
 * この点を中心から見た**方位角**は `atan2(b·sin t, a·cos t)` で、`a ≠ b` のときは
 * `t` と一致しない(円のときだけ一致する)。`model` の
 * `resolveSketch.ts` の `azimuthToEllipseParameter`(方位角 → 媒介変数)の逆にあたる。
 *
 * `t` が `2π` を超えていても掃過量を失わないよう、**回った周回数を先に外し**、
 * 畳んだ `[0, 2π)` の中で方位角を求めてから周回数を戻す。こうすると
 * `t = 2π` がちょうど `2π` に戻り、全周の楕円で「終了角 − 開始角 = 360 度」が
 * 誤差なく成り立つ(`SketchEllipseFeature` の全周の判定に効く)。
 */
function ellipseParameterToAzimuth(
  parameter: number,
  majorRadius: number,
  minorRadius: number,
): number {
  const fullTurn = 2 * Math.PI;
  const turns = Math.floor(parameter / fullTurn);
  const folded = parameter - turns * fullTurn;
  const base = Math.atan2(minorRadius * Math.sin(folded), majorRadius * Math.cos(folded));
  const positive = base < 0 ? base + fullTurn : base;
  return positive + turns * fullTurn;
}

/**
 * ELLIPSE(グループ 10/20 = 中心、11/21 = 中心からの相対の長軸の端、40 = 短軸比、
 * 41/42 = 開始・終了の媒介変数(ラジアン))から楕円(弧)を起こす。
 *
 * ## 導出
 *
 * - **長半径** `a = |(11, 21)|`(中心から長軸の端までの距離)。
 * - **短半径** `b = a × 40`(グループ 40 は「短軸半径 ÷ 長軸半径」の比)。
 * - **傾き** `= atan2(21, 11)`(第1軸から長軸まで)。
 * - **開始角・終了角**は媒介変数を方位角へ直したもの(`ellipseParameterToAzimuth`)。
 *
 * @param center グループ 10/20。
 * @param majorEnd グループ 11/21。**中心からの相対**であることに注意。
 * @param ratio グループ 40。`0 < ratio ≤ 1`。
 * @param startParameter グループ 41(ラジアン)。
 * @param endParameter グループ 42(ラジアン)。全周なら `2π`。
 * @throws {Error} `DXF_UNSUPPORTED_FORMAT_MESSAGE` を持つ例外。値が有限でない、
 *   長軸の長さが 0、または比が `(0, 1]` の外のとき。DXF の仕様が比を 1 以下と
 *   定めており、1 を超える値は「どちらが長軸か」が決まらないため断る。
 */
export function ellipseFromDxf(
  center: DxfPoint2d,
  majorEnd: DxfPoint2d,
  ratio: number,
  startParameter: number,
  endParameter: number,
): DxfEllipseGeometry {
  if (
    !Number.isFinite(center.x) ||
    !Number.isFinite(center.y) ||
    !Number.isFinite(majorEnd.x) ||
    !Number.isFinite(majorEnd.y) ||
    !Number.isFinite(ratio) ||
    !Number.isFinite(startParameter) ||
    !Number.isFinite(endParameter)
  ) {
    throw new Error(DXF_UNSUPPORTED_FORMAT_MESSAGE);
  }
  const majorRadius = Math.hypot(majorEnd.x, majorEnd.y);
  if (majorRadius === 0 || ratio <= 0 || ratio > 1) {
    throw new Error(DXF_UNSUPPORTED_FORMAT_MESSAGE);
  }

  const minorRadius = majorRadius * ratio;
  const rotation = foldDegrees(toDegrees(Math.atan2(majorEnd.y, majorEnd.x)));

  const startAzimuth = ellipseParameterToAzimuth(startParameter, majorRadius, minorRadius);
  const endAzimuth = ellipseParameterToAzimuth(endParameter, majorRadius, minorRadius);
  const startAngle = foldDegrees(toDegrees(startAzimuth));
  const sweepDegrees = toDegrees(endAzimuth - startAzimuth);

  return {
    center: makePoint(center.x, center.y),
    majorRadius,
    minorRadius,
    rotation,
    startAngle,
    endAngle: normalizeZero(startAngle + sweepDegrees),
  };
}

/**
 * SPLINE(グループ 71 = 次数、10/20 = 制御点、11/21 = フィット点、41 = 重み、
 * 70 の bit 1 = 閉じている)から自由曲線を起こす。
 *
 * ## 決めごと
 *
 * - **制御点があれば制御点の版**(`mode: 'control'`)へ写す(計画書 §2.7)。
 *   `SketchSplineFeature` が「通過点」と「制御点」の 2 通りを持つため、
 *   新しい曲線の種類を作らずに済む。
 * - **制御点が無くフィット点だけのとき**は、フィット点を通過点として
 *   `mode: 'interpolate'` へ写す。フィット点は「曲線が通る点」なので意味が一致し、
 *   捨てるより形が保てる(DXF は制御点を省いてフィット点だけを書く実装がある)。
 * - **どちらも無ければ断る。** 点が 1 つも無い曲線は形が決まらないため。
 * - **重み(有理スプライン)は無視する。** 写し先が重みを持たないので、
 *   1 でない重みがあれば `warnings` に `DXF_SPLINE_WEIGHT_IGNORED_MESSAGE` を入れる
 *   (断らずに案内する。FR-504)。
 * - **閉じた曲線の末尾が先頭と同じ点なら 1 つ落とす。**
 *   `SketchSplineFeature` は「閉じるための重複点は入れない」約束のため。
 *   落とすのは**座標が完全に一致する**ときだけにして、近いだけの点は残す
 *   (DXF は同じ十進表記を書き直すので一致する)。周期スプラインが先頭の
 *   `次数` 個ぶんを巻き直して並べている場合の畳み直しは、実体の段(タスク24)で見る。
 * - **点の個数の上限(`model` の `MAX_SPLINE_POINTS`)はここでは見ない。**
 *   上限は写し先の都合なので、`model` 側(タスク26)が見る。
 *
 * @throws {Error} `DXF_UNSUPPORTED_FORMAT_MESSAGE` を持つ例外。次数が 1 以上の整数でない、
 *   座標が有限でない、または点が 1 つも無いとき。
 */
export function splineFromDxf(input: DxfSplineInput): DxfSplineGeometry {
  if (!Number.isInteger(input.degree) || input.degree < 1) {
    throw new Error(DXF_UNSUPPORTED_FORMAT_MESSAGE);
  }

  const fitPoints = input.fitPoints ?? [];
  const source = input.controlPoints.length > 0 ? input.controlPoints : fitPoints;
  if (source.length === 0) {
    throw new Error(DXF_UNSUPPORTED_FORMAT_MESSAGE);
  }
  const mode = input.controlPoints.length > 0 ? 'control' : 'interpolate';

  const points: DxfPoint2d[] = [];
  for (const point of source) {
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) {
      throw new Error(DXF_UNSUPPORTED_FORMAT_MESSAGE);
    }
    points.push(makePoint(point.x, point.y));
  }

  if (input.closed) {
    // 閉じるための重複点は持たない約束なので、末尾が先頭と同じ点なら落とす。
    while (points.length > 1) {
      const last = points[points.length - 1];
      const first = points[0];
      if (last.x !== first.x || last.y !== first.y) {
        break;
      }
      points.pop();
    }
  }

  const warnings: string[] = [];
  const weights = input.weights ?? [];
  if (weights.some((weight) => weight !== 1)) {
    warnings.push(DXF_SPLINE_WEIGHT_IGNORED_MESSAGE);
  }

  return { mode, points, closed: input.closed, degree: input.degree, warnings };
}
