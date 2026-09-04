/**
 * スケッチの保存形式と、解決済みの形の型(計画書 docs/plans/P1-式とスケッチ.md §2.6)。
 *
 * 保存するのはフィーチャー履歴だけで、解決済みの座標やメッシュは保存しない
 * (要件§8、rules/04-設計の規律.md「導出できるものは保存しない」)。
 * 全パラメータは式文字列+評価値のペア(ExpressionValue)で持つ(FR-202)。
 * カーネルの結果を受け取る型もここへ置き、@pointercad/kernel の型は再輸出しない。
 */

import type { ExpressionValue } from '@pointercad/expression';

import type { SubShapeRef } from '../geometry/subShapeRef.js';
import type { WorkPlaneId } from './planeMath.js';
import type { Vec3 } from './vec3.js';

/**
 * 座標の基準にできるもの(FR-302、FR-303)。座標を複製せず id で参照するので、
 * 基準が動けば下流が追従する(FR-311、FR-502 の土台)。
 * `previous` は保存しても履歴上の位置から導けるため、解決のときに
 * 「そのフィーチャーより前で最後に作られた点」として求める。
 *
 * **新しい基準の足し方(P4 §0.a-0.6):** この union に 1 種類足し、
 * `resolveCoordinate.ts` の `resolvePointReference` に 1 case、
 * `geometry/planeSpec.ts` の `pointReferenceKeyText` に 1 case、
 * `io` の `POINT_REFERENCE_KINDS` / `serializePointReference` / `readPointReference` に
 * 1 か所ずつ足すだけで済む形を保つ。**P5 の球面上の点(FR-431)はこの形で
 * `{ readonly kind: 'sphereGrid'; readonly sphereFeatureId: string;
 *    readonly latitude: ExpressionValue; readonly longitude: ExpressionValue }`
 * を足す予定**(球というフィーチャーが P5 まで無いので、P4 では型に入れない。
 * 解決できない種類を先に型へ持ち込むと、意味を持たない分岐が残るため)。
 */
export type PointReference =
  | { readonly kind: 'origin' }
  | { readonly kind: 'previous' }
  | { readonly kind: 'point'; readonly pointId: string }
  | {
      readonly kind: 'vertex';
      readonly featureId: string;
      readonly vertex: 'start' | 'end' | 'center';
    }
  /**
   * 立体の部分形状(頂点・辺・面)の位置(FR-330、P4 §2.4・§2.6、タスク10)。
   * 3D スケッチで「立体の頂点を結んで線を引く / 面を張る」ための基準。
   * 位置は頂点ならその点、辺なら中点、面なら重心(`SubShapeFingerprint.position` の約束)。
   * 上流の立体が変われば指紋で選び直す(`SketchResolveOptions.subShape`)。
   */
  | { readonly kind: 'subShape'; readonly ref: SubShapeRef };

/** 1 点の指定方法(FR-301〜303)。x/y/z はワールド座標、角度は度。 */
export type CoordinateInput =
  | {
      readonly mode: 'absolute';
      readonly x: ExpressionValue;
      readonly y: ExpressionValue;
      readonly z: ExpressionValue;
    }
  | {
      readonly mode: 'relative';
      readonly base: PointReference;
      readonly dx: ExpressionValue;
      readonly dy: ExpressionValue;
      readonly dz: ExpressionValue;
    }
  | {
      readonly mode: 'polar';
      readonly base: PointReference;
      readonly distance: ExpressionValue;
      readonly azimuth: ExpressionValue;
      readonly elevation: ExpressionValue;
    };

export type SketchFeatureKind =
  | 'point'
  | 'line'
  | 'arc'
  | 'pointArray'
  | 'face'
  | 'rectangle'
  | 'polygon'
  | 'slot'
  | 'ellipse'
  | 'spline'
  | 'offset';

interface SketchFeatureBase {
  readonly id: string;
  /** フィーチャーツリーの表示名(FR-501)。 */
  readonly name: string;
  /** 作成時の作図面。極座標と円弧の向きの基準になる。 */
  readonly planeId: WorkPlaneId;
}

