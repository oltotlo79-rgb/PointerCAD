import type { StateCreator } from 'zustand';
import type { PlasticBarInput } from '@pointercad/fem';
import { withBeamAnalysisInputs } from '@pointercad/model/beam-analysis';
import { createPlasticBarSession, editPlasticBarSession, plasticBarInput, plasticBarSavedInput,
  restorePlasticBarSession, savedPlasticBarInput, type PlasticBarEdit,
  type PlasticBarSession } from '../plasticBar/plasticBarSession.js';
import type { AppState } from './appState.js';

export interface PlasticBarRunner {
  run(session: PlasticBarSession, input: PlasticBarInput): void;
  cancel(): void;
}
export interface PlasticBarSlice {
  readonly plasticBarSession: PlasticBarSession | null;
  readonly plasticBarRunner: PlasticBarRunner | null;
  readonly setPlasticBarRunner: (runner: PlasticBarRunner | null) => void;
  readonly openPlasticBar: () => void;
  readonly closePlasticBar: () => void;
  readonly editPlasticBar: (edit: PlasticBarEdit) => void;
  readonly runPlasticBar: () => void;
  readonly cancelPlasticBar: () => void;
  readonly savePlasticBar: () => void;
}

/** Inputs are saved only on request, into the owner document's analysis-input attachment (the assembly when one is
 * open, otherwise the part), through the existing Undo history. A result is never stored or restored. */
export const createPlasticBarSlice: StateCreator<AppState, [], [], PlasticBarSlice> = (set, get) => ({
  plasticBarSession: null,
  plasticBarRunner: null,
  setPlasticBarRunner: plasticBarRunner => { set({ plasticBarRunner }); },
  openPlasticBar: () => {
    const state = get();
    if (state.strengthSession === null) return;
    state.plasticBarRunner?.cancel();
    const saved = savedPlasticBarInput(state.assembly ?? state.document);
    set({ plasticBarSession: saved === null ? createPlasticBarSession(state.activeDocumentId)
      : restorePlasticBarSession(state.activeDocumentId, saved) });
  },
  savePlasticBar: () => {
    const state = get(), session = state.plasticBarSession;
    if (session === null || session.ownerId !== state.activeDocumentId) return;
    const owner = state.assembly ?? state.document;
    const checked = plasticBarSavedInput(session, owner.parameters, owner.id);
    if (!checked.ok) {
      set({ plasticBarSession: { ...session, errorKey: checked.key, diagnostic: checked.diagnostic,
        focusedField: checked.field ?? session.focusedField } });
      return;
    }
    // Keep every other analysis input of the document; replace only the single plastic-bar configuration.
    const others = owner.beamAnalysisInputs?.analyses.filter(input => input.kind !== 'plastic-bar') ?? [];
    const attachment = { schema: 'pointercad-beam-inputs/1', analyses: [...others, { kind: 'plastic-bar', definition: checked.saved }] };
    try {
      if (state.assembly !== null) state.applyAssembly(withBeamAnalysisInputs(state.assembly, attachment));
      else state.applyDocument(withBeamAnalysisInputs(state.document, attachment));
    } catch (error) {
      set({ plasticBarSession: { ...session, errorKey: 'plasticBar.error.save',
        diagnostic: error instanceof Error ? error.message : 'Plastic-bar inputs could not be saved' } });
      return;
    }
    // Saving changes neither the inputs nor the revision, so a current result stays current.
    const next = get().plasticBarSession;
    if (next !== null) set({ plasticBarSession: { ...next, errorKey: null, diagnostic: null } });
  },
  closePlasticBar: () => {
    get().plasticBarRunner?.cancel();
    set({ plasticBarSession: null });
  },
  editPlasticBar: edit => {
    const state = get();
    if (state.plasticBarSession === null) return;
    if (edit.kind !== 'focus') state.plasticBarRunner?.cancel();
    set({ plasticBarSession: editPlasticBarSession(state.plasticBarSession, edit) });
  },
  runPlasticBar: () => {
    const state = get(), session = state.plasticBarSession;
    if (session === null) return;
    const checked = plasticBarInput(session, state.assembly?.parameters ?? state.document.parameters);
    if (!checked.ok) {
      set({ plasticBarSession: { ...session, result: null, status: 'editing', errorKey: checked.key,
        diagnostic: checked.diagnostic, focusedField: checked.field ?? session.focusedField } });
      return;
    }
    if (state.plasticBarRunner === null) {
      set({ plasticBarSession: { ...session, result: null, status: 'failed', errorKey: 'plasticBar.error.unavailable', diagnostic: null } });
      return;
    }
    state.plasticBarRunner.run(session, checked.input);
  },
  cancelPlasticBar: () => {
    const state = get();
    state.plasticBarRunner?.cancel();
    if (state.plasticBarSession !== null) set({ plasticBarSession: { ...state.plasticBarSession, result: null,
      phase: null, status: 'cancelled', errorKey: null, diagnostic: null } });
  },
});
