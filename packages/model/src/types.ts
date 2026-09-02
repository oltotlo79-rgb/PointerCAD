/** 表示用のメッシュ。model が UI へ渡す唯一の幾何データ形式。 */
export interface PartMesh {
  readonly positions: Float32Array;
  readonly normals: Float32Array;
  readonly indices: Uint32Array;
  /** 稜線の線分列。線分1本あたり 6 個。 */
  readonly edgePositions: Float32Array;
  readonly triangleCount: number;
}

/** 直方体フィーチャー。P0 で扱う唯一の種類。 */
export interface BoxFeature {
  readonly id: string;
  readonly kind: 'box';
  /** フィーチャーツリーに表示する名前(FR-501)。 */
  readonly name: string;
  readonly dx: number;
  readonly dy: number;
  readonly dz: number;
}

export type Feature = BoxFeature;

/** 部品(パート)ドキュメント。フィーチャー履歴を 1 本持つ(要件§2)。 */
export interface PartDocument {
  readonly id: string;
  readonly name: string;
  readonly features: readonly Feature[];
}

/** 再計算の結果。失敗しても例外にせず、理由を持ち回る(FR-504、NFR-RE-1)。 */
export type RecomputeResult =
  | { readonly status: 'ok'; readonly mesh: PartMesh }
  | { readonly status: 'error'; readonly featureId: string; readonly message: string };