export interface SketchPointFeature extends SketchFeatureBase {
  readonly kind: 'point';
  readonly at: CoordinateInput;
}

export interface SketchLineFeature extends SketchFeatureBase {
  readonly kind: 'line';
  readonly from: CoordinateInput;
  readonly to: CoordinateInput;
  /** 構築線(FR-320)。P4 タスク6 で境界に選べない扱いにする。既定 false。 */
  readonly construction: boolean;
}

/**
 * 3D スケッチ(`planeId` が `FREE_WORK_PLANE_ID`)の円弧の向き(FR-330、§2.4、タスク10)。
 *
 * 作図面が無いと法線・第1軸を借りる先が無いので、その円弧専用の向きをここで持つ。
 * どちらも「原点から見た向きベクトル」として解く(絶対座標なら成分そのもの)。
 * `xAxis` は法線に垂直な成分だけを使うので、多少ずれていてもよい(法線と平行なときだけ断る)。
 *
 * 3 点(始点・終点・通過点)から円弧を作る指定方法は、UI 側(タスク14)が中心・半径・
 * 角度とこの向きを計算してから保存する(2 点+半径の円弧を UI で中心へ直す §0.a-0.18 と
 * 同じ考え方。model の保存形は「中心+半径+角度+向き」の 1 通りに揃える)。
 */
export interface FreeArcOrientation {
  /** 円弧が乗る平面の法線。 */
  readonly normal: CoordinateInput;
  /** 角度 0 の向き。法線に垂直な成分を使う。 */
  readonly xAxis: CoordinateInput;
}

export interface SketchArcFeature extends SketchFeatureBase {
  readonly kind: 'arc';
  readonly center: CoordinateInput;
  readonly radius: ExpressionValue;
  readonly startAngle: ExpressionValue;
  /** 開始角との差が ±360 なら全周の円になる(FR-305、§0.a-0.4)。 */
  readonly endAngle: ExpressionValue;
  /** 構築線(FR-320)。P4 タスク6 で境界に選べない扱いにする。既定 false。 */
  readonly construction: boolean;
  /**
   * 3D スケッチ専用の向き(FR-330、タスク10)。`planeId` が作図面を指すときは
   * 作図面の法線・第1軸を使うので不要(無視する)。3D スケッチで無ければ `missingBase`。
   */
  readonly freeOrientation?: FreeArcOrientation;
}

/**
 * 点列の並べ方(FR-327、タスク6)。直線状(既存)に加え、円周上・格子状を持てる。
 * P3 の `PatternPlacement`(直線/円形の discriminated union)と同じ形を流用する
 * (§0.a-0.9)。
 */
export type PointArrayLayout =
  | {
      readonly kind: 'linear';
      readonly base: CoordinateInput;
      readonly azimuth: ExpressionValue;
      readonly spacing: ExpressionValue;
      readonly count: ExpressionValue;
    }
  | {
      /** 中心・半径・個数で等角度に並べる。開始角は常に作図面の第1軸(角度 0)。 */
      readonly kind: 'circular';
      readonly center: CoordinateInput;
      readonly radius: ExpressionValue;
      readonly count: ExpressionValue;
    }
  | {
      /** 基準点から行方向・列方向へ格子状に並べる。 */
      readonly kind: 'grid';
      readonly base: CoordinateInput;
      readonly rowAzimuth: ExpressionValue;
      readonly rowSpacing: ExpressionValue;
      readonly rowCount: ExpressionValue;
      readonly colAzimuth: ExpressionValue;
      readonly colSpacing: ExpressionValue;
      readonly colCount: ExpressionValue;
    };

/**
 * 点列(FR-308、FR-327)。並べ方は `layout` の種類で分岐する(既存の直線状は
 * `layout.kind === 'linear'` へ包み直した、P3までのデータとは保存形が変わる破壊的変更
 * (§0.a-0.24。`.pcad` の版アップとタスク31 の変換で吸収する)。
 */
