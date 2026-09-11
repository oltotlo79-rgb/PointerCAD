/** FR-1112: bounded expression input and explicit physical units. */
import {
  collectVariableNames, containsLengthUnit, evaluateExpressionExact,
  type ExactExpressionValue,
} from '@pointercad/expression';
import { analyzeParameters } from '../parameters/parameterTable.js';
import type { Parameter } from '../parameters/types.js';
import { normalizeInchQuotes, parseDisplayInput, type LengthUnit } from '../units/length.js';

export type StrengthQuantityKind = 'length' | 'force' | 'stress' | 'torque' | 'scalar';
export interface StrengthInputField {
  readonly name: string;
  readonly source: string;
  readonly quantity: StrengthQuantityKind;
  readonly allowZero?: boolean;
}
export interface StrengthInputValue {
  readonly name: string;
  readonly source: string;
  readonly quantity: StrengthQuantityKind;
  readonly canonical: ExactExpressionValue;
}
export type StrengthInputOutcome =
  | { readonly ok: true; readonly values: ReadonlyMap<string, StrengthInputValue> }
  | { readonly ok: false; readonly field: string; readonly message: string };

// A suffix applies to the complete entered expression. All conversions are exact decimal factors.
// Model parameters only distinguish length/angle/scalar; force, stress and torque use scalar parameters.
const unitSuffixes: Record<Exclude<StrengthQuantityKind, 'length' | 'scalar'>, readonly (readonly [string, string])[]> = {
  force: [['kN', '1000'], ['N', '1']],
  stress: [['GPa', '1000'], ['MPa', '1'], ['kPa', '0.001'], ['Pa', '0.000001']],
  torque: [['kN·m', '1000000'], ['kN*m', '1000000'], ['kNm', '1000000'],
    ['N·mm', '1'], ['N*mm', '1'], ['Nmm', '1'], ['N·m', '1000'], ['N*m', '1000'], ['Nm', '1000']],
};

function canonicalSource(field: StrengthInputField, lengthUnit: LengthUnit): string {
  const source = normalizeInchQuotes(field.source).trim();
  if (field.quantity === 'length') return parseDisplayInput(source, lengthUnit);
  if (field.quantity === 'scalar') return source;
  for (const [suffix, factor] of unitSuffixes[field.quantity]) {
    if (source.endsWith(suffix)) {
      const prefix = source.slice(0, -suffix.length);
      // A unit suffix follows a number, a closing parenthesis or separating whitespace.
      // Unknown identifier "荷重N" remains an unknown variable instead of silently becoming "荷重".
      if (!/[0-9.)\s]$/u.test(prefix)) continue;
      const value = prefix.trim();
      return factor === '1' ? value : `(${value})*${factor}`;
    }
  }
  return source;
}

export function readStrengthInputs(fields: readonly StrengthInputField[], parameters: readonly Parameter[], lengthUnit: LengthUnit): StrengthInputOutcome {
  const names = new Set<string>();
  // Validate every field before sending even the first source to the expression parser.
  for (const field of fields) {
    if (names.has(field.name)) return { ok: false, field: field.name, message: '同じ入力欄が重複しています。' };
    if (field.source.length > 4096) return { ok: false, field: field.name, message: '式は4096文字以内で入力してください。' };
    if (field.source.trim() === '') return { ok: false, field: field.name, message: '式を入力してください。' };
    names.add(field.name);
  }
  const analysis = analyzeParameters(parameters, []);
  const parameterKinds = new Map(parameters.map(parameter => [parameter.name, parameter.unit]));
  const values = new Map<string, StrengthInputValue>();
  for (const field of fields) {
    const source = canonicalSource(field, lengthUnit);
    if (field.quantity !== 'length' && containsLengthUnit(source)) {
      return { ok: false, field: field.name, message: 'この欄には長さの単位を使えません。欄に表示された単位で入力してください。' };
    }
    const variables = collectVariableNames(source);
    for (const name of variables) {
      const unit = parameterKinds.get(name);
      if (unit === 'degree' || (field.quantity !== 'length' && unit === 'mm')) {
        return { ok: false, field: field.name, message: `「${name}」の量の種類がこの入力欄と一致しません。` };
      }
      if (analysis.circular.includes(name) || analysis.failures.some(failure => failure.name === name)) {
        return { ok: false, field: field.name, message: `参照するパラメータ「${name}」の式を直してください。` };
      }
    }
    const result = evaluateExpressionExact(source, { exactVariables: analysis.exactVariables, nonLengthVariables: analysis.nonLengthVariables });
    if (!result.ok) return { ok: false, field: field.name, message: result.error.message };
    if (!Number.isFinite(result.value.value) || (field.allowZero ? result.value.value < 0 : result.value.value <= 0)) {
      return { ok: false, field: field.name, message: field.allowZero ? '0以上の有限の値を入力してください。' : '0より大きい有限の値を入力してください。' };
    }
    values.set(field.name, { name: field.name, source: field.source, quantity: field.quantity, canonical: result.value });
  }
  return { ok: true, values };
}
