/** Resolve every range against current coefficients before preview, CAD generation, or point search. */
import type { ExpressionValue } from '@pointercad/expression';
import type { MathParameter } from '@pointercad/expression/math/contracts';
import { FUNCTION_PLOT_AXES, FunctionPlotBounds, type FunctionPlotInterval } from './functionPlotBounds.js';
import type { FunctionDefinition, FunctionInputRange } from './functionDefinitionTypes.js';

export interface FunctionRangeContext {
  readonly isCurrent: () => boolean;
  /** The shared scalar evaluator must re-evaluate the source, never return its persisted cache. */
  readonly evaluate: (value: ExpressionValue, field: string) => Promise<
    { readonly ok: true; readonly value: number } | { readonly ok: false; readonly message: string }>;
}
export interface FunctionRangeIssue { readonly field: string; readonly message: string }
export interface ResolvedFunctionRanges {
  readonly bounds: FunctionPlotBounds;
  readonly tolerance: number;
  readonly parameters: readonly { readonly parameter: MathParameter; readonly range: FunctionPlotInterval }[];
  readonly fixedCoordinate: number | null;
}
export type FunctionRangeResult =
  | { readonly status: 'ready'; readonly ranges: ResolvedFunctionRanges }
  | { readonly status: 'invalid'; readonly issues: readonly FunctionRangeIssue[] }
  | { readonly status: 'cancelled' };

function parameterRanges(definition: FunctionDefinition): readonly { readonly parameter: MathParameter; readonly input: FunctionInputRange }[] {
  const formula = definition.formula;
  return formula.kind === 'parametric-curve' ? [{ parameter: 'T', input: formula.T }]
    : formula.kind === 'parametric-surface' ? [{ parameter: 'U', input: formula.U }, { parameter: 'V', input: formula.V }] : [];
}

export async function resolveFunctionRanges(definition: FunctionDefinition, context: FunctionRangeContext): Promise<FunctionRangeResult> {
  if (!context.isCurrent()) return { status: 'cancelled' };
  const fields: { readonly field: string; readonly value: ExpressionValue }[] = [];
  const addRange = (name: string, range: FunctionInputRange) => {
    fields.push({ field: `${name}.min`, value: range.min }, { field: `${name}.max`, value: range.max });
  };
  for (const axis of FUNCTION_PLOT_AXES) addRange(`bounds.${axis}`, definition.bounds[axis]);
  const parameters = parameterRanges(definition);
  for (const { parameter, input } of parameters) addRange(`formula.${parameter}`, input);
  fields.push({ field: 'tolerance', value: definition.tolerance });
  if (definition.formula.kind === 'implicit-curve') fields.push({ field: 'formula.fixedCoordinate', value: definition.formula.fixedCoordinate });
  // At most eleven scalar requests. The owning Worker client still controls its bounded queue and cancellation.
  const results = await Promise.all(fields.map(async ({ field, value }) => ({ field, result: await context.evaluate(value, field) })));
  if (!context.isCurrent()) return { status: 'cancelled' };
  const values = new Map<string, number>(), issues: FunctionRangeIssue[] = [];
  for (const { field, result } of results) {
    if (!result.ok) issues.push({ field, message: result.message });
    else if (!Number.isFinite(result.value)) issues.push({ field, message: '有限な実数を入力してください。' });
    else values.set(field, result.value);
  }
  if (issues.length > 0) return { status: 'invalid', issues };
  const number = (field: string): number => {
    const value = values.get(field);
    if (value === undefined) throw new Error(`Missing evaluated function field: ${field}`);
    return value;
  };
  const evaluatedRange = (prefix: string): FunctionPlotInterval => ({ min: number(`${prefix}.min`), max: number(`${prefix}.max`) });
  const bounds = FunctionPlotBounds.read({ X: evaluatedRange('bounds.X'), Y: evaluatedRange('bounds.Y'), Z: evaluatedRange('bounds.Z') });
  if (!bounds.ok) for (const issue of bounds.issues) issues.push({ field: `bounds.${issue.axis}.${issue.field}`,
    message: '描画範囲は各軸とも有限の最小値 < 最大値にしてください。' });
  const resolvedParameters = parameters.map(({ parameter }) => ({ parameter, range: evaluatedRange(`formula.${parameter}`) }));
  for (const { parameter, range } of resolvedParameters) {
    if (!(range.min < range.max) || !Number.isFinite(range.max - range.min)) issues.push({ field: `formula.${parameter}`,
      message: '媒介変数の範囲は有限の最小値 < 最大値にしてください。' });
  }
  const tolerance = number('tolerance');
  if (!(tolerance > 0)) issues.push({ field: 'tolerance', message: '精度は0より大きい長さで指定してください。' });
  if (!bounds.ok || issues.length > 0) return { status: 'invalid', issues };
  return { status: 'ready', ranges: Object.freeze({ bounds: bounds.bounds, tolerance,
    parameters: Object.freeze(resolvedParameters.map(item => Object.freeze({ parameter: item.parameter, range: Object.freeze(item.range) }))),
    fixedCoordinate: definition.formula.kind === 'implicit-curve' ? number('formula.fixedCoordinate') : null }) };
}
