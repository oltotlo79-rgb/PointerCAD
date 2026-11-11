import { beamDisplayNumber } from '../beam/BeamResults.js';
import { t, type MessageKey } from '../i18n/t.js';
import { useAppStore } from '../store/useAppStore.js';
import { FATIGUE_STRAIN_MAX_HISTORIES, FATIGUE_STRAIN_NUMBER_FIELDS, currentFatigueStrainResult, fatigueStrainApplicability,
  fatigueStrainDraftIsSaved, savedFatigueStrainConfiguration, type FatigueStrainDerivation, type FatigueStrainHistoryDraft,
  type FatigueStrainHistoryKind, type FatigueStrainHistoryTextField, type FatigueStrainNumberField, type FatigueStrainResult,
  type FatigueStrainSequence, type FatigueStrainSession } from './fatigueStrainSession.js';

const NUMBER_LABELS: Readonly<Record<FatigueStrainNumberField, MessageKey>> = {
  elasticModulusMpa: 'fatigueStrain.elasticModulusMpa', fatigueStrengthCoefficientMpa: 'fatigueStrain.fatigueStrengthCoefficientMpa',
  fatigueStrengthExponent: 'fatigueStrain.fatigueStrengthExponent', fatigueDuctilityCoefficient: 'fatigueStrain.fatigueDuctilityCoefficient',
  fatigueDuctilityExponent: 'fatigueStrain.fatigueDuctilityExponent', minimumCycles: 'fatigueStrain.minimumCycles',
  maximumCycles: 'fatigueStrain.maximumCycles',
};
const NUMBER_GUIDES: Readonly<Record<FatigueStrainNumberField, MessageKey>> = {
  elasticModulusMpa: 'fatigueStrain.guide.elasticModulus',
  fatigueStrengthCoefficientMpa: 'fatigueStrain.guide.fatigueStrengthCoefficient',
  fatigueStrengthExponent: 'fatigueStrain.guide.fatigueStrengthExponent',
  fatigueDuctilityCoefficient: 'fatigueStrain.guide.fatigueDuctilityCoefficient',
  fatigueDuctilityExponent: 'fatigueStrain.guide.fatigueDuctilityExponent',
  minimumCycles: 'fatigueStrain.guide.minimumCycles',
  maximumCycles: 'fatigueStrain.guide.maximumCycles',
};
const KINDS: readonly (readonly [FatigueStrainHistoryKind, MessageKey])[] = [['strain-only', 'fatigueStrain.kindStrainOnly'],
  ['paired-stress', 'fatigueStrain.kindPaired']];
const DERIVATIONS: readonly (readonly [FatigueStrainDerivation, MessageKey])[] = [['', 'fatigueStrain.choose'],
  ['measured', 'fatigueStrain.derivationMeasured'], ['elastic-plastic-analysis', 'fatigueStrain.derivationAnalysis']];
const PAIRED_DERIVATIONS: readonly (readonly [FatigueStrainDerivation, MessageKey])[] = [['', 'fatigueStrain.choose'],
  ['measured', 'fatigueStrain.pairedDerivationMeasured'], ['elastic-plastic-analysis', 'fatigueStrain.pairedDerivationAnalysis']];
const SEQUENCES: readonly (readonly [FatigueStrainSequence, MessageKey])[] = [['', 'fatigueStrain.choose'],
  ['once', 'fatigueStrain.sequenceOnce'], ['repeated-periodic', 'fatigueStrain.sequencePeriodic']];
const isKind = (value: string): value is FatigueStrainHistoryKind => KINDS.some(([option]) => option === value);
const isDerivation = (value: string): value is FatigueStrainDerivation => DERIVATIONS.some(([option]) => option === value);
const isSequence = (value: string): value is FatigueStrainSequence => SEQUENCES.some(([option]) => option === value);

/** The refused field, matched both for the panel's own checks ('elasticModulusMpa') and for reader paths
 * ('material.calibration.minimumCycles', 'histories[0].strain[3]', 'histories[0].samples[2].timeSeconds'). */
export function fatigueStrainFieldRefused(session: FatigueStrainSession, field: string): boolean {
  const path = session.refusal?.path;
  if (path === null || path === undefined) return false;
  return path === field || path === `material.${field}` || path === `material.calibration.${field}`
    || path.startsWith(`${field}[`) || path.startsWith(`${field}.`);
}

/** The shortest life among all counted cycles, or null when there is no cycle. */
export function fatigueStrainMinimumLife(result: FatigueStrainResult): number | null {
  let minimum: number | null = null;
  for (const history of result.histories) {
    for (const cycle of history.cycles) minimum = minimum === null ? cycle.cyclesToFailure : Math.min(minimum, cycle.cyclesToFailure);
  }
  return minimum;
}

