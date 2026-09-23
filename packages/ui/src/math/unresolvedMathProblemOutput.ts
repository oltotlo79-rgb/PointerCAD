import type { StoredMathExpression } from '@pointercad/expression';
import { differentialEquationProblem } from '@pointercad/expression/math/contracts';
import type { MathEditorOutput } from './mathEditorSession.js';

/** Never turn an unresolved equation into a numeric parameter or an invented zero. */
export function unresolvedMathProblemOutput(output: MathEditorOutput): StoredMathExpression | null {
  if (output.evaluation.status !== 'unresolved' || output.evaluation.reason !== 'unevaluated'
    || output.definition === null || output.definition.expression.kind !== 'operation'
    || output.definition.source !== output.input.source || output.definition.inputNotation !== output.input.notation
    || output.definition.angleUnit !== output.input.angleUnit
    || output.definition.expression.operation !== 'partial-equations') return null;
  try { differentialEquationProblem(output.definition.expression); return output.definition; }
  catch { return null; }
}
