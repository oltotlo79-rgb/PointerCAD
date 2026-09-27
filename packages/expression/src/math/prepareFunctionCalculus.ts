/** Expand all vector components before selection can discard another component's domain. */
import type { MathNode } from './mathInputContract.js';
import type { ScalarInput } from './scalarMathTape.js';
import { expandFunctionVectorCalculus } from './vectorCalculusOperations.js';
import { expandFunctionDerivatives } from './functionDerivatives.js';
import { prepareMathCalculation } from './prepareMathCalculation.js';

export function prepareFunctionVectorCalculus(source: MathNode, inputs: readonly ScalarInput[], angleUnit: 'degree' | 'radian'):
  { readonly expression: MathNode; readonly guards: readonly MathNode[] } | null {
  const lowered = expandFunctionVectorCalculus(source, inputs);
  if (!lowered.changed) return null;
  const expanded = expandFunctionDerivatives(lowered.expression, inputs, angleUnit);
  // Validate constant invalid operands even when a later component/zero hides them.
  // Dynamic domains remain in the original guard expressions for each sample/cell.
  for (const guard of expanded.guards) prepareMathCalculation(guard, { angleUnit, resolve: () => null });
  return expanded;
}