/** The smallest and largest cycle mean stress of one paired history (taken from the paired reversal stresses), or null. */
export function fatigueStrainMeanStressRange(cycles: readonly { readonly meanStressMpa: number }[]): readonly [number, number] | null {
  if (cycles.length === 0) return null;
  const values = cycles.map(cycle => cycle.meanStressMpa);
  return [Math.min(...values), Math.max(...values)];
}

/** True when a history is a one-time record: its repeated applications are counted closed-loop (task019), so the
 * life is not 1 / damage and the panel says how it was counted. */
export function fatigueStrainHasOnceHistory(result: FatigueStrainResult): boolean {
  for (const history of result.histories) if (history.sequence === 'once') return true;
  return false;
}

function HistoryFields({ session, history, index }: {
  readonly session: FatigueStrainSession; readonly history: FatigueStrainHistoryDraft; readonly index: number;
}): React.JSX.Element {
  const edit = useAppStore(state => state.editFatigueStrain);
  const prefix = `histories[${index}]`;
  const paired = session.draft.historyKind === 'paired-stress';
  const text = (field: FatigueStrainHistoryTextField, value: string): void => {
    edit({ kind: 'history', index, field, value });
  };
  return <fieldset data-testid={`fatigue-strain-history-${index}`}>
    <legend>{`${t('fatigueStrain.historyLegend')} ${index + 1}`}</legend>
    <label>{t('fatigueStrain.historyId')}
      <input type="text" maxLength={64} value={history.id} data-fatigue-strain-field={`${prefix}.id`}
        aria-invalid={fatigueStrainFieldRefused(session, `${prefix}.id`)} onChange={event => text('id', event.target.value)} title={t('fatigueStrain.guide.historyId')} /></label>
    <label>{t(paired ? 'fatigueStrain.pairedDerivation' : 'fatigueStrain.derivation')}
      <select value={history.derivation} data-fatigue-strain-field={`${prefix}.derivation`}
        aria-invalid={fatigueStrainFieldRefused(session, `${prefix}.derivation`)}
        onChange={event => { if (isDerivation(event.target.value)) edit({ kind: 'historyDerivation', index, value: event.target.value }); }} title={t(paired ? 'fatigueStrain.guide.pairedDerivation' : 'fatigueStrain.guide.derivation')}>
        {(paired ? PAIRED_DERIVATIONS : DERIVATIONS).map(([value, key]) => <option key={value} value={value}>{t(key)}</option>)}
      </select></label>
    {paired
      ? <label>{t('fatigueStrain.samples')}
        <textarea value={history.samples ?? ''} rows={6} data-fatigue-strain-field={`${prefix}.samples`}
          aria-invalid={fatigueStrainFieldRefused(session, `${prefix}.samples`)} onChange={event => text('samples', event.target.value)} title={t('fatigueStrain.guide.samples')} />
        <span data-testid={`fatigue-strain-samples-format-${index}`}>{t('fatigueStrain.samplesFormat')}</span></label>
      : <label>{t('fatigueStrain.strain')}
        <textarea value={history.strain} rows={3} data-fatigue-strain-field={`${prefix}.strain`}
          aria-invalid={fatigueStrainFieldRefused(session, `${prefix}.strain`)} onChange={event => text('strain', event.target.value)} title={t('fatigueStrain.guide.strain')} /></label>}
    <label>{t('fatigueStrain.sequence')}
      <select value={history.sequence} data-fatigue-strain-field={`${prefix}.sequence`}
        aria-invalid={fatigueStrainFieldRefused(session, `${prefix}.sequence`)}
        onChange={event => { if (isSequence(event.target.value)) edit({ kind: 'historySequence', index, value: event.target.value }); }} title={t('fatigueStrain.guide.sequence')}>
        {SEQUENCES.map(([value, key]) => <option key={value} value={value}>{t(key)}</option>)}
      </select></label>
    <label>{t('fatigueStrain.repeats')}
      <input type="text" inputMode="numeric" value={history.repeats} data-fatigue-strain-field={`${prefix}.repeats`}
        aria-invalid={fatigueStrainFieldRefused(session, `${prefix}.repeats`)} onChange={event => text('repeats', event.target.value)} title={t('fatigueStrain.guide.repeats')} /></label>
    <label>{t('fatigueStrain.sourceReference')}
      <input type="text" maxLength={512} value={history.reference} data-fatigue-strain-field={`${prefix}.reference`}
        aria-invalid={fatigueStrainFieldRefused(session, `${prefix}.source`)} onChange={event => text('reference', event.target.value)} title={t('fatigueStrain.guide.historyReference')} /></label>
    <label>{t('fatigueStrain.sourceCondition')}
      <input type="text" maxLength={512} value={history.condition} data-fatigue-strain-field={`${prefix}.condition`}
        aria-invalid={fatigueStrainFieldRefused(session, `${prefix}.source`)} onChange={event => text('condition', event.target.value)} title={t('fatigueStrain.guide.historyCondition')} /></label>
    <button type="button" disabled={session.draft.histories.length <= 1}
      onClick={() => { edit({ kind: 'removeHistory', index }); }} title={t('fatigueStrain.guide.removeHistory')}>{t('fatigueStrain.removeHistory')}</button>
  </fieldset>;
}

