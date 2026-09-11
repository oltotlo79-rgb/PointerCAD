/** 作成と寸法換算で共用する式評価。文書・形状は変更しない。 */
import type { EvaluateOptions } from '@pointercad/expression';
import { evaluateSheetField, type LengthUnit, type SheetMetalFeature } from '@pointercad/model';
import { SHEET_FIELD_DEFINITIONS, setSheetField, sheetFieldValues, type SheetFieldKey } from './sheetFields.js';

export function evaluateSheetDraft(feature: SheetMetalFeature, sources: Readonly<Partial<Record<SheetFieldKey, string>>>,
  lengthUnit: LengthUnit, options: EvaluateOptions): { readonly ok: true; readonly feature: SheetMetalFeature }
  | { readonly ok: false; readonly message: string; readonly field?: SheetFieldKey } {
  let next = feature;
  for (const [key] of sheetFieldValues(feature)) {
    const source = sources[key]; if (source === undefined) continue;
    const definition = SHEET_FIELD_DEFINITIONS[key];
    const dimension = definition.unit === 'mm' ? 'length' : definition.unit === 'degree' ? 'angle' : 'ratio';
    const evaluated = evaluateSheetField(source, dimension, lengthUnit, options);
    if (!evaluated.ok) return { ...evaluated, field: key };
    const value = evaluated.value.value, range = definition.range;
    if (!Number.isFinite(value) || (range.minInclusive ? value < range.min : value <= range.min)
      || (range.max !== null && (range.maxInclusive ? value > range.max : value >= range.max)))
      return { ok: false, message: '板金の値が入力できる範囲にありません。欄の説明と値を確認してください。', field: key };
    next = setSheetField(next, key, evaluated.value);
  }
  return { ok: true, feature: next };
}
