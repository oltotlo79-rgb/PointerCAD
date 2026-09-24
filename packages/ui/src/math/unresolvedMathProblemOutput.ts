import type { StoredMathExpression } from '@pointercad/expression';
import { differentialEquationProblem, referencedMathDeclarations, sameMathDeclarations } from '@pointercad/expression/math/contracts';
import type { MathEditorOutput } from './mathEditorSession.js';

/** Never turn an unresolved equation into a numeric parameter or an invented zero. */
export function unresolvedMathProblemOutput(output: MathEditorOutput): StoredMathExpression | null {
  if (output.evaluation.status !== 'unresolved'
    || output.definition === null
    || output.definition.source !== output.input.source || output.definition.inputNotation !== output.input.notation
    || output.definition.angleUnit !== output.input.angleUnit
    || !sameMathDeclarations(output.definition.declarations, output.input.declarations)) return null;
  try {
    if (output.evaluation.reason === 'missing-condition'
      && referencedMathDeclarations(output.definition.expression, output.definition.declarations ?? []).length > 0) return output.definition;
    if (output.evaluation.reason !== 'unevaluated' || output.definition.expression.kind !== 'operation'
      || output.definition.expression.operation !== 'partial-equations') return null;
    differentialEquationProblem(output.definition.expression); return output.definition;
  }
  catch { return null; }
}
