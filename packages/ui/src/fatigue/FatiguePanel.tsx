import { FATIGUE_PROPORTIONAL_TENSOR_METHOD, FATIGUE_TENSOR_COMPONENT_KEYS, MAX_FATIGUE_HISTORIES, type FatigueLife, type FatigueResult,
  type FatigueTensorComponent } from '@pointercad/fem';
import { useRef } from 'react';
import { isCompositionKey } from '../commands/compositionKey.js';
import { t, type MessageKey } from '../i18n/t.js';
import { ExpressionField } from '../sketch/ExpressionField.js';
import { useAppStore } from '../store/useAppStore.js';
import { beamDisplayNumber } from '../beam/BeamResults.js';
import { fatigueExpressionField, type FatigueFieldName } from '../beam/beamFields.js';
import { beamSourceIsCurrent } from '../beam/beamSource.js';
import { fatigueTensorRow, savedFatigueEntry, type FatigueAxialSource, type FatigueSession,
  type FatigueCorrectionField, type FatigueSourceDraft, type FatigueValueField } from './fatigueSession.js';
import { currentFatigueResultWithPiecewise, fatigueEntryIsSavedWithPiecewise } from './fatiguePiecewiseSession.js';
import { currentSolidFatigueResult, maximumSolidFatigueElement, solidFatigueSourceIsCurrent, solidFatigueSnapshotMatches } from './fatigueSolidSession.js';
import { PiecewiseCurveFields } from './FatiguePiecewiseFields.js';
import '../beam/beam.css';

/** Plain text of the typed life: a finite count, no damaging cycle, or a value too small or large for a number. */
export function fatigueLifeText(life: FatigueLife): string {
  if (life.kind === 'finite') return `${t('fatigue.lifeFinite')} ${beamDisplayNumber(life.spectrumRepetitions)}`;
  if (life.kind === 'no-damaging-cycle') return t('fatigue.lifeNoDamage');
  return t(life.reason === 'damage-underflow' ? 'fatigue.lifeUnderflow' : 'fatigue.lifeOverflow');
}
/** Damage 0 is shown only when no cycle damages; a positive damage below the number range is never shown as 0. */
export function fatigueDamageText(result: Pick<FatigueResult, 'life' | 'damage'>): string {
  if (result.life.kind === 'not-representable' && result.life.reason === 'damage-underflow') return t('fatigue.damageUnderflow');
  return beamDisplayNumber(result.damage);
}
/** A history's damage 0 is exact only when no cycle of the input damages; otherwise it may be below the number range. */
export function fatigueHistoryDamageText(result: Pick<FatigueResult, 'life'>, damage: number): string {
  return damage === 0 && result.life.kind !== 'no-damaging-cycle' ? t('fatigue.historyDamageZero') : beamDisplayNumber(damage);
}

function SourceFields({ prefix, value, onFocus, onChange, conditionReadOnly = false }: {
  readonly prefix: string; readonly value: FatigueSourceDraft; readonly onFocus: (field: string) => void;
  readonly onChange: (field: keyof FatigueSourceDraft, source: string) => void;
  /** An imported history's condition states its measure and analysis; it is not edited by hand. */
  readonly conditionReadOnly?: boolean;
}): React.JSX.Element {
  return <>
    <label>{t('fatigue.sourceReference')}
      <input type="text" maxLength={512} value={value.reference} data-fatigue-field={`${prefix}reference`}
        onFocus={() => onFocus(`${prefix}reference`)} onChange={event => onChange('reference', event.target.value)} title={t('fatigue.guide.sourceReference')} /></label>
    <label>{t('fatigue.sourceCondition')}
      <input type="text" maxLength={512} value={value.condition} data-fatigue-field={`${prefix}condition`}
        readOnly={conditionReadOnly}
        onFocus={() => onFocus(`${prefix}condition`)} onChange={event => onChange('condition', event.target.value)} title={t('fatigue.guide.sourceCondition')} /></label>
  </>;
}

