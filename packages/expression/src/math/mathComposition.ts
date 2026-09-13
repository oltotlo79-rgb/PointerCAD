/** Structural algebra for generated CAD expressions; the calculation Worker verifies the new definition before geometry. */
import type { ExpressionValue } from '../evaluateExpression.js';
import { DISPLAY_SIGNIFICANT_DIGITS } from '../evaluateExpression.js';
import { ExpressionDecimal } from '../evaluate.js';
import { parse } from '../parse.js';
import { legacyMathToDefinition } from './legacyMathBridge.js';
import { collectMathCoefficients } from './mathExpressionReferences.js';
import { MathInputProblem, type MathNode, type StoredMathExpression } from './mathInputContract.js';
import { mathInRadians } from './mathAngleConvention.js';
import { formatMathText } from './formatMathText.js';
import { parseMathText } from './mathTextSyntax.js';
import { convertMathNotation } from './mathNotationConversion.js';
import { CANDIDATE_MATH_BY_ID, CANDIDATE_MATH_OPERATIONS } from './mathOperations.js';
import type { MathNameContext } from './mathSymbolScope.js';

export interface MathCompositionCoefficient { readonly id: string; readonly label: string; readonly kind: 'length' | 'angle' | 'scalar' }
const environments = new WeakMap<ExpressionValue, readonly MathCompositionCoefficient[]>();
/** Metadata is transient and never makes a cached value eligible for numeric adoption. */
export function bindMathCompositionNames(value: ExpressionValue, coefficients: readonly MathCompositionCoefficient[]): void {
  environments.set(value, coefficients.map(coefficient => Object.freeze({ ...coefficient })));
}
/** Structural scalar input for generated function formulas. No numeric cache is consulted. */
export function scalarMathInRadians(value: ExpressionValue): MathNode {
  const definition = value.mathDefinition;
  if (definition !== undefined) {
    if (definition.source !== value.source) throw new MathInputProblem('syntax', '合成元の原式が数学定義と一致しません。');
    return mathInRadians(definition.expression, definition.angleUnit);
  }
  const coefficients = new Map((environments.get(value) ?? []).map(coefficient => [coefficient.label, coefficient]));
  return legacyMathToDefinition(parse(value.source), { resolveVariable: name => {
    const coefficient = coefficients.get(name);
    return coefficient === undefined ? null : { reference: { role: 'coefficient', id: coefficient.id, label: coefficient.label }, kind: coefficient.kind };
  } }).expression;
}
export function composeMathValues(a: ExpressionValue, b: ExpressionValue, operator: '+' | '-' | '*' | '/') : ExpressionValue | null {
  if (a.mathDefinition === undefined && b.mathDefinition === undefined) return null;
  const coefficients = new Map<string, MathCompositionCoefficient>();
  const knownUnits = new Set<string>();
  for (const value of [a, b]) {
    for (const coefficient of environments.get(value) ?? []) knownUnits.add(coefficient.label);
    const names = environments.get(value) ?? (value.mathDefinition === undefined ? [] :
      collectMathCoefficients(value.mathDefinition.expression).map(reference => ({ id: reference.id, label: reference.label, kind: 'length' as const })));
    for (const coefficient of names) {
      const previous = coefficients.get(coefficient.label);
      if (previous !== undefined && previous.id !== coefficient.id) throw new MathInputProblem('syntax', '合成する式の係数参照が一致しません。');
      coefficients.set(coefficient.label, coefficient);
    }
  }
  const unit = a.mathDefinition?.angleUnit === b.mathDefinition?.angleUnit
    ? a.mathDefinition?.angleUnit ?? 'degree'
    : a.mathDefinition === undefined ? b.mathDefinition?.angleUnit ?? 'degree'
      : b.mathDefinition === undefined ? a.mathDefinition.angleUnit : 'radian';
  const expressionOf = (value: ExpressionValue): MathNode => {
    const definition = value.mathDefinition;
    if (definition !== undefined) {
      if (definition.source !== value.source) throw new MathInputProblem('syntax', '合成元の原式が数学定義と一致しません。');
      return unit === definition.angleUnit ? definition.expression : mathInRadians(definition.expression, definition.angleUnit);
    }
    return legacyMathToDefinition(parse(value.source), { resolveVariable: name => {
      const coefficient = coefficients.get(name);
      return coefficient === undefined || !knownUnits.has(name) ? null
        : { reference: { role: 'coefficient', id: coefficient.id, label: coefficient.label }, kind: coefficient.kind };
    } }).expression;
  };
  const leftExpression = expressionOf(a), rightExpression = expressionOf(b);
  // A coordinate offset and its inverse must not accumulate two sign wrappers on each edit.
  // Only literal -1 is cancelled; a coefficient whose cached value happens to be -1 is retained.
  const literalMinusOne = (node: MathNode): boolean => node.kind === 'number'
    ? new ExpressionDecimal(node.decimal).equals(-1)
    : node.kind === 'operation' && node.operation === 'negate' && node.operands.length === 1
      && node.operands[0].kind === 'number' && new ExpressionDecimal(node.operands[0].decimal).equals(1);
  const expression: MathNode = operator === '*' && literalMinusOne(rightExpression)
    && leftExpression.kind === 'operation' && leftExpression.operation === 'multiply' && leftExpression.operands.length === 2
    && literalMinusOne(leftExpression.operands[1]) ? leftExpression.operands[0]
    : { kind: 'operation', operation: { '+': 'add', '-': 'subtract', '*': 'multiply', '/': 'divide' }[operator],
      operands: [leftExpression, rightExpression] };
  const table = [...coefficients.values()];
  const names: MathNameContext = { axes: new Set(), parameters: new Set(), declared: [],
    coefficients: table.map(coefficient => ({ role: 'coefficient' as const, id: coefficient.id, label: coefficient.label })) };
  const converted = convertMathNotation(expression, node => formatMathText(node, CANDIDATE_MATH_BY_ID), source => parseMathText(source,
    { operations: CANDIDATE_MATH_OPERATIONS, names, scalarCoefficientIds: new Set(table.map(coefficient => coefficient.id)) }));
  const definition: StoredMathExpression = { format: 'pointercad-math/1', source: converted.source, inputNotation: 'text',
    angleUnit: unit, expression: converted.expression };
  const left = new ExpressionDecimal(a.value), right = new ExpressionDecimal(b.value);
  const number = operator === '+' ? left.add(right) : operator === '-' ? left.sub(right) : operator === '*' ? left.mul(right) : left.div(right);
  if (!number.isFinite() || !Number.isFinite(number.toNumber())) throw new MathInputProblem('domain', '合成した数式が有限の数値になりません。');
  const value: ExpressionValue = { source: definition.source, value: number.toNumber(),
    display: number.toSignificantDigits(DISPLAY_SIGNIFICANT_DIGITS).toString(), mathDefinition: definition };
  bindMathCompositionNames(value, table);
  return value;
}
