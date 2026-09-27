import type { MathNode } from './mathInputContract.js';

/** Real reciprocal branches use the same scalar/interval/derivative operations. */
export function lowerReciprocalHyperbolic(node: MathNode): MathNode | null {
  if (node.kind !== 'operation' || node.operands.length !== 1) return null;
  const operation = ({ coth: 'tanh', sech: 'cosh', csch: 'sinh',
    arcoth: 'artanh', arsech: 'arcosh', arcsch: 'arsinh' } as const)[
    node.operation as 'coth' | 'sech' | 'csch' | 'arcoth' | 'arsech' | 'arcsch'];
  if (operation === undefined) return null;
  const inverse = node.operation.startsWith('ar');
  const reciprocal = (value: MathNode): MathNode => ({ kind: 'operation', operation: 'divide',
    operands: [{ kind: 'number', decimal: '1' }, value] });
  const base: MathNode = { kind: 'operation', operation,
    operands: [inverse ? reciprocal(node.operands[0]) : node.operands[0]] };
  return inverse ? base : reciprocal(base);
}
