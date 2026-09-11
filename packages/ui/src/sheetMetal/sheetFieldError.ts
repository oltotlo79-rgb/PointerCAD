import { containsLengthUnit, type ExpressionError } from '@pointercad/expression';
import { t } from '../i18n/t.js';
import { SHEET_FIELD_DEFINITIONS, type SheetFieldKey } from './sheetFields.js';

export function sheetFieldUnitError(key: string, source: string): ExpressionError | null {
  const isSheetField = (value: string): value is SheetFieldKey => Object.hasOwn(SHEET_FIELD_DEFINITIONS, value);
  if (!isSheetField(key) || SHEET_FIELD_DEFINITIONS[key].unit === 'mm' || !containsLengthUnit(source)) return null;
  return { code: 'outOfRange', position: -1, message: t('sheetMetal.unitError') };
}
