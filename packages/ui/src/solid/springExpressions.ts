import { composeExpressionSource, evaluateExpression, multiplyExpression, divideExpression,
  type ExpressionValue, type EvaluateOptions } from '@pointercad/expression';

/** Creation and property editing share the same stored derivation, including structured mathematics. */
export function deriveSpringValue(a: ExpressionValue, b: ExpressionValue, operator: '*' | '/',
  variables?: ReadonlyMap<string, number>, options: Omit<EvaluateOptions, 'variables'> = {}): ExpressionValue {
  if (a.mathDefinition !== undefined || b.mathDefinition !== undefined) {
    return operator === '*' ? multiplyExpression(a, b, { ...options, variables }) : divideExpression(a, b, { ...options, variables });
  }
  const source = composeExpressionSource(a.source, b.source, operator), result = evaluateExpression(source, { ...options, variables });
  return result.ok ? result.value : { source, value: 0, display: '0' };
}