export interface SketchPointArrayFeature extends SketchFeatureBase {
  readonly kind: 'pointArray';
  readonly layout: PointArrayLayout;
}

/**
 * 対角の 2 点で指定する矩形(FR-314)。1 フィーチャーが 4 本の線分を生む
 * (`resolveSketch.ts` の `curvesByFeature`、§0.a-0.8)。中心+幅+高さの指定は
 * UI 側が corner1/corner2 の対角座標へ変換してから保存する(保存形はこの 2 点に統一する)。
 */
export interface SketchRectangleFeature extends SketchFeatureBase {
  readonly kind: 'rectangle';
  readonly corner1: CoordinateInput;
  readonly corner2: CoordinateInput;
  /** 構築線(FR-320)。P4 タスク6 で境界に選べない扱いにする。既定 false。 */
  readonly construction: boolean;
}

/**
 * 中心+辺数+半径で指定する正多角形(FR-315)。1 フィーチャーが辺数ぶんの線分を生む。
 * 半径は円周(頂点)半径(外接)か辺の中点までの距離(内接、アポテム)かを `radiusMode` で選ぶ。
 */
export interface SketchPolygonFeature extends SketchFeatureBase {
  readonly kind: 'polygon';
  readonly center: CoordinateInput;
  /** 3 以上の整数。 */
  readonly sides: ExpressionValue;
  readonly radius: ExpressionValue;
  /** 半径の意味(FR-315)。 */
  readonly radiusMode: 'circumscribed' | 'inscribed';
  readonly construction: boolean;
}

/**
 * 2 つの中心点+幅で指定する長穴(FR-316)。1 フィーチャーが直線区間 2 本+半円弧 2 本を生む。
 */
export interface SketchSlotFeature extends SketchFeatureBase {
  readonly kind: 'slot';
  readonly center1: CoordinateInput;
  readonly center2: CoordinateInput;
  readonly width: ExpressionValue;
  readonly construction: boolean;
}

/**
 * 中心・長軸半径・短軸半径・傾き・開始角・終了角で指定する楕円と楕円弧(FR-318)。
 * 矩形などと違い 1 フィーチャー = 1 曲線で、`ResolvedEllipse` 1 つに解決する。
 *
 * `rotation` は作図面の第1軸から長軸までの角度(度)。
 * `startAngle` / `endAngle` は**長軸から測った幾何の方位角**(度)で、画面で見える角度と
 * 一致する。差が ±360 度なら全周の楕円になる(円弧と同じ約束、FR-305)。
 * カーネルが要る「径数方程式のパラメータ角」への変換は解決のとき
 * (`resolveSketch.ts` の `azimuthToEllipseParameter`)に済ませる。
 */
export interface SketchEllipseFeature extends SketchFeatureBase {
  readonly kind: 'ellipse';
  readonly center: CoordinateInput;
  readonly majorRadius: ExpressionValue;
  readonly minorRadius: ExpressionValue;
  /** 長軸の傾き(度)。作図面の第1軸からの角度。 */
  readonly rotation: ExpressionValue;
  readonly startAngle: ExpressionValue;
  readonly endAngle: ExpressionValue;
  /** 構築線(FR-320)。P4 タスク6 で境界に選べない扱いにする。既定 false。 */
  readonly construction: boolean;
}

/**
 * 点の並びから作る自由曲線(FR-317)。1 フィーチャー = 1 曲線。
 *
 * `mode` が `interpolate` なら与えた点を必ず通り、`control` なら与えた点が曲線を引っぱる。
 * `closed` なら最後の点から最初の点へ戻ってつながる(**閉じるための重複点は入れない**)。
 * 点の数は開いた曲線で 2 個以上、閉じた曲線で 3 個以上、いずれも
 * `splineMath.ts` の `MAX_SPLINE_POINTS` 個以下(統括の決定 §0.a-0.17)。
 */