function Result({ result }: { readonly result: FatigueStrainResult }): React.JSX.Element {
  const minimum = fatigueStrainMinimumLife(result);
  const paired = result.meanStress === 'morrow-paired-reversal-stress';
  return <section role="status" aria-label={t('fatigueStrain.resultTitle')} data-testid="fatigue-strain-result">
    <h4>{t('fatigueStrain.resultTitle')}</h4>
    <p>{t(paired ? 'fatigueStrain.scopePaired' : 'fatigueStrain.scope')}</p>
    <p data-testid="fatigue-strain-applicability" data-mean-stress={result.meanStress}>{t(fatigueStrainApplicability(result))}</p>
    <dl>
      <dt>{t('fatigueStrain.damage')}</dt><dd data-testid="fatigue-strain-damage">{beamDisplayNumber(result.damage)}</dd>
      <dt>{t('fatigueStrain.life')}</dt>
      <dd data-testid="fatigue-strain-life">{result.life.kind === 'finite' ? beamDisplayNumber(result.life.spectrumRepetitions)
        : t('fatigueStrain.lifeNoCycle')}</dd>
      {minimum === null ? null : <><dt>{t('fatigueStrain.minimumLife')}</dt>
        <dd data-testid="fatigue-strain-minimum-life">{beamDisplayNumber(minimum)}</dd></>}
    </dl>
    {fatigueStrainHasOnceHistory(result) ? <p data-testid="fatigue-strain-life-basis">{t('fatigueStrain.lifeBasis')}</p> : null}
    <table>
      <thead><tr><th scope="col">{t('fatigueStrain.historyId')}</th><th scope="col">{t('fatigueStrain.cycleCount')}</th>
        <th scope="col">{t('fatigueStrain.historyDamage')}</th>
        {paired ? <th scope="col">{t('fatigueStrain.cycleMeanStress')}</th> : null}</tr></thead>
      <tbody>{result.meanStress === 'morrow-paired-reversal-stress'
        ? result.histories.map(history => {
          const range = fatigueStrainMeanStressRange(history.cycles);
          return <tr key={history.id} data-testid={`fatigue-strain-history-result-${history.id}`}>
            <th scope="row">{history.id}</th><td>{history.cycles.length}</td><td>{beamDisplayNumber(history.damage)}</td>
            <td data-testid={`fatigue-strain-mean-stress-${history.id}`}>{range === null ? t('fatigueStrain.noCycle')
              : `${beamDisplayNumber(range[0])}${t('fatigueStrain.rangeTo')}${beamDisplayNumber(range[1])}`}</td></tr>;
        })
        : result.histories.map(history => <tr key={history.id} data-testid={`fatigue-strain-history-result-${history.id}`}>
          <th scope="row">{history.id}</th><td>{history.cycles.length}</td><td>{beamDisplayNumber(history.damage)}</td></tr>)}</tbody>
    </table>
  </section>;
}

