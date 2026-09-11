/**
 * ストアの合成(P6 タスク52)。**ここは組み立てだけ**で、欄と操作は機能ごとのスライスにある。
 *
 * ストアは 1 本のまま(rules/04-設計の規律.md)。`create()` に渡す作り手を機能ごとに分け、
 * 同じ `set` / `get` を配ってあるので、呼ぶ側(`useAppStore(...)` / `getState()`)は
 * 分ける前と 1 文字も変わらない。
 */
import { create } from 'zustand';

import type { AppState } from './appState.js';
import { createInitialDocumentState } from './initialDocumentState.js';
import { createViewSlice } from './viewSlice.js';
import { createCanvasSlice } from './canvasSlice.js';
import { createExchangeSlice } from './exchangeSlice.js';
import { createDocumentSlice } from './documentSlice.js';
import { createTimelineSlice } from './timelineSlice.js';
import { createRecomputeSlice } from './recomputeSlice.js';
import { createSketchSlice } from './sketchSlice.js';
import { createConstraintSlice } from './constraintSlice.js';
import { createSelectionSlice } from './selectionSlice.js';
import { createMeasureSlice } from './measureSlice.js';
import { createFileSlice } from './fileSlice.js';
import { createAssemblySlice } from './assemblySlice.js';
import { createDrawingSlice } from './drawingSlice.js';
import { createHelpSlice } from './helpSlice.js';
import { createSheetMetalSlice } from './sheetMetalSlice.js';
import { createScriptSlice } from './scriptSlice.js';

export type { AppState } from './appState.js';
export type { ViewSlice } from './viewSlice.js';
export type { CanvasSlice } from './canvasSlice.js';
export type { ExchangeSlice } from './exchangeSlice.js';
export type { DocumentSlice } from './documentSlice.js';
export type { TimelineSlice } from './timelineSlice.js';
export type { RecomputeSlice } from './recomputeSlice.js';
export type { SketchSlice } from './sketchSlice.js';
export type { ConstraintSlice } from './constraintSlice.js';
export type { SelectionSlice } from './selectionSlice.js';
export type { MeasureSlice } from './measureSlice.js';
export type { FileSlice } from './fileSlice.js';
export type { AssemblySlice } from './assemblySlice.js';
export type { DrawingSlice } from './drawingSlice.js';

/** Shared with the ownership checks: a new slice cannot disappear from their registry. */
export const STORE_SLICE_CREATORS = {
  viewSlice: createViewSlice,
  canvasSlice: createCanvasSlice,
  exchangeSlice: createExchangeSlice,
  documentSlice: createDocumentSlice,
  timelineSlice: createTimelineSlice,
  recomputeSlice: createRecomputeSlice,
  sketchSlice: createSketchSlice,
  constraintSlice: createConstraintSlice,
  selectionSlice: createSelectionSlice,
  measureSlice: createMeasureSlice,
  fileSlice: createFileSlice,
  assemblySlice: createAssemblySlice,
  drawingSlice: createDrawingSlice,
  helpSlice: createHelpSlice,
  sheetMetalSlice: createSheetMetalSlice,
  scriptSlice: createScriptSlice,
};

export const useAppStore = create<AppState>()((...args) => ({
  ...createInitialDocumentState(),
  ...STORE_SLICE_CREATORS.viewSlice(...args),
  ...STORE_SLICE_CREATORS.canvasSlice(...args),
  ...STORE_SLICE_CREATORS.exchangeSlice(...args),
  ...STORE_SLICE_CREATORS.documentSlice(...args),
  ...STORE_SLICE_CREATORS.timelineSlice(...args),
  ...STORE_SLICE_CREATORS.recomputeSlice(...args),
  ...STORE_SLICE_CREATORS.sketchSlice(...args),
  ...STORE_SLICE_CREATORS.constraintSlice(...args),
  ...STORE_SLICE_CREATORS.selectionSlice(...args),
  ...STORE_SLICE_CREATORS.measureSlice(...args),
  ...STORE_SLICE_CREATORS.fileSlice(...args),
  ...STORE_SLICE_CREATORS.assemblySlice(...args),
  ...STORE_SLICE_CREATORS.drawingSlice(...args),
  ...STORE_SLICE_CREATORS.helpSlice(...args),
  ...STORE_SLICE_CREATORS.sheetMetalSlice(...args),
  ...STORE_SLICE_CREATORS.scriptSlice(...args),
}));
