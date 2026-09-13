/** Engine-free shared inputs; the receiving Worker reparses every constructed identity expression. */
import { MATH_INPUT_FORMAT, type MathAxis, type StoredMathExpression } from '@pointercad/expression/math/contracts';
import type { MathRequestIdentity, MathWorkRequest } from '@pointercad/expression/math/client';

export interface FunctionRequestContext { readonly identity:MathRequestIdentity; readonly coefficients:MathWorkRequest['coefficients'] }
export function axisFunctionExpression(axis: MathAxis): StoredMathExpression {
  return {format:MATH_INPUT_FORMAT,source:axis,inputNotation:'text',angleUnit:'radian',
    expression:{kind:'symbol',reference:{role:'axis',name:axis}}};
}
