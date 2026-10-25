import type { StateCreator } from 'zustand';
import { withBeamAnalysisInputs } from '@pointercad/model/beam-analysis';
import { createFatigueStrainSession, editFatigueStrainSession, fatigueStrainDraftIsSaved, fatigueStrainSaved,
  restoreFatigueStrainSession, runFatigueStrainSession, savedFatigueStrainConfiguration, type FatigueStrainEdit,
  type FatigueStrainSession } from '../fatigueStrain/fatigueStrainSession.js';
import type { AppState } from './appState.js';

export interface FatigueStrainSlice {
  readonly fatigueStrainSession: FatigueStrainSession | null;
  readonly openFatigueStrain: () => void;
  readonly closeFatigueStrain: () => void;
  readonly editFatigueStrain: (edit: FatigueStrainEdit) => void;
  readonly runFatigueStrain: () => void;
  readonly saveFatigueStrain: () => void;
}

/** The strain-life estimate is a pure synchronous calculation (no Worker). Inputs are saved only on request, into the
 * owner document's analysis-input attachment (the assembly when one is open, otherwise the part), through the existing
 * Undo history, as the separate `fatigue-strain-life` kind: the stress-life `fatigue` input is never replaced. A result
 * is never stored or restored, and is shown only for the draft revision that produced it. */
export const createFatigueStrainSlice: StateCreator<AppState, [], [], FatigueStrainSlice> = (set, get) => ({
  fatigueStrainSession: null,
  openFatigueStrain: () => {
    const state = get();
    if (state.strengthSession === null) return;
    const saved = savedFatigueStrainConfiguration(state.assembly ?? state.document);
    set({ fatigueStrainSession: saved === null ? createFatigueStrainSession(state.activeDocumentId)
      : restoreFatigueStrainSession(state.activeDocumentId, saved) });
  },
  closeFatigueStrain: () => { set({ fatigueStrainSession: null }); },
  editFatigueStrain: edit => {
    const session = get().fatigueStrainSession;
    if (session === null) return;
    const next = editFatigueStrainSession(session, edit);
    if (next !== session) set({ fatigueStrainSession: next });
  },
  runFatigueStrain: () => {
    const state = get(), session = state.fatigueStrainSession;
    if (session === null || session.ownerId !== state.activeDocumentId) return;
    set({ fatigueStrainSession: runFatigueStrainSession(session, (state.assembly ?? state.document).id) });
  },
  saveFatigueStrain: () => {
    const state = get(), session = state.fatigueStrainSession;
    if (session === null || session.ownerId !== state.activeDocumentId) return;
    const owner = state.assembly ?? state.document;
    const checked = fatigueStrainSaved(session, owner.id);
    if (!checked.ok) {
      // The document is not touched; an invalid draft has no current result to keep.
      set({ fatigueStrainSession: { ...session, analyzed: null, refusal: checked.refusal } });
      return;
    }
    // Keep every other analysis input of the document (including stress-life fatigue); replace only this kind.
    const others = owner.beamAnalysisInputs?.analyses.filter(input => input.kind !== 'fatigue-strain-life') ?? [];
    const attachment = { schema: 'pointercad-beam-inputs/1',
      analyses: [...others, { kind: 'fatigue-strain-life', definition: checked.saved }] };
    try {
      if (state.assembly !== null) state.applyAssembly(withBeamAnalysisInputs(state.assembly, attachment));
      else state.applyDocument(withBeamAnalysisInputs(state.document, attachment));
    } catch {
      // The attachment reader refused the combined inputs; the document is unchanged.
      set({ fatigueStrainSession: { ...session, refusal: { key: 'fatigueStrain.error.save', code: null, path: null } } });
      return;
    }
    // applyAssembly/applyDocument return without a change when no Undo history exists; never report that as saved.
    const after = get();
    if (!fatigueStrainDraftIsSaved(session, owner.id, savedFatigueStrainConfiguration(after.assembly ?? after.document))) {
      set({ fatigueStrainSession: { ...session, refusal: { key: 'fatigueStrain.error.save', code: null, path: null } } });
      return;
    }
    // Saving changes neither the draft nor its revision, so a current result stays current.
    const next = after.fatigueStrainSession;
    if (next !== null) set({ fatigueStrainSession: { ...next, refusal: null } });
  },
});
