import type { StateCreator } from 'zustand';
import { withBeamAnalysisInputs } from '@pointercad/model/beam-analysis';
import { createFatigueLocalCycleSession, editFatigueLocalCycleSession, fatigueLocalCycleDraftIsSaved, fatigueLocalCycleSaved,
  restoreFatigueLocalCycleSession, runFatigueLocalCycleSession, savedFatigueLocalCycleInput, type FatigueLocalCycleEdit,
  type FatigueLocalCycleSession } from '../fatigueLocalCycle/fatigueLocalCycleSession.js';
import type { AppState } from './appState.js';

export interface FatigueLocalCycleSlice {
  readonly fatigueLocalCycleSession: FatigueLocalCycleSession | null;
  readonly openFatigueLocalCycle: () => void;
  readonly closeFatigueLocalCycle: () => void;
  readonly editFatigueLocalCycle: (edit: FatigueLocalCycleEdit) => void;
  readonly runFatigueLocalCycle: () => void;
  readonly saveFatigueLocalCycle: () => void;
}

/** A pure synchronous estimate (no Worker). Inputs are saved only on request into the owner document's analysis-input
 * attachment through the existing Undo history, as the separate `fatigue-local-cycle` kind; every other input kind
 * (stress-life fatigue, strain-life histories, beams, solids) is kept. A result is never stored or restored. */
export const createFatigueLocalCycleSlice: StateCreator<AppState, [], [], FatigueLocalCycleSlice> = (set, get) => ({
  fatigueLocalCycleSession: null,
  openFatigueLocalCycle: () => {
    const state = get();
    if (state.strengthSession === null) return;
    const saved = savedFatigueLocalCycleInput(state.assembly ?? state.document);
    set({ fatigueLocalCycleSession: saved === null ? createFatigueLocalCycleSession(state.activeDocumentId)
      : restoreFatigueLocalCycleSession(state.activeDocumentId, saved) });
  },
  closeFatigueLocalCycle: () => { set({ fatigueLocalCycleSession: null }); },
  editFatigueLocalCycle: edit => {
    const session = get().fatigueLocalCycleSession;
    if (session !== null) set({ fatigueLocalCycleSession: editFatigueLocalCycleSession(session, edit) });
  },
  runFatigueLocalCycle: () => {
    const state = get(), session = state.fatigueLocalCycleSession;
    if (session === null || session.ownerId !== state.activeDocumentId) return;
    set({ fatigueLocalCycleSession: runFatigueLocalCycleSession(session, (state.assembly ?? state.document).id) });
  },
  saveFatigueLocalCycle: () => {
    const state = get(), session = state.fatigueLocalCycleSession;
    if (session === null || session.ownerId !== state.activeDocumentId) return;
    const owner = state.assembly ?? state.document;
    const checked = fatigueLocalCycleSaved(session, owner.id);
    if (!checked.ok) {
      // The document is not touched; an invalid draft has no current result to keep.
      set({ fatigueLocalCycleSession: { ...session, analyzed: null, refusal: checked.refusal } });
      return;
    }
    const others = owner.beamAnalysisInputs?.analyses.filter(input => input.kind !== 'fatigue-local-cycle') ?? [];
    const attachment = { schema: 'pointercad-beam-inputs/1', analyses: [...others, { kind: 'fatigue-local-cycle', definition: checked.saved }] };
    try {
      if (state.assembly !== null) state.applyAssembly(withBeamAnalysisInputs(state.assembly, attachment));
      else state.applyDocument(withBeamAnalysisInputs(state.document, attachment));
    } catch {
      // The attachment reader refused the combined inputs; the document is unchanged.
      set({ fatigueLocalCycleSession: { ...session, refusal: { key: 'fatigueLocalCycle.error.save', code: null, path: null } } });
      return;
    }
    // applyAssembly/applyDocument return without a change when no Undo history exists; never report that as saved.
    const after = get();
    if (!fatigueLocalCycleDraftIsSaved(session, owner.id, savedFatigueLocalCycleInput(after.assembly ?? after.document))) {
      set({ fatigueLocalCycleSession: { ...session, refusal: { key: 'fatigueLocalCycle.error.save', code: null, path: null } } });
      return;
    }
    const next = after.fatigueLocalCycleSession;
    if (next !== null) set({ fatigueLocalCycleSession: { ...next, refusal: null } });
  },
});
