import type { DimensionTarget } from '../dimension/types.js';
import type { DrawingElementStyle, DrawingExpressionValue, Point2 } from '../types.js';

export type WeldKind = 'fillet' | 'squareButt' | 'vButt' | 'bevelButt' | 'uButt' | 'jButt' | 'spot' | 'seam';
export interface WeldLengthValue { readonly expression: DrawingExpressionValue; readonly unit: 'mm' | 'inch' }
/** X形は上下のV形として各側の寸法を独立して保持する。 */
export interface WeldSideSpec {
  readonly kind: WeldKind;
  readonly side: 'arrow' | 'opposite' | 'center';
  readonly size?: { readonly kind: 'leg' | 'throat' | 'penetration' | 'diameter' | 'width'; readonly value: WeldLengthValue };
  readonly length?: WeldLengthValue;
  readonly pitch?: WeldLengthValue;
  readonly count?: DrawingExpressionValue;
  readonly rootGap?: WeldLengthValue;
  readonly grooveDepth?: WeldLengthValue;
  /** 開先角度の式は度。 */
  readonly grooveAngle?: DrawingExpressionValue;
  readonly contour: 'none' | 'flush' | 'convex' | 'concave';
  readonly finish: 'none' | 'grind' | 'machine' | 'chip' | 'polish';
}
export interface WeldSymbol {
  readonly id: string;
  readonly system: 'B';
  readonly target: DimensionTarget;
  readonly sides: readonly WeldSideSpec[];
  readonly allAround: boolean;
  readonly fieldWeld: boolean;
  readonly tail: string;
  readonly closedTail?: boolean;
  /** 折れ矢の折点は基線始点からの紙上mm。移動で対象形体を変えない。 */
  readonly arrowBendOffset?: Point2;
  readonly position: Point2;
  readonly height: number;
  readonly layerId: string;
  readonly style?: DrawingElementStyle | null;
}
