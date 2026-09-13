/** Reconstruct a function DTO through the same expression readers used for normal CAD fields. */
import type { ExpressionValue, StoredMathExpression } from '@pointercad/expression';
import type { MathNode, MathParameter } from '@pointercad/expression/math/contracts';
import { FUNCTION_PLOT_AXES, FunctionPlotBounds, type FunctionPlotAxis } from './functionPlotBounds.js';
import { FUNCTION_DEFINITION_FORMAT, type FunctionDefinition, type FunctionFormula, type FunctionInputRange } from './functionDefinitionTypes.js';

export interface FunctionExpressionScope {
  readonly axes: readonly FunctionPlotAxis[];
  readonly parameters: readonly MathParameter[];
}
export interface FunctionDefinitionReader {
  /** Decode source/units/structure. A saved numeric cache is not authority for later recomputation. */
  readonly scalar: (input: unknown, field: string) => ExpressionValue;
  /** The Worker reader also reparses visible source and proves AST equivalence in this closed scope. */
  readonly math: (input: unknown, field: string, scope: FunctionExpressionScope) => StoredMathExpression;
}
export class FunctionDefinitionProblem extends Error {
  constructor(readonly field: string, message: string) { super(message); this.name = 'FunctionDefinitionProblem'; }
}
function isRecord(input: unknown): input is Record<string, unknown> {
  return input !== null && typeof input === 'object' && !Array.isArray(input);
}
function record(input: unknown, field: string): Record<string, unknown> {
  if (!isRecord(input)) {
    throw new FunctionDefinitionProblem(field, '関数の定義に必要な項目を入力してください。');
  }
  return input;
}
function exactKeys(value: Record<string, unknown>, expected: readonly string[], field: string): void {
  if (Object.keys(value).length !== expected.length || expected.some(key => !Object.hasOwn(value, key))) {
    throw new FunctionDefinitionProblem(field, '関数の定義に必要な項目が不足しているか、未対応の項目があります。');
  }
}
function axis(input: unknown, field: string): FunctionPlotAxis {
  if (input === 'X' || input === 'Y' || input === 'Z') return input;
  throw new FunctionDefinitionProblem(field, '座標軸X・Y・Zから選んでください。');
}
function assertScope(node: MathNode, scope: FunctionExpressionScope, field: string): void {
  const pending = [node]; let remaining = 4096;
  while (pending.length > 0) {
    const current = pending.pop(); if (current === undefined) break;
    if (--remaining < 0) throw new FunctionDefinitionProblem(field, '関数の式が複雑すぎます。');
    if (current.kind === 'symbol') {
      const ref = current.reference;
      if ((ref.role === 'axis' && !scope.axes.includes(ref.name))
        || (ref.role === 'parameter' && !scope.parameters.includes(ref.name))) {
        throw new FunctionDefinitionProblem(field, 'この形式の独立変数ではない軸・媒介変数が使われています。');
      }
    } else if (current.kind === 'operation') pending.push(...current.operands);
    else if (current.kind === 'binder') {
      pending.push(current.body);
      for (const binding of current.bindings) {
        if (binding.domain.kind === 'set') pending.push(binding.domain.value);
        else if (binding.domain.kind === 'range') {
          pending.push(binding.domain.lower, binding.domain.upper);
          if (binding.domain.step !== null) pending.push(binding.domain.step);
        }
      }
    }
  }
}

