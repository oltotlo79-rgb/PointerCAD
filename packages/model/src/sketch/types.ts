/**
 * スケッチの保存形式と、解決済みの形の型(計画書 docs/plans/P1-式とスケッチ.md §2.6)。
 *
 * 保存するのはフィーチャー履歴だけで、解決済みの座標やメッシュは保存しない
 * (要件§8、rules/04-設計の規律.md「導出できるものは保存しない」)。
 * 全パラメータは式文字列+評価値のペア(ExpressionValue)で持つ(FR-202)。
 * カーネルの結果を受け取る型もここへ置き、@pointercad/kernel の型は再輸出しない。
 */

import type { ExpressionValue } from '@pointercad/expression';

import type { WorkPlaneId } from './planeMath.js';
import type { Vec3 } from './vec3.js';

/**
 * 座標の基準にできるもの(FR-302、FR-303)。座標を複製せず id で参照するので、
 * 基準が動けば下流が追従する(FR-311、FR-502 の土台)。
 * `previous` は保存しても履歴上の位置から導けるため、解決のときに
 * 「そのフィーチャーより前で最後に作られた点」として求める。
 */
export type PointReference =
  | { readonly kind: 'origin' }
  | { readonly kind: 'previous' }
  | { readonly kind: 'point'; readonly pointId: string }
  | {
      readonly kind: 'vertex';
      readonly featureId: string;
      readonly vertex: 'start' | 'end' | 'center';
    };

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
  | 'slot';

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
}

export interface SketchArcFeature extends SketchFeatureBase {
  readonly kind: 'arc';
  readonly center: CoordinateInput;
  readonly radius: ExpressionValue;
  readonly startAngle: ExpressionValue;
  /** 開始角との差が ±360 なら全周の円になる(FR-305、§0.a-0.4)。 */
  readonly endAngle: ExpressionValue;
}

export interface SketchPointArrayFeature extends SketchFeatureBase {
  readonly kind: 'pointArray';
  readonly base: CoordinateInput;
  readonly azimuth: ExpressionValue;
  readonly spacing: ExpressionValue;
  readonly count: ExpressionValue;
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

/** 面の境界に使う要素の参照。点列の中の 1 点、または複数曲線フィーチャーの n 番目の曲線を
 * 指すときだけ index を付ける(§0.a-0.8)。省略時は「そのフィーチャーの全周・全体」を表す。 */
export interface SketchElementRef {
  readonly featureId: string;
  readonly index?: number;
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
  | SketchSlotFeature;

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

export type ResolvedCurve = ResolvedSegment | ResolvedArc;

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
  | 'kernelFailed';

/** 解決できなかった理由。止めずに持ち回る(FR-504、NFR-RE-1)。 */
export interface SketchError {
  readonly featureId: string;
  readonly code: SketchErrorCode;
  readonly message: string;
}

export interface ResolvedSketch {
  readonly points: readonly ResolvedPoint[];
  readonly segments: readonly ResolvedSegment[];
  readonly arcs: readonly ResolvedArc[];
  readonly faces: readonly ResolvedFace[];
  readonly errors: readonly SketchError[];
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
