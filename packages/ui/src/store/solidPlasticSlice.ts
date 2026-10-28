import type { StateCreator } from 'zustand';
import { withBeamAnalysisInputs } from '@pointercad/model/beam-analysis';
import { createSolidPlasticSession, solidPlasticSavedInput, type SolidPlasticField,
  type SolidPlasticSession } from '../solidPlastic/solidPlasticSession.js';
import type { AppState } from './appState.js';
import { t } from '../i18n/t.js';

/** Same contract as solidAnalysisSlice: every edit cancels the run and clears the result (no stale result survives). */
export interface SolidPlasticRunner {
  run(): void;
  cancel(): void;
  captureFaces(role: 'fixed' | 'loaded'): void;
  validate(): void;
}
export interface SolidPlasticSlice {
  readonly solidPlasticSession: SolidPlasticSession | null;
  readonly solidPlasticRunner: SolidPlasticRunner | null;
  readonly openSolidPlastic: () => void;
  readonly closeSolidPlastic: () => void;
  readonly editSolidPlastic: (field: SolidPlasticField, source: string) => void;
  readonly focusSolidPlastic: (field: SolidPlasticField) => void;
  readonly saveSolidPlastic: () => void;
  readonly cancelSolidPlastic: () => void;
}
export const createSolidPlasticSlice: StateCreator<AppState, [], [], SolidPlasticSlice> = (set, get) => ({
  solidPlasticSession: null, solidPlasticRunner: null,
  openSolidPlastic: () => {
    const state = get();
    if (state.strengthSession === null || state.assembly !== null || state.drawing !== null) return;
    state.solidPlasticRunner?.cancel();
    const saved = state.document.beamAnalysisInputs?.analyses.find(value => value.kind === 'solid-plastic-cad');
    state.setSelectionKind('face');
    state.setSelection([]);
    set({ solidPlasticSession: createSolidPlasticSession(state.activeDocumentId,
      saved?.kind === 'solid-plastic-cad' ? saved.definition : undefined) });
  },
  closeSolidPlastic: () => { get().solidPlasticRunner?.cancel(); set({ solidPlasticSession: null }); },
  editSolidPlastic: (field, source) => {
    const state = get(), session = state.solidPlasticSession;
    if (!session) return;
    state.solidPlasticRunner?.cancel();
    set({ solidPlasticSession: { ...session, revision: session.revision + 1, values: { ...session.values, [field]: source },
      result: null, error: null, status: 'editing' } });
  },
  focusSolidPlastic: focused => {
    const session = get().solidPlasticSession;
    if (session) set({ solidPlasticSession: { ...session, focused } });
  },
  cancelSolidPlastic: () => {
    get().solidPlasticRunner?.cancel();
    const session = get().solidPlasticSession;
    if (session) set({ solidPlasticSession: { ...session, result: null, status: 'cancelled' } });
  },
  /** Saved through the existing document contract (applyDocument), so Undo/Redo and save/reopen cover it. */
  saveSolidPlastic: () => {
    const state = get(), session = state.solidPlasticSession;
    if (!session || session.ownerId !== state.activeDocumentId || state.assembly !== null || state.drawing !== null) return;
    try {
      if (!state.solidPlasticRunner) throw new Error(t('solidPlastic.failed'));
      state.solidPlasticRunner.validate();
      const definition = solidPlasticSavedInput(session, state.document.id, state.document.parameters);
      const others = state.document.beamAnalysisInputs?.analyses.filter(value => value.kind !== 'solid-plastic-cad') ?? [];
      state.applyDocument(withBeamAnalysisInputs(state.document, {
        schema: 'pointercad-beam-inputs/1', analyses: [...others, { kind: 'solid-plastic-cad', definition }],
      }));
    } catch (error) {
      const current = get().solidPlasticSession;
      if (current) set({ solidPlasticSession: { ...current, error: error instanceof Error ? error.message : t('solidPlastic.failed') } });
    }
  },
});
