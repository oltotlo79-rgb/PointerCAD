/** P10: 板金の履歴に保存する入力。解決済みの形状・展開座標は含めない。 */
import type { ExpressionValue } from '@pointercad/expression';
import type { SketchFaceRef, SketchLineRef } from '../part/featureReferences.js';
import type { SolidFeatureBase } from '../part/featureIdentity.js';

export interface SheetMetalRule {
  readonly thickness: ExpressionValue;
  readonly innerRadius: ExpressionValue;
  /** 無次元。exactVariables/nonLengthVariablesを通し、inchを掛けない。 */
  readonly kFactor: ExpressionValue;
}

export interface SheetBaseFeature extends SolidFeatureBase {
  readonly kind: 'sheetBase';
  readonly profile: SketchFaceRef;
  /** 外周とは別の閉輪郭。保存時に同じ線の配列へ平坦化しない。 */
  readonly holes: readonly SketchFaceRef[];
  readonly reversed: boolean;
  readonly rule: SheetMetalRule;
}
export interface SheetPanelBoundaryRef {
  /** 元のスケッチ要素または生成featureから決まる安定ID。OCCTの面番号ではない。 */
  readonly panelId: string;
  readonly boundaryId: string;
}
export interface SheetBendRuleOverride {
  /** nullは基板の規則を使う。厚みは後段で変更しない。 */
  readonly innerRadius: ExpressionValue | null;
  readonly kFactor: ExpressionValue | null;
}
export interface SheetFlangeProfile {
  readonly face: SketchFaceRef;
  /** 接続する直線の安定ID。自動で最長辺を選んだり幅を拡縮したりしない。 */
  readonly baselineId: string;
  readonly holes: readonly SketchFaceRef[];
}
export interface SheetFlangeFeature extends SolidFeatureBase {
  readonly kind: 'sheetFlange';
  readonly targetFeatureId: string;
  readonly edges: readonly SheetPanelBoundaryRef[];
  readonly length: ExpressionValue;
  readonly angle: ExpressionValue;
  readonly startOffset: ExpressionValue;
  readonly endOffset: ExpressionValue;
  readonly lengthBasis: 'tangent' | 'outer' | 'inner';
  readonly rule: SheetBendRuleOverride;
  /** nullは矩形。任意輪郭は指定した基準縁を接線へ合わせて剛体配置する。 */
  readonly profile: SheetFlangeProfile | null;
}
export interface SheetBendFeature extends SolidFeatureBase {
  readonly kind: 'sheetBend';
  readonly targetFeatureId: string;
  readonly panelId: string;
  readonly line: SketchLineRef;
  readonly fixedSide: 'left' | 'right';
  readonly angle: ExpressionValue;
  readonly rule: SheetBendRuleOverride;
}
export interface SheetReliefFeature extends SolidFeatureBase {
  readonly kind: 'sheetRelief';
  readonly targetFeatureId: string;
  readonly boundary: SheetPanelBoundaryRef;
  readonly position: ExpressionValue;
  readonly width: ExpressionValue;
  readonly depth: ExpressionValue;
  readonly shape: 'rectangle' | 'slot';
  /** 閉周回を切り開く継ぎ目。省略は継ぎ目なしの従来入力。 */
  readonly seamConnectionIds?: readonly string[];
}

/** 展開条件は幾何の入力。カメラや折曲げ/展開の表示モードは保存しない。 */
export interface SheetUnfoldDefinition {
  readonly sourceFeatureId: string;
  readonly fixedPanelId: string;
  readonly seamConnectionIds: readonly string[];
}
export type SheetMetalFeature = SheetBaseFeature | SheetFlangeFeature | SheetBendFeature | SheetReliefFeature;
