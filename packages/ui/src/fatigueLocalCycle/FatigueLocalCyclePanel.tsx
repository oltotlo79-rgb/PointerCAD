import type { LocalCycleResult } from '@pointercad/fem';
import { beamDisplayNumber } from '../beam/BeamResults.js';
import { t, type MessageKey } from '../i18n/t.js';
import { useAppStore } from '../store/useAppStore.js';
import { currentFatigueLocalCycleResult, fatigueLocalCycleDraftIsSaved, savedFatigueLocalCycleInput,
  type FatigueLocalCycleCorrection, type FatigueLocalCycleDerivation, type FatigueLocalCycleNumberField,
  type FatigueLocalCycleSession, type FatigueLocalCycleTextField } from './fatigueLocalCycleSession.js';

const MATERIAL_NUMBERS: readonly (readonly [FatigueLocalCycleNumberField, MessageKey])[] = [
  ['elasticModulusMpa', 'fatigueLocalCycle.elasticModulusMpa'],
  ['fatigueStrengthCoefficientMpa', 'fatigueLocalCycle.fatigueStrengthCoefficientMpa'],
  ['fatigueStrengthExponent', 'fatigueLocalCycle.fatigueStrengthExponent'],
  ['fatigueDuctilityCoefficient', 'fatigueLocalCycle.fatigueDuctilityCoefficient'],
  ['fatigueDuctilityExponent', 'fatigueLocalCycle.fatigueDuctilityExponent'],
  ['minimumCycles', 'fatigueLocalCycle.minimumCycles'], ['maximumCycles', 'fatigueLocalCycle.maximumCycles'],
];
const CYCLE_NUMBERS: readonly (readonly [FatigueLocalCycleNumberField, MessageKey])[] = [
  ['strainMax', 'fatigueLocalCycle.strainMax'], ['strainMin', 'fatigueLocalCycle.strainMin'],
  ['stressMax', 'fatigueLocalCycle.stressMax'], ['stressMin', 'fatigueLocalCycle.stressMin'],
];
const CORRECTIONS: readonly (readonly [FatigueLocalCycleCorrection, MessageKey])[] = [['', 'fatigueLocalCycle.choose'],
  ['morrow', 'fatigueLocalCycle.correctionMorrow'], ['swt', 'fatigueLocalCycle.correctionSwt']];
const DERIVATIONS: readonly (readonly [FatigueLocalCycleDerivation, MessageKey])[] = [['', 'fatigueLocalCycle.choose'],
  ['measured', 'fatigueLocalCycle.derivationMeasured'], ['elastic-plastic-analysis', 'fatigueLocalCycle.derivationAnalysis']];
const isCorrection = (value: string): value is FatigueLocalCycleCorrection => CORRECTIONS.some(([option]) => option === value);
const isDerivation = (value: string): value is FatigueLocalCycleDerivation => DERIVATIONS.some(([option]) => option === value);
const NUMBER_GUIDES: Readonly<Record<FatigueLocalCycleNumberField, MessageKey>> = {
  elasticModulusMpa: 'fatigueLocalCycle.guide.elasticModulus',
  fatigueStrengthCoefficientMpa: 'fatigueLocalCycle.guide.fatigueStrengthCoefficient',
  fatigueStrengthExponent: 'fatigueLocalCycle.guide.fatigueStrengthExponent',
  fatigueDuctilityCoefficient: 'fatigueLocalCycle.guide.fatigueDuctilityCoefficient',
  fatigueDuctilityExponent: 'fatigueLocalCycle.guide.fatigueDuctilityExponent',
  minimumCycles: 'fatigueLocalCycle.guide.minimumCycles',
  maximumCycles: 'fatigueLocalCycle.guide.maximumCycles',
  strainMax: 'fatigueLocalCycle.guide.strainMax',
  strainMin: 'fatigueLocalCycle.guide.strainMin',
  stressMax: 'fatigueLocalCycle.guide.stressMax',
  stressMin: 'fatigueLocalCycle.guide.stressMin',
};

