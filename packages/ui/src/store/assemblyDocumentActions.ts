import { createUndoStack, EMPTY_PART_LIBRARY, pruneContextPlaneLinks, pushUndo, redo, syncAccessorySets, undo,
  type AssemblyDocument, type UndoStack } from '@pointercad/model';
import type { StoreApi } from 'zustand';
import { openedAnalysisResults } from '../beam/savedBeamResults.js';
import type { AppState } from './appState.js';
import type { AssemblyOwnedInitialState, AssemblySlice, AssemblySnapshot } from './assemblySlice.js';
import { emptyComponentPickState } from './componentPickActions.js';
import { emptyDimensionMoveState } from './dimensionMoveActions.js';
import type { PreparedDocumentSession } from './documentIdentity.js';
import { emptyJointBracketState } from './frameJointBracketActions.js';
import { emptyMemberStretchState } from './memberStretchActions.js';
import { createAssemblyPartEditActions, finishAssemblyPartEdit, syncAssemblyPartEdit,
  type AssemblyPartEditActions } from './partEditActions.js';
import { emptySheetMetalTool } from './sheetMetalSlice.js';

type AssemblyDocumentActions = Pick<AssemblySlice,
  'resetAssembly' | 'openAssembly' | 'applyAssembly' | 'setAssemblyFileState'
  | 'closeAssembly' | 'undoAssembly' | 'redoAssembly'> & AssemblyPartEditActions;

type InterferenceTransientState = Pick<AssemblyOwnedInitialState,
  'assemblyInterferenceOpen' | 'assemblyInterferenceResult' | 'assemblyInterferenceSelectedKey'
  | 'assemblyInterferenceProgress' | 'assemblyInterferenceRequestId' | 'assemblyGapRequestId'
  | 'isCheckingAssemblyInterference' | 'assemblyInterferenceError'>;

/** an edit or Undo that ends a coupled drag of the current document gives back the drives shown at the drag start,
 * but only while the shown drives are still the ones that drag published (anything else replaced them on purpose). */
function endedDragDrives(state: AppState): Pick<AppState, 'assemblyOccurrenceDrives'> | null {
  const drag = state.assemblyDrag;
  return drag !== null && drag.published !== null && state.assemblyOccurrenceDrives === drag.published
    && state.assembly === drag.document && state.assemblyLibrary === drag.library
    && state.activeDocumentId === drag.documentId && state.documentVersion === drag.version
    ? { assemblyOccurrenceDrives: drag.occurrenceDrives } : null;
}

/** 付属の組の記録のある文書の付属を、本体の今の端へ付け直した文書(A3。付け直せない時は元のまま。理由は接合チェックが出す)。 */
function withSyncedAccessories(document: AssemblyDocument): AssemblyDocument {
  const synced = syncAccessorySets(document);
  return synced.ok ? synced.document : document;
}

/** 文書を替える全経路で解析結果と非同期要求を同時に失効させる正本。 */
export function emptyInterferenceState(): InterferenceTransientState {
  return {
    assemblyInterferenceOpen: false,
    assemblyInterferenceResult: null,
    assemblyInterferenceSelectedKey: null,
    assemblyInterferenceProgress: null,
    assemblyInterferenceRequestId: null,
    assemblyGapRequestId: null,
    isCheckingAssemblyInterference: false,
    assemblyInterferenceError: null,
  };
}

