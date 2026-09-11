/** FR-1112: exact formulas without model mutation or geometry recomputation. */
import { evaluateExpressionExact, type ExactExpressionValue } from '@pointercad/expression';
import type { Parameter } from '../parameters/types.js';
import type { LengthUnit } from '../units/length.js';
import { calculateExactStrength, type StrengthCalculation } from './strengthExact.js';
import { readStrengthInputs, type StrengthInputField, type StrengthInputValue } from './strengthInputs.js';

export interface StrengthCalculationInput {
  readonly calculation: StrengthCalculation;
  readonly sources: ReadonlyMap<string, string>;
  readonly parameters: readonly Parameter[];
  readonly lengthUnit: LengthUnit;
}
export interface StrengthCalculationValue {
  readonly calculation: StrengthCalculation;
  readonly inputs: ReadonlyMap<string, StrengthInputValue>;
  readonly results: ReadonlyMap<string, ExactExpressionValue>;
  readonly criterion: 'normal-stress' | 'von-mises';
  readonly meetsSpecifiedFactor: boolean;
}
export type StrengthCalculationOutcome = { readonly ok: true; readonly value: StrengthCalculationValue }
  | { readonly ok: false; readonly field: string; readonly message: string };

export type StrengthFieldName = 'width' | 'height' | 'diameter' | 'thickness' | 'length' | 'force'
  | 'youngModulus' | 'yieldStress' | 'safetyFactor' | 'outerDiameter' | 'innerDiameter'
  | 'torque' | 'shearModulus' | 'tensileArea';
type FieldDefinition = readonly [name: StrengthFieldName, quantity: StrengthInputField['quantity'], allowZero?: true];
const commonFields: readonly FieldDefinition[] = [['yieldStress', 'stress'], ['safetyFactor', 'scalar']];
function requiredFields(calculation: StrengthCalculation): readonly FieldDefinition[] {
  if (calculation.kind === 'bolt') return [...commonFields, ['force', 'force'], ['tensileArea', 'scalar']];
  if (calculation.kind === 'shaft') return [...commonFields, ['outerDiameter', 'length'], ['innerDiameter', 'length', true],
    ['length', 'length'], ['torque', 'torque'], ['shearModulus', 'stress']];
  const section: readonly FieldDefinition[] = calculation.section === 'rectangle'
    ? [['width', 'length'], ['height', 'length']] : calculation.section === 'circle'
      ? [['diameter', 'length']] : [['diameter', 'length'], ['thickness', 'length']];
  return [...commonFields, ...section, ['length', 'length'], ['force', 'force'], ['youngModulus', 'stress']];
}

export function strengthCalculationFields(calculation: StrengthCalculation): readonly FieldDefinition[] {
  return requiredFields(calculation);
}

export function calculateStrength(input: StrengthCalculationInput): StrengthCalculationOutcome {
  const fields: StrengthInputField[] = [];
  for (const [name, quantity, allowZero] of requiredFields(input.calculation)) {
    const source = input.sources.get(name);
    if (source === undefined) return { ok: false, field: name, message: '必要な入力欄に式を入力してください。' };
    fields.push({ name, quantity, source, ...(allowZero === true ? { allowZero: true } : {}) });
  }
  const read = readStrengthInputs(fields, input.parameters, input.lengthUnit);
  if (!read.ok) return read;
  const canonical = new Map(Array.from(read.values, ([name, value]) => [name, value.canonical.exact]));
  let gap: { field: string; source: string; message: string } | null = null;
  if (input.calculation.kind === 'shaft') gap = { field: 'innerDiameter', source: 'outerDiameter-innerDiameter',
    message: '内径は0以上で、外径より小さくしてください。' };
  if (input.calculation.kind === 'beam' && input.calculation.section === 'tube') gap = {
    field: 'thickness', source: 'diameter-2*thickness', message: '肉厚は0より大きく、外径の半分より小さくしてください。' };
  if (gap !== null) {
    const evaluated = evaluateExpressionExact(gap.source, { exactVariables: canonical });
    if (!evaluated.ok || !Number.isFinite(evaluated.value.value) || evaluated.value.value <= 0) {
      return { ok: false, field: gap.field, message: gap.message };
    }
  }
  const result = calculateExactStrength(input.calculation, canonical);
  if (!result.ok) return result;
  // Compare unrounded exact expressions. Display rounding must never change the assessment.
  const comparedVariables = new Map(canonical);
  for (const [name, value] of result.values) comparedVariables.set(name, value.exact);
  const margin = evaluateExpressionExact('yieldStress-safetyFactor*equivalentStress', { exactVariables: comparedVariables });
  if (!margin.ok) return { ok: false, field: 'safetyFactor', message: margin.error.message };
  return { ok: true, value: { calculation: input.calculation, inputs: read.values, results: result.values,
    criterion: input.calculation.kind === 'shaft' ? 'von-mises' : 'normal-stress',
    meetsSpecifiedFactor: margin.value.value >= 0 } };
}
