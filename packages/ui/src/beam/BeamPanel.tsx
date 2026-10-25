import { impactMemberResponseMatches, transientAxialMatches, type FemPhase } from '@pointercad/fem';
import { useEffect, useMemo, useRef } from 'react';
import { isCompositionKey } from '../commands/compositionKey.js';
import { t, type MessageKey } from '../i18n/t.js';
import { useAppStore } from '../store/useAppStore.js';
import { BeamMemberFields } from './BeamMemberFields.js';
import { BeamResults } from './BeamResults.js';
import { BeamModalResults } from './BeamModalResults.js';
import { BeamBucklingResults } from './BeamBucklingResults.js';
import { BeamTransientHistory } from './BeamTransientHistory.js';
import { BeamTransientResults } from './BeamTransientResults.js';
import { BeamContactDefinitions } from './BeamContactDefinitions.js';
import { BeamContactResults } from './BeamContactResults.js';
import { BeamAxialBoltDefinitions, BeamAxialBoltResults } from './BeamAxialBolts.js';
import { BeamWeldLayerDefinitions, BeamWeldLayerResults } from './BeamWeldLayers.js';
import { BeamJointResults } from './BeamJointResults.js';
import { BeamJointInitialStrainDefinitions, BeamJointInitialStrainResults } from './BeamJointInitialStrain.js';
import { BeamImpactDefinitions } from './BeamImpactDefinitions.js';
import { BeamImpactResults } from './BeamImpactResults.js';
import { fibreOutlinesFromDraft } from './beamImpactDraft.js';
import type { BeamSession } from './beamSession.js';
import { beamOccurrences, beamSourceIsCurrent, captureBeamSource } from './beamSource.js';
import './beam.css';

const phaseLabel: Readonly<Record<FemPhase, MessageKey>> = {
  'loading-assets': 'beam.phase.assets', 'loading-runtime': 'beam.phase.runtime',
  'loading-packages': 'beam.phase.packages', solving: 'beam.phase.solving',
};