/** Import of one member's member-mean axial stress from the kept transient beam result. Every choice is explicit. */
function AxialImport({ session, source }: { readonly session: FatigueSession; readonly source: FatigueAxialSource | null }):
  React.JSX.Element {
  const parameters = useAppStore(state => state.assembly?.parameters ?? state.document.parameters);
  const current = useAppStore(state => source !== null && beamSourceIsCurrent(source.reviewed, state));
  const edit = useAppStore(state => state.editFatigue);
  const importAxial = useAppStore(state => state.importFatigueAxial);
  const form = session.draft.axialImport;
  const usable = source !== null && source.ownerId === session.ownerId;
  return <fieldset data-testid="fatigue-axial-import">
    <legend>{t('fatigue.axialTitle')}</legend>
    <p data-testid="fatigue-axial-measure">{t('fatigue.axialMeasure')}</p>
    {!usable ? <p data-testid="fatigue-axial-unavailable">{t('fatigue.axialUnavailable')}</p> : <>
      {current ? null : <p role="alert" data-testid="fatigue-axial-stale">{t('fatigue.error.axialStale')}</p>}
      <label data-fatigue-field="axial:member">{t('fatigue.axialMember')}
        <select value={form.memberId} onFocus={() => edit({ kind: 'focus', field: 'axial:member' })}
          onChange={event => edit({ kind: 'axial-member', memberId: event.target.value })} title={t('fatigue.guide.axialMember')}>
          <option value="">{t('fatigue.choose')}</option>
          {source.axial.members.map(member => <option key={member.memberId} value={member.memberId}>
            {`${member.memberId} (${member.startNodeId} → ${member.endNodeId})`}</option>)}
        </select></label>
      <label data-fatigue-field="axial:sequence">{t('fatigue.sequence')}
        <select value={form.sequence} onFocus={() => edit({ kind: 'focus', field: 'axial:sequence' })}
          onChange={event => edit({ kind: 'axial-sequence',
            value: event.target.value === 'once' || event.target.value === 'repeated-periodic' ? event.target.value : '' })} title={t('fatigue.guide.axialSequence')}>
          <option value="">{t('fatigue.choose')}</option>
          <option value="once">{t('fatigue.axialOnce')}</option>
          <option value="repeated-periodic">{t('fatigue.axialRepeated')}</option>
        </select></label>
      {form.sequence === 'repeated-periodic' ? <div className="pcad-beam__numbers" data-fatigue-field="axial:repeats">
        <ExpressionField {...fatigueExpressionField('repeats', 'axial:repeats', form.repeats, parameters)} lengthUnit="mm"
          focused={session.focusedField === 'axial:repeats'} onFocus={() => edit({ kind: 'focus', field: 'axial:repeats' })}
          onChange={value => edit({ kind: 'axial-repeats', source: value })} />
      </div> : null}
      <label>{t('fatigue.axialReference')}
        <input type="text" maxLength={512} value={form.reference} data-fatigue-field="axial:reference"
          onFocus={() => edit({ kind: 'focus', field: 'axial:reference' })}
          onChange={event => edit({ kind: 'axial-reference', source: event.target.value })} title={t('fatigue.guide.axialReference')} /></label>
      <button type="button" className="pcad-button" data-testid="fatigue-axial-import-run" disabled={!current}
        onClick={importAxial} title={t('fatigue.guide.axialImport')}>{t('fatigue.axialImport')}</button>
    </>}
  </fieldset>;
}

/** The reference tensor components in the order of the solid results (tensor shear components). */
const TENSOR_COMPONENT_LABELS: Readonly<Record<FatigueTensorComponent, MessageKey>> = {
  xx: 'fatigue.tensor.xx', yy: 'fatigue.tensor.yy', zz: 'fatigue.tensor.zz',
  yz: 'fatigue.tensor.yz', xz: 'fatigue.tensor.xz', xy: 'fatigue.tensor.xy',
};

/** Fatigue estimate panel: explicit ordered stress histories and the user's own S-N curve. Every edit discards the
 * previous result; inputs are saved in the document only with the save button (Undo removes the save). */
