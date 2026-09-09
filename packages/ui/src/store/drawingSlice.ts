import type { DrawingDocument } from '@pointercad/drawing';
import type { StateCreator } from 'zustand';

import type { AppState } from './appState.js';

export interface OpenDrawingOptions {
  readonly fileName?: string | null;
  readonly saved?: boolean;
}

/** 図面文書の寿命。履歴と保存処理はP8後段が同じ欄へ接続する。 */
export interface DrawingSlice {
  readonly drawing: DrawingDocument | null;
  readonly savedDrawing: DrawingDocument | null;
  readonly drawingFileName: string | null;
  readonly drawingInitialName: string | null;
  readonly openDrawing: (document: DrawingDocument, options?: OpenDrawingOptions) => void;
  readonly applyDrawing: (document: DrawingDocument) => void;
  readonly setDrawingFileState: (name: string | null, saved: DrawingDocument | null) => void;
  readonly closeDrawing: () => void;
}

export type DrawingInitialState = Pick<
  DrawingSlice,
  'drawing' | 'savedDrawing' | 'drawingFileName' | 'drawingInitialName'
>;

export function createDrawingInitialState(): DrawingInitialState {
  return { drawing: null, savedDrawing: null, drawingFileName: null, drawingInitialName: null };
}

export const createDrawingSlice: StateCreator<AppState, [], [], Omit<DrawingSlice, keyof DrawingInitialState>> = (set, get) => ({
  openDrawing: (drawing, options) => {
    get().fileGateway.clearSaveTarget?.();
    set((state) => ({
      ...createDrawingInitialState(),
      drawing,
      savedDrawing: options?.saved === true ? drawing : null,
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
  applyDrawing: (drawing) => {
    if (get().drawing === null || get().drawing === drawing) return;
    set((state) => ({ drawing, documentVersion: state.documentVersion + 1, fileMessage: null }));
  },
  setDrawingFileState: (drawingFileName, savedDrawing) => set({ drawingFileName, savedDrawing }),
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