/** The refused field, matched for the panel's own checks ('stressMax') and for reader paths ('cycle.stressMax',
 * 'material.calibration.minimumCycles', 'material.source'). */
export function fatigueLocalCycleFieldRefused(session: FatigueLocalCycleSession, field: string): boolean {
  const path = session.refusal?.path;
  if (path === null || path === undefined) return false;
  return path === field || path === `material.${field}` || path === `material.calibration.${field}` || path === `cycle.${field}`;
}

function Result({ result }: { readonly result: LocalCycleResult }): React.JSX.Element {
  return <section role="status" aria-label={t('fatigueLocalCycle.resultTitle')} data-testid="fatigue-local-cycle-result">
    <h4>{t('fatigueLocalCycle.resultTitle')}</h4>
    <p>{t('fatigueLocalCycle.scope')}</p>
    <dl>
      <dt>{t('fatigueLocalCycle.cyclesToFailure')}</dt><dd data-testid="fatigue-local-cycle-cycles">{beamDisplayNumber(result.cyclesToFailure)}</dd>
      <dt>{t('fatigueLocalCycle.reversalsToFailure')}</dt><dd>{beamDisplayNumber(result.reversalsToFailure)}</dd>
      <dt>{t('fatigueLocalCycle.strainAmplitude')}</dt><dd>{beamDisplayNumber(result.strainAmplitude)}</dd>
      <dt>{t('fatigueLocalCycle.meanStress')}</dt><dd>{beamDisplayNumber(result.meanStressMpa)}</dd>
      {result.swtParameterMpa === null ? null : <><dt>{t('fatigueLocalCycle.swtParameter')}</dt>
        <dd>{beamDisplayNumber(result.swtParameterMpa)}</dd></>}
    </dl>
  </section>;
}

/** Constant-amplitude local-cycle input and estimate. Every value is typed by the user; a result is shown only for the
 * current draft; a refusal never presents a life, an infinite life or zero damage. */
