import type { StateCreator } from 'zustand';
import { withBeamAnalysisInputs } from '@pointercad/model/beam-analysis';
import { beamDefinition, createBeamSession, editBeamSession, invalidateBeamSession, restoreBeamSession,
  type BeamEdit, type BeamSession } from '../beam/beamSession.js';
import { beamOccurrences, beamSourceIsCurrent, captureBeamSource, type BeamSourceSnapshot } from '../beam/beamSource.js';
import type { AppState } from './appState.js';
import { prepareBeamAnalysis } from '../beam/prepareBeamAnalysis.js';

export interface BeamRunner {
  run(session: BeamSession, source: BeamSourceSnapshot): void;
  cancel(): void;
}
export interface BeamSlice {
  readonly beamSession: BeamSession | null;
  readonly beamRunner: BeamRunner | null;
  readonly setBeamRunner: (runner: BeamRunner | null) => void;
  readonly openBeam: () => void;
  readonly closeBeam: () => void;
  readonly editBeam: (edit: BeamEdit) => void;
  readonly reviewBeam: () => void;
  readonly runBeam: () => void;
  readonly cancelBeam: () => void;
  readonly applyBeamInputs: () => void;
}

export const createBeamSlice: StateCreator<AppState, [], [], BeamSlice> = (set, get) => ({
  beamSession: null,
  beamRunner: null,
  setBeamRunner: beamRunner => { set({ beamRunner }); },
  openBeam: () => {
    const state = get();
    if (state.assembly === null || state.strengthSession === null) return;
    state.beamRunner?.cancel();
    const saved = state.assembly.beamAnalysisInputs?.analyses.find(input => input.kind === 'standard-members');
    const occurrences = state.assemblyView?.sourceDocument === state.assembly
      ? beamOccurrences(state.assembly, state.assemblyView.resolved) : [];
    set({ beamSession: saved?.kind === 'standard-members'
      ? restoreBeamSession(state.activeDocumentId, saved.definition, occurrences)
      : createBeamSession(state.activeDocumentId, crypto.randomUUID()) });
  },
  closeBeam: () => {
    get().beamRunner?.cancel();
    set({ beamSession: null });
  },
  editBeam: edit => {
    const state = get();
    if (state.beamSession === null) return;
    // Focus and the transient/contact result views are view-only: they neither cancel a run nor invalidate a result.
    if (edit.kind !== 'focus' && edit.kind !== 'transient-view' && edit.kind !== 'contact-view') state.beamRunner?.cancel();
    set({ beamSession: editBeamSession(state.beamSession, edit) });
  },
  reviewBeam: () => {
    const state = get(), session = state.beamSession;
    if (session === null) return;
    state.beamRunner?.cancel();
    const source = captureBeamSource(state);
    if (source === null) {
      set({ beamSession: { ...session, reviewed: null, result: null, bucklingEdges: [], transientAxial: null, impactMembers: null, status: 'editing', errorKey: 'beam.error.geometry', diagnostic: null } });
      return;
    }
    const draft = beamDefinition(session, source, source.document.parameters);
    if (!draft.ok) {
      set({ beamSession: { ...session, reviewed: null, result: null, bucklingEdges: [], transientAxial: null, impactMembers: null, status: 'editing',
        errorKey: draft.key, diagnostic: draft.diagnostic, focusedField: draft.field } });
      return;
    }
    const checked = prepareBeamAnalysis(source, draft.definition);
    set({ beamSession: { ...session, reviewed: checked.ok ? source : null, result: null, bucklingEdges: [], transientAxial: null, impactMembers: null, status: 'editing',
      errorKey: checked.ok ? null : 'beam.error.model',
      diagnostic: checked.ok ? null : `${checked.issue.code}: ${checked.issue.path}: ${checked.issue.message}` } });
  },
  runBeam: () => {
    const state = get(), session = state.beamSession;
    if (session === null) return;
    if (session.reviewed === null || !beamSourceIsCurrent(session.reviewed, state) || state.beamRunner === null) {
      set({ beamSession: { ...session, result: null, bucklingEdges: [], transientAxial: null, impactMembers: null, status: 'editing', errorKey: 'beam.error.review' } });
      return;
    }
    state.beamRunner.run(session, session.reviewed);
  },
  cancelBeam: () => {
    const state = get();
    state.beamRunner?.cancel();
    if (state.beamSession !== null) set({ beamSession: { ...state.beamSession, result: null,
      phase: null, status: 'cancelled', bucklingEdges: [], transientAxial: null, impactMembers: null, errorKey: null, diagnostic: null } });
  },
  applyBeamInputs: () => {
    const state = get(), session = state.beamSession;
    if (session === null || session.reviewed === null || !beamSourceIsCurrent(session.reviewed, state)) return;
    const source = session.reviewed;
    const draft = beamDefinition(session, source, source.document.parameters);
    if (!draft.ok) return;
    state.beamRunner?.cancel();
    // Existing assembly history owns the edit. Results and derived world endpoints never enter the document.
    // Saving is an intentional input edit, not stale geometry. Release review before subscribers see the document edit.
    set({ beamSession: invalidateBeamSession(session) });
    const analyses = source.document.beamAnalysisInputs?.analyses.filter(input =>
      (input.kind === 'manual' ? input.document.id : input.definition.id) !== draft.definition.id) ?? [];
    state.applyAssembly(withBeamAnalysisInputs(source.document, {
      schema: 'pointercad-beam-inputs/1', analyses: [...analyses, { kind: 'standard-members', definition: draft.definition }],
    }), source.library);
  },
});
