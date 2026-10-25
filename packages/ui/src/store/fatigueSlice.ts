import type { StateCreator } from 'zustand';
import { analyzeFatigue, analyzeFatigueWithMeanStressCorrection, analyzeProportionalTensorFatigue, solidFatigueInput } from '@pointercad/fem';
import { fatigueSolidSelection } from '@pointercad/model/beam-analysis';
import { fatigueSolidSavedEntry, selectFatigueSolidElement, solidFatigueSourceIsCurrent } from '../fatigue/fatigueSolidSession.js';
import { withBeamAnalysisInputs } from '@pointercad/model/beam-analysis';
import { beamSourceIsCurrent } from '../beam/beamSource.js';
import { createFatigueSession, fatigueCorrection, fatigueInput, fatigueRefusal,
  fatigueTensorAnalysisRefusal, fatigueTensorInput, importAxialHistory,
  savedFatigueEntry, type FatigueAxialSource,
  type FatigueSession } from '../fatigue/fatigueSession.js';
import { editFatigueSessionWithPiecewise, fatigueEntryIsSavedWithPiecewise, fatigueSavedEntryWithPiecewise, restoreSavedFatigueEntry,
  runPiecewiseFatigue, type FatigueAnyEdit } from '../fatigue/fatiguePiecewiseSession.js';
import type { AppState } from './appState.js';
import { beginDocumentRequest } from './documentRequest.js';

export interface FatigueSlice {
  readonly fatigueSession: FatigueSession | null;
  /** The accepted transient beam result with its matched member-mean axial measure (set by attachFatigue); it outlives
   * the closed beam panel so that its stresses can be imported, and is cleared on a document or strength change. */
  readonly fatigueAxialSource: FatigueAxialSource | null;
  readonly importFatigueAxial: () => void;
  readonly selectFatigueSolidElement: (elementIndex: number) => void;
  readonly editFatigueSolidElement: (source: string) => void;
  readonly openFatigue: () => void;
  readonly openSolidFatigue: () => void;
  readonly closeFatigue: () => void;
  readonly editFatigue: (edit: FatigueAnyEdit) => void;
  readonly runFatigue: () => void | Promise<void>;
  readonly saveFatigue: () => void;
}

/** Existing fatigue modes calculate synchronously; the solid mode asynchronously validates the retained native result.
 * Inputs are saved only on request, into the owner
 * document's analysis-input attachment (the assembly when one is open, otherwise the part), through the existing Undo
 * history. A result is never stored or restored, and is shown only for the exact input that produced it. */
