import type { DrawingElementStyle, DrawingSubShapeRef, Point2, Vector3 } from '../types.js';

export type DimensionKind =
  | 'length'
  | 'diameter'
  | 'radius'
  | 'angle'
  | 'sphereDiameter'
  | 'sphereRadius'
  | 'arcLength'
  | 'thickness'
  | 'coordinate';

/** 寸法値をモデルからどう測るか。値そのものは保存しない(FR-706)。 */
export type DimensionMeasurement =
  | 'horizontal'
  | 'vertical'
  | 'trueDistance'
  | 'angle'
  | 'radius'
  | 'coordinate';

export type DimensionTarget =
  | {
      readonly kind: 'subShape';
      readonly viewId: string;
      readonly sourceRef: string;
      readonly componentId?: string;
      readonly ref: DrawingSubShapeRef;
    }
  | {
      readonly kind: 'point';
      readonly viewId: string;
      readonly paperPoint: Point2;
      readonly modelPoint?: Vector3;
    };

/** 手動配置でも数値は持たず、寸法線の紙上位置だけを保存する。 */
export interface DimensionPlacement {
  readonly commonNormalCoordinate: number;
  readonly textPosition: Point2 | null;
}

export type DimensionTolerance =
  | { readonly kind: 'symmetric'; readonly value: number }
  | { readonly kind: 'deviation'; readonly upper: number; readonly lower: number };

/** 寸法の保存形。`value` は意図的に持たない(FR-706、FR-710)。 */
export interface Dimension {
  readonly id: string;
  readonly kind: DimensionKind;
  readonly measurement: DimensionMeasurement;
  readonly targets: readonly DimensionTarget[];
  readonly placement: DimensionPlacement;
  readonly tolerance?: DimensionTolerance;
  readonly prefix?: string;
  readonly suffix?: string;
  readonly reference: boolean;
  readonly origin: 'auto' | 'manual';
  readonly layerId: string;
  readonly style?: DrawingElementStyle | null;
}