export interface SketchSplineFeature extends SketchFeatureBase {
  readonly kind: 'spline';
  readonly mode: 'interpolate' | 'control';
  /** 通過点または制御点。並び順が曲線の向きになる。3D スケッチでも使えるよう座標指定のまま持つ。 */
  readonly points: readonly CoordinateInput[];
  readonly closed: boolean;
  readonly construction: boolean;
}

/** 面の境界に使う要素の参照。点列の中の 1 点、または複数曲線フィーチャーの n 番目の曲線を
 * 指すときだけ index を付ける(§0.a-0.8)。省略時は「そのフィーチャーの全周・全体」を表す。 */
export interface SketchElementRef {
  readonly featureId: string;
  readonly index?: number;
}

/**
 * オフセットをどちら側へずらすか(FR-321、タスク15)。
 *
 * - **閉じた輪郭**: `outside` が外へ広がる側、`inside` が内へ縮む側。
 *   輪郭を描いた向き(時計回り/反時計回り)にはよらない
 *   (`offsetMath.ts` 冒頭の実測を参照)。
 * - **開いた曲線**: 内も外も無いので、**進む向きから見た左が `outside`、右が `inside`**。
 *   画面には「左/右」と出す(道具の側の言葉づかいはタスク21)。
 */
export type OffsetSide = 'outside' | 'inside';

/**
 * オフセットの角の作り方(FR-321)。
 * `round` は外側の角を半径 = 距離の丸みでつなぎ、`sharp` は隣り合う辺を延長して尖らせる。
 */
export type OffsetCornerKind = 'round' | 'sharp';

/**
 * オフセット(FR-321、§2.5、タスク15)。選んだ線・円弧・つながった輪郭を、距離ぶん
 * 平行にずらした**新しい**曲線列を作る。元の要素は変えない(複製系、§0.a-0.10)。
 *
 * **曲線の形はここでは決まらない。** ずらした形は OCCT に解いてもらうので、解決
 * (`resolveSketch`)は「材料がそろっているか」だけを確かめ、まだ形が無いものを
 * `ResolvedSketch.pendingOffsets` へ積む。実際の形はカーネルの往復を持つ
 * `recomputeSketch` が入れる(§2.9、`offsetMath.ts` の注釈)。
 */
export interface SketchOffsetFeature extends SketchFeatureBase {
  readonly kind: 'offset';
  /**
   * オフセット元。並んだ順につながった 1 本の輪郭として扱う。
   * 矩形などの複数曲線フィーチャーは、`index` を省けば全周、指定すれば n 番目の曲線
   * (面の境界と同じ約束、§0.a-0.8)。
   */
  readonly source: readonly SketchElementRef[];
  /** 距離の**大きさ**(mm、0 以上)。どちら側かは `side` が決める(NFR-UX-4)。 */
  readonly distance: ExpressionValue;
  readonly side: OffsetSide;
  readonly corner: OffsetCornerKind;
  /** 構築線(FR-320)。ずらした結果を参照専用にしたいときに true。既定 false。 */
  readonly construction: boolean;
}

export interface SketchFaceFeature extends SketchFeatureBase {
  readonly kind: 'face';
  /** 順序が意味を持つ。点だけ、または線・円弧だけを並べる(§0.a-0.13)。 */
  readonly boundary: readonly SketchElementRef[];
  /** 塗り色(FR-310)。"#rrggbb"。 */
  readonly color: string;
}

export type SketchFeature =
  | SketchPointFeature
  | SketchLineFeature
  | SketchArcFeature
  | SketchPointArrayFeature
  | SketchFaceFeature
  | SketchRectangleFeature
  | SketchPolygonFeature
  | SketchSlotFeature
  | SketchEllipseFeature
  | SketchSplineFeature
  | SketchOffsetFeature;

/** スケッチ文書。変更のたびに新しい配列を作る(P2 の Undo の土台、FR-505)。 */
export interface SketchDocument {
  readonly id: string;
  readonly name: string;
  readonly features: readonly SketchFeature[];
}

/** 解決済みの点。id は点フィーチャーなら featureId、点列の n 番目なら `featureId#n`。 */
export interface ResolvedPoint {
  readonly id: string;
  readonly featureId: string;
  readonly position: Vec3;
}

