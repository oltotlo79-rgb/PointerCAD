import type { MathEvaluation } from '@pointercad/expression/math/contracts';
import { readableMathResult } from './mathTransformResult.js';
import { t } from '../i18n/t.js';

type Node = Parameters<typeof readableMathResult>[0];
function visibleSigns(node: Node): Node {
  if (node.kind !== 'operation') return node;
  const operands = node.operands.map(visibleSigns);
  if (node.operation === 'multiply' && operands.length === 2 && operands[0].kind === 'number' && operands[0].decimal === '-1') {
    return { kind: 'operation', operation: 'negate', operands: [operands[1]] };
  }
  if (node.operation === 'add' && operands.length === 2 && operands[1].kind === 'operation' && operands[1].operation === 'negate') {
    return { kind: 'operation', operation: 'subtract', operands: [operands[0], operands[1].operands[0]] };
  }
  return { ...node, operands };
}

/** Each displayed branch keeps its parameter order and exclusions next to its values. */
export function mathEquationSystemResult(evaluation: Extract<MathEvaluation, { kind: 'equation-system' }>): { message: string; detail: string } {
  const { solutions } = evaluation;
  const rows = solutions.branches.map((branch, index) => {
    const fn = branch.formula, body = fn.body;
    const values = body.kind === 'operation' && body.operation === 'list' ? body.operands : [];
    const assignments = fn.bindings.map((binding, index) => `${binding.variable.label} = ${readableMathResult(visibleSigns(values[index]))}`).join(', ');
    const parameters = branch.parameters.map(id => fn.bindings.find(binding => binding.variable.id === id)?.variable.label ?? '').join(', ');
    const condition = readableMathResult(branch.condition.body);
    return `${t('math.system.branch')} ${String(index + 1)}: ${assignments}。${t('math.system.parameters')}: ${parameters || t('math.system.none')}。${t('math.system.condition')}: ${condition === 'true' ? t('math.system.allFinite') : condition}`;
  });
  return { message: solutions.branches.length === 0 ? t('math.equation.empty') : t('math.system.solutions'),
    detail: `${t('math.equation.domain')}: ${solutions.domain === 'real' ? 'ℝ' : 'ℂ'}。${rows.join('\n')}\n${t('math.system.select')}` };
}
