import type { FatigueDetailQuantity, FatigueDetailStress } from '@pointercad/fem';
import { t, type MessageKey } from '../i18n/t.js';
import { ExpressionField } from '../sketch/ExpressionField.js';
import { useAppStore } from '../store/useAppStore.js';
import { fatigueExpressionField, plasticBarExpressionField } from '../beam/beamFields.js';
import type { FatigueDetailBoltArea, FatigueDetailEdit, FatigueDetailNumberField, FatigueDetailWeldArea } from './fatigueDetailDraft.js';
import { sessionDetailDraft } from './fatigueDetailSession.js';
import type { FatigueSession } from './fatigueSession.js';

/** The plain name of each nominal stress definition (joint, histories and calibration use the same four). */
export const DETAIL_STRESS_LABELS: Readonly<Record<FatigueDetailStress, MessageKey>> = {
  'weld-fillet-throat-nominal-shear': 'fatigue.detail.stressWeldThroat',
  'weld-fillet-leg-nominal-shear': 'fatigue.detail.stressWeldLeg',
  'bolt-axial-normal-tensile-stress-area': 'fatigue.detail.stressBoltTensile',
  'bolt-axial-normal-nominal-shank-area': 'fatigue.detail.stressBoltShank',
};
/** What each quantity holds, with its unit. */
export const DETAIL_QUANTITY_LABELS: Readonly<Record<FatigueDetailQuantity, MessageKey>> = {
  'weld-group-concentric-shear-force': 'fatigue.detail.quantityWeldForce',
  'bolt-total-axial-force': 'fatigue.detail.quantityBoltForce',
  'joint-external-axial-force': 'fatigue.detail.quantityExternalForce',
  'detail-stress': 'fatigue.detail.quantityStress',
};
const STRESSES: readonly FatigueDetailStress[] = ['weld-fillet-throat-nominal-shear', 'weld-fillet-leg-nominal-shear',
  'bolt-axial-normal-tensile-stress-area', 'bolt-axial-normal-nominal-shank-area'];
const WELD_AREAS: readonly (readonly [FatigueDetailWeldArea, MessageKey])[] = [
  ['fillet-throat-area', 'fatigue.detail.weldThroatArea'], ['fillet-leg-area', 'fatigue.detail.weldLegArea'],
];
const BOLT_AREAS: readonly (readonly [FatigueDetailBoltArea, MessageKey])[] = [
  ['iso-metric-thread-tensile-stress-area', 'fatigue.detail.boltTensileArea'], ['nominal-shank-area', 'fatigue.detail.boltShankArea'],
];
/** The quantities offered for each joint; an external joint force is offered for a bolt only so that its refusal
 * (no distribution to the bolt is inferred) is explicit. */
const QUANTITIES: Readonly<Record<'weld' | 'bolt', readonly FatigueDetailQuantity[]>> = {
  weld: ['weld-group-concentric-shear-force', 'detail-stress'],
  bolt: ['bolt-total-axial-force', 'joint-external-axial-force', 'detail-stress'],
};

/**
 * The joint of the fatigue panel's joint mode: the joint kind, the area its nominal stress is defined on and that area's
 * dimensions (mm, or a count), the quantity of the histories and where it was taken, and which stress the histories and
 * the calibration are stated in. Nothing is prefilled. Every field carries the key a refusal names (`detail:<field>`), so
 * the panel focuses and the error names exactly that field.
 */
