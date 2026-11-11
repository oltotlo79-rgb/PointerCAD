import type { StateCreator } from 'zustand';
import { withBeamAnalysisInputs } from '@pointercad/model/beam-analysis';
import { createShellAnalysisSession, shellSavedInput, SHELL_DOFS,
  type ShellAnalysisSession, type ShellDof, type ShellField, type ShellLoadComponent, type ShellMaterialSourceDraft,
  type ShellStressComponent } from '../shellAnalysis/shellAnalysisSession.js';
import type { AppState } from './appState.js';
import { t } from '../i18n/t.js';

/** The selection capture and the run belong to attachShellAnalysis (it owns the FEM client and the CAD context). */
export interface ShellAnalysisRunner {
  run(): void;
  cancel(): void;
  /** 'midsurface': selected faces of one CAD sheet body; 'support': selected edges/vertices; 'load': selected edges. */
  capture(role: 'midsurface' | 'support' | 'load'): void;
  validate(): void;
}
export interface ShellAnalysisSlice {
  readonly shellAnalysisSession: ShellAnalysisSession | null;
  readonly shellAnalysisRunner: ShellAnalysisRunner | null;
  readonly openShellAnalysis: () => void;
  readonly closeShellAnalysis: () => void;
  /** Physical edits: cancel a pending run, advance the revision and drop the previous result. */
  readonly editShellAnalysis: (field: ShellField, source: string) => void;
  readonly editShellMaterialSource: (change: Partial<ShellMaterialSourceDraft>) => void;
  readonly setShellSupportFixed: (key: string, dof: ShellDof, fixed: boolean) => void;
  readonly removeShellSupport: (key: string) => void;
  readonly editShellEdgeLoad: (key: string, component: ShellLoadComponent, source: string) => void;
  readonly removeShellEdgeLoad: (key: string) => void;
  readonly clearShellMidsurface: () => void;
  readonly focusShellAnalysis: (field: string) => void;
  readonly cancelShellAnalysis: () => void;
  readonly saveShellAnalysis: () => void;
  /** Display only: the shown stress component of the current result. Never cancels, re-runs, saves or changes the revision. */
  readonly setShellAnalysisView: (component: ShellStressComponent) => void;
}

function owned(state: AppState): ShellAnalysisSession | null {
  const session = state.shellAnalysisSession;
  return session !== null && session.ownerId === state.activeDocumentId && state.assembly === null && state.drawing === null
    ? session : null;
}
function physicalEdit(state: AppState, session: ShellAnalysisSession, change: Partial<ShellAnalysisSession>):
  Pick<AppState, 'shellAnalysisSession'> {
  state.shellAnalysisRunner?.cancel();
  return { shellAnalysisSession: { ...session, ...change, revision: session.revision + 1, status: 'editing', result: null,
    error: null } };
}

