import {
  MATH_INPUT_FORMAT,
  validateMathDecimal,
  type FunctionSurfaceParameterBounds,
  type StoredMathExpression,
  type MathNode,
} from '@pointercad/expression/math/contracts';
import type { ExpressionValue } from '@pointercad/expression';

import type { FunctionInputRange } from './functionDefinitionTypes.js';

/** Preserve exact Pi and coefficient references. A cached decimal cannot stand in for a missing source definition. */
export function functionParameterBounds(u: FunctionInputRange, v: FunctionInputRange): FunctionSurfaceParameterBounds | undefined {
  const source = (value: ExpressionValue): StoredMathExpression | null => {
    if (value.mathDefinition) return value.mathDefinition;
    try { validateMathDecimal(value.source); }
    catch { return null; }
    const literal:MathNode={kind:'number',decimal:value.source.replace(/^[+-]/u,'')};
    return {format:MATH_INPUT_FORMAT,source:value.source,inputNotation:'text',angleUnit:'radian',
      expression:value.source.startsWith('-')?{kind:'operation',operation:'negate',operands:[literal]}:literal};
  };
  const a = source(u.min), b = source(v.min), c = source(u.max), d = source(v.max);
  return a && b && c && d ? {lower:[a,b],upper:[c,d]} : undefined;
}
