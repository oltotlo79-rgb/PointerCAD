import { useRef } from 'react';
import { t } from '../i18n/t.js';
import { ExpressionField } from '../sketch/ExpressionField.js';
import { useAppStore } from '../store/useAppStore.js';
import { beamDisplayNumber } from './BeamResults.js';
import { transientExpressionField, type TransientFieldName } from './beamFields.js';
import { TRANSIENT_DRAFT_MAXIMUM_SAMPLES, type BeamSession } from './beamSession.js';

/** Time-history editor. Every value uses the shared expression field (keyboard, IME and parameter rules);
 * edits go through editBeam, and saving goes through the existing assembly Undo history. */
export function BeamTransientHistory({ session }: { readonly session: BeamSession }): React.JSX.Element {
  const parameters = useAppStore(state => state.assembly?.parameters ?? state.document.parameters);
  const edit = useAppStore(state => state.editBeam);
  const draft = session.transient;
  // A remove button disappears with its own row; keep the keyboard position on the persistent add button
  // instead of letting focus fall to the document body.
  const addButton = useRef<HTMLButtonElement>(null);
  const field = (name: TransientFieldName, key: string, source: string, change: (source: string) => void): React.JSX.Element =>
    <div key={key} data-beam-transient-field={key}>
      <ExpressionField {...transientExpressionField(name, key, source, parameters)} lengthUnit="mm"
        focused={session.focusedField === key} onFocus={() => edit({ kind: 'focus', field: key })} onChange={change} />
    </div>;
  const step = transientExpressionField('timeStep', 'transient:timeStep', draft.timeStep, parameters).result.value?.value;
  const count = transientExpressionField('stepCount', 'transient:stepCount', draft.stepCount, parameters).result.value?.value;
  const duration = step !== undefined && count !== undefined && Number.isSafeInteger(count) ? step * count : null;
  return <fieldset className="pcad-beam__transient" data-testid="beam-transient-history">
    <legend>{t('beam.transientHistory')}</legend>
    <p>{t('beam.transientHistoryHelp')}</p>
    <label>{t('beam.transientDamping')}<select data-testid="beam-transient-damping" value={draft.damping}
      onChange={event => {
        const value = event.target.value;
        if (value === 'none' || value === 'rayleigh') edit({ kind: 'transient-damping', value });
      }} title={t('beam.guide.transientDamping')}>
      <option value="none">{t('beam.transientDampingNone')}</option>
      <option value="rayleigh">{t('beam.transientDampingRayleigh')}</option>
    </select></label>
    <p>{t('beam.transientDampingHelp')}</p>
    {draft.damping === 'rayleigh' ? <div className="pcad-beam__numbers">
      {field('massCoefficientPerS', 'transient:massCoefficientPerS', draft.massCoefficientPerS,
        source => edit({ kind: 'transient-value', field: 'massCoefficientPerS', source }))}
      {field('stiffnessCoefficientS', 'transient:stiffnessCoefficientS', draft.stiffnessCoefficientS,
        source => edit({ kind: 'transient-value', field: 'stiffnessCoefficientS', source }))}
    </div> : null}
    <div className="pcad-beam__numbers">
      {field('timeStep', 'transient:timeStep', draft.timeStep, source => edit({ kind: 'transient-value', field: 'timeStep', source }))}
      {field('stepCount', 'transient:stepCount', draft.stepCount, source => edit({ kind: 'transient-value', field: 'stepCount', source }))}
      {field('outputEvery', 'transient:outputEvery', draft.outputEvery,
        source => edit({ kind: 'transient-value', field: 'outputEvery', source }))}
    </div>
    <p data-testid="beam-transient-duration">{t('beam.transientDuration')}: {duration === null ? '—' : `${beamDisplayNumber(duration)} s`}</p>
    <table data-testid="beam-transient-samples">
      <caption>{t('beam.transientSamples')}</caption>
      <thead><tr><th>{t('beam.transientSampleTime')}</th><th>{t('beam.transientSampleFactor')}</th><th aria-hidden="true" /></tr></thead>
      <tbody>{draft.samples.map((row, index) => <tr key={index} data-beam-transient-sample={index}>
        <td>{field('sampleTime', `transient:sample:${index}:time`, row.time,
          source => edit({ kind: 'transient-sample', index, field: 'time', source }))}</td>
        <td>{field('sampleFactor', `transient:sample:${index}:factor`, row.factor,
          source => edit({ kind: 'transient-sample', index, field: 'factor', source }))}</td>
        <td><button type="button" className="pcad-button" data-beam-transient-remove={index} disabled={draft.samples.length <= 2}
          onClick={() => { edit({ kind: 'transient-sample-remove', index }); addButton.current?.focus(); }} title={t('beam.guide.transientRemoveSample')}>
          {t('beam.transientRemoveSample')}</button></td>
      </tr>)}</tbody>
    </table>
    <button ref={addButton} type="button" className="pcad-button" data-testid="beam-transient-add"
      disabled={draft.samples.length >= TRANSIENT_DRAFT_MAXIMUM_SAMPLES}
      onClick={() => edit({ kind: 'transient-sample-add' })} title={t('beam.guide.transientAddSample')}>{t('beam.transientAddSample')}</button>
  </fieldset>;
}