export const createShellAnalysisSlice: StateCreator<AppState, [], [], ShellAnalysisSlice> = (set, get) => ({
  shellAnalysisSession: null,
  shellAnalysisRunner: null,
  openShellAnalysis: () => {
    const state = get();
    if (state.strengthSession === null || state.assembly !== null || state.drawing !== null) return;
    state.shellAnalysisRunner?.cancel();
    const saved = state.document.beamAnalysisInputs?.analyses.find(value => value.kind === 'shell-cad-analysis');
    let session = createShellAnalysisSession(state.activeDocumentId);
    let error: string | null = null;
    if (saved?.kind === 'shell-cad-analysis') {
      try { session = createShellAnalysisSession(state.activeDocumentId, saved.definition); }
      catch (failure) { error = `${t('shellAnalysis.savedUnreadable')} ${failure instanceof Error ? failure.message : ''}`.trim(); }
    }
    state.setSelectionKind('face');
    state.setSelection([]);
    set({ shellAnalysisSession: { ...session, error } });
  },
  closeShellAnalysis: () => {
    get().shellAnalysisRunner?.cancel();
    set({ shellAnalysisSession: null });
  },
  editShellAnalysis: (field, source) => {
    const state = get(), session = owned(state);
    if (!session || session.values[field] === source) return;
    set(physicalEdit(state, session, { values: { ...session.values, [field]: source } }));
  },
  editShellMaterialSource: change => {
    const state = get(), session = owned(state);
    if (!session) return;
    const next = { ...session.materialSource, ...change };
    if (next.kind === session.materialSource.kind && next.reference === session.materialSource.reference
      && next.condition === session.materialSource.condition) return;
    set(physicalEdit(state, session, { materialSource: next }));
  },
  setShellSupportFixed: (key, dof, fixed) => {
    const state = get(), session = owned(state);
    const row = session?.supports.find(value => value.key === key);
    const index = SHELL_DOFS.indexOf(dof);
    if (!session || !row || index < 0 || row.fixed[index] === fixed) return;
    const flags = [...row.fixed];
    flags[index] = fixed;
    const [ux, uy, uz, rx, ry, rz] = flags;
    set(physicalEdit(state, session, { supports: session.supports.map(value => value === row
      ? { ...row, fixed: [ux, uy, uz, rx, ry, rz] } : value) }));
  },
  removeShellSupport: key => {
    const state = get(), session = owned(state);
    if (!session || !session.supports.some(row => row.key === key)) return;
    set(physicalEdit(state, session, { supports: session.supports.filter(row => row.key !== key) }));
  },
  editShellEdgeLoad: (key, component, source) => {
    const state = get(), session = owned(state);
    const row = session?.edgeLoads.find(value => value.key === key);
    if (!session || !row || row.values[component] === source) return;
    set(physicalEdit(state, session, { edgeLoads: session.edgeLoads.map(value => value === row
      ? { ...row, values: { ...row.values, [component]: source } } : value) }));
  },
  removeShellEdgeLoad: key => {
    const state = get(), session = owned(state);
    if (!session || !session.edgeLoads.some(row => row.key === key)) return;
    set(physicalEdit(state, session, { edgeLoads: session.edgeLoads.filter(row => row.key !== key) }));
  },
  clearShellMidsurface: () => {
    const state = get(), session = owned(state);
    if (!session || (session.bodyFeatureId === null && session.midsurfaceFaces.length === 0)) return;
    // Supports and loads belong to the body of the midsurface; they go with it rather than being rebound elsewhere.
    set(physicalEdit(state, session, { bodyFeatureId: null, midsurfaceFaces: [], supports: [], edgeLoads: [] }));
  },
  focusShellAnalysis: focused => {
    const session = get().shellAnalysisSession;
    if (session && session.focused !== focused) set({ shellAnalysisSession: { ...session, focused } });
  },
  cancelShellAnalysis: () => {
    get().shellAnalysisRunner?.cancel();
    const session = get().shellAnalysisSession;
    if (session && session.status === 'running') set({ shellAnalysisSession: { ...session, result: null, status: 'cancelled' } });
  },
  saveShellAnalysis: () => {
    const state = get(), session = owned(state);
    if (!session) return;
    try {
      if (!state.shellAnalysisRunner) throw new Error(t('shellAnalysis.failed'));
      state.shellAnalysisRunner.validate();
      const definition = shellSavedInput(session, state.document.id, state.document.parameters);
      const others = state.document.beamAnalysisInputs?.analyses.filter(value => value.kind !== 'shell-cad-analysis') ?? [];
      state.applyDocument(withBeamAnalysisInputs(state.document, {
        schema: 'pointercad-beam-inputs/1', analyses: [...others, { kind: 'shell-cad-analysis', definition }],
      }));
    } catch (error) {
      const current = get().shellAnalysisSession;
      if (current) set({ shellAnalysisSession: { ...current, error: error instanceof Error ? error.message : t('shellAnalysis.failed') } });
    }
  },
  setShellAnalysisView: component => {
    const session = get().shellAnalysisSession;
    if (session && session.view.component !== component) set({ shellAnalysisSession: { ...session, view: { component } } });
  },
});
