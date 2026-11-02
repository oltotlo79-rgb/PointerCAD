import { createDocumentElementId } from '@pointercad/model/document-identity';
import { readCircularFilletWeldSource, type AssemblyDocument, type JointOccurrenceCommandContext, type PartLibrary } from '@pointercad/model';
import {
  appendCircularFilletWeldPick, commitCircularFilletWeldDraft, createCircularFilletWeldDraft,
  editCircularFilletWeldDraft, previewCircularFilletWeldDraft, restoreCircularFilletWeldDraft,
  type CircularDraftFields, type CircularDraftPick, type CircularDraftPreview, type CircularFilletWeldDraft,
} from '../assembly/circularFilletWeldDraft.js';
import { nestedJointCommandContext } from '../assembly/nestedWeldDraft.js';
import { jointOccurrenceInputsOf } from '../viewport/pickJointOccurrence.js';
import type { AppState } from './appState.js';
import type { AssemblyView } from './assemblySlice.js';

type ReadyPreview = Extract<CircularDraftPreview, { readonly ok: true }>;
export interface CircularWeldSlice {
  readonly assemblyCircularWeldDraft: CircularFilletWeldDraft | null;
  readonly assemblyCircularWeldPreview: CircularDraftPreview | null;
  readonly beginCircularWeld: () => boolean;
  readonly pickCircularWeldTarget: (pick: CircularDraftPick) => boolean;
  readonly updateCircularWeldDraft: (fields: CircularDraftFields) => void;
  readonly reselectCircularWeld: () => void;
  readonly cancelCircularWeld: () => void;
  readonly commitCircularWeld: (draft: CircularFilletWeldDraft, preview: ReadyPreview) => boolean;
}

/** Preserve the solved input object only after checking all of its current owners. */
export function circularWeldContext(document: AssemblyDocument, library: PartLibrary, view: AssemblyView): JointOccurrenceCommandContext | null {
  const current = jointOccurrenceInputsOf(document, library), source = view.source;
  if (source === undefined || source.document !== current.document || source.library !== current.library
    || source.subAssemblies !== current.subAssemblies) return null;
  const context = nestedJointCommandContext(document, library, view);
  return context === null ? null : { ...context, inputs: source };
}

/** A selected circular bead edits its complete weld; straight sources are not reinterpreted. */
export function selectedCircularWeldId(document: AssemblyDocument, selection: readonly string[]): string | null {
  if (selection.length !== 1) return null;
  const component = document.components.find(value => value.id === selection[0]);
  return component?.source.kind === 'standardPart' ? readCircularFilletWeldSource(component.source)?.options.weldId ?? null : null;
}

function busy(state: AppState): boolean {
  return state.assembly === null || state.isComputing || state.assemblyPlacement !== null || state.assemblyMateDraft !== null
    || state.assemblyDrag !== null || state.assemblyReplacementBusy || state.assemblyReplacementPreview !== null
    || state.assemblyJointDrive !== null || state.assemblyMotionPlaying || state.assemblyMotionPlacements !== null;
}

export function createCircularWeldActions(set: (patch: Partial<AppState>) => void, get: () => AppState): Omit<CircularWeldSlice,
  'assemblyCircularWeldDraft' | 'assemblyCircularWeldPreview'> {
  // Weak keys release old geometry when its preview is cleared by open, Undo, or cancel.
  const owners = new WeakMap<ReadyPreview, { readonly view: AssemblyView; readonly session: string;
    readonly generation: number; readonly cancelCount: number; readonly drives: AppState['assemblyOccurrenceDrives'] }>();
  const publish = (state: AppState, draft: CircularFilletWeldDraft): void => {
    const context = state.assembly === null || state.assemblyView === null || busy(state)
      ? null : circularWeldContext(state.assembly, state.assemblyLibrary, state.assemblyView);
    const preview: CircularDraftPreview = context === null ? { ok: false, reason: 'stale' } : previewCircularFilletWeldDraft(context, draft);
    if (preview.ok && state.assemblyView !== null) owners.set(preview, { view: state.assemblyView, session: state.activeDocumentId,
      generation: state.requestedGeneration, cancelCount: state.cancelRequestCount, drives: state.assemblyOccurrenceDrives });
    set({ assemblyCircularWeldDraft: draft, assemblyCircularWeldPreview: preview });
  };
  return {
    beginCircularWeld: () => {
      const state = get(), document = state.assembly;
      if (document === null || busy(state)) return false;
      const weldId = selectedCircularWeldId(document, state.selection);
      const epoch = crypto.randomUUID();
      const draft = weldId === null ? createCircularFilletWeldDraft(document, createDocumentElementId(), epoch)
        : restoreCircularFilletWeldDraft(document, weldId, epoch);
      if (draft === null) return false;
      set({ assemblyCircularWeldDraft: draft, assemblyCircularWeldPreview: null, assemblyDragNotice: null,
        assemblyFilletWeldDraft: null, assemblyFilletWeldPreview: null, assemblyNestedWeldDraft: null, assemblyNestedWeldPreview: null,
        assemblyChildWeldEdit: null, assemblyBoltedJointDraft: null, assemblyBoltedJointPreview: null,
        assemblyNestedBoltDraft: null, assemblyNestedBoltPreview: null, standardPartPickerOpen: false,
        assemblyExplodeDraft: null, assemblyExplodeError: null });
      return true;
    },
    pickCircularWeldTarget: pick => {
      const state = get(), draft = state.assemblyCircularWeldDraft;
      if (draft === null || busy(state) || draft.sourceDocument !== state.assembly) return false;
      const next = appendCircularFilletWeldPick(draft, pick, crypto.randomUUID());
      if (next === null) return false;
      publish(state, next);
      return true;
    },
    updateCircularWeldDraft: fields => {
      const state = get(), draft = state.assemblyCircularWeldDraft;
      if (draft === null) return;
      const next = editCircularFilletWeldDraft(draft, fields, crypto.randomUUID());
      if (next !== null && next !== draft) publish(state, next);
    },
    reselectCircularWeld: () => {
      const state = get(), draft = state.assemblyCircularWeldDraft;
      if (draft === null) return;
      // Keep exact typed values and all replacement identities; only the three picks expire.
      publish(state, Object.freeze({ ...draft, picks: Object.freeze([]), draftEpoch: crypto.randomUUID() }));
    },
    cancelCircularWeld: () => set({ assemblyCircularWeldDraft: null, assemblyCircularWeldPreview: null }),
    commitCircularWeld: (draft, preview) => {
      const state = get(), owner = owners.get(preview), view = state.assemblyView;
      if (busy(state) || owner === undefined || state.assemblyCircularWeldDraft !== draft
        || state.assemblyCircularWeldPreview !== preview || state.assembly !== draft.sourceDocument
        || view !== owner.view || state.activeDocumentId !== owner.session || state.requestedGeneration !== owner.generation
        || state.cancelRequestCount !== owner.cancelCount || state.assemblyOccurrenceDrives !== owner.drives
        || state.assembly === null || view === null || circularWeldContext(state.assembly, state.assemblyLibrary, view) === null) {
        set({ assemblyCircularWeldPreview: { ok: false, reason: 'preview-changed' } });
        return false;
      }
      // Reuse exactly the preview context; the model rechecks current source/body/placement stamps.
      const result = commitCircularFilletWeldDraft(preview.context, draft, preview);
      if (!result.ok) {
        set({ assemblyCircularWeldPreview: { ok: false, reason: result.reason } });
        return false;
      }
      state.applyAssembly(result.document);
      return true;
    },
  };
}
