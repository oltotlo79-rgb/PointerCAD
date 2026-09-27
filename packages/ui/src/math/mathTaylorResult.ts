import { CANDIDATE_MATH_BY_ID, formatMathText, type MathEvaluation } from '@pointercad/expression/math/contracts';
import { t } from '../i18n/t.js';

/** Display a polynomial and its provenance; never add a scalar '=' for the original function. */
export function mathTaylorResult(evaluation: Extract<MathEvaluation, { kind: 'series' }>): { message: string; detail: string } {
  const { expansion, expression } = evaluation;
  const fn = expression.kind === 'operation' ? expression.operands[0] : null;
  const variable = fn?.kind === 'binder' ? fn.bindings[0].variable.label : 'x';
  const format = (node: Parameters<typeof formatMathText>[0]) => formatMathText(node, CANDIDATE_MATH_BY_ID);
  const center = format(expansion.center), delta = center === '0' ? variable : `(${variable} - (${center}))`;
  const terms = expansion.coefficients.flatMap((node, index) => {
    const coefficient = format(node);
    if (coefficient === '0') return [];
    if (index === 0) return [coefficient];
    const power = index === 1 ? delta : `${delta}^${index}`;
    return [coefficient === '1' ? power : `(${coefficient})*${power}`];
  });
  const message = `P${expansion.degree}(${variable}) = ${terms.length === 0 ? '0' : terms.join(' + ')}`;
  const remainder = expansion.exact ? t('math.series.exact')
    : `${t('math.series.remainder')}: O(${delta}^${expansion.remainderOrder})。${t('math.series.errorUnknown')}`;
  const convergence = expansion.convergence.kind === 'entire' ? t('math.series.entire')
    : expansion.convergence.kind === 'disk' && expansion.convergence.radius !== null
      ? `${t('math.series.disk')}: |${delta}| < ${format(expansion.convergence.radius)}。${t('math.series.boundary')}`
      : t('math.series.convergenceUnknown');
  return { message, detail: `${t('math.series.center')}: ${center}。${t('math.series.degree')}: ${expansion.degree}。${remainder} ${convergence}` };
}