/** Structural validation is separate from resolving expressions against the current coefficient generation. */
export function readFunctionDefinition(input: unknown, reader: FunctionDefinitionReader): FunctionDefinition {
  const value = record(input, 'definition'); exactKeys(value, ['format', 'bounds', 'formula', 'tolerance'], 'definition');
  if (value.format !== FUNCTION_DEFINITION_FORMAT) throw new FunctionDefinitionProblem('format', '関数定義の版に対応していません。');
  const readScalar = (input: unknown, field: string): ExpressionValue => {
    const scalar = reader.scalar(input, field);
    if (!Number.isFinite(scalar.value)) throw new FunctionDefinitionProblem(field, '有限な実数を入力してください。');
    if (scalar.mathDefinition !== undefined) assertScope(scalar.mathDefinition.expression, { axes: [], parameters: [] }, field);
    return scalar;
  };
  const range = (input: unknown, field: string): FunctionInputRange => {
    const limits = record(input, field); exactKeys(limits, ['min', 'max'], field);
    const min = readScalar(limits.min, `${field}.min`), max = readScalar(limits.max, `${field}.max`);
    if (!(min.value < max.value) || !Number.isFinite(max.value - min.value)) {
      throw new FunctionDefinitionProblem(field, '範囲は有限の最小値 < 最大値にしてください。');
    }
    return { min, max };
  };
  const rawBounds = record(value.bounds, 'bounds'); exactKeys(rawBounds, FUNCTION_PLOT_AXES, 'bounds');
  const bounds = { X: range(rawBounds.X, 'bounds.X'), Y: range(rawBounds.Y, 'bounds.Y'), Z: range(rawBounds.Z, 'bounds.Z') };
  // Use the same all-axis contract at file, editor, and later recomputation boundaries.
  const checked = FunctionPlotBounds.read(Object.fromEntries(FUNCTION_PLOT_AXES.map(axis =>
    [axis, { min: bounds[axis].min.value, max: bounds[axis].max.value }])));
  if (!checked.ok) throw new FunctionDefinitionProblem('bounds', 'XYZの描画範囲を確認してください。');
  const tolerance = readScalar(value.tolerance, 'tolerance');
  if (!(tolerance.value > 0)) throw new FunctionDefinitionProblem('tolerance', '精度は0より大きい長さで指定してください。');
  const readMath = (input: unknown, field: string, axes: readonly FunctionPlotAxis[], parameters: readonly MathParameter[] = []) => {
    const scope = { axes, parameters }, math = reader.math(input, field, scope);
    assertScope(math.expression, scope, field);
    return math;
  };
  const raw = record(value.formula, 'formula');
  const output = (names: readonly FunctionPlotAxis[], axes: readonly FunctionPlotAxis[], parameters: readonly MathParameter[] = []) => {
    const values = record(raw.outputs, 'formula.outputs'); exactKeys(values, names, 'formula.outputs');
    return (name: FunctionPlotAxis) => readMath(values[name], `formula.outputs.${name}`, axes, parameters);
  };
  let formula: FunctionFormula;
  switch (raw.kind) {
    case 'coordinate-curve': {
      exactKeys(raw, ['kind', 'independent', 'outputs'], 'formula');
      const independent = axis(raw.independent, 'formula.independent');
      const read = output(FUNCTION_PLOT_AXES.filter(name => name !== independent), [independent]);
      formula = independent === 'X' ? { kind: raw.kind, independent, outputs: { Y: read('Y'), Z: read('Z') } }
        : independent === 'Y' ? { kind: raw.kind, independent, outputs: { X: read('X'), Z: read('Z') } }
          : { kind: raw.kind, independent, outputs: { X: read('X'), Y: read('Y') } };
      break;
    }
    case 'parametric-curve': {
      exactKeys(raw, ['kind', 'outputs', 'T'], 'formula'); const read = output(FUNCTION_PLOT_AXES, [], ['T']);
      formula = { kind: raw.kind, T: range(raw.T, 'formula.T'), outputs: { X: read('X'), Y: read('Y'), Z: read('Z') } }; break;
    }
    case 'implicit-curve': {
      exactKeys(raw, ['kind', 'expression', 'fixedAxis', 'fixedCoordinate'], 'formula');
      const fixedAxis = axis(raw.fixedAxis, 'formula.fixedAxis');
      formula = { kind: raw.kind, fixedAxis, fixedCoordinate: readScalar(raw.fixedCoordinate, 'formula.fixedCoordinate'),
        expression: readMath(raw.expression, 'formula.expression', FUNCTION_PLOT_AXES.filter(name => name !== fixedAxis)) }; break;
    }
    case 'coordinate-surface': {
      exactKeys(raw, ['kind', 'output', 'expression'], 'formula'); const output = axis(raw.output, 'formula.output');
      formula = { kind: raw.kind, output, expression: readMath(raw.expression, 'formula.expression', FUNCTION_PLOT_AXES.filter(name => name !== output)) }; break;
    }
    case 'parametric-surface': {
      exactKeys(raw, ['kind', 'outputs', 'U', 'V'], 'formula'); const read = output(FUNCTION_PLOT_AXES, [], ['U', 'V']);
      formula = { kind: raw.kind, U: range(raw.U, 'formula.U'), V: range(raw.V, 'formula.V'),
        outputs: { X: read('X'), Y: read('Y'), Z: read('Z') } }; break;
    }
    case 'implicit-surface':
      exactKeys(raw, ['kind', 'expression'], 'formula');
      formula = { kind: raw.kind, expression: readMath(raw.expression, 'formula.expression', FUNCTION_PLOT_AXES) }; break;
    default: throw new FunctionDefinitionProblem('formula.kind', '関数の形式に対応していません。');
  }
  return { format: FUNCTION_DEFINITION_FORMAT, bounds, formula, tolerance };
}
