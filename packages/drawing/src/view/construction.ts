import type { DimensionTarget } from '../dimension/types.js';
import type { DrawingExpressionValue, Point2 } from '../types.js';

/** 保存するのは面を選んだ条件。解決した行列や投影線は含めない。 */
export type DrawingPlaneDefinition =
  | { readonly kind: 'workPlane'; readonly planeId: 'xy' | 'xz' | 'yz'; readonly offset: DrawingExpressionValue }
  | { readonly kind: 'face'; readonly target: DimensionTarget; readonly offset: DrawingExpressionValue }
  | { readonly kind: 'threePoints'; readonly points: readonly [DimensionTarget, DimensionTarget, DimensionTarget] }
  | { readonly kind: 'viewLine'; readonly sourceViewId: string; readonly from: Point2; readonly to: Point2 };

/** 範囲は元投影の実寸mm。用紙の縮尺を変更しても対象領域を変えない。 */
export type DrawingClipDefinition =
  | { readonly kind: 'circle'; readonly center: Point2; readonly radius: DrawingExpressionValue }
  | { readonly kind: 'polygon'; readonly points: readonly Point2[] };

/** 高度な図の作成条件。共通の位置・名前・線の指定はDrawingView側に置く。 */
export type DrawingViewConstruction =
  | {
      readonly kind: 'section';
      readonly plane: DrawingPlaneDefinition;
      readonly mode: 'full' | 'half' | 'local' | 'revolved' | 'stepped';
      readonly keepSide: 'positive' | 'negative';
      readonly boundary?: readonly Point2[];
      readonly label: string;
      readonly reversed: boolean;
    }
  | {
      readonly kind: 'detail';
      readonly sourceViewId: string;
      readonly center: Point2;
      readonly radius: DrawingExpressionValue;
      readonly scale: DrawingExpressionValue;
      readonly label: string;
    }
  | { readonly kind: 'auxiliary'; readonly sourceViewId: string; readonly plane: DrawingPlaneDefinition }
  | { readonly kind: 'partial'; readonly sourceViewId: string; readonly region: DrawingClipDefinition }
  | {
      readonly kind: 'broken';
      readonly sourceViewId: string;
      readonly axis: 'u' | 'v';
      readonly from: DrawingExpressionValue;
      readonly to: DrawingExpressionValue;
      /** 省略後に紙上へ残す隙間(mm)。縮尺を掛けない。 */
      readonly gap: DrawingExpressionValue;
    };
