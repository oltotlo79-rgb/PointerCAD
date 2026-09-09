import type { DimensionTarget, DrawingDocument } from '@pointercad/drawing';
import { createUndoStack, emptyDrawingSourceLibrary, pushUndo, undo, redo,
  type DrawingSourceLibrary, type DrawingSourceResolution, type DrawingRefreshResult,
  type SuggestedDimensionKind, type UndoStack, type ImportedShapeBytes } from '@pointercad/model';
import type { StateCreator } from 'zustand';

import type { AppState } from './appState.js';

export interface OpenDrawingOptions {
  readonly preserveSaveTarget?: boolean;
  readonly fileName?: string | null;
  readonly saved?: boolean;
  readonly sources?: DrawingSourceLibrary;
  readonly importedShapes?: ImportedShapeBytes;
}

export interface DrawingSnapshot {
  readonly document: DrawingDocument;
  readonly sources: DrawingSourceLibrary;
}
export type DrawingTool = 'select' | 'dimension' | 'annotation' | 'note' | 'balloon';

/** 図面文書の寿命。履歴と保存処理はP8後段が同じ欄へ接続する。 */
export interface DrawingSlice {
  readonly drawing: DrawingDocument | null;
  readonly savedDrawing: DrawingDocument | null;
  readonly savedDrawingSources: DrawingSourceLibrary | null;
  readonly drawingFileName: string | null;
  readonly drawingInitialName: string | null;
  readonly drawingSources: DrawingSourceLibrary;
  readonly drawingImportedShapes: ImportedShapeBytes;
  readonly drawingUndoStack: UndoStack<DrawingSnapshot> | null;
  readonly drawingTool: DrawingTool;
  readonly drawingRequestedDimension: SuggestedDimensionKind | null;
  readonly drawingTargets: readonly DimensionTarget[];
  readonly drawingSelectedIds: readonly string[];
  readonly drawingResolution: DrawingRefreshResult | null;
  readonly drawingSourceResolution: DrawingSourceResolution | null;
  readonly drawingBusy: boolean;
  readonly drawingMessage: string | null;
  readonly openDrawing: (document: DrawingDocument, options?: OpenDrawingOptions) => void;
  readonly applyDrawing: (document: DrawingDocument, sources?: DrawingSourceLibrary) => void;
  readonly undoDrawing: () => void;
  readonly redoDrawing: () => void;
  readonly setDrawingTool: (tool: DrawingTool, requested?: SuggestedDimensionKind | null) => void;
  readonly setDrawingTargets: (targets: readonly DimensionTarget[]) => void;
  readonly selectDrawingIds: (ids: readonly string[]) => void;
  readonly setDrawingMessage: (message: string | null) => void;
  readonly setDrawingResolution: (document: DrawingDocument, result: DrawingRefreshResult, source: DrawingSourceResolution | null) => void;
  readonly setDrawingFileState: (name: string | null, saved: DrawingDocument | null, sources?: DrawingSourceLibrary) => void;
  readonly closeDrawing: () => void;
}

export type DrawingInitialState = Pick<
  DrawingSlice,
  'drawing' | 'savedDrawing' | 'savedDrawingSources' | 'drawingFileName' | 'drawingInitialName' | 'drawingSources' | 'drawingImportedShapes'
  | 'drawingUndoStack' | 'drawingTool' | 'drawingRequestedDimension' | 'drawingTargets' | 'drawingSelectedIds'
  | 'drawingResolution' | 'drawingSourceResolution' | 'drawingBusy' | 'drawingMessage'
>;

export function createDrawingInitialState(): DrawingInitialState {
  return { drawing: null, savedDrawing: null, savedDrawingSources: null, drawingFileName: null, drawingInitialName: null,
    drawingSources: emptyDrawingSourceLibrary(), drawingImportedShapes: new Map(), drawingUndoStack: null,
    drawingTool: 'select', drawingRequestedDimension: null, drawingTargets: [], drawingSelectedIds: [],
    drawingResolution: null, drawingSourceResolution: null, drawingBusy: false, drawingMessage: null };
}

