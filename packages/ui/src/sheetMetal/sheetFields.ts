/** 作成パネルとプロパティが共有する板金の欄。 */
import type { ExpressionValue } from '@pointercad/expression';
import type { SheetBaseFeature, SheetFlangeFeature, SheetBendFeature, SheetReliefFeature, SheetMetalFeature } from '@pointercad/model';
import type { MessageKey } from '../i18n/t.js';
import type { FieldUnit, NumericFieldRange } from '../sketch/numericInput.js';

export type SheetFieldKey = 'sheetThickness' | 'sheetRadius' | 'sheetKFactor' | 'sheetLength' | 'sheetAngle' | 'sheetStartOffset' | 'sheetEndOffset'
  | 'sheetReliefPosition' | 'sheetReliefWidth' | 'sheetReliefDepth';
const positive: NumericFieldRange = { min: 1e-7, minInclusive: false, max: null, maxInclusive: false };
const nonnegative: NumericFieldRange = { min: 0, minInclusive: true, max: null, maxInclusive: false };
export const SHEET_FIELD_DEFINITIONS: Readonly<Record<SheetFieldKey, { readonly labelKey: MessageKey; readonly tooltipKey: MessageKey; readonly unit: FieldUnit; readonly range: NumericFieldRange }>> = {
  sheetReliefPosition: { labelKey: 'sheetMetal.reliefPosition', tooltipKey: 'sheetMetal.reliefPositionHint', unit: 'mm', range: nonnegative },
  sheetReliefWidth: { labelKey: 'sheetMetal.reliefWidth', tooltipKey: 'sheetMetal.reliefWidthHint', unit: 'mm', range: positive },
  sheetReliefDepth: { labelKey: 'sheetMetal.reliefDepth', tooltipKey: 'sheetMetal.reliefDepthHint', unit: 'mm', range: positive },
  sheetThickness: { labelKey: 'sheetMetal.thickness', tooltipKey: 'sheetMetal.thicknessHint', unit: 'mm', range: positive },
  sheetRadius: { labelKey: 'sheetMetal.radius', tooltipKey: 'sheetMetal.radiusHint', unit: 'mm', range: positive },
  sheetKFactor: { labelKey: 'sheetMetal.kFactor', tooltipKey: 'sheetMetal.kFactorHint', unit: 'ratio', range: { min: 0, minInclusive: true, max: 0.5, maxInclusive: true } },
  sheetLength: { labelKey: 'sheetMetal.length', tooltipKey: 'sheetMetal.lengthHint', unit: 'mm', range: positive },
  sheetAngle: { labelKey: 'sheetMetal.angle', tooltipKey: 'sheetMetal.angleHint', unit: 'degree', range: { min: -180, minInclusive: false, max: 180, maxInclusive: false } },
  sheetStartOffset: { labelKey: 'sheetMetal.startOffset', tooltipKey: 'sheetMetal.startOffsetHint', unit: 'mm', range: nonnegative },
  sheetEndOffset: { labelKey: 'sheetMetal.endOffset', tooltipKey: 'sheetMetal.endOffsetHint', unit: 'mm', range: nonnegative },
};

export function sheetFieldValues(feature: SheetMetalFeature): readonly (readonly [SheetFieldKey, ExpressionValue])[] {
  if (feature.kind === 'sheetConvert') return [['sheetRadius', feature.rule.innerRadius], ['sheetKFactor', feature.rule.kFactor]];
  if (feature.kind === 'sheetRelief') return [['sheetReliefPosition', feature.position], ['sheetReliefWidth', feature.width], ['sheetReliefDepth', feature.depth]];
  if (feature.kind === 'sheetBase') return [['sheetThickness', feature.rule.thickness], ['sheetRadius', feature.rule.innerRadius], ['sheetKFactor', feature.rule.kFactor]];
  if (feature.kind === 'sheetBend') return [['sheetAngle', feature.angle],
    ...(feature.rule.innerRadius === null ? [] : [['sheetRadius', feature.rule.innerRadius] as const]),
    ...(feature.rule.kFactor === null ? [] : [['sheetKFactor', feature.rule.kFactor] as const])];
  return [
    ...(feature.profile === null ? [['sheetLength', feature.length] as const] : []),
    ['sheetAngle', feature.angle], ['sheetStartOffset', feature.startOffset], ['sheetEndOffset', feature.endOffset],
    ...(feature.rule.innerRadius === null ? [] : [['sheetRadius', feature.rule.innerRadius] as const]),
    ...(feature.rule.kFactor === null ? [] : [['sheetKFactor', feature.rule.kFactor] as const]),
  ];
}

export function setSheetField(feature: SheetBaseFeature | SheetFlangeFeature | SheetBendFeature | SheetReliefFeature, key: string, value: ExpressionValue): SheetBaseFeature | SheetFlangeFeature | SheetBendFeature | SheetReliefFeature;
export function setSheetField(feature: SheetMetalFeature, key: string, value: ExpressionValue): SheetMetalFeature;
export function setSheetField(feature: SheetMetalFeature, key: string, value: ExpressionValue): SheetMetalFeature {
  // 立体を板金へ変える行(M-08)は内半径と K 係数だけ。板厚は形から読む。
  if (feature.kind === 'sheetConvert') {
    return key === 'sheetRadius' ? { ...feature, rule: { ...feature.rule, innerRadius: value } }
      : key === 'sheetKFactor' ? { ...feature, rule: { ...feature.rule, kFactor: value } } : feature;
  }
  if (feature.kind === 'sheetRelief') {
    switch (key) {
      case 'sheetReliefPosition': return { ...feature, position: value };
      case 'sheetReliefWidth': return { ...feature, width: value };
      case 'sheetReliefDepth': return { ...feature, depth: value };
      default: return feature;
    }
  }
  if (feature.kind === 'sheetBase') {
    switch (key) {
      case 'sheetThickness': return { ...feature, rule: { ...feature.rule, thickness: value } };
      case 'sheetRadius': return { ...feature, rule: { ...feature.rule, innerRadius: value } };
      case 'sheetKFactor': return { ...feature, rule: { ...feature.rule, kFactor: value } };
      default: return feature;
    }
  }
  if (key === 'sheetRadius') return { ...feature, rule: { ...feature.rule, innerRadius: value } };
  if (key === 'sheetKFactor') return { ...feature, rule: { ...feature.rule, kFactor: value } };
  if (feature.kind === 'sheetBend') return key === 'sheetAngle' ? { ...feature, angle: value } : feature;
  switch (key) {
    case 'sheetLength': return feature.profile === null ? { ...feature, length: value } : feature;
    case 'sheetAngle': return { ...feature, angle: value };
    case 'sheetStartOffset': return { ...feature, startOffset: value };
    case 'sheetEndOffset': return { ...feature, endOffset: value };
    default: return feature;
  }
}
