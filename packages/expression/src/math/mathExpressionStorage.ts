/** Structural file boundary only. Current coefficient scope and source equivalence are mandatory in the Worker. */
import { decodeStoredMathStructure } from './decodeStoredMath.js';
import { CANDIDATE_MATH_BY_ID } from './mathOperations.js';
import { MathInputProblem, type StoredMathExpression } from './mathInputContract.js';

export function decodeMathExpressionStorage(value: unknown, source: string): StoredMathExpression {
  const definition = decodeStoredMathStructure(value, { operationsById: CANDIDATE_MATH_BY_ID,
    coefficientIds: new Set(), declaredIds: new Set(), allowUnresolvedCoefficients: true, allowStoredDeclarations: true });
  if (definition.source !== source) throw new MathInputProblem('syntax', '保存する原式と数学定義が一致しません。');
  return definition;
}