export const createDrawingSlice: StateCreator<AppState, [], [], Omit<DrawingSlice, keyof DrawingInitialState>> = (set, get) => ({
  openDrawing: (drawing, options) => {
    if (options?.preserveSaveTarget !== true) get().fileGateway.clearSaveTarget?.();
    const sources = options?.sources ?? emptyDrawingSourceLibrary();
    set((state) => ({
      ...createDrawingInitialState(),
      drawing,
      drawingSources: sources,
      drawingImportedShapes: options?.importedShapes ?? new Map(),
      drawingUndoStack: createUndoStack({ document: drawing, sources }),
      savedDrawing: options?.saved === true ? drawing : null,
      savedDrawingSources: options?.saved === true ? sources : null,
      drawingFileName: options?.fileName ?? null,
      drawingInitialName: drawing.name,
      assembly: null,
      activeDocumentId: crypto.randomUUID(),
      documentVersion: state.documentVersion + 1,
      selection: [],
      hoveredElementId: null,
      activeTool: 'select',
      canUndo: false,
      canRedo: false,
      fileMessage: null,
    }));
  },
  applyDrawing: (drawing, sources) => {
    const current = get();
    if (current.drawing === null || current.drawingUndoStack === null
      || (current.drawing === drawing && (sources === undefined || sources === current.drawingSources))) return;
    const drawingSources = sources ?? current.drawingSources;
    const stack = pushUndo(current.drawingUndoStack, { document: drawing, sources: drawingSources });
    set((state) => ({ drawing, drawingSources, drawingUndoStack: stack, canUndo: stack.past.length > 0, canRedo: false,
      documentVersion: state.documentVersion + 1, fileMessage: null, drawingMessage: null }));
  },
  undoDrawing: () => {
    const current = get();
    if (current.drawing === null || current.drawingUndoStack === null) return;
    const stack = undo(current.drawingUndoStack);
    if (stack === current.drawingUndoStack) return;
    set((state) => ({ drawing: stack.present.document, drawingSources: stack.present.sources, drawingUndoStack: stack,
      canUndo: stack.past.length > 0, canRedo: stack.future.length > 0, documentVersion: state.documentVersion + 1,
      drawingSelectedIds: [], drawingTargets: [], drawingTool: 'select', drawingRequestedDimension: null, drawingMessage: null }));
  },
  redoDrawing: () => {
    const current = get();
    if (current.drawing === null || current.drawingUndoStack === null) return;
    const stack = redo(current.drawingUndoStack);
    if (stack === current.drawingUndoStack) return;
    set((state) => ({ drawing: stack.present.document, drawingSources: stack.present.sources, drawingUndoStack: stack,
      canUndo: stack.past.length > 0, canRedo: stack.future.length > 0, documentVersion: state.documentVersion + 1,
      drawingSelectedIds: [], drawingTargets: [], drawingTool: 'select', drawingRequestedDimension: null, drawingMessage: null }));
  },
  setDrawingTool: (drawingTool, drawingRequestedDimension = null) => set({ drawingTool, drawingRequestedDimension,
    drawingTargets: [], drawingSelectedIds: [], drawingMessage: null }),
  setDrawingTargets: (drawingTargets) => set({ drawingTargets, drawingSelectedIds: [], drawingMessage: null }),
  selectDrawingIds: (drawingSelectedIds) => set({ drawingSelectedIds, drawingTargets: [], drawingMessage: null }),
  setDrawingMessage: (drawingMessage) => set({ drawingMessage }),
  setDrawingResolution: (drawing, drawingResolution, drawingSourceResolution) => {
    if (get().drawing !== drawing) return;
    set({ drawingResolution, drawingSourceResolution, drawingBusy: false,
      drawingMessage: drawingResolution.ok ? null : drawingResolution.message });
  },
  setDrawingFileState: (drawingFileName, savedDrawing, sources) => set({ drawingFileName, savedDrawing,
    savedDrawingSources: savedDrawing === null ? null : sources ?? get().drawingSources }),
  closeDrawing: () => {
    get().fileGateway.clearSaveTarget?.();
    set((state) => ({
      ...createDrawingInitialState(),
      activeDocumentId: crypto.randomUUID(),
      documentVersion: state.documentVersion + 1,
      canUndo: state.undoStack.past.length > 0,
      canRedo: state.undoStack.future.length > 0,
    }));
  },
});
