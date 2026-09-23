import { formatNumericalRootEndpoint, type MathEvaluation } from '@pointercad/expression/math/contracts';
import { readableMathResult } from './mathTransformResult.js';
import { t } from '../i18n/t.js';

export function mathNumericalRootResult(value: Extract<MathEvaluation, { kind: 'root-intervals' }>): { message: string; detail: string } {
  const { expression, intervals } = value;
  if (expression.kind !== 'operation' || expression.operands[0].kind !== 'binder') throw new Error('Missing root source');
  const variable = expression.operands[0].bindings[0].variable.label;
  const rows = intervals.roots.map((root, index) => `${t('math.numericRoots.candidate')} ${String(index + 1)}: ${formatNumericalRootEndpoint(root.lower, -1)} ≤ ${variable} ≤ ${formatNumericalRootEndpoint(root.upper, 1)}`);
  const unknown = intervals.unresolved.map(region => `${formatNumericalRootEndpoint(region.lower, -1)} ≤ ${variable} ≤ ${formatNumericalRootEndpoint(region.upper, 1)} (${t(`math.numericRoots.${region.reason}`)})`);
  const range = `${readableMathResult(expression.operands[1])} ≤ ${variable} ≤ ${readableMathResult(expression.operands[2])}`;
  return { message: t(intervals.status === 'unresolved' ? 'math.numericRoots.unresolved'
    : intervals.roots.length === 0 ? 'math.equation.empty' : 'math.numericRoots.complete'),
  detail: `${t('math.numericRoots.range')}: ${range}。${t('math.numericRoots.tolerance')}: ${readableMathResult(expression.operands[3])}。`
    + (rows.length === 0 ? '' : `\n${rows.join('\n')}`)
    + (unknown.length === 0 ? '' : `\n${t('math.numericRoots.unknown')}:\n${unknown.join('\n')}`)
    + `\n${t('math.numericRoots.select')}` };
}