export function FatigueDetailFields({ session }: { readonly session: FatigueSession }): React.JSX.Element {
  const parameters = useAppStore(state => state.assembly?.parameters ?? state.document.parameters);
  const editFatigue = useAppStore(state => state.editFatigue);
  const draft = sessionDetailDraft(session);
  const edit = (change: FatigueDetailEdit): void => { editFatigue({ kind: 'detail', edit: change }); };
  const focus = (field: string): void => { editFatigue({ kind: 'focus', field }); };
  const number = (field: FatigueDetailNumberField, labelKey: MessageKey): React.JSX.Element => {
    const key = `detail:${field}`;
    const props = field === 'weldLines' ? fatigueExpressionField('repeats', key, draft.values[field], parameters)
      : plasticBarExpressionField('length', key, draft.values[field], parameters);
    return <div key={key} data-fatigue-field={key}>
      <ExpressionField {...props} field={{ ...props.field, labelKey }} lengthUnit="mm" focused={session.focusedField === key}
        onFocus={() => focus(key)} onChange={source => edit({ kind: 'value', field, source })} /></div>;
  };
  const stressChoice = (key: 'detail:loadingStress' | 'detail:curveStress', label: MessageKey, guide: MessageKey,
    value: FatigueDetailStress | '', change: (next: FatigueDetailStress | '') => void): React.JSX.Element =>
    <label data-fatigue-field={key}>{t(label)}
      <select data-testid={key === 'detail:curveStress' ? 'fatigue-detail-curve-stress' : 'fatigue-detail-loading-stress'} value={value}
        onFocus={() => focus(key)} onChange={event => change(STRESSES.find(item => item === event.target.value) ?? '')} title={t(guide)}>
        <option value="">{t('fatigue.choose')}</option>
        {STRESSES.map(item => <option key={item} value={item}>{t(DETAIL_STRESS_LABELS[item])}</option>)}
      </select></label>;
  const quantities = draft.kind === '' ? [] : QUANTITIES[draft.kind];
  return <fieldset data-testid="fatigue-detail">
    <legend>{t('fatigue.detail.title')}</legend>
    <p>{t('fatigue.detail.help')}</p>
    <label data-fatigue-field="detail:kind">{t('fatigue.detail.kind')}
      <select data-testid="fatigue-detail-kind" value={draft.kind} onFocus={() => focus('detail:kind')}
        onChange={event => edit({ kind: 'kind', value: event.target.value === 'weld' || event.target.value === 'bolt' ? event.target.value : '' })}
        title={t('fatigue.guide.detailKind')}>
        <option value="">{t('fatigue.choose')}</option>
        <option value="weld">{t('fatigue.detail.kindWeld')}</option>
        <option value="bolt">{t('fatigue.detail.kindBolt')}</option>
      </select></label>
    {draft.kind === 'weld' ? <>
      <label data-fatigue-field="detail:weldArea">{t('fatigue.detail.area')}
        <select data-testid="fatigue-detail-weld-area" value={draft.weldArea} onFocus={() => focus('detail:weldArea')}
          onChange={event => edit({ kind: 'weld-area', value: WELD_AREAS.find(([area]) => area === event.target.value)?.[0] ?? '' })}
          title={t('fatigue.guide.detailWeldArea')}>
          <option value="">{t('fatigue.choose')}</option>
          {WELD_AREAS.map(([area, label]) => <option key={area} value={area}>{t(label)}</option>)}
        </select></label>
      <label data-fatigue-field="detail:weldConcentric">
        <input type="checkbox" data-testid="fatigue-detail-weld-concentric" checked={draft.weldConcentric}
          onFocus={() => focus('detail:weldConcentric')} onChange={event => edit({ kind: 'weld-concentric', value: event.target.checked })}
          title={t('fatigue.guide.detailWeldConcentric')} />
        {t('fatigue.detail.weldConcentric')}</label>
      <div className="pcad-beam__numbers">
        {number('weldSize', draft.weldArea === 'fillet-leg-area' ? 'fatigue.detail.weldLeg' : 'fatigue.detail.weldThroat')}
        {number('weldLength', 'fatigue.detail.weldLength')}
        {number('weldLines', 'fatigue.detail.weldLines')}
      </div>
    </> : null}
    {draft.kind === 'bolt' ? <>
      <label data-fatigue-field="detail:boltArea">{t('fatigue.detail.area')}
        <select data-testid="fatigue-detail-bolt-area" value={draft.boltArea} onFocus={() => focus('detail:boltArea')}
          onChange={event => edit({ kind: 'bolt-area', value: BOLT_AREAS.find(([area]) => area === event.target.value)?.[0] ?? '' })}
          title={t('fatigue.guide.detailBoltArea')}>
          <option value="">{t('fatigue.choose')}</option>
          {BOLT_AREAS.map(([area, label]) => <option key={area} value={area}>{t(label)}</option>)}
        </select></label>
      <div className="pcad-beam__numbers">
        {number('boltDiameter', 'fatigue.detail.boltDiameter')}
        {draft.boltArea === 'nominal-shank-area' ? null : number('boltPitch', 'fatigue.detail.boltPitch')}
      </div>
    </> : null}
    <label data-fatigue-field="detail:quantity">{t('fatigue.detail.quantity')}
      <select data-testid="fatigue-detail-quantity" value={draft.quantity} onFocus={() => focus('detail:quantity')}
        onChange={event => edit({ kind: 'quantity', value: quantities.find(item => item === event.target.value) ?? '' })}
        title={t('fatigue.guide.detailQuantity')}>
        <option value="">{t('fatigue.choose')}</option>
        {quantities.map(item => <option key={item} value={item}>{t(DETAIL_QUANTITY_LABELS[item])}</option>)}
      </select></label>
    {draft.kind === 'bolt' ? <p data-testid="fatigue-detail-bolt-force-note">{t('fatigue.detail.boltForceNote')}</p> : null}
    <label>{t('fatigue.detail.location')}
      <input type="text" maxLength={512} value={draft.location} data-fatigue-field="detail:location" data-testid="fatigue-detail-location"
        onFocus={() => focus('detail:location')} onChange={event => edit({ kind: 'location', source: event.target.value })}
        title={t('fatigue.guide.detailLocation')} /></label>
    {draft.quantity === 'detail-stress' ? stressChoice('detail:loadingStress', 'fatigue.detail.loadingStress',
      'fatigue.guide.detailLoadingStress', draft.loadingStress, value => edit({ kind: 'loading-stress', value })) : null}
    {stressChoice('detail:curveStress', 'fatigue.detail.curveStress', 'fatigue.guide.detailCurveStress', draft.curveStress,
      value => edit({ kind: 'curve-stress', value }))}
  </fieldset>;
}
