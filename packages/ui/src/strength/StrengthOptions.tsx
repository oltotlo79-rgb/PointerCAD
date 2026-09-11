import { METRIC_THREADS, type BeamSectionKind, type StrengthCalculation, type TensileAreaMethod, type ThreadSeries } from '@pointercad/model';
import { t } from '../i18n/t.js';
import { FIELD_VALUE_DISPLAY_DIGITS, roundToSignificantDigits } from '../sketch/numericInput.js';
import { StrengthSelect } from './StrengthSelect.js';
import { strengthSessionArea, type StrengthEdit, type StrengthSession } from './strengthSession.js';

export function StrengthOptions({ session, edit }: {
  readonly session: StrengthSession; readonly edit: (edit: StrengthEdit) => void;
}): React.JSX.Element {
  const calculation = session.calculation;
  const area = calculation.kind === 'bolt' ? strengthSessionArea(session) : null;
  return <>
    <StrengthSelect<StrengthCalculation['kind']> labelKey="strength.kind" value={calculation.kind}
      options={[{ value: 'beam', label: t('strength.beam') }, { value: 'shaft', label: t('strength.shaft') }, { value: 'bolt', label: t('strength.bolt') }]}
      onChange={kind => edit({ kind: 'calculation', calculation: kind === 'beam' ? { kind, section: 'rectangle', support: 'cantilever' } : { kind } })} />
    {calculation.kind !== 'beam' ? null : <>
      <StrengthSelect<BeamSectionKind> labelKey="strength.section" value={calculation.section}
        options={[{ value: 'rectangle', label: t('strength.rectangle') }, { value: 'circle', label: t('strength.circle') }, { value: 'tube', label: t('strength.tube') }]}
        onChange={section => edit({ kind: 'calculation', calculation: { ...calculation, section } })} />
      <StrengthSelect<'cantilever' | 'simply-supported'> labelKey="strength.support" value={calculation.support}
        options={[{ value: 'cantilever', label: t('strength.cantilever') }, { value: 'simply-supported', label: t('strength.simplySupported') }]}
        onChange={support => edit({ kind: 'calculation', calculation: { ...calculation, support } })} />
    </>}
    {calculation.kind !== 'bolt' ? null : <>
      <StrengthSelect labelKey="strength.thread" value={session.threadDesignation}
        options={METRIC_THREADS.map(thread => ({ value: thread.designation, label: `${thread.designation} × ${String(session.threadSeries === 'coarse' ? thread.coarsePitch : thread.finePitch)} mm` }))}
        onChange={designation => edit({ kind: 'thread', designation })} />
      <StrengthSelect<ThreadSeries> labelKey="strength.series" value={session.threadSeries}
        options={[{ value: 'coarse', label: t('strength.coarse') }, { value: 'fine', label: t('strength.fine') }]}
        onChange={series => edit({ kind: 'series', series })} />
      <StrengthSelect<TensileAreaMethod> labelKey="strength.areaMethod" value={session.areaMethod}
        options={[{ value: 'table', label: t('strength.table') }, { value: 'approximation', label: t('strength.approximation') }]}
        onChange={method => edit({ kind: 'area-method', method })} />
      <p>{t('strength.field.tensileArea')}: {area?.ok ? String(roundToSignificantDigits(area.area.value, FIELD_VALUE_DISPLAY_DIGITS)) : '—'}</p>
      {session.areaMethod === 'approximation' ? <p>{t('strength.areaFormula')}</p> : null}
    </>}
  </>;
}
