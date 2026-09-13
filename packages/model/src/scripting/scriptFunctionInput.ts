/** Untrusted script function sources remain strings until the ordinary math Worker accepts them. */
import { SCRIPT_LIMITS } from './scriptTypes.js';
export type ScriptFunctionAxis = 'X' | 'Y' | 'Z';
export type ScriptFunctionRange = readonly [string, string];
type Outputs = Readonly<Record<ScriptFunctionAxis, string>>;
export type ScriptCurveFormula =
  | { readonly kind: 'coordinate-curve'; readonly independent: ScriptFunctionAxis; readonly outputs: Readonly<Partial<Outputs>> }
  | { readonly kind: 'parametric-curve'; readonly T: ScriptFunctionRange; readonly outputs: Outputs }
  | { readonly kind: 'implicit-curve'; readonly fixedAxis: ScriptFunctionAxis; readonly fixedCoordinate: string; readonly expression: string };
export type ScriptSurfaceFormula =
  | { readonly kind: 'coordinate-surface'; readonly output: ScriptFunctionAxis; readonly expression: string }
  | { readonly kind: 'parametric-surface'; readonly U: ScriptFunctionRange; readonly V: ScriptFunctionRange; readonly outputs: Outputs }
  | { readonly kind: 'implicit-surface'; readonly expression: string };
export interface ScriptFunctionDefinition {
  readonly angleUnit: 'degree' | 'radian';
  readonly bounds: Readonly<Record<ScriptFunctionAxis, ScriptFunctionRange>>;
  readonly tolerance: string;
  readonly formula: ScriptCurveFormula | ScriptSurfaceFormula;
}
const axes = ['X', 'Y', 'Z'] as const;
export class ScriptFunctionInputError extends Error {}

function fail(): never {
  throw new ScriptFunctionInputError('関数の形式、式、角度単位とXYZ全範囲を指定してください。');
}

function row(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return fail();
  const keys = Object.keys(value);
  if (required.some(key => !Object.hasOwn(value, key))
    || keys.some(key => !required.includes(key) && !optional.includes(key))) return fail();
  return value as Record<string, unknown>;
}

function source(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > SCRIPT_LIMITS.expressionCharacters) return fail();
  return value;
}

function axis(value: unknown): ScriptFunctionAxis {
  if (value === 'X' || value === 'Y' || value === 'Z') return value;
  return fail();
}

function range(value: unknown): ScriptFunctionRange {
  if (!Array.isArray(value) || value.length !== 2) return fail();
  return [source(value[0]), source(value[1])];
}

function outputs(value: unknown): Outputs {
  const fields = row(value, axes);
  return { X: source(fields.X), Y: source(fields.Y), Z: source(fields.Z) };
}

export function readScriptFunctionDefinition(value: unknown, geometry: 'curve' | 'surface'): ScriptFunctionDefinition {
  const input = row(value, ['bounds', 'tolerance', 'formula'], ['angleUnit']);
  const bounds = row(input.bounds, axes);
  const unit = input.angleUnit === undefined ? 'degree' : input.angleUnit;
  if (unit !== 'degree' && unit !== 'radian') return fail();
  const data = input.formula;
  if (data === null || typeof data !== 'object' || Array.isArray(data) || !('kind' in data)) return fail();
  let formula: ScriptFunctionDefinition['formula'];
  switch (data.kind) {
    case 'coordinate-curve': {
      if (geometry !== 'curve') return fail();
      const fields = row(data, ['kind', 'independent', 'outputs']);
      const independent = axis(fields.independent);
      const dependent = axes.filter(item => item !== independent);
      const values = row(fields.outputs, dependent);
      formula = { kind: data.kind, independent, outputs: Object.fromEntries(dependent.map(item => [item, source(values[item])])) };
      break;
    }
    case 'parametric-curve': {
      if (geometry !== 'curve') return fail();
      const fields = row(data, ['kind', 'T', 'outputs']);
      formula = { kind: data.kind, T: range(fields.T), outputs: outputs(fields.outputs) };
      break;
    }
    case 'implicit-curve': {
      if (geometry !== 'curve') return fail();
      const fields = row(data, ['kind', 'fixedAxis', 'fixedCoordinate', 'expression']);
      formula = {
        kind: data.kind, fixedAxis: axis(fields.fixedAxis),
        fixedCoordinate: source(fields.fixedCoordinate), expression: source(fields.expression),
      };
      break;
    }
    case 'coordinate-surface': {
      if (geometry !== 'surface') return fail();
      const fields = row(data, ['kind', 'output', 'expression']);
      formula = { kind: data.kind, output: axis(fields.output), expression: source(fields.expression) };
      break;
    }
    case 'parametric-surface': {
      if (geometry !== 'surface') return fail();
      const fields = row(data, ['kind', 'U', 'V', 'outputs']);
      formula = { kind: data.kind, U: range(fields.U), V: range(fields.V), outputs: outputs(fields.outputs) };
      break;
    }
    case 'implicit-surface': {
      if (geometry !== 'surface') return fail();
      const fields = row(data, ['kind', 'expression']);
      formula = { kind: data.kind, expression: source(fields.expression) };
      break;
    }
    default: return fail();
  }
  return {
    angleUnit: unit, bounds: { X: range(bounds.X), Y: range(bounds.Y), Z: range(bounds.Z) },
    tolerance: source(input.tolerance), formula,
  };
}