export function FatigueLocalCyclePanel({ session }: { readonly session: FatigueLocalCycleSession }): React.JSX.Element {
  const edit = useAppStore(state => state.editFatigueLocalCycle);
  const run = useAppStore(state => state.runFatigueLocalCycle);
  const save = useAppStore(state => state.saveFatigueLocalCycle);
  const close = useAppStore(state => state.closeFatigueLocalCycle);
  const ownerId = useAppStore(state => (state.assembly ?? state.document).id);
  const saved = useAppStore(state => savedFatigueLocalCycleInput(state.assembly ?? state.document));
  const { draft, refusal } = session;
  const result = currentFatigueLocalCycleResult(session);
  const text = (field: FatigueLocalCycleNumberField | FatigueLocalCycleTextField, value: string): void => {
    edit({ kind: 'text', field, value });
  };
  const numberField = ([field, key]: readonly [FatigueLocalCycleNumberField, MessageKey]): React.JSX.Element =>
    <label key={field}>{t(key)}
      <input type="text" inputMode="decimal" value={draft[field]} data-fatigue-local-cycle-field={field}
        aria-invalid={fatigueLocalCycleFieldRefused(session, field)} onChange={event => { text(field, event.target.value); }} title={t(NUMBER_GUIDES[field])} /></label>;
  return <div data-testid="fatigue-local-cycle-panel">
    <h3>{t('fatigueLocalCycle.title')}</h3>
    <p>{t('fatigueLocalCycle.scope')}</p>
    <label>{t('fatigueLocalCycle.correction')}
      <select value={draft.correction} data-fatigue-local-cycle-field="correction"
        aria-invalid={fatigueLocalCycleFieldRefused(session, 'correction')}
        onChange={event => { if (isCorrection(event.target.value)) edit({ kind: 'correction', value: event.target.value }); }} title={t('fatigueLocalCycle.guide.correction')}>
        {CORRECTIONS.map(([value, key]) => <option key={value} value={value}>{t(key)}</option>)}
      </select></label>
    <fieldset data-testid="fatigue-local-cycle-material">
      <legend>{t('fatigueLocalCycle.materialLegend')}</legend>
      <label>{t('fatigueLocalCycle.materialId')}
        <input type="text" maxLength={64} value={draft.materialId} data-fatigue-local-cycle-field="materialId"
          aria-invalid={fatigueLocalCycleFieldRefused(session, 'id')} onChange={event => { text('materialId', event.target.value); }} title={t('fatigueLocalCycle.guide.materialId')} /></label>
      {MATERIAL_NUMBERS.map(numberField)}
      <label>{t('fatigueLocalCycle.sourceReference')}
        <input type="text" maxLength={512} value={draft.materialReference} data-fatigue-local-cycle-field="materialReference"
          aria-invalid={fatigueLocalCycleFieldRefused(session, 'material.source')}
          onChange={event => { text('materialReference', event.target.value); }} title={t('fatigueLocalCycle.guide.materialReference')} /></label>
      <label>{t('fatigueLocalCycle.sourceCondition')}
        <input type="text" maxLength={512} value={draft.materialCondition} data-fatigue-local-cycle-field="materialCondition"
          aria-invalid={fatigueLocalCycleFieldRefused(session, 'material.source')}
          onChange={event => { text('materialCondition', event.target.value); }} title={t('fatigueLocalCycle.guide.materialCondition')} /></label>
    </fieldset>
    <fieldset data-testid="fatigue-local-cycle-cycle">
      <legend>{t('fatigueLocalCycle.cycleLegend')}</legend>
      <p>{t('fatigueLocalCycle.cycleNote')}</p>
      <label>{t('fatigueLocalCycle.derivation')}
        <select value={draft.derivation} data-fatigue-local-cycle-field="derivation"
          aria-invalid={fatigueLocalCycleFieldRefused(session, 'derivation')}
          onChange={event => { if (isDerivation(event.target.value)) edit({ kind: 'derivation', value: event.target.value }); }} title={t('fatigueLocalCycle.guide.derivation')}>
          {DERIVATIONS.map(([value, key]) => <option key={value} value={value}>{t(key)}</option>)}
        </select></label>
      {CYCLE_NUMBERS.map(numberField)}
      <label>{t('fatigueLocalCycle.sourceReference')}
        <input type="text" maxLength={512} value={draft.cycleReference} data-fatigue-local-cycle-field="cycleReference"
          aria-invalid={fatigueLocalCycleFieldRefused(session, 'cycle.source')}
          onChange={event => { text('cycleReference', event.target.value); }} title={t('fatigueLocalCycle.guide.cycleReference')} /></label>
      <label>{t('fatigueLocalCycle.sourceCondition')}
        <input type="text" maxLength={512} value={draft.cycleCondition} data-fatigue-local-cycle-field="cycleCondition"
          aria-invalid={fatigueLocalCycleFieldRefused(session, 'cycle.source')}
          onChange={event => { text('cycleCondition', event.target.value); }} title={t('fatigueLocalCycle.guide.cycleCondition')} /></label>
    </fieldset>
    <div>
      <button type="button" data-testid="fatigue-local-cycle-run" onClick={run} title={t('fatigueLocalCycle.guide.run')}>{t('fatigueLocalCycle.run')}</button>
      <button type="button" data-testid="fatigue-local-cycle-save" onClick={save} title={t('fatigueLocalCycle.guide.save')}>{t('fatigueLocalCycle.save')}</button>
      <button type="button" onClick={close} title={t('fatigueLocalCycle.guide.close')}>{t('fatigueLocalCycle.close')}</button>
    </div>
    {fatigueLocalCycleDraftIsSaved(session, ownerId, saved) ? <p data-testid="fatigue-local-cycle-saved">{t('fatigueLocalCycle.saved')}</p> : null}
    {refusal === null ? null : <div role="alert" data-testid="fatigue-local-cycle-refusal">
      <p>{t(refusal.key)}</p>
      {refusal.code === null ? null : <p>{t('fatigueLocalCycle.refusalCode')}: <code>{refusal.code}</code></p>}
      {refusal.path === null ? null : <p>{t('fatigueLocalCycle.refusalPath')}: <code>{refusal.path}</code></p>}
    </div>}
    {result === null ? null : <Result result={result} />}
  </div>;
}
