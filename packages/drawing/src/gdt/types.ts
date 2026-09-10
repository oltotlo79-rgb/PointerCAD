import type { DimensionTarget } from '../dimension/types.js';
import type { DrawingElementStyle, DrawingExpressionValue, Point2 } from '../types.js';

/** JIS B 0021:1998の14特性。生成・規格検証・形状参照の解決はmodelが行う。 */
export type ToleranceCharacteristic = 'straightness' | 'flatness' | 'roundness' | 'cylindricity'
  | 'lineProfile' | 'surfaceProfile' | 'parallelism' | 'perpendicularity' | 'angularity'
  | 'position' | 'coaxiality' | 'symmetry' | 'circularRunout' | 'totalRunout';

export type GdtShapeTarget = Extract<DimensionTarget, { readonly kind: 'subShape' }>;
export type GdtFeature =
  | { readonly kind: 'surface' | 'line' | 'axis'; readonly target: GdtShapeTarget }
  | { readonly kind: 'medianPlane'; readonly targets: readonly [GdtShapeTarget, GdtShapeTarget] };

export type ToleranceZone = 'betweenLines' | 'betweenPlanes' | 'cylinder' | 'sphere'
  | 'concentricCircles' | 'coaxialCylinders' | 'lineProfile' | 'surfaceProfile'
  | 'radialRunout' | 'axialRunout';
export type MaterialRequirement = 'none' | 'maximum';
export interface GdtToleranceValue {
  readonly expression: DrawingExpressionValue;
  /** 式の数値を解釈する単位。用紙・画面の表示単位から独立する。 */
  readonly unit: 'mm' | 'inch';
}
export type DatumId = string;
export interface DatumReferenceMember { readonly datumId: DatumId; readonly material: MaterialRequirement }
/** 一つの欄のA-B（共通基準）と、別欄のA/B（優先順）を混同しない。 */
export type DatumReference =
  | { readonly kind: 'single'; readonly member: DatumReferenceMember }
  | { readonly kind: 'common'; readonly members: readonly [DatumReferenceMember, DatumReferenceMember] };

export interface GdtFrameSegment {
  readonly characteristic: ToleranceCharacteristic;
  readonly tolerance: GdtToleranceValue;
  readonly zone: ToleranceZone;
  readonly material: MaterialRequirement;
  /** 第1・第2・第3基準の順。配列順を保存する。 */
  readonly datums: readonly DatumReference[];
  readonly basicDimensionIds: readonly string[];
}
export interface DatumDefinition {
  readonly id: DatumId;
  readonly label: string;
  readonly feature: GdtFeature;
  /** 軸・中心平面を示す場合のサイズ寸法。指示線をその寸法線の延長へ結ぶ。 */
  readonly sizeDimensionId?: string;
  readonly position: Point2;
  readonly height: number;
  readonly layerId: string;
  readonly style?: DrawingElementStyle | null;
}
export interface GeometricToleranceFrame {
  readonly id: string;
  readonly feature: GdtFeature;
  readonly sizeDimensionId?: string;
  /** 各段は独立した要求。ASMEの複合公差記入枠に読み替えない。 */
  readonly segments: readonly GdtFrameSegment[];
  readonly position: Point2;
  readonly height: number;
  readonly layerId: string;
  readonly style?: DrawingElementStyle | null;
}