export interface ResolvedSegment {
  readonly kind: 'segment';
  readonly featureId: string;
  readonly from: Vec3;
  readonly to: Vec3;
}

export interface ResolvedArc {
  readonly kind: 'arc';
  readonly featureId: string;
  readonly center: Vec3;
  readonly normal: Vec3;
  /** 角度 0 の向き。作図面の第1軸。 */
  readonly xAxis: Vec3;
  readonly radius: number;
  /** ラジアン。xAxis から normal まわりに正。 */
  readonly startAngle: number;
  readonly endAngle: number;
}

/**
 * 解決済みの楕円・楕円弧(FR-318)。`ResolvedArc` を「半径 2 つ」へ広げず新しい種類にしたのは、
 * 円弧の利用箇所がどれも「半径は 1 つ」を前提にしているため(§2.3 の判断)。
 *
 * **`startAngle` / `endAngle` は径数方程式のパラメータ角(ラジアン)**で、中心から見た
 * 幾何の方位角ではない(両者が一致するのは 0°・90°・180°・270° の 4 点だけ)。曲線上の点は
 *   P(u) = center + majorRadius·cos(u)·majorAxis + minorRadius·sin(u)·(normal × majorAxis)
 * で、この式はカーネルの `gp_Elips`(`makeEllipseEdge.ts` の注釈)とそのまま同じ。
 * 利用者が入力する方位角からの変換は `resolveSketch.ts` の `azimuthToEllipseParameter` が済ませる。
 */
export interface ResolvedEllipse {
  readonly kind: 'ellipse';
  readonly featureId: string;
  readonly center: Vec3;
  readonly normal: Vec3;
  /** 長軸方向の単位ベクトル。パラメータ角 0 の向き。 */
  readonly majorAxis: Vec3;
  readonly majorRadius: number;
  readonly minorRadius: number;
  /** ラジアン(パラメータ角)。majorAxis から normal まわりに正。 */
  readonly startAngle: number;
  readonly endAngle: number;
}

/**
 * 解決済みのスプライン(FR-317)。**曲線の形(極・節点)はここに持たず、与えられた点だけを持つ。**
 * 極を解くのは点の数の 3 乗に比例する計算なので、表示用の折れ線が要るときにだけ
 * `splineMath.ts` の `splineCurveData` / `sampleSpline` が解き直す。
 */
export interface ResolvedSpline {
  readonly kind: 'spline';
  readonly featureId: string;
  readonly mode: 'interpolate' | 'control';
  /** 通過点(interpolate)または制御点(control)。並び順が曲線の向き。 */
  readonly points: readonly Vec3[];
  readonly closed: boolean;
}

export type ResolvedCurve = ResolvedSegment | ResolvedArc | ResolvedEllipse | ResolvedSpline;

export interface ResolvedFace {
  readonly featureId: string;
  readonly color: string;
  /** 閉ループの順に並んだ曲線。 */
  readonly curves: readonly ResolvedCurve[];
}

export type SketchErrorCode =
  | 'missingBase'
  | 'invalidValue'
  | 'degenerate'
  | 'notClosed'
  | 'notPlanar'
  /** 面の境界に選んだ点が一直線に並んでいて平面が定まらない(§2.3、P1 の残件)。 */
  | 'collinear'
  | 'tooFewPoints'
  | 'mixedBoundary'
  /** 構築線(FR-320)を面の境界に選んだ(タスク6)。 */
  | 'constructionElement'
  /**
   * 立体の部分形状(頂点・辺・面)の参照を選び直せなかった(FR-330、タスク10)。
   * 上流の立体が大きく変わって指紋に合う形が無くなった場合で、
   * `missingBase`(スケッチの中の基準が無い)とは原因が違うので分けて持つ。
   */
  | 'missingSubShape'
  | 'kernelFailed';

/** 解決できなかった理由。止めずに持ち回る(FR-504、NFR-RE-1)。 */
export interface SketchError {
  readonly featureId: string;
  readonly code: SketchErrorCode;
  readonly message: string;
}