export const createFatigueSlice: StateCreator<AppState, [], [], FatigueSlice> = (set, get) => {
  let solidRunEpoch = 0;
  return ({
  fatigueSession: null,
  fatigueAxialSource: null,
  editFatigueSolidElement: value => {
    const state = get(), session = state.fatigueSession;
    if (session === null || session.ownerId !== state.activeDocumentId) return;
    solidRunEpoch += 1;
    const solid = state.solidAnalysisSession;
    if (/^[1-9][0-9]*$/u.test(value) && solid?.status === 'complete' && solid.result !== null
      && solidFatigueSourceIsCurrent(solid.result, state)) {
      const selected = selectFatigueSolidElement(session, solid.result, Number(value) - 1, state.document.id);
      if (selected !== session) { set({ fatigueSession: selected }); return; }
    }
    set({ fatigueSession: { ...session, revision: session.revision + 1, analyzed: null, piecewiseAnalyzed: null,
      solidAnalyzed: null, draft: { ...session.draft, solidElement: value }, errorKey: null, diagnostic: null } });
  },
  openSolidFatigue: () => {
    const state = get(), solid = state.solidAnalysisSession;
    if (state.strengthSession === null || solid?.status !== 'complete' || solid.result === null
      || !solidFatigueSourceIsCurrent(solid.result, state) || solid.ownerId !== state.activeDocumentId) return;
    solidRunEpoch += 1;
    const saved = savedFatigueEntry(state.document);
    const session = saved?.kind === 'fatigue-solid-proportional'
      ? restoreSavedFatigueEntry(state.activeDocumentId, saved, state.document.id) : createFatigueSession(state.activeDocumentId);
    set({ fatigueSession: editFatigueSessionWithPiecewise(session, { kind: 'input-mode', value: 'solid-proportional' }) });
  },
  selectFatigueSolidElement: elementIndex => {
    const state = get(), session = state.fatigueSession, solid = state.solidAnalysisSession;
    if (session === null || solid?.status !== 'complete' || solid.result === null
      || !solidFatigueSourceIsCurrent(solid.result, state) || session.ownerId !== state.activeDocumentId) return;
    solidRunEpoch += 1;
    set({ fatigueSession: selectFatigueSolidElement(session, solid.result, elementIndex, state.document.id) });
  },
  importFatigueAxial: () => {
    const state = get(), session = state.fatigueSession, source = state.fatigueAxialSource;
    if (session === null || session.ownerId !== state.activeDocumentId) return;
    const refuse = (errorKey: 'fatigue.error.axialUnavailable' | 'fatigue.error.axialStale'): void => {
      set({ fatigueSession: { ...session, errorKey, diagnostic: null, focusedField: 'axial:member' } });
    };
    if (source === null || source.ownerId !== session.ownerId) { refuse('fatigue.error.axialUnavailable'); return; }
    // The analysis must still describe the current CAD model (the same check that invalidates the beam result).
    if (!beamSourceIsCurrent(source.reviewed, state)) { refuse('fatigue.error.axialStale'); return; }
    const checked = importAxialHistory(session, source, state.assembly?.parameters ?? state.document.parameters);
    if (!checked.ok) {
      set({ fatigueSession: { ...session, errorKey: checked.key, diagnostic: checked.diagnostic,
        focusedField: checked.field ?? session.focusedField } });
      return;
    }
    set({ fatigueSession: checked.session });
  },
  openFatigue: () => {
    solidRunEpoch += 1;
    const state = get();
    if (state.strengthSession === null) return;
    const saved = savedFatigueEntry(state.assembly ?? state.document);
    set({ fatigueSession: saved === null ? createFatigueSession(state.activeDocumentId)
      : restoreSavedFatigueEntry(state.activeDocumentId, saved, state.document.id) });
  },
  closeFatigue: () => { solidRunEpoch += 1; set({ fatigueSession: null }); },
  editFatigue: edit => {
    if (edit.kind !== 'focus') solidRunEpoch += 1;
    const session = get().fatigueSession;
    if (session !== null) set({ fatigueSession: editFatigueSessionWithPiecewise(session, edit) });
  },
  runFatigue: (): void | Promise<void> => {
    const epoch = ++solidRunEpoch;
    const state = get(), session = state.fatigueSession;
    if (session === null || session.ownerId !== state.activeDocumentId) return;
    if (session.draft.inputMode === 'solid-proportional') {
      const solid = state.solidAnalysisSession, source = solid?.result;
      const checked = fatigueSolidSavedEntry(session, state.document.parameters, state.document.id);
      if (!checked.ok) {
        set({ fatigueSession: { ...session, analyzed: null, solidAnalyzed: null, errorKey: checked.key,
          diagnostic: checked.diagnostic, focusedField: checked.field ?? session.focusedField } });
        return;
      }
      if (source === null || source === undefined || solid?.status !== 'complete' || state.assembly !== null
        || state.drawing !== null || !solidFatigueSourceIsCurrent(source, state) || checked.entry.kind !== 'fatigue-solid-proportional') {
        set({ fatigueSession: { ...session, solidAnalyzed: null, errorKey: 'fatigue.error.solidUnavailable', diagnostic: null } });
        return;
      }
      const request = beginDocumentRequest('fatigue.solid', state);
      const definition = checked.entry.definition;
      set({ fatigueSession: { ...session, analyzed: null, solidAnalyzed: null, errorKey: null, diagnostic: null } });
      const current = (): boolean => {
        const next = get(), nextSession = next.fatigueSession;
        return request.isCurrent() && epoch === solidRunEpoch && nextSession !== null && nextSession.ownerId === session.ownerId
          && nextSession.revision === session.revision && next.activeDocumentId === state.activeDocumentId
          && next.document === state.document && next.documentVersion === state.documentVersion
          && next.completedGeneration === state.completedGeneration && next.fileGateway === state.fileGateway
          && next.cancelRequestCount === state.cancelRequestCount && next.strengthSession !== null
          && next.assembly === null && next.drawing === null && next.solidAnalysisSession?.status === 'complete'
          && next.solidAnalysisSession.result === source && solidFatigueSourceIsCurrent(source, next);
      };
      return solidFatigueInput(source.prepared.input, source.result, fatigueSolidSelection(definition), definition.curve).then(adapted => {
        if (!current()) return;
        const after = get().fatigueSession;
        if (after === null) return;
        if (!adapted.ok) {
          set({ fatigueSession: { ...after, solidAnalyzed: null, errorKey: 'fatigue.error.solidRefused', diagnostic: null } });
          return;
        }
        const analyzed = analyzeFatigue(adapted.input);
        if (!analyzed.ok) {
          const refusal = fatigueRefusal(analyzed.code, analyzed.path);
          set({ fatigueSession: { ...after, solidAnalyzed: null, errorKey: refusal.key, diagnostic: refusal.diagnostic,
            focusedField: refusal.field ?? after.focusedField } });
          return;
        }
        set({ fatigueSession: { ...after, solidAnalyzed: { definition, source, result: analyzed.result,
          provenance: adapted.provenance, conversions: adapted.conversions, snapshot: { document: state.document,
            documentVersion: state.documentVersion, completedGeneration: state.completedGeneration, fileGateway: state.fileGateway,
            cancelRequestCount: state.cancelRequestCount, activeDocumentId: state.activeDocumentId } }, errorKey: null, diagnostic: null } });
      }).catch(() => {
        if (!current()) return;
        const after = get().fatigueSession;
        if (after !== null) set({ fatigueSession: { ...after, solidAnalyzed: null, errorKey: 'fatigue.error.solidRefused', diagnostic: null } });
      });
    }
    if (session.draft.inputMode === 'piecewise') {
      // The user's sourced multi-slope calibration on the panel's stress histories (the core's existing rainflow and
      // Miner path); every refusal names its row or field. The result is derived only and never saved.
      set({ fatigueSession: runPiecewiseFatigue(session, state.assembly?.parameters ?? state.document.parameters) });
      return;
    }
    if (session.draft.inputMode === 'proportional-tensor') {
      // Proportional tensor loading: the input is built and converted first (every refusal names its field), then the
      // actual core converts each reference to the signed von Mises equivalent and runs the existing rainflow/Miner path.
      const tensorInput = fatigueTensorInput(session, state.assembly?.parameters ?? state.document.parameters);
      if (!tensorInput.ok) {
        set({ fatigueSession: { ...session, analyzed: null, errorKey: tensorInput.key, diagnostic: tensorInput.diagnostic,
          focusedField: tensorInput.field ?? session.focusedField } });
        return;
      }
      const tensorAnalysis = analyzeProportionalTensorFatigue(tensorInput.problem);
      if (!tensorAnalysis.ok) {
        const refusal = fatigueTensorAnalysisRefusal(tensorAnalysis.code, tensorAnalysis.path);
        set({ fatigueSession: { ...session, analyzed: null, errorKey: refusal.key, diagnostic: refusal.diagnostic,
          focusedField: refusal.field ?? session.focusedField } });
        return;
      }
      set({ fatigueSession: { ...session, analyzed: { input: tensorInput.input, result: tensorAnalysis.result,
        tensor: { problem: tensorInput.problem, conversions: tensorAnalysis.conversions } }, errorKey: null, diagnostic: null } });
      return;
    }
    const checked = fatigueInput(session, state.assembly?.parameters ?? state.document.parameters);
    if (!checked.ok) {
      set({ fatigueSession: { ...session, analyzed: null, errorKey: checked.key, diagnostic: checked.diagnostic,
        focusedField: checked.field ?? session.focusedField } });
      return;
    }
    const correction = fatigueCorrection(session, state.assembly?.parameters ?? state.document.parameters);
    if (!correction.ok) {
      set({ fatigueSession: { ...session, analyzed: null, errorKey: correction.key, diagnostic: correction.diagnostic,
        focusedField: correction.field ?? session.focusedField } });
      return;
    }
    if (correction.correction !== null) {
      const corrected = analyzeFatigueWithMeanStressCorrection(checked.input, correction.correction);
      if (!corrected.ok) {
        const refusal = fatigueRefusal(corrected.code, corrected.path);
        set({ fatigueSession: { ...session, analyzed: null, errorKey: refusal.key, diagnostic: refusal.diagnostic,
          focusedField: refusal.field ?? session.focusedField } });
        return;
      }
      set({ fatigueSession: { ...session, analyzed: { input: checked.input, correction: correction.correction,
        result: corrected.result }, errorKey: null, diagnostic: null } });
      return;
    }
    const analysis = analyzeFatigue(checked.input);
    if (!analysis.ok) {
      // A cycle with a nonzero mean under a fully-reversed-only curve, or the defensive overflow refusal.
      const refusal = fatigueRefusal(analysis.code, analysis.path);
      set({ fatigueSession: { ...session, analyzed: null, errorKey: refusal.key, diagnostic: refusal.diagnostic,
        focusedField: refusal.field ?? session.focusedField } });
      return;
    }
    set({ fatigueSession: { ...session, analyzed: { input: checked.input, result: analysis.result }, errorKey: null,
      diagnostic: null } });
  },
  saveFatigue: () => {
    const state = get(), session = state.fatigueSession;
    if (session === null || session.ownerId !== state.activeDocumentId) return;
    const owner = state.assembly ?? state.document;
    const checked = fatigueSavedEntryWithPiecewise(session, owner.parameters, owner.id);
    if (!checked.ok) {
      set({ fatigueSession: { ...session, errorKey: checked.key, diagnostic: checked.diagnostic,
        focusedField: checked.field ?? session.focusedField } });
      return;
    }
    // Keep every other analysis input of the document; replace only the single fatigue configuration (either form).
    const others = owner.beamAnalysisInputs?.analyses
      .filter(input => input.kind !== 'fatigue' && input.kind !== 'fatigue-proportional-tensor' && input.kind !== 'fatigue-piecewise' && input.kind !== 'fatigue-solid-proportional') ?? [];
    const attachment = { schema: 'pointercad-beam-inputs/1', analyses: [...others, checked.entry] };
    try {
      if (state.assembly !== null) state.applyAssembly(withBeamAnalysisInputs(state.assembly, attachment));
      else state.applyDocument(withBeamAnalysisInputs(state.document, attachment));
    } catch (error) {
      set({ fatigueSession: { ...session, errorKey: 'fatigue.error.save',
        diagnostic: error instanceof Error ? error.message : null } });
      return;
    }
    // applyAssembly/applyDocument return without a change when no Undo history exists; never report that as saved.
    const after = get();
    if (!fatigueEntryIsSavedWithPiecewise(session, owner.parameters, savedFatigueEntry(after.assembly ?? after.document))) {
      set({ fatigueSession: { ...session, errorKey: 'fatigue.error.save', diagnostic: null } });
      return;
    }
    // Existing modes retain a current result on save. Solid results additionally require the live CAD/native snapshot,
    // which the panel rechecks; a save or Undo that invalidates that snapshot must not keep its result visible.
    const next = after.fatigueSession;
    if (next !== null) set({ fatigueSession: { ...next, errorKey: null, diagnostic: null } });
  },
});
};
