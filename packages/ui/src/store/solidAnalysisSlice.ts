import type { StateCreator } from 'zustand';
import { withBeamAnalysisInputs, type AnalysisMaterialCapacity, type SolidCadSavedInput } from '@pointercad/model/beam-analysis';
import { createSolidAnalysisSession, solidSavedInput, type SolidAnalysisSession, type SolidField,
  type SolidLoadMode } from '../solidAnalysis/solidAnalysisSession.js';
import type { AppState } from './appState.js';
import type { SolidFieldViewChoice } from '../solidAnalysis/solidFieldState.js';
import { t } from '../i18n/t.js';
import { cancelSolidModal, editSolidModalInput, initialSolidModalState, invalidateSolidModal, receiveSolidModal,
  setSolidModalView, startSolidModal, type SolidModalReply, type SolidModalRunState } from '../solidAnalysis/solidModalState.js';
import type { SolidModeDisplay } from '../solidAnalysis/solidModeView.js';
import { solidModalSavedInput, withSolidModalSaved } from '../solidAnalysis/solidModalSaved.js';
import type { SolidModalSharedInput } from '../solidAnalysis/solidModalShared.js';
import { cancelSolidBuckling, editSolidBucklingCount, initialSolidBucklingState, invalidateSolidBuckling, receiveSolidBuckling,
  setSolidBucklingView, startSolidBuckling, type SolidBucklingReply, type SolidBucklingRunState }
  from '../solidAnalysis/solidBucklingState.js';
import { solidBucklingSavedInput, withSolidBucklingSaved } from '../solidAnalysis/solidBucklingSaved.js';
import { createSolidBoundaryDraft, createSolidSupport, SOLID_BOUNDARY_INDEX,
  type SolidBoundaryAxis, type SolidGravityField } from '../solidAnalysis/solidBoundaryDraft.js';

