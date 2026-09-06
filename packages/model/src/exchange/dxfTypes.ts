/**
 * DXF の実体を `model` の言葉で表した型(要件 FR-813、計画書 docs/plans/P6-入出力.md
 * §2.7、タスク26)。
 *
 * ## なぜ `packages/io` の `DxfEntity` を輸入しないか
 *
 * 依存の向きは `apps → ui → model → kernel / expression` の一方向で(rules/04-設計の規律.md、
 * `eslint.config.js` の `no-restricted-imports` が施行)、**`io` が `model` に依存している**
 * (`packages/io/src/dxf/writeDxf.ts` が `@pointercad/model` の `sampleSpline` と
 * `azimuthToEllipseParameter` を呼んでいる)。逆向きの `model → io` は作れないので、
 * DXF の実体の形をこちら側にも置く。
 *
 * **欄は `packages/io/src/dxf/readDxf.ts` の `DxfEntity` と 1 対 1 に同じ**にしてあるので、
 * 構造的部分型でそのまま受け渡せる(`readDxf(...).entities` を `dxfToSketch` へ、
 * `sketchToDxf(...)` の結果を `writeDxf` へ、変換なしで渡せる)。
 * **両者がずれていないことは `io` 側の検査で固定する**(`io` は `model` を輸入できるので、
 * あちらでだけ 2 つの型を並べて代入できる。タスク32 / 44 への申し送り)。
 *
 * ## 名前に `Sketch` を付けている理由
 *
 * `@pointercad/model` と `@pointercad/io` の両方を輸入する側(`packages/ui` の
 * 書き出し・読み込みの画面)で `DxfEntity` という同じ名前が 2 つ見えると、どちらを
 * 指しているのか読めなくなる。**型の形は同じでも名前は分ける。**
 *
 * ## 単位と向きの約束(`io` の `dxfCurves.ts` と同じ)
 *
 * - **長さは mm。** DXF のファイルに書かれた数は `$INSUNITS` の単位のままなので、
 *   mm への換算は `dxfToSketch` の `options.unit` が行う(この型に来る前後で単位が
 *   変わる場所はそこ 1 か所だけ)。
 * - **角度は度**で、**反時計回りが正。** `endAngle − startAngle` が符号つきの中心角で、
 *   差が ±360 なら全周(円・楕円)を表す。`SketchArcFeature` / `SketchEllipseFeature` の
 *   約束(`sketch/types.ts`)とそろえてある。
 * - **楕円の開始角・終了角は「長軸から測った方位角」**(媒介変数ではない)。
 */

/**
 * `$INSUNITS` から見た長さの単位。`'other'` は「単位は書いてあるが mm でも inch でもない」
 * (0 = 無単位、2 = フィート、5 = cm、6 = m など)。**倍率は呼び手が利用者へ訊く**
 * (計画書 §0.a-0.6。`DxfToSketchOptions.unitOverrideMm`)。
 */
export type SketchDxfLengthUnit = 'mm' | 'inch' | 'other';

/** 作図面の上の 2 次元の点。単位はファイルのまま(換算は `dxfToSketch`)。 */
export interface SketchDxfPoint2d {
  readonly x: number;
  readonly y: number;
}

/** すべての実体が持つ欄。 */
export interface SketchDxfEntityBase {
  /** グループ 8。**前後の空白は落とさない**(レイヤー名の一部として意味があるため)。 */
  readonly layer: string;
  /** グループ 62。無ければ `null`。 */
  readonly color: number | null;
}

/** `POINT` ↔ `SketchPointFeature`。 */
export interface SketchDxfPointEntity extends SketchDxfEntityBase {
  readonly kind: 'point';
  readonly position: SketchDxfPoint2d;
}

/** `LINE`(多角形を開いた直線の区間を含む)↔ `SketchLineFeature`。 */
export interface SketchDxfLineEntity extends SketchDxfEntityBase {
  readonly kind: 'line';
  readonly start: SketchDxfPoint2d;
  readonly end: SketchDxfPoint2d;
}

/**
 * `CIRCLE` / `ARC` ↔ `SketchArcFeature`。**円は「開始 0 度・終了 360 度の円弧」**として持つ
 * (計画書 §0.32。写し先が全周の指定で円になるので、種類を増やさない)。
 */
export interface SketchDxfArcEntity extends SketchDxfEntityBase {
  readonly kind: 'arc';
  readonly center: SketchDxfPoint2d;
  readonly radius: number;
  /** 度。`[0, 360)`。中心から始点を見た方位角。 */
  readonly startAngle: number;
  /** 度。`startAngle + 符号つきの中心角`。 */
  readonly endAngle: number;
}

/** `ELLIPSE` ↔ `SketchEllipseFeature`。 */
export interface SketchDxfEllipseEntity extends SketchDxfEntityBase {
  readonly kind: 'ellipse';
  readonly center: SketchDxfPoint2d;
  readonly majorRadius: number;
  readonly minorRadius: number;
  /** 度。`[0, 360)`。作図面の第1軸から長軸までの傾き。 */
  readonly rotation: number;
  /** 度。**長軸から測った方位角**(媒介変数ではない)。 */
  readonly startAngle: number;
  /** 度。`startAngle + 符号つきの掃過角`。全周なら差がちょうど 360。 */
  readonly endAngle: number;
}

/** `SPLINE` ↔ `SketchSplineFeature`。 */
export interface SketchDxfSplineEntity extends SketchDxfEntityBase {
  readonly kind: 'spline';
  /** `SketchSplineFeature.mode` と同じ意味(制御点か通過点か)。 */
  readonly mode: 'control' | 'interpolate';
  readonly points: readonly SketchDxfPoint2d[];
  /** 閉じた曲線。**閉じるための重複点は入れない**(`SketchSplineFeature` と同じ約束)。 */
  readonly closed: boolean;
  /** DXF に書かれていた次数。写し先の曲線は 3 次までなので、案内の判断に使う。 */
  readonly degree: number;
  /** 形が変わる読み替えをしたときの案内(FR-504「止めずに警告する」)。 */
  readonly warnings: readonly string[];
}

/** DXF の実体。**写し先の `SketchFeature` の 5 種と 1 対 1 に対応する。** */
export type SketchDxfEntity =
  | SketchDxfPointEntity
  | SketchDxfLineEntity
  | SketchDxfArcEntity
  | SketchDxfEllipseEntity
  | SketchDxfSplineEntity;
