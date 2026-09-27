import type { MathEvaluation } from '@pointercad/expression/math/contracts';
import { readableMathResult } from './mathTransformResult.js';
import { t } from '../i18n/t.js';

type Node = Parameters<typeof readableMathResult>[0];
function setText(node: Node): string {
  if (node.kind !== 'operation') return readableMathResult(node);
  if (node.operation === 'set') return `{${node.operands.map(readableMathResult).join(', ')}}`;
  if (node.operation === 'interval') {
    const [lower, upper] = node.operands;
    const open = (value: Node) => value.kind === 'operation' && value.operation === 'open-endpoint';
    const endpoint = (value: Node) => readableMathResult(open(value) && value.kind === 'operation' ? value.operands[0] : value);
    return `${open(lower) ? '(' : '['}${endpoint(lower)}, ${endpoint(upper)}${open(upper) ? ')' : ']'}`;
  }
  const symbols: Readonly<Record<string, string>> = { union: ' ∪ ', intersection: ' ∩ ', 'set-minus': ' ∖ ' };
  const symbol = symbols[node.operation];
  return symbol === undefined ? readableMathResult(node) : node.operands.map(value =>
    value.kind === 'operation' && symbols[value.operation] !== undefined ? `(${setText(value)})` : setText(value)).join(symbol);
}

/** Keep the complete set visible; a set or root/multiplicity table is not a scalar. */
export function mathEquationResult(evaluation: MathEvaluation, source: Node | undefined): { message: string; detail: string } | null {
  if (evaluation.status !== 'value' || evaluation.kind === 'real' || source?.kind !== 'operation'
    || (source.operation !== 'solve-equation' && source.operation !== 'polynomial-roots')) return null;
  const empty = evaluation.expression.kind === 'constant' && evaluation.expression.name === 'empty-set';
  if (source.operation === 'solve-equation' && (evaluation.kind === 'set' || evaluation.kind === 'interval')) {
    return { message: empty ? t('math.equation.empty') : `${t('math.equation.solutions')}: ${setText(evaluation.expression)}`,
      detail: `${t('math.equation.domain')}: ${setText(source.operands[1])}。${t('math.equation.select')}` };
  }
  if (source.operation === 'polynomial-roots' && (evaluation.kind === 'matrix' || evaluation.kind === 'vector')) {
    const matrix = evaluation.expression;
    const rows = matrix.kind === 'operation' && matrix.operation === 'matrix' ? matrix.operands[0] : matrix;
    const values = rows.kind === 'operation' && rows.operation === 'list' ? rows.operands : [];
    const descriptions = values.map(row => row.kind === 'operation' && row.operation === 'list'
      ? `${readableMathResult(row.operands[0])} (${t('math.equation.multiplicity')}: ${readableMathResult(row.operands[1])})` : '');
    return { message: t('math.equation.roots'), detail: `${descriptions.length === 0 ? t('math.equation.empty') : descriptions.join('、') + '。'}${t('math.equation.rootSelect')}` };
  }
  return null;
}
