import { useRef } from 'react';
import { t, type MessageKey } from '../i18n/t.js';
import { ExpressionField } from '../sketch/ExpressionField.js';
import { useAppStore } from '../store/useAppStore.js';
import { fatigueExpressionField } from '../beam/beamFields.js';
import type { FatiguePiecewiseApplicabilityField, FatiguePiecewiseEdit, FatiguePiecewiseSegmentField } from './fatiguePiecewiseDraft.js';
import { sessionPiecewiseDraft } from './fatiguePiecewiseSession.js';
import type { FatigueSession } from './fatigueSession.js';

/** The expression reader (and its bounds) of each segment value, and its label. */
const SEGMENT_FIELDS: readonly (readonly [FatiguePiecewiseSegmentField, 'referenceStress' | 'referenceCycles' | 'slope', MessageKey])[] = [
  ['fromStress', 'referenceStress', 'fatigue.piecewise.fromStress'],
  ['fromCycles', 'referenceCycles', 'fatigue.piecewise.fromCycles'],
  ['slope', 'slope', 'fatigue.piecewise.slope'],
];
const APPLICABILITY_FIELDS: readonly (readonly [FatiguePiecewiseApplicabilityField, MessageKey])[] = [
  ['material', 'fatigue.piecewise.material'], ['detail', 'fatigue.piecewise.detail'], ['scope', 'fatigue.piecewise.scope'],
];

/**
 * The piecewise S-N calibration of the fatigue panel's curve: ordered segment rows (each a start stress, start cycles and
 * slope; a row can be added or removed, the last one stays), the end of the calibrated cycle range and what applies below
 * it, and the user's applicability statement. Nothing is prefilled. Every field carries the key that a refusal names
 * (`piecewise:segment:<row>:<field>`, `piecewise:segment:<row>`, `piecewise:endCycles`, `piecewise:end`,
 * `piecewise:<material|detail|scope>`), so the panel focuses and the error names exactly that row or field.
 */
export function PiecewiseCurveFields({ session }: { readonly session: FatigueSession }): React.JSX.Element {
  const parameters = useAppStore(state => state.assembly?.parameters ?? state.document.parameters);
  const editFatigue = useAppStore(state => state.editFatigue);
  const addButton = useRef<HTMLButtonElement>(null);
  const draft = sessionPiecewiseDraft(session);
  const edit = (change: FatiguePiecewiseEdit): void => { editFatigue({ kind: 'piecewise', edit: change }); };
  const focus = (field: string): void => { editFatigue({ kind: 'focus', field }); };
  const errorRow = session.errorKey !== null && session.focusedField !== null
    ? /^piecewise:segment:(\d+)$/u.exec(session.focusedField)?.[1] ?? null : null;
  return <fieldset data-testid="fatigue-piecewise">
    <legend>{t('fatigue.piecewise.title')}</legend>
    <p>{t('fatigue.piecewise.help')}</p>
    {draft.segments.map((row, index) => <fieldset key={row.key} data-fatigue-segment={index} data-fatigue-field={`piecewise:segment:${index}`}
      aria-invalid={errorRow === String(index)}>
      <legend>{`${t('fatigue.piecewise.segment')} ${index + 1}`}</legend>
      <div className="pcad-beam__numbers">{SEGMENT_FIELDS.map(([field, reader, labelKey]) => {
        const key = `piecewise:segment:${index}:${field}`;
        const props = fatigueExpressionField(reader, key, row[field], parameters);
        return <div key={field} data-fatigue-field={key}>
          <ExpressionField {...props} field={{ ...props.field, labelKey }} lengthUnit="mm"
            focused={session.focusedField === key} onFocus={() => focus(key)}
            onChange={source => edit({ kind: 'segment-value', index, field, source })} /></div>;
      })}</div>
      <button type="button" className="pcad-button" data-fatigue-segment-remove={index} disabled={draft.segments.length <= 1}
        aria-label={`${t('fatigue.piecewise.removeSegment')} ${index + 1}`}
        onClick={() => { edit({ kind: 'segment-remove', index }); addButton.current?.focus(); }} title={t('fatigue.guide.removeSegment')}>
        {t('fatigue.piecewise.removeSegment')}</button>
    </fieldset>)}
    <button ref={addButton} type="button" className="pcad-button" data-testid="fatigue-piecewise-add"
      onClick={() => edit({ kind: 'segment-add' })} title={t('fatigue.guide.addSegment')}>{t('fatigue.piecewise.addSegment')}</button>
    <div className="pcad-beam__numbers" data-fatigue-field="piecewise:endCycles">
      {(() => {
        const key = 'piecewise:endCycles';
        const props = fatigueExpressionField('referenceCycles', key, draft.endCycles, parameters);
        return <ExpressionField {...props} field={{ ...props.field, labelKey: 'fatigue.piecewise.endCycles' }} lengthUnit="mm"
          focused={session.focusedField === key} onFocus={() => focus(key)} onChange={source => edit({ kind: 'end-cycles', source })} />;
      })()}
    </div>
    <label data-fatigue-field="piecewise:end">{t('fatigue.piecewise.end')}
      <select data-testid="fatigue-piecewise-end" value={draft.end} onFocus={() => focus('piecewise:end')}
        onChange={event => edit({ kind: 'end',
          value: event.target.value === 'cutoff-at-end' || event.target.value === 'none' ? event.target.value : '' })} title={t('fatigue.guide.piecewiseEnd')}>
        <option value="">{t('fatigue.choose')}</option>
        <option value="cutoff-at-end">{t('fatigue.piecewise.endCutoff')}</option>
        <option value="none">{t('fatigue.piecewise.endNone')}</option>
      </select></label>
    {APPLICABILITY_FIELDS.map(([field, labelKey]) => <label key={field}>{t(labelKey)}
      <input type="text" maxLength={512} value={draft.applicability[field]} data-fatigue-field={`piecewise:${field}`}
        onFocus={() => focus(`piecewise:${field}`)} onChange={event => edit({ kind: 'applicability', field, source: event.target.value })} title={t(field === 'material' ? 'fatigue.guide.piecewiseMaterial' : field === 'detail' ? 'fatigue.guide.piecewiseDetail' : 'fatigue.guide.piecewiseScope')} />
    </label>)}
  </fieldset>;
}