export function BeamPanel({ session }: { readonly session: BeamSession }): React.JSX.Element {
  const state = useAppStore();
  const blurredField = useRef<{ readonly element: HTMLElement; readonly field: string;
    readonly ownerId: string; readonly analysisId: string } | null>(null);
  const form = useRef<HTMLFormElement>(null);
  const review = (): void => {
    const blurred = blurredField.current;
    blurredField.current = null;
    state.reviewBeam();
    const current = useAppStore.getState().beamSession;
    if (blurred !== null && current !== null && current.errorKey !== null
      && current.focusedField === blurred.field && current.ownerId === blurred.ownerId
      && current.analysisId === blurred.analysisId && blurred.element.isConnected
      && form.current?.contains(blurred.element)) blurred.element.focus();
  };
  useEffect(() => () => {
    const current = useAppStore.getState();
    if (current.beamSession?.ownerId === session.ownerId && current.beamSession.analysisId === session.analysisId
      && current.beamSession.status === 'running') current.cancelBeam();
  }, [session.ownerId, session.analysisId]);
  // The exact-content association recomputes members x samples; it reruns only when the immutable result or
  // derived-response reference changes, not on unrelated store renders.
  const matchedAxial = useMemo(() => session.result?.kind === 'oofem-beam-transient-3d'
    && transientAxialMatches(session.transientAxial, session.result) ? session.transientAxial : null,
  [session.result, session.transientAxial]);
  const matchedImpactMembers = useMemo(() => session.result?.kind === 'oofem-beam-impact-3d'
    && impactMemberResponseMatches(session.impactMembers, session.result) ? session.impactMembers : null,
  [session.result, session.impactMembers]);
  // The outline text is unchanged since the run: every outline edit invalidates the result (editBeamSession).
  const parameters = state.assembly?.parameters ?? state.document.parameters;
  const fibreOutlines = useMemo(() => {
    if (session.result?.kind !== 'oofem-beam-impact-3d') return null;
    const checked = fibreOutlinesFromDraft(session.impact, session.members.map(member => member.id), parameters);
    return checked.ok ? checked.outlines : null;
  }, [session.result, session.impact, session.members, parameters]);
  const source = captureBeamSource(state);
  const occurrences = source === null || state.assemblyView === null ? [] : beamOccurrences(source.document, state.assemblyView.resolved);
  const selected = new Set(session.members.map(member => JSON.stringify(member.occurrence.path)));
  const reviewed = session.reviewed !== null && beamSourceIsCurrent(session.reviewed, state);
  const running = session.status === 'running';
  return <form className="pcad-panel__body pcad-beam" aria-label={t('beam.title')} data-testid="beam-panel"
    ref={form}
    // Keep the store and unit preview stable during pointer departure; the ref is view-only.
    onBlurCapture={event => {
      const element = event.target;
      const current = useAppStore.getState().beamSession;
      blurredField.current = element instanceof HTMLElement && element.classList.contains('pcad-field__input')
        && current !== null && current.focusedField !== null
        ? { element, field: current.focusedField, ownerId: current.ownerId, analysisId: current.analysisId } : null;
    }}
    onSubmit={event => { event.preventDefault(); }}
    onKeyDown={event => {
      if (isCompositionKey(event.nativeEvent)) return;
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); state.closeBeam(); }
    }}>
    <h3 className="pcad-section__title">{t('beam.title')}</h3>
    <p>{t('beam.scope')}</p>
    <p>{t('beam.saveHelp')}</p>
    <fieldset>
      <legend>{t('beam.analysisType')}</legend>
      <label>{t('beam.analysisType')}<select data-testid="beam-analysis-type" value={session.analysisType}
        onChange={event => {
          const value = event.target.value;
          if (value === 'static' || value === 'modal' || value === 'buckling' || value === 'transient' || value === 'contact'
            || value === 'impact') {
            state.editBeam({ kind: 'analysis-type', value });
          }
        }} title={t('beam.guide.analysisType')}>
        <option value="static">{t('beam.static')}</option>
        <option value="modal">{t('beam.modal')}</option>
        <option value="buckling">{t('beam.buckling')}</option>
        <option value="transient">{t('beam.transient')}</option>
        <option value="contact">{t('beam.contact')}</option>
        <option value="impact">{t('beam.impact')}</option>
      </select></label>
      {session.analysisType === 'transient' || session.analysisType === 'contact' || session.analysisType === 'impact' ? <>
        <p>{t(session.analysisType === 'contact' ? 'beam.contactScope'
          : session.analysisType === 'impact' ? 'beam.impactScope' : 'beam.transientScope')}</p>
        <label>{t('beam.segments')}<select data-testid="beam-segments" value={session.segmentsPerMember}
          onChange={event => state.editBeam({ kind: 'modal-settings', modeCount: session.modeCount,
            segmentsPerMember: Number(event.target.value) })} title={t('beam.guide.segments')}>
          {Array.from({ length: 32 }, (_, index) => index + 1).map(count => <option key={count} value={count}>{count}</option>)}
        </select></label>
        <p>{t(session.analysisType === 'contact' ? 'beam.contactRefinement'
          : session.analysisType === 'impact' ? 'beam.impactRefinement' : 'beam.transientRefinement')}</p>
      </> : null}
      {session.analysisType === 'modal' || session.analysisType === 'buckling' ? <>
        <p>{t(session.analysisType === 'buckling' ? 'beam.bucklingScope' : 'beam.modalScope')}</p>
        <label>{t(session.analysisType === 'buckling' ? 'beam.bucklingModeCount' : 'beam.modeCount')}<select data-testid="beam-mode-count" value={session.modeCount}
          onChange={event => state.editBeam({ kind: 'modal-settings', modeCount: Number(event.target.value),
            segmentsPerMember: session.segmentsPerMember })} title={t(session.analysisType === 'buckling' ? 'beam.guide.bucklingModeCount' : 'beam.guide.modeCount')}>
          {Array.from({ length: 24 }, (_, index) => index + 1).map(count => <option key={count} value={count}>{count}</option>)}
        </select></label>
        <label>{t('beam.segments')}<select data-testid="beam-segments" value={session.segmentsPerMember}
          onChange={event => state.editBeam({ kind: 'modal-settings', modeCount: session.modeCount,
            segmentsPerMember: Number(event.target.value) })} title={t('beam.guide.segments')}>
          {Array.from({ length: 32 }, (_, index) => index + 1).map(count => <option key={count} value={count}>{count}</option>)}
        </select></label>
        <p>{t(session.analysisType === 'buckling' ? 'beam.bucklingRefinement' : 'beam.modalRefinement')}</p>
      </> : null}
    </fieldset>
    {session.analysisType === 'transient' ? <BeamTransientHistory session={session} /> : null}
    <fieldset>
      <legend>{t('beam.members')}</legend>
      {source === null ? <p role="status">{t('beam.error.geometry')}</p> : null}
      {source !== null && occurrences.length === 0 ? <p>{t('beam.noMembers')}</p> : null}
      {occurrences.map(occurrence => <label key={JSON.stringify(occurrence.path)} className="pcad-beam__occurrence">
        <input type="checkbox" data-beam-occurrence={JSON.stringify(occurrence.path)}
          checked={selected.has(JSON.stringify(occurrence.path))}
          onChange={event => state.editBeam({ kind: 'select', occurrence, selected: event.target.checked })} title={t('beam.guide.member')} />{occurrence.label}
      </label>)}
    </fieldset>
    <p>{t(session.analysisType === 'buckling' ? 'beam.bucklingSupportHelp'
      : session.analysisType === 'transient' ? 'beam.transientSupportHelp'
      : session.analysisType === 'contact' ? 'beam.contactSupportHelp'
      : session.analysisType === 'impact' ? 'beam.impactSupportHelp' : 'beam.supportHelp')}</p>
    {session.members.map(member => <BeamMemberFields key={member.id} member={member} session={session} />)}
    {session.analysisType === 'contact' ? <BeamContactDefinitions session={session} /> : null}
    {session.analysisType === 'contact' ? <BeamAxialBoltDefinitions session={session} /> : null}
    {session.analysisType === 'contact' ? <BeamWeldLayerDefinitions session={session} /> : null}
    {session.analysisType === 'contact' ? <BeamJointInitialStrainDefinitions session={session} /> : null}
    {session.analysisType === 'impact' ? <BeamImpactDefinitions session={session} /> : null}
    <div className="pcad-beam__actions">
      <button type="button" className="pcad-button" data-testid="beam-review" disabled={source === null || running}
        onClick={review} title={t('beam.guide.review')}>{t('beam.review')}</button>
      <button type="button" className="pcad-button pcad-button--primary" data-testid="beam-run" disabled={!reviewed || running || state.beamRunner === null}
        onClick={state.runBeam} title={t('beam.guide.run')}>
        {t('beam.run')}</button>
      <button type="button" className="pcad-button" data-testid="beam-cancel" disabled={!running} onClick={state.cancelBeam} title={t('beam.guide.cancel')}>{t('beam.cancel')}</button>
      <button type="button" className="pcad-button" data-testid="beam-apply" disabled={!reviewed || running} onClick={state.applyBeamInputs} title={t('beam.guide.apply')}>{t('beam.apply')}</button>
      <button type="button" className="pcad-button" data-testid="beam-close" onClick={state.closeBeam} title={t('beam.guide.close')}>{t('beam.close')}</button>
    </div>
    <p role="status" data-testid="beam-status" data-status={session.status} data-phase={session.phase ?? ''}>
      {running ? t(session.analysisType === 'impact' && session.phase === 'solving' ? 'beam.phase.impact'
        : session.analysisType === 'contact' && session.phase === 'solving' ? 'beam.phase.contact'
        : session.analysisType === 'transient' && session.phase === 'solving' ? 'beam.phase.transient'
        : session.analysisType === 'buckling' && session.phase === 'solving' ? 'beam.phase.buckling'
        : session.analysisType === 'modal' && session.phase === 'solving' ? 'beam.phase.modal'
        : session.phase === null ? 'beam.phase.assets' : phaseLabel[session.phase])
        : session.status === 'cancelled' ? t('beam.cancelled') : reviewed ? t('beam.reviewed') : t('beam.needsReview')}
    </p>
    {session.errorKey === null ? null : <p role="alert">{t(session.errorKey)}</p>}
    {session.diagnostic === null ? null : <details><summary>{t('beam.details')}</summary><p>{session.diagnostic}</p></details>}
    {reviewed && session.result !== null ? session.result.kind === 'oofem-beam-impact-3d'
      ? <BeamImpactResults result={session.result} members={matchedImpactMembers} outlines={fibreOutlines} />
      : session.result.kind === 'oofem-beam-joint-initial-strain'
      ? <BeamJointInitialStrainResults result={session.result} view={session.contactView} />
      : session.result.kind === 'oofem-beam-joint-contact'
      ? <BeamJointResults result={session.result} view={session.contactView} />
      : session.result.kind === 'oofem-beam-weld-layer-contact'
      ? <BeamWeldLayerResults result={session.result} view={session.contactView} />
      : session.result.kind === 'oofem-beam-axial-bolt-contact'
      ? <BeamAxialBoltResults result={session.result} view={session.contactView} />
      : session.result.kind === 'oofem-beam-contact-3d'
      ? <BeamContactResults result={session.result} view={session.contactView} />
      : session.result.kind === 'oofem-beam-transient-3d'
      ? <BeamTransientResults result={session.result} view={session.transientView}
        axial={matchedAxial} />
      : session.result.kind === 'oofem-beam-buckling-3d'
      ? <BeamBucklingResults result={session.result} edges={session.bucklingEdges} />
      : session.result.kind === 'oofem-beam-modal-3d'
      ? <BeamModalResults result={session.result} />
      : <BeamResults result={session.result} members={session.members} /> : null}
  </form>;
}
