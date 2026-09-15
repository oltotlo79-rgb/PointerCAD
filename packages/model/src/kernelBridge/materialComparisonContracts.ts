import type { PartCancelToken } from './solidContracts.js';

export interface MaterialComparisonMesh {
  readonly positions: Float32Array;
  readonly normals: Float32Array;
  readonly indices: Uint32Array;
  readonly triangleCount: number;
}
export type MaterialDifferenceRegion =
  | { readonly kind: 'empty'; readonly volume: 0; readonly mesh: null }
  | { readonly kind: 'material'; readonly volume: number; readonly mesh: MaterialComparisonMesh };
export interface MaterialComparisonGeometry {
  readonly added: MaterialDifferenceRegion;
  readonly removed: MaterialDifferenceRegion;
  readonly common: MaterialDifferenceRegion;
  readonly beforeVolume: number;
  readonly afterVolume: number;
}
export type MaterialComparisonResult =
  | { readonly kind: 'compared'; readonly result: MaterialComparisonGeometry }
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'failed'; readonly message: string };
export interface MaterialComparisonBridge {
  compareMaterials(beforeKeys: readonly string[], afterKeys: readonly string[], shouldCancel?: PartCancelToken): Promise<MaterialComparisonResult>;
}
