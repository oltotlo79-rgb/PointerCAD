import type { DimensionSeriesInput, DimensionTarget, DrawingDocument, DrawingTable, DrawingViewConstruction } from '@pointercad/drawing';
import { createUndoStack, emptyDrawingSourceLibrary, pushUndo, undo, redo,
  type DrawingSourceLibrary, type DrawingSourceResolution, type DrawingRefreshResult,
  type SuggestedDimensionKind, type UndoStack, type ImportedShapeBytes } from '@pointercad/model';
import type { StateCreator } from 'zustand';

import type { AppState } from './appState.js';
import { emptySheetMetalTool } from './sheetMetalSlice.js';

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
export type DrawingTool = 'select' | 'dimension' | 'dimensionSeries' | 'annotation' | 'note' | 'balloon' | 'datum' | 'gdt' | 'weld';
/** 作成フォームの表示だけを管理する。文書や保存データには含めない。 */
export type DrawingEditor = { readonly kind: 'view'; readonly cameraId?: string; readonly constructionKind?: DrawingViewConstruction['kind'];
  readonly sourceViewId?: string; readonly targets?: readonly DimensionTarget[] }
  | { readonly kind: 'table'; readonly tableKind?: DrawingTable['kind'] }
  | { readonly kind: 'dimension'; readonly seriesKind: DimensionSeriesInput['kind']; readonly axis: 'x' | 'y'; readonly baseIndex: number; readonly offset: string }
  | { readonly kind: 'annotation'; readonly manufacturingKind: 'datum' | 'gdt' | 'weld'; readonly elementId?: string }
  | { readonly kind: 'layer' };

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
  readonly drawingEditor: DrawingEditor | null;
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
  readonly openDrawingEditor: (editor: DrawingEditor) => void;
  readonly updateDrawingSeriesEditor: (changes: Partial<Omit<Extract<DrawingEditor, { kind: 'dimension' }>, 'kind'>>) => void;
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
  | 'drawingUndoStack' | 'drawingTool' | 'drawingEditor' | 'drawingRequestedDimension' | 'drawingTargets' | 'drawingSelectedIds'
  | 'drawingResolution' | 'drawingSourceResolution' | 'drawingBusy' | 'drawingMessage'
>;

export function createDrawingInitialState(): DrawingInitialState {
  return { drawing: null, savedDrawing: null, savedDrawingSources: null, drawingFileName: null, drawingInitialName: null,
    drawingSources: emptyDrawingSourceLibrary(), drawingImportedShapes: new Map(), drawingUndoStack: null,
    drawingTool: 'select', drawingEditor: null, drawingRequestedDimension: null, drawingTargets: [], drawingSelectedIds: [],
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
      ...emptySheetMetalTool(),
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
      drawingSelectedIds: [], drawingTargets: [], drawingTool: 'select', drawingEditor: null, drawingRequestedDimension: null, drawingMessage: null }));
  },
  redoDrawing: () => {
    const current = get();
    if (current.drawing === null || current.drawingUndoStack === null) return;
    const stack = redo(current.drawingUndoStack);
    if (stack === current.drawingUndoStack) return;
    set((state) => ({ drawing: stack.present.document, drawingSources: stack.present.sources, drawingUndoStack: stack,
      canUndo: stack.past.length > 0, canRedo: stack.future.length > 0, documentVersion: state.documentVersion + 1,
      drawingSelectedIds: [], drawingTargets: [], drawingTool: 'select', drawingEditor: null, drawingRequestedDimension: null, drawingMessage: null }));
  },
  setDrawingTool: (drawingTool, drawingRequestedDimension = null) => set({ drawingTool, drawingRequestedDimension,
    drawingEditor: null, drawingTargets: [], drawingSelectedIds: [], drawingMessage: null }),
  openDrawingEditor: (drawingEditor) => {
    if (get().drawing === null || get().drawingBusy) return;
    set({ drawingEditor, drawingTool: drawingEditor.kind === 'dimension' ? 'dimensionSeries' : drawingEditor.kind === 'annotation' ? drawingEditor.manufacturingKind : 'select', drawingTargets: [], drawingSelectedIds: [], drawingRequestedDimension: null, drawingMessage: null });
  },
  updateDrawingSeriesEditor: (changes) => {
    const editor = get().drawingEditor;
    if (editor?.kind === 'dimension') set({ drawingEditor: { ...editor, ...changes } });
  },
  setDrawingTargets: (drawingTargets) => set((state) => {
    const editor = state.drawingEditor;
    const base = editor?.kind === 'dimension' ? state.drawingTargets[editor.baseIndex] : undefined;
    const baseIndex = base === undefined ? 0 : Math.max(0, drawingTargets.findIndex((target) => JSON.stringify(target) === JSON.stringify(base)));
    return { drawingTargets, drawingEditor: editor?.kind === 'dimension' ? { ...editor, baseIndex } : editor?.kind === 'annotation' ? editor : null, drawingSelectedIds: [], drawingMessage: null };
  }),
  selectDrawingIds: (drawingSelectedIds) => set((state) => ({ drawingSelectedIds, drawingEditor: null, drawingTargets: [], drawingMessage: null,
    ...(state.drawingTool === 'dimensionSeries' ? { drawingTool: 'select' as const } : {}) })),
  setDrawingMessage: (drawingMessage) => set(drawingMessage === null ? { drawingMessage } : { drawingMessage, fileMessage: null }),
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
