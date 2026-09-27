import type { MathEvaluation } from '@pointercad/expression/math/contracts';
import { readableMathResult } from './mathTransformResult.js';
import { t } from '../i18n/t.js';

export function mathDifferentialEquationResult(evaluation: Extract<MathEvaluation, { kind: 'ode-solutions' }>): { message: string; detail: string } {
  const source = evaluation.expression;
  const fn = source.kind === 'operation' ? source.operands[0] : undefined;
  const names = fn?.kind === 'binder' ? fn.bindings.slice(1).map(binding => binding.variable.label) : [];
  const rows = evaluation.solutions.branches.map((branch, index) => {
    const body = branch.formula.body, variables = branch.formula.bindings;
    const values = body.kind === 'operation' && body.operation === 'list' ? body.operands : [];
    const assignments = values.map((value, index) => names[index] + '(' + variables[0].variable.label + ') = ' + readableMathResult(value)).join(', ');
    const constants = variables.slice(1).map(binding => binding.variable.label).join(', ') || t('math.system.none');
    const condition = readableMathResult(branch.condition.body);
    return t('math.system.branch') + ' ' + String(index + 1) + ': ' + assignments + '。'
      + t('math.ode.constants') + ': ' + constants + '。' + t('math.system.condition') + ': '
      + (condition === 'true' ? t('math.ode.noAdditionalCondition') : condition);
  });
  return { message: t('math.ode.solutions'), detail: rows.join('\n') + '\n' + t('math.ode.select') };
}
