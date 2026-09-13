/** The function Worker parses geometry variables in an explicit scope; it never guesses output axes. */
import type { MathExecutionBackend } from './mathWorkExecution.js';
import { decodeStoredMath } from './decodeStoredMath.js';
import { decodeMathJson } from './decodeMathJson.js';
import { parseMathText } from './mathTextSyntax.js';
import { MATH_INPUT_FORMAT, MathInputProblem, validateMathSource, type MathAxis, type MathParameter,
  type MathNode, type StoredMathExpression } from './mathInputContract.js';

export interface FunctionMathScope {
  readonly axes: readonly MathAxis[];
  readonly parameters: readonly MathParameter[];
  readonly coefficients: readonly { readonly id: string; readonly label: string }[];
}
function sourceReader(scope: FunctionMathScope, backend: MathExecutionBackend) {
  if (new Set(scope.axes).size !== scope.axes.length || new Set(scope.parameters).size !== scope.parameters.length) {
    throw new MathInputProblem('syntax', '関数の独立変数が重複しています。');
  }
  const names = { axes: new Set(scope.axes), parameters: new Set(scope.parameters), declared: [],
    // Callers may carry current numeric values too. Only identity belongs in a saved symbol reference.
    coefficients: scope.coefficients.map(coefficient => ({ role: 'coefficient' as const, id: coefficient.id, label: coefficient.label })) };
  const options = { names, operations: backend.operations, scalarCoefficientIds: new Set(scope.coefficients.map(coefficient => coefficient.id)) };
  return (source: string, notation: 'text' | 'latex'): MathNode => {
    validateMathSource(source);
    return notation === 'text' ? parseMathText(source, options)
      : decodeMathJson(backend.parseLatex(source), { ...options, allowRenderedProducts: true });
  };
}

/** Input editing produces the same stored expression used by coordinates, including angle convention. */
export function createFunctionMathSource(source: string, notation: 'text' | 'latex', angleUnit: 'degree' | 'radian',
  scope: FunctionMathScope, backend: MathExecutionBackend): StoredMathExpression {
  const parse = sourceReader(scope, backend);
  return { format: MATH_INPUT_FORMAT, source, inputNotation: notation, angleUnit, expression: parse(source, notation) };
}

/** Reparse the visible source at the calculation boundary. Neither a saved AST nor a label supplies authority. */
export function readFunctionMathSource(input: unknown, scope: FunctionMathScope, backend: MathExecutionBackend): StoredMathExpression {
  return decodeStoredMath(input, { operationsById: backend.operationsById,
    coefficientIds: new Set(scope.coefficients.map(coefficient => coefficient.id)), declaredIds: new Set(),
    parseSource: sourceReader(scope, backend) });
}
