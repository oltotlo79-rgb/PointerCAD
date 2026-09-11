import { readStrengthInputs, type Parameter, type StrengthFieldName, type StrengthQuantityKind } from '@pointercad/model';
import { expressionValueFromNumber } from '@pointercad/expression';
import type { MessageKey } from '../i18n/t.js';
import type { FieldUnit, NumericField, NumericFieldResult } from '../sketch/numericInput.js';
import type { StrengthSession } from './strengthSession.js';

export const STRENGTH_FIELD_LABELS: Readonly<Record<StrengthFieldName, MessageKey>> = {
  width: 'strength.field.width', height: 'strength.field.height', diameter: 'strength.field.diameter',
  thickness: 'strength.field.thickness', length: 'strength.field.length', force: 'strength.field.force',
  youngModulus: 'strength.field.youngModulus', yieldStress: 'strength.field.yieldStress', safetyFactor: 'strength.field.safetyFactor',
  outerDiameter: 'strength.field.outerDiameter', innerDiameter: 'strength.field.innerDiameter', torque: 'strength.field.torque',
  shearModulus: 'strength.field.shearModulus', tensileArea: 'strength.field.tensileArea',
};
const units: Readonly<Record<StrengthQuantityKind, FieldUnit>> = { length: 'mm', scalar: 'ratio', force: 'N', stress: 'MPa', torque: 'Nmm' };
export function strengthExpressionField(session: StrengthSession, parameters: readonly Parameter[], name: string,
  quantity: StrengthQuantityKind, labelKey: MessageKey, source: string, allowZero = false):
  { readonly field: NumericField; readonly result: NumericFieldResult } {
  const parsed = readStrengthInputs([{ name, source, quantity, allowZero }], parameters, session.lengthUnit);
  const canonical = parsed.ok ? parsed.values.get(name)?.canonical : undefined;
  return {
    field: { key: name, labelKey, tooltipKey: quantity === 'length' ? 'strength.lengthTooltip' : 'strength.expressionTooltip',
      unit: units[quantity], source, defaultSource: source, typed: true },
    result: { key: name, value: canonical === undefined ? null : { ...expressionValueFromNumber(canonical.value), source },
      error: parsed.ok ? null : { code: 'outOfRange', position: -1, message: parsed.message } },
  };
}