/** Strain-life input and estimate. Every value is typed by the user; a result is shown only for the current draft. */
export function FatigueStrainPanel({ session }: { readonly session: FatigueStrainSession }): React.JSX.Element {
  const edit = useAppStore(state => state.editFatigueStrain);
  const run = useAppStore(state => state.runFatigueStrain);
  const save = useAppStore(state => state.saveFatigueStrain);
  const close = useAppStore(state => state.closeFatigueStrain);
  const ownerId = useAppStore(state => (state.assembly ?? state.document).id);
  const saved = useAppStore(state => savedFatigueStrainConfiguration(state.assembly ?? state.document));
  const { draft, refusal } = session;
  const paired = draft.historyKind === 'paired-stress';
  const result = currentFatigueStrainResult(session);
  const material = (field: 'materialId' | 'materialReference' | 'materialCondition', value: string): void => {
    edit({ kind: 'material', field, value });
  };
  return <div data-testid="fatigue-strain-panel">
    <h3>{t('fatigueStrain.title')}</h3>
    <p>{t(paired ? 'fatigueStrain.scopePaired' : 'fatigueStrain.scope')}</p>
    <fieldset data-testid="fatigue-strain-material">
      <legend>{t('fatigueStrain.materialLegend')}</legend>
      <label>{t('fatigueStrain.materialId')}
        <input type="text" maxLength={64} value={draft.materialId} data-fatigue-strain-field="materialId"
          aria-invalid={fatigueStrainFieldRefused(session, 'id')} onChange={event => material('materialId', event.target.value)} title={t('fatigueStrain.guide.materialId')} /></label>
      {FATIGUE_STRAIN_NUMBER_FIELDS.map(field => <label key={field}>{t(NUMBER_LABELS[field])}
        <input type="text" inputMode="decimal" value={draft[field]} data-fatigue-strain-field={field}
          aria-invalid={fatigueStrainFieldRefused(session, field)}
          onChange={event => { edit({ kind: 'material', field, value: event.target.value }); }} title={t(NUMBER_GUIDES[field])} /></label>)}
      <label>{t('fatigueStrain.sourceReference')}
        <input type="text" maxLength={512} value={draft.materialReference} data-fatigue-strain-field="materialReference"
          aria-invalid={fatigueStrainFieldRefused(session, 'source')} onChange={event => material('materialReference', event.target.value)} title={t('fatigueStrain.guide.materialReference')} /></label>
      <label>{t('fatigueStrain.sourceCondition')}
        <input type="text" maxLength={512} value={draft.materialCondition} data-fatigue-strain-field="materialCondition"
          aria-invalid={fatigueStrainFieldRefused(session, 'source')} onChange={event => material('materialCondition', event.target.value)} title={t('fatigueStrain.guide.materialCondition')} /></label>
    </fieldset>
    <label>{t('fatigueStrain.historyKind')}
      <select value={draft.historyKind} data-testid="fatigue-strain-history-kind" data-fatigue-strain-field="historyKind"
        onChange={event => { if (isKind(event.target.value)) edit({ kind: 'historyKind', value: event.target.value }); }} title={t('fatigueStrain.guide.historyKind')}>
        {KINDS.map(([value, key]) => <option key={value} value={value}>{t(key)}</option>)}
      </select></label>
    {paired ? <p data-testid="fatigue-strain-paired-note">{t('fatigueStrain.pairedNote')}</p>
      : <label>
        <input type="checkbox" checked={draft.zeroMeanStressConfirmed} data-fatigue-strain-field="meanStress"
          aria-invalid={fatigueStrainFieldRefused(session, 'meanStress')}
          onChange={event => { edit({ kind: 'zeroMeanStress', confirmed: event.target.checked }); }} title={t('fatigueStrain.guide.zeroMeanStress')} />
        {t('fatigueStrain.zeroMeanStress')}</label>}
    <fieldset data-testid="fatigue-strain-histories">
      <legend>{t(paired ? 'fatigueStrain.pairedHistoriesLegend' : 'fatigueStrain.historiesLegend')}</legend>
      {draft.histories.map((history, index) => <HistoryFields key={index} session={session} history={history} index={index} />)}
      <button type="button" disabled={draft.histories.length >= FATIGUE_STRAIN_MAX_HISTORIES}
        onClick={() => { edit({ kind: 'addHistory' }); }} title={t('fatigueStrain.guide.addHistory')}>{t('fatigueStrain.addHistory')}</button>
    </fieldset>
    <div>
      <button type="button" data-testid="fatigue-strain-run" onClick={run} title={t('fatigueStrain.guide.run')}>{t('fatigueStrain.run')}</button>
      <button type="button" data-testid="fatigue-strain-save" onClick={save} title={t('fatigueStrain.guide.save')}>{t('fatigueStrain.save')}</button>
      <button type="button" onClick={close} title={t('fatigueStrain.guide.close')}>{t('fatigueStrain.close')}</button>
    </div>
    {fatigueStrainDraftIsSaved(session, ownerId, saved) ? <p data-testid="fatigue-strain-saved">{t('fatigueStrain.saved')}</p> : null}
    {refusal === null ? null : <div role="alert" data-testid="fatigue-strain-refusal">
      <p>{t(refusal.key)}</p>
      {refusal.code === null ? null : <p>{t('fatigueStrain.refusalCode')}: <code>{refusal.code}</code></p>}
      {refusal.path === null ? null : <p>{t('fatigueStrain.refusalPath')}: <code>{refusal.path}</code></p>}
    </div>}
    {result === null ? null : <Result result={result} />}
  </div>;
}