/**
 * オフセット元の輪郭の形(FR-321、タスク15)。
 *
 * 閉じているかどうかで、ずらす側の決め方が変わる。開いた曲線は「進む向きの左/右」で
 * 側を決めるので、たどり始める点・そこでの進む向き・左右の基準になる法線を持つ。
 */
export type OffsetContourShape =
  | { readonly closed: true }
  | {
      readonly closed: false;
      /** 輪郭をたどり始める点。 */
      readonly startPoint: Vec3;
      /** 起点での進む向き(単位ベクトル)。 */
      readonly startDirection: Vec3;
      /** 左右の基準になる作図面の法線(単位ベクトル)。左は normal × direction。 */
      readonly normal: Vec3;
    };

/**
 * まだ形が決まっていないオフセットの依頼(FR-321、タスク15)。
 *
 * 解決(`resolveSketch`)は OCCT を呼ばない純関数なので、覚え書き(`OffsetCache`)に
 * 結果が無いオフセットはここへ積まれる。これは**失敗ではなく一時的な状態**なので
 * `errors` には入れない(§2.7 の投影・交差の `pending` と同じ扱い)。
 * カーネルへ頼んで結果を覚え書きへ入れ、解決し直すのは `recomputeSketch` の役目。
 */
export interface PendingOffset {
  readonly featureId: string;
  /** 覚え書きの鍵(`offsetMath.ts` の `offsetCacheKey`)。 */
  readonly key: string;
  /** オフセット元の曲線。並んだ順につながっている。 */
  readonly curves: readonly ResolvedCurve[];
  /** 距離の大きさ(mm、0 以上)。 */
  readonly distance: number;
  readonly side: OffsetSide;
  readonly corner: OffsetCornerKind;
  readonly contour: OffsetContourShape;
}

export interface ResolvedSketch {
  readonly points: readonly ResolvedPoint[];
  readonly segments: readonly ResolvedSegment[];
  readonly arcs: readonly ResolvedArc[];
  /** 楕円・楕円弧(FR-318)。線分・円弧と並ぶ独立の配列(タスク5)。 */
  readonly ellipses: readonly ResolvedEllipse[];
  /** スプライン(FR-317)。 */
  readonly splines: readonly ResolvedSpline[];
  readonly faces: readonly ResolvedFace[];
  readonly errors: readonly SketchError[];
  /** まだ形が決まっていないオフセット(FR-321、タスク15)。無ければ空。 */
  readonly pendingOffsets: readonly PendingOffset[];
  /**
   * 「1 フィーチャーが複数の曲線を生む」もの(矩形・正多角形・長穴・オフセット)の
   * 曲線を、フィーチャーの id から順番どおりに引く(§0.a-0.8、タスク4・15)。
   *
   * `segments` / `arcs` にも同じ曲線が入っているが、そちらは種類ごとに分かれるので
   * **1 フィーチャーの中の並び順(`featureId#n` の n)が分からなくなる**
   * (長穴は「直線・円弧・直線・円弧」の順で交互に並ぶ)。n 番目の曲線を名指しする側
   * (面の境界、オフセット元、トリム・延長の対象。FR-322、タスク17)はここを見る。
   * 線分・円弧のように 1 フィーチャー = 1 曲線のものはここに入らない。
   */
  readonly curvesByFeature: ReadonlyMap<string, readonly ResolvedCurve[]>;
}

/** 面 1 枚のメッシュ。kernel の FaceMeshData を model の言葉へ詰め替えたもの。 */
export interface SketchFaceMesh {
  readonly featureId: string;
  readonly color: string;
  readonly positions: Float32Array;
  readonly normals: Float32Array;
  readonly indices: Uint32Array;
  readonly triangleCount: number;
  readonly boundaryPositions: Float32Array;
}

/** カーネルが返したスケッチの表示用データ。 */
export interface SketchMesh {
  readonly faces: readonly SketchFaceMesh[];
}
