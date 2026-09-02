/**
 * 部品(パート)文書の保存形式(計画書 docs/plans/P2-ソリッド基礎.md §2.1、要件§8)。
 *
 * P1 の SketchDocument をそのまま中へ入れ、ソリッドフィーチャーの履歴を並べる。
 * 保存するのは履歴と式だけで、解決済みの座標・B-rep・メッシュ・キャッシュの鍵は
 * 保存しない(rules/04-設計の規律.md「導出できるものは保存しない」)。
 * 全パラメータは式文字列+評価値のペア(ExpressionValue)で持つ(FR-202)。
 * 参照はすべて id で持ち、座標や形を複製しない(FR-311、FR-502)。
 */

import type { ExpressionValue } from '@pointercad/expression';

import type { SketchDocument } from '../sketch/types.js';

/** スケッチの面フィーチャー1枚への参照。断面に使う(§0.a-0.7、§0.a-0.8)。 */
export interface SketchFaceRef {
  readonly sketchId: string;
  readonly faceFeatureId: string;
}

/** スケッチの線分フィーチャー1本への参照。回転軸に使う(§0.a-0.9)。 */
export interface SketchLineRef {
  readonly sketchId: string;
  readonly lineFeatureId: string;
}

export type SolidFeatureKind = 'extrude' | 'revolve' | 'sew' | 'boolean';

interface SolidFeatureBase {
  /**
   * フィーチャーの id。同時にこのフィーチャーが作るボディの id でもある(§0.a-0.5)。
   * 他のフィーチャー(ブーリアン)から参照されるので、文書の中で重ならない。
   */
  readonly id: string;
  /** フィーチャーツリーの表示名(FR-501)。 */
  readonly name: string;
  /** 抑制(FR-503)。true なら再計算で飛ばし、ボディを作らない。 */
  readonly suppressed: boolean;
}

/** 押し出し(FR-401)。テーパーは P3(§0.a-0.8)。 */
export interface ExtrudeFeature extends SolidFeatureBase {
  readonly kind: 'extrude';
  readonly profile: SketchFaceRef;
  /** 押し出す長さ(mm)。正の数。向きは reversed で決める。 */
  readonly distance: ExpressionValue;
  /** 面の法線と逆向きへ出すか。 */
  readonly reversed: boolean;
  /** 両側へ出すか。true なら距離の半分ずつ両方向(平行移動は model 側で計算する)。 */
  readonly symmetric: boolean;
}

/** 回転軸の指定(FR-402、§0.a-0.9)。既定は world の z 軸。 */
export type RevolveAxis =
  | { readonly kind: 'world'; readonly axis: 'x' | 'y' | 'z' }
  | { readonly kind: 'line'; readonly line: SketchLineRef };

/** 回転(FR-402)。 */
export interface RevolveFeature extends SolidFeatureBase {
  readonly kind: 'revolve';
  readonly profile: SketchFaceRef;
  readonly axis: RevolveAxis;
  /** 回転角(度)。0 より大きく 360 以下。 */
  readonly angle: ExpressionValue;
  /** 軸の向きを反転するか。 */
  readonly reversed: boolean;
}

/** 縫合(FR-403)。閉じた殻を作れる面を並べる(§0.a-0.7)。 */
export interface SewFeature extends SolidFeatureBase {
  readonly kind: 'sew';
  readonly faces: readonly SketchFaceRef[];
  /** つなぎ目とみなす許容量(mm)。既定 DEFAULT_SEW_TOLERANCE_MM。 */
  readonly tolerance: ExpressionValue;
}

export type BooleanOperation = 'union' | 'subtract' | 'intersect';

/**
 * ブーリアン(FR-404)。対象と相手のボディを消費して1つのボディを作る(§0.a-0.5)。
 * 参照先のフィーチャーが消えても文書としては成り立ち、解決のときに理由つきで失敗する(FR-504)。
 */
export interface BooleanFeature extends SolidFeatureBase {
  readonly kind: 'boolean';
  readonly operation: BooleanOperation;
  /** 残る側のボディを作ったフィーチャーの id。 */
  readonly targetFeatureId: string;
  /** 相手のボディを作ったフィーチャーの id。 */
  readonly toolFeatureId: string;
}

export type SolidFeature = ExtrudeFeature | RevolveFeature | SewFeature | BooleanFeature;

/**
 * 部品(パート)文書。Undo のスナップショットの単位で、.pcad に保存される唯一のもの
 * (FR-505、FR-801)。変更のたびに新しい配列を作る(不変)。
 */
export interface PartDocument {
  readonly id: string;
  readonly name: string;
  /** 保存形式の版(§0.a-0.3)。読み書きの互換判定は packages/io が行う。 */
  readonly schemaVersion: number;
  /** スケッチ群。P2 の UI は1本だけ作るが、形は最初から複数を許す。 */
  readonly sketches: readonly SketchDocument[];
  /** いま編集しているスケッチの id。sketches のいずれかを指す(§0.a-0.4)。 */
  readonly activeSketchId: string;
  /** ソリッドフィーチャーの履歴。順序が意味を持つ(要件§2「履歴パラメトリック」)。 */
  readonly solids: readonly SolidFeature[];
}
