/** Change world origin structurally: substitute old axes, then translate the output. Bound symbols keep their identity. */
import type { ExpressionValue } from '../evaluateExpression.js';
import { scalarMathInRadians } from './mathComposition.js';
import { mathInRadians } from './mathAngleConvention.js';
import { collectMathCoefficients, mapMathSymbols } from './mathExpressionReferences.js';
import type { MathAxis, MathNode, StoredMathExpression } from './mathInputContract.js';
import { formatMathText } from './formatMathText.js';
import { parseMathText } from './mathTextSyntax.js';
import { convertMathNotation } from './mathNotationConversion.js';
import { CANDIDATE_MATH_BY_ID, CANDIDATE_MATH_OPERATIONS } from './mathOperations.js';

export type FunctionAxisTranslation = { readonly kind: 'keep' }
  | { readonly kind: 'add' | 'subtract'; readonly amount: ExpressionValue };

export function translateFunctionExpression(definition: StoredMathExpression,
  axes: Readonly<Record<MathAxis, FunctionAxisTranslation>>, output?: MathAxis): StoredMathExpression {
  let changed = false;
  const translate = (node: MathNode, axis: MathAxis, inverse: boolean): MathNode => {
    const shift = axes[axis];
    if (shift.kind === 'keep') return node;
    changed = true;
    return { kind: 'operation', operation: inverse ? shift.kind === 'add' ? 'subtract' : 'add' : shift.kind,
      operands: [node, scalarMathInRadians(shift.amount)] };
  };
  let expression = mapMathSymbols(mathInRadians(definition.expression, definition.angleUnit), reference => {
    const node: MathNode = { kind: 'symbol', reference };
    return reference.role === 'axis' ? translate(node, reference.name, true) : node;
  });
  if (output !== undefined) expression = translate(expression, output, false);
  if (!changed) return definition;
  const coefficients = collectMathCoefficients(expression);
  const converted = convertMathNotation(expression, node => formatMathText(node, CANDIDATE_MATH_BY_ID), source => parseMathText(source,
    { operations: CANDIDATE_MATH_OPERATIONS, names: { axes: new Set(['X', 'Y', 'Z']), parameters: new Set(['T', 'U', 'V']),
      declared: [], coefficients }, scalarCoefficientIds: new Set(coefficients.map(coefficient => coefficient.id)) }));
  return { ...definition, source: converted.source, inputNotation: 'text', angleUnit: 'radian', expression: converted.expression };
}