export interface SolidAnalysisRunner {
  run(): void;
  cancel(): void;
  captureFaces(role: 'fixed' | 'loaded' | 'support'): void;
  validate(): void;
  /** Modal run of the same session (attachSolidAnalysis); optional so other runners stay valid. */
  runModal?(): void;
  cancelModal?(): void;
  /** Linear prestress buckling run of the same session; optional so other runners stay valid. */
  runBuckling?(): void;
  cancelBuckling?(): void;
}
export interface SolidAnalysisSlice {
  readonly solidAnalysisSession: SolidAnalysisSession | null;
  readonly solidAnalysisRunner: SolidAnalysisRunner | null;
  readonly openSolidAnalysis: () => void;
  readonly closeSolidAnalysis: () => void;
  readonly editSolidAnalysis: (field: SolidField, source: string) => void;
  /** Switches the single surface load. Like an edit it cancels a pending run and drops the stale result. */
  readonly setSolidAnalysisLoadMode: (mode: SolidLoadMode) => void;
  /** Atomic material/value validity edit; null,true explicitly keeps elastic analysis without yield evidence. */
  readonly setSolidAnalysisMaterial: (capacity: AnalysisMaterialCapacity | null, valid: boolean) => void;
  readonly focusSolidAnalysis: (field: SolidField) => void;
  readonly editSolidSupport: (face: string, axis: SolidBoundaryAxis, change: { readonly fixed: boolean } | { readonly displacement: string }) => void;
  readonly removeSolidSupport: (face: string) => void;
  readonly convertSolidFixedFace: (face: string) => void;
  readonly removeSolidFixedFace: (face: string) => void;
  readonly clearSolidLoadedFaces: () => void;
  readonly setSolidGravityEnabled: (enabled: boolean) => void;
  readonly editSolidGravity: (field: SolidGravityField, source: string) => void;
  readonly focusSolidBoundary: (field: string) => void;
  readonly saveSolidAnalysis: () => void;
  readonly cancelSolidAnalysis: () => void;
  /** Changes only how the current result is shown; never cancels, re-runs or saves. Non-finite or negative scales are refused. */
  readonly setSolidAnalysisFieldView: (change: Partial<SolidFieldViewChoice>) => void;
  /** Modal (free vibration) run of the same session: physical drafts, bound result and display-only view. */
  readonly solidModal: SolidModalRunState;
  /** Starts a modal request and returns its id; only the reply carrying this id is accepted. */
  readonly startSolidModal: () => number;
  readonly receiveSolidModal: (requestId: number, reply: SolidModalReply) => void;
  readonly cancelSolidModal: () => void;
  /** Physical modal input (density kg/m^3, number of modes): cancels a pending run and drops the result. */
  readonly editSolidModalInput: (field: 'density' | 'modeCount', text: string) => void;
  /** Display only: never cancels, re-runs, saves or changes the request. */
  readonly setSolidModalView: (view: SolidModeDisplay, amplitudeText: string) => void;
  /** Saves only the physical modal input (kind 'solid-modal-cad'); never a mode, shape or display choice. */
  readonly saveSolidModal: () => void;
  /** Shared physical values of an independently saved modal input; null: the modal run uses the panel's values. */
  readonly solidModalShared: SolidModalSharedInput | null;
  /** Explicit choice: from now on the modal analysis runs and saves with the panel's current values. */
  readonly adoptPanelForSolidModal: () => void;
  /** Linear prestress buckling of the same session: count draft and the result bound to its request. */
  readonly solidBuckling: SolidBucklingRunState;
  /** Starts a buckling request and returns its id; only the reply carrying this id is accepted. */
  readonly startSolidBuckling: () => number;
  readonly receiveSolidBuckling: (requestId: number, reply: SolidBucklingReply) => void;
  readonly cancelSolidBuckling: () => void;
  /** Number of requested load factors: cancels a pending run and drops the result. */
  readonly editSolidBucklingCount: (text: string) => void;
  /** Saves only the buckling input (kind 'solid-buckling-cad'): the count and the reference static input. */
  readonly saveSolidBuckling: () => void;
  /** Reference static input of an independently saved buckling input; null: the buckling run uses the panel's input. */
  readonly solidBucklingReference: SolidCadSavedInput | null;
  /** Explicit choice: from now on the buckling analysis runs and saves with the panel's current static input. */
  readonly adoptPanelForSolidBuckling: () => void;
  /** Display only (drawn mode, amplitude, phase, shown or not): never cancels, re-runs, saves or changes the request. */
  readonly setSolidBucklingView: (view: SolidModeDisplay, amplitudeText: string, showShape: boolean) => void;
}
function boundarySession(state: AppState): SolidAnalysisSession | null {
  const session = state.solidAnalysisSession;
  return session?.ownerId === state.activeDocumentId && state.assembly === null && state.drawing === null ? session : null;
}
function boundaryEdit(state: AppState, session: SolidAnalysisSession, change: Partial<SolidAnalysisSession>) {
  state.solidAnalysisRunner?.cancel(); state.solidAnalysisRunner?.cancelModal?.(); state.solidAnalysisRunner?.cancelBuckling?.();
  return { solidAnalysisSession: { ...session, ...change, revision: session.revision + 1,
    status: 'editing' as const, result: null, error: null }, solidModal: invalidateSolidModal(state.solidModal),
  solidBuckling: invalidateSolidBuckling(state.solidBuckling) };
}
function zeroEmptySurfaceDraft(session: SolidAnalysisSession): SolidAnalysisSession['values'] {
  const values = { ...session.values };
  const fields = session.loadMode === 'pressure' ? ['pressure'] as const : ['tx', 'ty', 'tz'] as const;
  for (const field of fields) if (values[field].trim() === '') values[field] = '0';
  return values;
}
export const createSolidAnalysisSlice: StateCreator<AppState, [], [], SolidAnalysisSlice> = (set, get) => ({
  solidAnalysisSession: null, solidAnalysisRunner: null,
  solidModal: initialSolidModalState(),
  solidModalShared: null,
  solidBuckling: initialSolidBucklingState(),
  solidBucklingReference: null,
  openSolidAnalysis: () => {
    const state = get();
    if (state.strengthSession === null || state.assembly !== null || state.drawing !== null) return;
    state.solidAnalysisRunner?.cancel(); state.solidAnalysisRunner?.cancelModal?.(); state.solidAnalysisRunner?.cancelBuckling?.();
    const saved = state.document.beamAnalysisInputs?.analyses.find(value => value.kind === 'solid-cad');
    state.setSelectionKind('face');
    state.setSelection([]);
    // Reopen: the saved modal input fills the modal drafts (and the shared fields when no static input was saved).
    const modalSaved = state.document.beamAnalysisInputs?.analyses.find(value => value.kind === 'solid-modal-cad');
    // The saved buckling input first: with no static input saved its reference fills the panel, and the modal input is
    // then compared with that panel input exactly as with a saved static input (no buckling input: unchanged).
    const staticSaved = saved?.kind === 'solid-cad' ? saved.definition : undefined;
    const bucklingSaved = state.document.beamAnalysisInputs?.analyses.find(value => value.kind === 'solid-buckling-cad');
    const buckled = withSolidBucklingSaved(createSolidAnalysisSession(state.activeDocumentId, staticSaved),
      invalidateSolidBuckling(state.solidBuckling), bucklingSaved?.kind === 'solid-buckling-cad' ? bucklingSaved.definition : undefined,
      staticSaved);
    const opened = withSolidModalSaved(buckled.session,
      invalidateSolidModal(state.solidModal), modalSaved?.kind === 'solid-modal-cad' ? modalSaved.definition : undefined,
      staticSaved ?? (bucklingSaved?.kind === 'solid-buckling-cad' ? bucklingSaved.definition.reference : undefined));
    set({ solidAnalysisSession: opened.session, solidModal: opened.modal, solidModalShared: opened.shared,
      solidBuckling: buckled.buckling, solidBucklingReference: buckled.reference });
  },
  closeSolidAnalysis: () => {
    const state = get();
    state.solidAnalysisRunner?.cancel(); state.solidAnalysisRunner?.cancelModal?.(); state.solidAnalysisRunner?.cancelBuckling?.();
    set({ solidAnalysisSession: null, solidModal: invalidateSolidModal(state.solidModal),
      solidBuckling: invalidateSolidBuckling(state.solidBuckling) });
  },
  editSolidAnalysis: (field, source) => {
    const state = get(), session = state.solidAnalysisSession;
    if (!session) return;
    state.solidAnalysisRunner?.cancel(); state.solidAnalysisRunner?.cancelModal?.(); state.solidAnalysisRunner?.cancelBuckling?.();
    set({ solidAnalysisSession: { ...session, revision: session.revision + 1, values: { ...session.values, [field]: source },
      result: null, error: null, status: 'editing' }, solidModal: invalidateSolidModal(state.solidModal),
      solidBuckling: invalidateSolidBuckling(state.solidBuckling) });
  },
  setSolidAnalysisLoadMode: mode => {
    const state = get(), session = state.solidAnalysisSession;
    if (!session || session.loadMode === mode) return;
    state.solidAnalysisRunner?.cancel(); state.solidAnalysisRunner?.cancelModal?.(); state.solidAnalysisRunner?.cancelBuckling?.();
    set({ solidAnalysisSession: { ...session, revision: session.revision + 1, loadMode: mode, focused: null,
      result: null, error: null, status: 'editing' }, solidModal: invalidateSolidModal(state.solidModal),
      solidBuckling: invalidateSolidBuckling(state.solidBuckling) });
  },
  setSolidAnalysisMaterial: (capacity, valid) => {
    const state = get(), session = state.solidAnalysisSession;
    if (!session || session.ownerId !== state.activeDocumentId || state.assembly !== null || state.drawing !== null) return;
    const next = valid ? capacity : null;
    if ((session.capacity ?? null) === next && (session.materialInputValid ?? true) === valid) return;
    state.solidAnalysisRunner?.cancel(); state.solidAnalysisRunner?.cancelModal?.(); state.solidAnalysisRunner?.cancelBuckling?.();
    const { capacity: previousCapacity, ...remaining } = session;
    void previousCapacity;
    // Do not retain the previous material behind a null/invalid draft. Saving revalidates authored capacity.
    set({ solidAnalysisSession: { ...remaining, ...(next === null ? {} : { capacity: next }),
      materialInputValid: valid, revision: session.revision + 1, result: null,
      error: valid ? null : t('solidAnalysis.material.stale'), status: 'editing' },
      solidModal: invalidateSolidModal(state.solidModal), solidBuckling: invalidateSolidBuckling(state.solidBuckling) });
  },
  setSolidAnalysisFieldView: change => {
    const session = get().solidAnalysisSession;
    if (!session) return;
    const scale = change.deformationScale ?? session.fieldView.deformationScale;
    if (!Number.isFinite(scale) || scale < 0) return;
    set({ solidAnalysisSession: { ...session, fieldView: { quantity: change.quantity ?? session.fieldView.quantity, deformationScale: scale } } });
  },
  focusSolidAnalysis: focused => {
    const session = get().solidAnalysisSession;
    if (session) set({ solidAnalysisSession: { ...session, focused, boundaryFocused: null } });
  },
  focusSolidBoundary: boundaryFocused => {
    const session = boundarySession(get());
    if (session) set({ solidAnalysisSession: { ...session, focused: null, boundaryFocused } });
  },
  editSolidSupport: (face, axis, change) => {
    const state = get(), session = boundarySession(state);
    if (!session) return;
    const index = SOLID_BOUNDARY_INDEX[axis], rows = session.supports ?? [], row = rows.find(value => value.face === face);
    if (!row || ('fixed' in change ? row.fixed[index] === change.fixed
      : !row.fixed[index] || row.displacement[index] === change.displacement)) return;
    const fixed: [boolean, boolean, boolean] = [...row.fixed], displacement: [string, string, string] = [...row.displacement];
    if ('fixed' in change) { fixed[index] = change.fixed; if (!change.fixed) displacement[index] = '0'; }
    else displacement[index] = change.displacement;
    const next = { ...row, fixed, displacement, prescribed: row.prescribed || 'displacement' in change };
    set(boundaryEdit(state, session, { supports: rows.map(value => value === row ? next : value) }));
  },
  removeSolidSupport: face => {
    const state = get(), session = boundarySession(state);
    if (!session || !(session.supports ?? []).some(row => row.face === face)) return;
    set(boundaryEdit(state, session, { supports: session.supports?.filter(row => row.face !== face) ?? [], boundaryFocused: null }));
  },
  convertSolidFixedFace: face => {
    const state = get(), session = boundarySession(state);
    if (!session || !session.fixedFaces.includes(face) || session.supports?.some(row => row.face === face)) return;
    set(boundaryEdit(state, session, { fixedFaces: session.fixedFaces.filter(value => value !== face),
      supports: [...(session.supports ?? []), createSolidSupport(face)], boundaryFocused: null }));
  },
  removeSolidFixedFace: face => {
    const state = get(), session = boundarySession(state);
    if (!session || !session.fixedFaces.includes(face)) return;
    set(boundaryEdit(state, session, { fixedFaces: session.fixedFaces.filter(value => value !== face), boundaryFocused: null }));
  },
  clearSolidLoadedFaces: () => {
    const state = get(), session = boundarySession(state);
    if (!session || session.loadedFaces.length === 0) return;
    set(boundaryEdit(state, session, { loadedFaces: [], values: zeroEmptySurfaceDraft(session) }));
  },
  setSolidGravityEnabled: enabled => {
    const state = get(), session = boundarySession(state);
    if (!session) return;
    const gravity = session.gravity ?? createSolidBoundaryDraft().gravity;
    if (gravity.enabled === enabled) return;
    set(boundaryEdit(state, session, { gravity: { ...gravity, enabled }, boundaryFocused: null,
      ...(enabled && session.loadedFaces.length === 0 ? { values: zeroEmptySurfaceDraft(session) } : {}) }));
  },
  editSolidGravity: (field, source) => {
    const state = get(), session = boundarySession(state);
    if (!session) return;
    const gravity = session.gravity ?? createSolidBoundaryDraft().gravity;
    if (field === 'density') {
      if (gravity.density !== source) set(boundaryEdit(state, session, { gravity: { ...gravity, density: source } }));
    } else {
      const index = SOLID_BOUNDARY_INDEX[field];
      if (gravity.acceleration[index] === source) return;
      const acceleration: [string, string, string] = [...gravity.acceleration]; acceleration[index] = source;
      set(boundaryEdit(state, session, { gravity: { ...gravity, acceleration } }));
    }
  },
  cancelSolidAnalysis: () => {
    get().solidAnalysisRunner?.cancel();
    const session = get().solidAnalysisSession;
    if (session) set({ solidAnalysisSession: { ...session, result: null, status: 'cancelled' } });
  },
  saveSolidAnalysis: () => {
    const state = get(), session = state.solidAnalysisSession;
    if (!session || session.ownerId !== state.activeDocumentId || state.assembly !== null || state.drawing !== null) return;
    try {
      if (!state.solidAnalysisRunner) throw new Error(t('solidAnalysis.failed'));
      state.solidAnalysisRunner.validate();
      const definition = solidSavedInput(session, state.document.id, state.document.parameters);
      const others = state.document.beamAnalysisInputs?.analyses.filter(value => value.kind !== 'solid-cad') ?? [];
      state.applyDocument(withBeamAnalysisInputs(state.document, {
        schema: 'pointercad-beam-inputs/1', analyses: [...others, { kind: 'solid-cad', definition }],
      }));
    } catch (error) {
      const current = get().solidAnalysisSession;
      if (current) set({ solidAnalysisSession: { ...current, error: error instanceof Error ? error.message : t('solidAnalysis.failed') } });
    }
  },
  startSolidModal: () => {
    const next = startSolidModal(get().solidModal);
    set({ solidModal: next });
    return next.requestId;
  },
  receiveSolidModal: (requestId, reply) => { set({ solidModal: receiveSolidModal(get().solidModal, requestId, reply) }); },
  cancelSolidModal: () => {
    get().solidAnalysisRunner?.cancelModal?.();
    set({ solidModal: cancelSolidModal(get().solidModal) });
  },
  editSolidModalInput: (field, text) => {
    get().solidAnalysisRunner?.cancelModal?.();
    set({ solidModal: editSolidModalInput(get().solidModal, field, text) });
  },
  setSolidModalView: (view, amplitudeText) => { set({ solidModal: setSolidModalView(get().solidModal, view, amplitudeText) }); },
  saveSolidModal: () => {
    const state = get(), session = state.solidAnalysisSession;
    if (!session || session.ownerId !== state.activeDocumentId || state.assembly !== null || state.drawing !== null) return;
    try {
      const definition = solidModalSavedInput(session, state.solidModal, state.solidModalShared, state.document.id, state.document.parameters, state.bodies);
      const others = state.document.beamAnalysisInputs?.analyses.filter(value => value.kind !== 'solid-modal-cad') ?? [];
      state.applyDocument(withBeamAnalysisInputs(state.document, {
        schema: 'pointercad-beam-inputs/1', analyses: [...others, { kind: 'solid-modal-cad', definition }],
      }));
    } catch (error) {
      set({ solidModal: { ...get().solidModal, error: error instanceof Error ? error.message : t('solidAnalysis.modalFailed') } });
    }
  },
  adoptPanelForSolidModal: () => {
    get().solidAnalysisRunner?.cancelModal?.();
    set({ solidModalShared: null, solidModal: invalidateSolidModal(get().solidModal) });
  },
  startSolidBuckling: () => {
    const next = startSolidBuckling(get().solidBuckling);
    set({ solidBuckling: next });
    return next.requestId;
  },
  receiveSolidBuckling: (requestId, reply) => { set({ solidBuckling: receiveSolidBuckling(get().solidBuckling, requestId, reply) }); },
  cancelSolidBuckling: () => {
    get().solidAnalysisRunner?.cancelBuckling?.();
    set({ solidBuckling: cancelSolidBuckling(get().solidBuckling) });
  },
  editSolidBucklingCount: text => {
    get().solidAnalysisRunner?.cancelBuckling?.();
    set({ solidBuckling: editSolidBucklingCount(get().solidBuckling, text) });
  },
  saveSolidBuckling: () => {
    const state = get(), session = state.solidAnalysisSession;
    if (!session || session.ownerId !== state.activeDocumentId || state.assembly !== null || state.drawing !== null) return;
    try {
      const definition = solidBucklingSavedInput(session, state.solidBuckling, state.solidBucklingReference, state.document.id,
        state.document.parameters);
      const others = state.document.beamAnalysisInputs?.analyses.filter(value => value.kind !== 'solid-buckling-cad') ?? [];
      state.applyDocument(withBeamAnalysisInputs(state.document, {
        schema: 'pointercad-beam-inputs/1', analyses: [...others, { kind: 'solid-buckling-cad', definition }],
      }));
    } catch (error) {
      set({ solidBuckling: { ...get().solidBuckling, code: null,
        error: error instanceof Error ? error.message : t('solidAnalysis.bucklingFailed') } });
    }
  },
  adoptPanelForSolidBuckling: () => {
    get().solidAnalysisRunner?.cancelBuckling?.();
    set({ solidBucklingReference: null, solidBuckling: invalidateSolidBuckling(get().solidBuckling) });
  },
  setSolidBucklingView: (view, amplitudeText, showShape) => {
    set({ solidBuckling: setSolidBucklingView(get().solidBuckling, view, amplitudeText, showShape) });
  },
});