/** 親の組立文書、部品の一式、履歴と保存先の切替を担当する。 */
export function createAssemblyDocumentActions(
  set: StoreApi<AppState>['setState'], get: StoreApi<AppState>['getState'],
  initialState: (session?: PreparedDocumentSession) => AssemblyOwnedInitialState,
): AssemblyDocumentActions {
  function applyHistory(stack: UndoStack<AssemblySnapshot>): void {
    set((state) => ({
      assembly: stack.present.document,
      assemblyLibrary: stack.present.library,
      assemblyUndoStack: stack,
      fileMessage: null,
      selection: [],
      connectionSelection: null,
      hoveredElementId: null,
      assemblyPlacement: null,
      assemblyMateDraft: null,
      assemblyDrag: null, assemblyDragOverlay: null, assemblyDragNotice: null,
      assemblyMotionTime: 0, assemblyMotionPlaying: false, assemblyMotionPlacements: null,
      assemblyMotionSourceDocument: null, assemblyMotionJointValues: new Map(), assemblyMotionNotice: null,
      assemblyExplodeDraft: null, assemblyExplodeError: null,
      standardPartPickerOpen: false, frameEdgePick: null, assemblyFrameSlotDraft: null, assemblyFrameSlotPreview: null,
      assemblyReplacementPreview: null, assemblyReplacementBusy: false, assemblyReplacementRequestId: null,
      assemblyBoltedJointDraft: null, assemblyBoltedJointPreview: null, assemblyNestedBoltDraft: null, assemblyNestedBoltPreview: null,
      assemblyFilletWeldDraft: null, assemblyFilletWeldPreview: null, assemblyCircularWeldDraft: null, assemblyCircularWeldPreview: null, assemblyNestedWeldDraft: null, assemblyNestedWeldPreview: null, assemblyChildWeldEdit: null,
      assemblyJointDrive: null,
      ...emptyInterferenceState(), assemblyJointCheckSelectedKey: null, ...emptyJointBracketState(), ...emptyMemberStretchState(), ...emptyDimensionMoveState(), ...emptyComponentPickState(), ...endedDragDrives(state),
      ...syncAssemblyPartEdit(state, stack, true),
      documentVersion: state.documentVersion + 1,
      canUndo: stack.past.length > 0,
      canRedo: stack.future.length > 0,
    }));
  }
  return {
    ...createAssemblyPartEditActions(set, get),
    resetAssembly: (update, session) => {
      const initial = initialState(session);
      set((state) => {
        const restored = finishAssemblyPartEdit(state);
        return { ...restored, ...update({ ...state, ...restored }), ...initial, assembly: null,
          strengthSession: null, exportHandoff: null, exportHandoffAttempt: null };
      });
    },
    openAssembly: (assembly, library = EMPTY_PART_LIBRARY, options) => {
      const initial = initialState(options?.preparedSession);
      if (options?.preserveSaveTarget !== true) get().fileGateway.clearSaveTarget?.();
      set((state) => ({
        ...finishAssemblyPartEdit(state), ...initial, assembly, drawing: null, savedDrawing: null, drawingFileName: null, strengthSession: null,
        exportHandoff: null, exportHandoffAttempt: null, ...emptySheetMetalTool(),
        drawingInitialName: null, assemblyLibrary: library, assemblyInitialName: assembly.name,
        assemblyUndoStack: createUndoStack({ document: assembly, library }),
        documentVersion: state.documentVersion + 1,
        canUndo: false, canRedo: false, selection: [], connectionSelection: null, hoveredElementId: null,
        activeTool: 'select', fileMessage: null, assemblyOpenedAnalysisResults: openedAnalysisResults(assembly, options?.analysisResults, options?.analysisResultsDropped),
      }));
    },
    applyAssembly: (assembly, library = get().assemblyLibrary, adopt) => {
      // An edit that breaks a saved cross-level gear or cam keeps the file readable: the repaired document is committed
      // instead (one Undo step), and what was suspended or removed is reported.
      const repaired = get().pruneAssemblyCrossLevelCouplings(withSyncedAccessories(assembly), library.assemblies ?? new Map());
      if (repaired.document !== assembly) {
        get().applyAssembly(repaired.document, library, adopt);
        set({ assemblyCrossLevelGearRepairs: repaired.repairs });
        return;
      }
      assembly = pruneContextPlaneLinks(assembly, library);
      const state = get();
      if (state.assembly === null || state.assemblyUndoStack === null) {
        return;
      }
      if (state.assembly === assembly && state.assemblyLibrary === library) {
        return;
      }
      const stack = pushUndo(state.assemblyUndoStack, { document: assembly, library });
      set((current) => {
        const overlay = current.assemblyDragOverlay;
        const keepOverlay = overlay !== null && overlay.document === assembly
          && overlay.library === library && overlay.documentId === current.activeDocumentId
          && overlay.version === current.documentVersion;
        const working = syncAssemblyPartEdit(current, stack, false);
        return { ...working, ...(adopt?.patch?.(current, working) ?? {}), assembly, assemblyLibrary: library, assemblyUndoStack: stack,
          canUndo: stack.past.length > 0, canRedo: false, fileMessage: null,
          assemblyPlacement: null, assemblyMateDraft: null, assemblyDrag: null,
          assemblyDragOverlay: keepOverlay ? overlay : null,
          assemblyDragNotice: keepOverlay ? current.assemblyDragNotice : null,
          assemblyMotionTime: 0, assemblyMotionPlaying: false, assemblyMotionPlacements: null,
          assemblyMotionSourceDocument: null, assemblyMotionJointValues: new Map(), assemblyMotionNotice: null,
          assemblyExplodeDraft: null, assemblyExplodeError: null,
          standardPartPickerOpen: false, frameEdgePick: null, assemblyFrameSlotDraft: null, assemblyFrameSlotPreview: null,
          assemblyReplacementPreview: null, assemblyReplacementBusy: false, assemblyReplacementRequestId: null,
          assemblyBoltedJointDraft: null, assemblyBoltedJointPreview: null, assemblyNestedBoltDraft: null, assemblyNestedBoltPreview: null,
          assemblyFilletWeldDraft: null, assemblyFilletWeldPreview: null, assemblyCircularWeldDraft: null, assemblyCircularWeldPreview: null, assemblyNestedWeldDraft: null, assemblyNestedWeldPreview: null, assemblyChildWeldEdit: null,
          assemblyJointDrive: null,
          assemblyCrossLevelGearRepairs: repaired.repairs,
          ...emptyInterferenceState(), assemblyJointCheckSelectedKey: null, ...emptyJointBracketState(), ...emptyMemberStretchState(), ...emptyDimensionMoveState(), ...emptyComponentPickState(), ...endedDragDrives(current) };
      });
    },
    setAssemblyFileState: (assemblyFileName, savedAssembly) => {
      set({ assemblyFileName, savedAssembly });
    },
    closeAssembly: () => {
      const state = get();
      const initial = initialState();
      state.fileGateway.clearSaveTarget?.();
      const restored = finishAssemblyPartEdit(state);
      const history = restored.undoStack ?? state.undoStack;
      set({ ...restored, ...initial, assembly: null, documentVersion: state.documentVersion + 1,
        canUndo: history.past.length > 0, canRedo: history.future.length > 0 });
    },
    undoAssembly: () => {
      const stack = get().assemblyUndoStack;
      if (stack !== null && stack.past.length > 0) applyHistory(undo(stack));
      else if (get().assemblyPlacement !== null || get().assemblyMateDraft !== null || get().assemblyDrag !== null
        || get().assemblyExplodeDraft !== null || get().standardPartPickerOpen
        || get().assemblyReplacementPreview !== null || get().assemblyReplacementBusy
        || get().assemblyBoltedJointDraft !== null || get().assemblyFilletWeldDraft !== null || get().assemblyCircularWeldDraft !== null) {
        set({ assemblyPlacement: null, assemblyMateDraft: null, assemblyDrag: null, assemblyDragOverlay: null,
          assemblyDragNotice: null, assemblyExplodeDraft: null, assemblyExplodeError: null,
          standardPartPickerOpen: false, assemblyReplacementPreview: null, assemblyReplacementBusy: false,
          assemblyReplacementRequestId: null, assemblyBoltedJointDraft: null, assemblyBoltedJointPreview: null, assemblyNestedBoltDraft: null, assemblyNestedBoltPreview: null,
          assemblyFilletWeldDraft: null, assemblyFilletWeldPreview: null, assemblyCircularWeldDraft: null, assemblyCircularWeldPreview: null, assemblyNestedWeldDraft: null, assemblyNestedWeldPreview: null, assemblyChildWeldEdit: null, ...endedDragDrives(get()) });
      }
    },
    redoAssembly: () => {
      const stack = get().assemblyUndoStack;
      if (stack !== null && stack.future.length > 0) applyHistory(redo(stack));
      else if (get().assemblyPlacement !== null || get().assemblyMateDraft !== null || get().assemblyDrag !== null
        || get().assemblyExplodeDraft !== null || get().standardPartPickerOpen
        || get().assemblyReplacementPreview !== null || get().assemblyReplacementBusy
        || get().assemblyBoltedJointDraft !== null || get().assemblyFilletWeldDraft !== null || get().assemblyCircularWeldDraft !== null) {
        set({ assemblyPlacement: null, assemblyMateDraft: null, assemblyDrag: null, assemblyDragOverlay: null,
          assemblyDragNotice: null, assemblyExplodeDraft: null, assemblyExplodeError: null,
          standardPartPickerOpen: false, assemblyReplacementPreview: null, assemblyReplacementBusy: false,
          assemblyReplacementRequestId: null, assemblyBoltedJointDraft: null, assemblyBoltedJointPreview: null, assemblyNestedBoltDraft: null, assemblyNestedBoltPreview: null,
          assemblyFilletWeldDraft: null, assemblyFilletWeldPreview: null, assemblyCircularWeldDraft: null, assemblyCircularWeldPreview: null, assemblyNestedWeldDraft: null, assemblyNestedWeldPreview: null, assemblyChildWeldEdit: null, ...endedDragDrives(get()) });
      }
    },
  };
}
