import type { MathEvaluation } from '@pointercad/expression/math/contracts';
import { readableMathResult } from './mathTransformResult.js';
import { t } from '../i18n/t.js';

export function mathFourierSeriesResult(evaluation: Extract<MathEvaluation, { kind: 'fourier-series' }>): { message: string; detail: string } {
  const value = evaluation.series;
  const list = (items: typeof value.cosine) => `[${items.map(readableMathResult).join(', ')}]`;
  const domain = `[${readableMathResult(value.lower)}, ${readableMathResult(value.upper)}]`;
  const convergence = value.endpointMean === null ? t('math.fourierSeries.unknown')
    : `${t('math.fourierSeries.converges')} ${t('math.fourierSeries.endpoint')}: ${readableMathResult(value.endpointMean)}。`;
  return { message: `${t('math.fourierSeries.partial')} N=${value.degree}`,
    detail: `${t('math.fourierSeries.interval')}: ${domain}。${t('math.fourierSeries.constant')}: ${readableMathResult(value.constant)}。`
      + `a[1..N]=${list(value.cosine)}、b[1..N]=${list(value.sine)}。${t('math.fourierSeries.convention')} ${convergence} ${t('math.fourierSeries.select')}` };
}
