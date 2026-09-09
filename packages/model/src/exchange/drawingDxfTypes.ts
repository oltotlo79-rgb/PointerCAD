import type { SketchDxfEntity, SketchDxfEntityBase, SketchDxfPoint2d } from './dxfTypes.js';

/** 図面を保存形式の実体へ変換した結果。文字列への符号化は io の責務。 */
export type DrawingDxfEntity = (SketchDxfEntity
  | (SketchDxfEntityBase & { readonly kind: 'text'; readonly text: string; readonly position: SketchDxfPoint2d;
    readonly height: number; readonly rotation: number; readonly horizontal: 0 | 1 | 2; readonly vertical: 0 | 1 | 2 | 3 })
  | (SketchDxfEntityBase & { readonly kind: 'solid'; readonly points: readonly [SketchDxfPoint2d, SketchDxfPoint2d, SketchDxfPoint2d, SketchDxfPoint2d] })
  | (SketchDxfEntityBase & { readonly kind: 'polyline'; readonly points: readonly SketchDxfPoint2d[]; readonly closed: boolean }))
  & { readonly lineType?: string };

export interface DrawingDxfLayer {
  readonly name: string;
  readonly color: number;
  readonly lineType: string;
  readonly visible: boolean;
}
export interface DrawingDxfLineType {
  readonly name: string;
  /** 正が線、負が空白、0が点。 */
  readonly segments: readonly number[];
}
export interface DrawingDxfOptions {
  readonly layers: readonly DrawingDxfLayer[];
  readonly lineTypes: readonly DrawingDxfLineType[];
}