export function FatiguePanel({ session }: { readonly session: FatigueSession }): React.JSX.Element {
  const parameters = useAppStore(state => state.assembly?.parameters ?? state.document.parameters);
  const saved = useAppStore(state => savedFatigueEntry(state.assembly ?? state.document));
  const edit = useAppStore(state => state.editFatigue);
  const run = useAppStore(state => state.runFatigue);
  const save = useAppStore(state => state.saveFatigue);
  const close = useAppStore(state => state.closeFatigue);
  const axialSource = useAppStore(state => state.fatigueAxialSource);
  const solidSource = useAppStore(state => state.assembly === null && state.drawing === null
    && state.activeDocumentId === session.ownerId && state.solidAnalysisSession?.status === 'complete'
    && state.solidAnalysisSession.result !== null && solidFatigueSourceIsCurrent(state.solidAnalysisSession.result, state)
    ? state.solidAnalysisSession.result : null);
  const solidSnapshotCurrent = useAppStore(state => session.solidAnalyzed === undefined || session.solidAnalyzed === null
    || solidFatigueSnapshotMatches(session.solidAnalyzed.snapshot, state));
  const selectSolid = useAppStore(state => state.selectFatigueSolidElement);
  const editSolidElement = useAppStore(state => state.editFatigueSolidElement);
  const addButton = useRef<HTMLButtonElement>(null);
  // View-only memory of the expression input left for Calculate (no store write, so the store and the unit preview
  // stay as they were while the pointer is pressed). A refusal naming the same field again is no change for the
  // ExpressionField effect, so that input is focused here; a different field is focused by its own effect.
  const blurredField = useRef<{ readonly element: HTMLElement; readonly field: string; readonly ownerId: string } | null>(null);
  const form = useRef<HTMLFormElement>(null);
  const calculate = (): void => {
    const blurred = blurredField.current;
    blurredField.current = null;
    void run();
    const current = useAppStore.getState().fatigueSession;
    if (blurred !== null && current !== null && current.errorKey !== null && current.focusedField === blurred.field
      && current.ownerId === blurred.ownerId && blurred.element.isConnected && form.current?.contains(blurred.element)) {
      blurred.element.focus();
    }
  };
  const draft = session.draft;
  const focus = (field: string | null): void => { edit({ kind: 'focus', field }); };
  const number = (name: FatigueFieldName, key: string, source: string, change: (source: string) => void): React.JSX.Element =>
    <div key={key} data-fatigue-field={key}>
      <ExpressionField {...fatigueExpressionField(name, key, source, parameters)} lengthUnit="mm"
        focused={session.focusedField === key} onFocus={() => focus(key)} onChange={change} />
    </div>;
  const value = (name: FatigueValueField): React.JSX.Element =>
    number(name, name, draft.values[name], source => edit({ kind: 'value', field: name, source }));
  const correctionNumber = (name: FatigueCorrectionField, labelKey: MessageKey): React.JSX.Element => {
    const key = `correction:${name}`;
    const props = fatigueExpressionField(name === 'minimumCycles' ? 'referenceCycles' : 'referenceStress',
      key, draft.correction.values[name], parameters);
    return <div data-fatigue-field={key}><ExpressionField {...props} field={{ ...props.field, labelKey }} lengthUnit="mm"
      focused={session.focusedField === key} onFocus={() => focus(key)}
      onChange={source => edit({ kind: 'correction-value', field: name, source })} /></div>;
  };
  const choice = <T extends string>(key: string, label: MessageKey, guide: MessageKey, current: T | '',
    options: readonly (readonly [T, MessageKey])[], change: (value: T | '') => void): React.JSX.Element =>
    <label data-fatigue-field={key}>{t(label)}
      <select value={current} onFocus={() => focus(key)}
        onChange={event => change(options.find(([option]) => option === event.target.value)?.[0] ?? '')} title={t(guide)}>
        <option value="">{t('fatigue.choose')}</option>
        {options.map(([option, text]) => <option key={option} value={option}>{t(text)}</option>)}
      </select></label>;
  const solidMode = draft.inputMode === 'solid-proportional';
  const solidResult = solidSnapshotCurrent ? currentSolidFatigueResult(session, parameters, solidSource) : null;
  const result = solidMode ? solidResult?.result ?? null : currentFatigueResultWithPiecewise(session, parameters);
  const isSaved = fatigueEntryIsSavedWithPiecewise(session, parameters, saved);
  const tensorMode = draft.inputMode === 'proportional-tensor';
  // The user's multi-slope calibration replaces the single-slope curve values; its histories are the stress lists.
  const piecewiseMode = draft.inputMode === 'piecewise';
  // The core's conversion of each reference, shown only with the current tensor-mode result.
  const tensorResult = result === null ? null : session.analyzed?.tensor ?? null;
  const tensorFields = (index: number, key: string): React.JSX.Element => {
    const tensor = fatigueTensorRow(draft, key);
    return <fieldset data-fatigue-tensor={index}>
      <legend>{t('fatigue.tensorReference')}</legend>
      <p>{t('fatigue.tensorComponentOrder')}</p>
      <div className="pcad-beam__numbers">{FATIGUE_TENSOR_COMPONENT_KEYS.map(component =>
        <label key={component}>{t(TENSOR_COMPONENT_LABELS[component])}
          <input type="text" maxLength={64} value={tensor.components[component]} data-fatigue-field={`tensor:${index}:${component}`}
            data-testid={`fatigue-tensor-${index}-${component}`} onFocus={() => focus(`tensor:${index}:${component}`)}
            onChange={event => edit({ kind: 'tensor-component', index, component, source: event.target.value })} title={t('fatigue.guide.tensorComponent')} /></label>)}
      </div>
      <label>{t('fatigue.tensorLoadFactors')}
        <textarea rows={3} value={tensor.loadFactors} data-fatigue-field={`tensor:${index}:factors`}
          data-testid={`fatigue-tensor-${index}-factors`} onFocus={() => focus(`tensor:${index}:factors`)}
          onChange={event => edit({ kind: 'tensor-factors', index, source: event.target.value })} title={t('fatigue.guide.tensorLoadFactors')} /></label>
      <p>{t('fatigue.tensorFactorsHelp')}</p>
    </fieldset>;
  };
  return <form className="pcad-panel__body pcad-beam" aria-label={t('fatigue.title')} data-testid="fatigue-panel"
    onSubmit={event => { event.preventDefault(); }}
    ref={form}
    onBlurCapture={event => {
      const element = event.target;
      const current = useAppStore.getState().fatigueSession;
      blurredField.current = element instanceof HTMLElement && element.classList.contains('pcad-field__input')
        && current !== null && current.focusedField !== null
        ? { element, field: current.focusedField, ownerId: current.ownerId } : null;
    }}
    onKeyDown={event => {
      if (isCompositionKey(event.nativeEvent)) return;
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); }
    }}>
    <h3 className="pcad-section__title">{t('fatigue.title')}</h3>
    <p data-testid="fatigue-scope">{t(solidMode ? 'fatigue.solidScope' : piecewiseMode ? 'fatigue.scopePiecewise' : 'fatigue.scope')}</p>
    <p>{t('fatigue.notCertified')}</p>
    <fieldset data-testid="fatigue-curve">
      <legend>{t('fatigue.curve')}</legend>
      <p>{t(piecewiseMode ? 'fatigue.curveHelpPiecewise' : 'fatigue.curveHelp')}</p>
      <label data-fatigue-field="curveFamily">{t('fatigue.curveFamily')}
        <select data-testid="fatigue-curve-family" value={piecewiseMode ? 'piecewise' : 'single'} onFocus={() => focus('curveFamily')}
          onChange={event => edit({ kind: 'input-mode', value: event.target.value === 'piecewise' ? 'piecewise' : 'stress' })} title={t('fatigue.guide.curveFamily')}>
          <option value="single">{t('fatigue.curveFamilySingle')}</option>
          <option value="piecewise">{t('fatigue.curveFamilyPiecewise')}</option>
        </select></label>
      {choice('stressDefinition', 'fatigue.stressDefinition', 'fatigue.guide.stressDefinition', draft.stressDefinition,
        [['range', 'fatigue.range'], ['amplitude', 'fatigue.amplitude']], next => edit({ kind: 'stress-definition', value: next }))}
      {choice('meanStressAssumption', 'fatigue.meanAssumption', 'fatigue.guide.meanAssumption', draft.meanStressAssumption,
        [['fully-reversed-only', 'fatigue.fullyReversedOnly'], ['mean-independent', 'fatigue.meanIndependent']],
        next => edit({ kind: 'mean-assumption', value: next }))}
      {piecewiseMode ? <PiecewiseCurveFields session={session} /> : <>
      <div className="pcad-beam__numbers">{value('referenceStress')}{value('referenceCycles')}{value('slope')}</div>
      {choice('cutoffMode', 'fatigue.cutoffMode', 'fatigue.guide.cutoffMode', draft.cutoffMode,
        [['none', 'fatigue.cutoffNone'], ['value', 'fatigue.cutoffValue']], next => edit({ kind: 'cutoff-mode', value: next }))}
      {draft.cutoffMode === 'value' ? <div className="pcad-beam__numbers">{value('cutoff')}</div> : null}
      </>}
      <SourceFields prefix="curve:" value={draft.curveSource} onFocus={focus}
        onChange={(field, source) => edit({ kind: 'curve-source', field, source })} />
    </fieldset>
    {piecewiseMode ? null : <fieldset data-testid="fatigue-correction">
      <legend>{t('fatigue.correction')}</legend>
      <label data-fatigue-field="correction:mode">{t('fatigue.correctionMethod')}
        <select data-testid="fatigue-correction-mode" value={draft.correction.mode} onFocus={() => focus('correction:mode')}
          onChange={event => edit({ kind: 'correction-mode', value: event.target.value === 'goodman' ? 'goodman' : 'none' })} title={t('fatigue.guide.correctionMethod')}>
          <option value="none">{t('fatigue.correctionNone')}</option>
          <option value="goodman">{t('fatigue.correctionGoodman')}</option>
        </select></label>
      {draft.correction.mode === 'goodman' ? <>
        <p>{t('fatigue.correctionHelp')}</p>
        <label data-fatigue-field="correction:applicability">
          <input type="checkbox" data-testid="fatigue-correction-applicability" checked={draft.correction.elasticSymmetricYield}
            onFocus={() => focus('correction:applicability')}
            onChange={event => edit({ kind: 'correction-applicability', value: event.target.checked })} title={t('fatigue.guide.correctionApplicability')} />
          {t('fatigue.correctionApplicability')}</label>
        <div className="pcad-beam__numbers">
          {correctionNumber('ultimateTensileStrengthMpa', 'fatigue.ultimateTensileStrength')}
          {correctionNumber('yieldStrengthMpa', 'fatigue.yieldStrength')}
          {correctionNumber('minimumCycles', 'fatigue.minimumCycles')}
        </div>
        <SourceFields prefix="correction:" value={draft.correction.source} onFocus={focus}
          onChange={(field, source) => edit({ kind: 'correction-source', field, source })} />
      </> : null}
    </fieldset>}
    <fieldset data-testid="fatigue-histories">
      <legend>{t('fatigue.histories')}</legend>
      {piecewiseMode ? null : <label data-fatigue-field="inputMode">{t('fatigue.inputMode')}
        <select data-testid="fatigue-input-mode" value={draft.inputMode} onFocus={() => focus('inputMode')}
          onChange={event => edit({ kind: 'input-mode',
            value: event.target.value === 'proportional-tensor' ? 'proportional-tensor'
              : event.target.value === 'solid-proportional' ? 'solid-proportional' : 'stress' })} title={t('fatigue.guide.inputMode')}>
          <option value="stress">{t('fatigue.inputModeStress')}</option>
          <option value="proportional-tensor">{t('fatigue.inputModeTensor')}</option>
          <option value="solid-proportional">{t('fatigue.inputModeSolid')}</option>
        </select></label>}
      {solidMode ? <fieldset data-testid="fatigue-solid-selection">
        <legend>{t('fatigue.solidTitle')}</legend>
        <p>{t('fatigue.solidScope')}</p>
        {solidSource === null ? <p role="alert">{t('fatigue.error.solidUnavailable')}</p> : <>
          <label>{t('fatigue.solidElement')}
            <input type="text" inputMode="numeric" data-testid="fatigue-solid-element" value={draft.solidElement ?? ''}
              onChange={event => editSolidElement(event.target.value)} title={t('fatigue.guide.solidElement')} /></label>
          <button type="button" className="pcad-button" data-testid="fatigue-solid-maximum" onClick={() => {
            const selected = maximumSolidFatigueElement(solidSource);
            if (selected !== null) selectSolid(selected);
          }} title={t('fatigue.guide.solidMaximum')}>{t('fatigue.solidMaximum')}</button>
          <p data-testid="fatigue-solid-source">{t('fatigue.solidCurrentSource').replace('{count}', String(solidSource.result.elements.length))}</p>
          <details><summary>{t('fatigue.solidIdentityDetails')}</summary><code>
            {`${solidSource.result.source.documentId}; ${solidSource.result.source.revision}; `
              + `${solidSource.result.source.meshKey}; ${solidSource.result.inputSha256}`}</code></details>
        </>}
        {draft.solid === undefined ? null : <p data-testid="fatigue-solid-saved-selection">
          {t('fatigue.solidSelected').replace('{element}', draft.solidElement ?? '')}</p>}
      </fieldset> : null}
      {tensorMode ? <>
        <p data-testid="fatigue-tensor-scope">{t('fatigue.tensorScope')}</p>
        <p>{t('fatigue.tensorSaved')}</p>
      </> : <p>{t(solidMode ? 'fatigue.tensorFactorsHelp' : 'fatigue.historiesHelp')}</p>}
      {draft.histories.map((row, index) => <fieldset key={row.key} data-fatigue-history={index}>
        <legend>{`${t('fatigue.history')} ${index + 1}`}</legend>
        {row.imported === null ? null : <p data-fatigue-imported={index}>
          {`${t('fatigue.importedNote')} ${t('fatigue.axialMember')}: ${row.imported.provenance.memberId}`}</p>}
        {tensorMode ? tensorFields(index, row.key) : <label>{t(solidMode ? 'fatigue.tensorLoadFactors' : 'fatigue.stressList')}
          <textarea rows={4} value={row.stress} data-fatigue-field={`history:${index}:stress`}
            readOnly={row.imported !== null}
            onFocus={() => focus(`history:${index}:stress`)}
            onChange={event => edit({ kind: 'history-stress', index, source: event.target.value })} title={t(solidMode ? 'fatigue.guide.tensorLoadFactors' : 'fatigue.guide.stressList')} /></label>}
        {choice(`history:${index}:sequence`, 'fatigue.sequence', 'fatigue.guide.historySequence', row.sequence,
          [['once', 'fatigue.once'], ['repeated-periodic', 'fatigue.repeated']],
          next => edit({ kind: 'history-sequence', index, value: next }))}
        {row.sequence === 'repeated-periodic' ? <div className="pcad-beam__numbers">
          {number('repeats', `history:${index}:repeats`, row.repeats, source => edit({ kind: 'history-repeats', index, source }))}
        </div> : null}
        <SourceFields prefix={`history:${index}:`} value={solidMode ? { ...row.source, condition: t('fatigue.solidScope') } : row.source}
          onFocus={focus} conditionReadOnly={solidMode || row.imported !== null}
          onChange={(field, source) => edit({ kind: 'history-source', index, field, source })} />
        {row.imported === null ? null : <button type="button" className="pcad-button" data-fatigue-detach={index}
          title={t('fatigue.detachHelp')} onClick={() => edit({ kind: 'history-detach', index })}>{t('fatigue.detach')}</button>}
        <button type="button" className="pcad-button" data-fatigue-remove={index} disabled={draft.histories.length <= 1}
          onClick={() => { edit({ kind: 'history-remove', index }); addButton.current?.focus(); }} title={t('fatigue.guide.removeHistory')}>
          {t('fatigue.removeHistory')}</button>
      </fieldset>)}
      <button ref={addButton} type="button" className="pcad-button" data-testid="fatigue-add-history"
        disabled={solidMode || draft.histories.length >= MAX_FATIGUE_HISTORIES} onClick={() => edit({ kind: 'history-add' })} title={t('fatigue.guide.addHistory')}>
        {t('fatigue.addHistory')}</button>
    </fieldset>
    {tensorMode || solidMode ? null : <AxialImport session={session} source={axialSource} />}
    <div className="pcad-beam__actions">
      <button type="button" className="pcad-button pcad-button--primary" data-testid="fatigue-run" onClick={calculate} title={t('fatigue.guide.run')}>
        {t('fatigue.run')}</button>
      <button type="button" className="pcad-button" data-testid="fatigue-save" title={t('fatigue.saveHelp')} onClick={save}>
        {t('fatigue.save')}</button>
      <button type="button" className="pcad-button" data-testid="fatigue-close" onClick={close} title={t('fatigue.guide.close')}>{t('fatigue.close')}</button>
    </div>
    <p data-testid="fatigue-saved" data-saved={String(isSaved)}>
      {t(isSaved ? 'fatigue.saved' : saved === null ? 'fatigue.notSaved' : 'fatigue.changedSinceSave')}</p>
    <p role="status" data-testid="fatigue-status">{t(result === null ? 'fatigue.status.editing' : 'fatigue.status.complete')}</p>
    {session.errorKey === null ? null : <p role="alert" data-testid="fatigue-error">{t(session.errorKey)}</p>}
    {session.diagnostic === null ? null : <p data-testid="fatigue-diagnostic">{session.diagnostic}</p>}
    {result === null ? null : <section data-testid="fatigue-results">
      <h4>{t('fatigue.results')}</h4>
      <p>{t('fatigue.resultScope')}</p>
      {result.method === 'rainflow-three-point-stack/1+miner-linear-piecewise/1' && session.piecewiseAnalyzed !== null
        && session.piecewiseAnalyzed !== undefined ? <div data-testid="fatigue-piecewise-result">
        <p>{t('fatigue.piecewise.resultScope')}</p>
        <p>{`${t('fatigue.piecewise.resultApplicability')}: `
          + `${t('fatigue.piecewise.material')} ${session.piecewiseAnalyzed.problem.curve.applicability.material}; `
          + `${t('fatigue.piecewise.detail')} ${session.piecewiseAnalyzed.problem.curve.applicability.detail}; `
          + `${t('fatigue.piecewise.scope')} ${session.piecewiseAnalyzed.problem.curve.applicability.scope}`}</p>
      </div> : null}
      {'correction' in result ? <div data-testid="fatigue-correction-result" data-method={result.correction.method}>
        <p>{t('fatigue.correctionResult')}</p>
        <p>{`${t('fatigue.ultimateTensileStrength')}: ${beamDisplayNumber(result.correction.ultimateTensileStrengthMpa)} MPa; `
          + `${t('fatigue.yieldStrength')}: ${beamDisplayNumber(result.correction.yieldStrengthMpa)} MPa; `
          + `${t('fatigue.minimumCycles')}: ${beamDisplayNumber(result.correction.minimumCycles)}`}</p>
        <p>{`${t('fatigue.sourceReference')}: ${result.correction.source.reference}; `
          + `${t('fatigue.sourceCondition')}: ${result.correction.source.condition}`}</p>
      </div> : null}
      {solidResult === null ? null : <div data-testid="fatigue-solid-provenance">
        <p>{t('fatigue.solidMeasure')}</p>
        <p>{t('fatigue.solidSelected').replace('{element}', String(solidResult.provenance.elementIndex + 1))}</p>
        <dl>{FATIGUE_TENSOR_COMPONENT_KEYS.map(component => <div key={component}>
          <dt>{t(TENSOR_COMPONENT_LABELS[component])}</dt>
          <dd>{`${beamDisplayNumber(solidResult.provenance.reference[component])} MPa`}</dd>
        </div>)}</dl>
      </div>}
      <p data-testid="fatigue-damage">{`${t('fatigue.damage')}: ${fatigueDamageText(result)}`}</p>
      <p data-testid="fatigue-life" data-life={result.life.kind}>{fatigueLifeText(result.life)}</p>
      {tensorResult === null ? null : <div data-testid="fatigue-tensor-result" data-method={FATIGUE_PROPORTIONAL_TENSOR_METHOD}>
        <p>{t('fatigue.tensorMethod')}</p>
        <table data-testid="fatigue-tensor-conversions">
          <thead><tr><th>{t('fatigue.history')}</th><th>{t('fatigue.tensorVonMises')}</th>
            <th>{t('fatigue.tensorEquivalent')}</th><th>{t('fatigue.tensorSign')}</th></tr></thead>
          <tbody>{tensorResult.conversions.map((conversion, index) => <tr key={conversion.historyId}
            data-fatigue-tensor-result={index} data-sign-tie={String(conversion.signTie)}>
            <td>{index + 1}</td>
            <td>{`${beamDisplayNumber(conversion.vonMisesReferenceMpa)} MPa`}</td>
            <td>{`${beamDisplayNumber(conversion.signedEquivalentReferenceMpa)} MPa`}</td>
            <td>{t(conversion.signTie ? 'fatigue.tensorTie' : 'fatigue.tensorNoTie')}</td>
          </tr>)}</tbody>
        </table>
      </div>}
      <table data-testid="fatigue-history-results">
        <thead><tr><th>{t('fatigue.history')}</th><th>{t('fatigue.fullCycles')}</th><th>{t('fatigue.halfCycles')}</th>
          <th>{t('fatigue.historyDamage')}</th></tr></thead>
        <tbody>{result.histories.map((history, index) => <tr key={history.id} data-fatigue-history-result={index}>
          <td>{index + 1}</td>
          <td>{history.cycles.filter(cycle => cycle.count === 1).length}</td>
          <td>{history.cycles.filter(cycle => cycle.count === 0.5).length}</td>
          <td>{fatigueHistoryDamageText(result, history.damage)}</td>
        </tr>)}</tbody>
      </table>
    </section>}
  </form>;
}
