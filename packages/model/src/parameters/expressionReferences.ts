import { collectMathCoefficients, collectVariableNames, type ExpressionValue } from '@pointercad/expression';
import type { Parameter } from './types.js';

/** Legacy expressions bind names; new definitions bind IDs. Never repair an unknown ID from its label. */
export function expressionParameterNames(value: Pick<ExpressionValue, 'source' | 'mathDefinition'>, parameters: readonly Parameter[]): readonly string[] {
  if (value.mathDefinition === undefined) return collectVariableNames(value.source);
  const names = new Map(parameters.flatMap(parameter => parameter.mathId === undefined ? [] : [[parameter.mathId, parameter.name] as const]));
  return collectMathCoefficients(value.mathDefinition.expression).flatMap(reference => {
    const name = names.get(reference.id);
    return name === undefined ? [] : [name];
  });
}
