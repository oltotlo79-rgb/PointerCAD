import { SOLID_FIELD_QUANTITIES } from '../solidAnalysis/solidFieldView.js';
import type { SolidFiniteFieldChoice } from '../solidFinite/solidFiniteFieldView.js';
import type { StateCreator } from 'zustand';
import { withBeamAnalysisInputs } from '@pointercad/model/beam-analysis';
import { createSolidFiniteSession, solidFiniteSavedInput, type SolidFiniteEdit, type SolidFiniteField,
  type SolidFiniteSession } from '../solidFinite/solidFiniteSession.js';
import { createSolidBoundaryDraft, createSolidSupport, SOLID_BOUNDARY_INDEX } from '../solidAnalysis/solidBoundaryDraft.js';
import type { AppState } from './appState.js';

export interface SolidFiniteRunner {
  run(): void;
  cancel(): void;
  validate(): void;
  captureFaces(role: 'fixed' | 'loaded' | 'support'): void;
}
export interface SolidFiniteSlice {
  readonly solidFiniteSession: SolidFiniteSession | null;
  readonly solidFiniteRunner: SolidFiniteRunner | null;
  readonly openSolidFinite: () => void;
  readonly closeSolidFinite: () => void;
  readonly editSolidFinite: (edit: SolidFiniteEdit) => void;
  readonly setSolidFiniteFieldView: (change: Partial<SolidFiniteFieldChoice>) => void;
  readonly focusSolidFinite: (field: SolidFiniteField | null) => void;
  readonly focusSolidFiniteBoundary: (key: string | null) => void;
  readonly saveSolidFinite: () => void;
  readonly cancelSolidFinite: () => void;
}
function ownedSession(state: AppState): SolidFiniteSession | null {
  const session = state.solidFiniteSession;
  return session?.ownerId === state.activeDocumentId && state.assembly === null && state.drawing === null ? session : null;
}
/** Returns only physical draft changes. Focus never enters this path. */
function edited(session: SolidFiniteSession, edit: SolidFiniteEdit): Partial<SolidFiniteSession> | null {
  switch (edit.kind) {
    case 'field': return session.values[edit.field] === edit.value ? null : { values: { ...session.values, [edit.field]: edit.value } };
    case 'support': {
      const row = session.supports?.find(value => value.face === edit.face), axis = SOLID_BOUNDARY_INDEX[edit.axis];
      if (!row || (edit.fixed === undefined && edit.displacement === undefined)) return null;
      const fixed: [boolean, boolean, boolean] = [...row.fixed];
      const displacement: [string, string, string] = [...row.displacement];
      if (edit.fixed !== undefined) { fixed[axis] = edit.fixed; if (!edit.fixed) displacement[axis] = '0'; }
      if (edit.displacement !== undefined && fixed[axis]) displacement[axis] = edit.displacement;
      const prescribed = row.prescribed || (edit.displacement !== undefined && fixed[axis]);
      if (fixed[axis] === row.fixed[axis] && displacement[axis] === row.displacement[axis] && prescribed === row.prescribed) return null;
      return { supports: session.supports?.map(value => value === row ? { ...row, fixed, displacement, prescribed } : value) };
    }
    case 'remove-support': return session.supports?.some(row => row.face === edit.face)
      ? { supports: session.supports.filter(row => row.face !== edit.face), boundaryFocused: null } : null;
    case 'convert-clamp': return session.fixedFaces.includes(edit.face) && !session.supports?.some(row => row.face === edit.face)
      ? { fixedFaces: session.fixedFaces.filter(face => face !== edit.face),
        supports: [...(session.supports ?? []), createSolidSupport(edit.face)], boundaryFocused: null } : null;
    case 'remove-clamp': return session.fixedFaces.includes(edit.face)
      ? { fixedFaces: session.fixedFaces.filter(face => face !== edit.face), boundaryFocused: null } : null;
    case 'clear-loaded': return session.loadedFaces.length === 0 ? null : { loadedFaces: [] };
    case 'gravity-enabled': {
      const gravity = session.gravity ?? createSolidBoundaryDraft().gravity;
      return gravity.enabled === edit.enabled ? null : { gravity: { ...gravity, enabled: edit.enabled }, boundaryFocused: null };
    }
    case 'gravity': {
      const gravity = session.gravity ?? createSolidBoundaryDraft().gravity;
      if (edit.field === 'density') return gravity.density === edit.value ? null : { gravity: { ...gravity, density: edit.value } };
      const axis = SOLID_BOUNDARY_INDEX[edit.field];
      if (gravity.acceleration[axis] === edit.value) return null;
      const acceleration: [string, string, string] = [...gravity.acceleration]; acceleration[axis] = edit.value;
      return { gravity: { ...gravity, acceleration } };
    }
  }
}
export const createSolidFiniteSlice: StateCreator<AppState, [], [], SolidFiniteSlice> = (set, get) => ({
  solidFiniteSession: null, solidFiniteRunner: null,
  openSolidFinite: () => {
    const state = get();
    if (state.strengthSession === null || state.assembly !== null || state.drawing !== null) return;
    state.solidFiniteRunner?.cancel();
    const saved = state.document.beamAnalysisInputs?.analyses.find(value => value.kind === 'solid-finite-cad');
    state.setSelectionKind('face'); state.setSelection([]);
    set({ solidFiniteSession: createSolidFiniteSession(state.activeDocumentId,
      saved?.kind === 'solid-finite-cad' ? saved.definition : undefined) });
  },
  closeSolidFinite: () => { get().solidFiniteRunner?.cancel(); set({ solidFiniteSession: null }); },
  editSolidFinite: edit => {
    const state = get(), session = ownedSession(state);
    if (!session) return;
    const change = edited(session, edit);
    if (change === null) return;
    state.solidFiniteRunner?.cancel();
    set({ solidFiniteSession: { ...session, ...change, revision: session.revision + 1,
      result: null, error: null, status: 'editing' } });
  },
  setSolidFiniteFieldView: change => {
    const session = ownedSession(get());
    if (!session || session.status !== 'complete' || session.result === null) return;
    const next = { ...session.fieldView, ...change };
    if (!Number.isSafeInteger(next.step) || !session.result.result.records.some(record => record.step === next.step)
      || !SOLID_FIELD_QUANTITIES.some(quantity => quantity === next.quantity)
      || !Number.isFinite(next.deformationScale) || next.deformationScale < 0) return;
    if (next.step === session.fieldView.step && next.quantity === session.fieldView.quantity
      && next.deformationScale === session.fieldView.deformationScale) return;
    set({ solidFiniteSession: { ...session, fieldView: next } });
  },
  focusSolidFinite: focused => {
    const session = ownedSession(get());
    if (session) set({ solidFiniteSession: { ...session, focused, boundaryFocused: null } });
  },
  focusSolidFiniteBoundary: boundaryFocused => {
    const session = ownedSession(get());
    if (session) set({ solidFiniteSession: { ...session, focused: null, boundaryFocused } });
  },
  cancelSolidFinite: () => {
    get().solidFiniteRunner?.cancel();
    const session = get().solidFiniteSession;
    if (session) set({ solidFiniteSession: { ...session, result: null, error: null, status: 'cancelled' } });
  },
  saveSolidFinite: () => {
    const state = get(), session = ownedSession(state);
    if (!session) return;
    try {
      if (!state.solidFiniteRunner) throw new Error('Finite analysis is not connected');
      state.solidFiniteRunner.validate();
      const current = get();
      if (current.solidFiniteSession !== session || current.document !== state.document
        || current.fileGateway !== state.fileGateway || ownedSession(current) !== session) return;
      const definition = solidFiniteSavedInput(session, state.document.id, state.document.parameters);
      const others = state.document.beamAnalysisInputs?.analyses.filter(value => value.kind !== 'solid-finite-cad') ?? [];
      state.applyDocument(withBeamAnalysisInputs(state.document, {
        schema: 'pointercad-beam-inputs/1', analyses: [...others, { kind: 'solid-finite-cad', definition }],
      }));
    } catch (error) {
      const current = get().solidFiniteSession;
      if (current === session) set({ solidFiniteSession: { ...current,
        error: error instanceof Error ? error.message : 'Invalid finite analysis input' } });
    }
  },
});
