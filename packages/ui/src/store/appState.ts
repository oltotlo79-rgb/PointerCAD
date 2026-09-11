/**
 * 画面の状態の全体(rules/04-設計の規律.md「フロントの状態は Zustand のストア 1 本」)。
 *
 * **中身は機能ごとのスライスが持つ**(P6 タスク52)。ここは束ねるだけなので、
 * 欄や操作を足すときはこのファイルではなく、その機能のスライスへ書く。
 * スライスは `AppState` を型としてだけ参照する(実体の輪はできない)。
 */
import type { ViewSlice } from './viewSlice.js';
import type { CanvasSlice } from './canvasSlice.js';
import type { ExchangeSlice } from './exchangeSlice.js';
import type { DocumentSlice } from './documentSlice.js';
import type { TimelineSlice } from './timelineSlice.js';
import type { RecomputeSlice } from './recomputeSlice.js';
import type { SketchSlice } from './sketchSlice.js';
import type { ConstraintSlice } from './constraintSlice.js';
import type { SelectionSlice } from './selectionSlice.js';
import type { MeasureSlice } from './measureSlice.js';
import type { FileSlice } from './fileSlice.js';
import type { AssemblySlice } from './assemblySlice.js';
import type { DrawingSlice } from './drawingSlice.js';
import type { HelpSlice } from './helpSlice.js';
import type { SheetMetalSlice } from './sheetMetalSlice.js';

/** 文書とその寿命の欄を、購読へ中間状態を渡さず一緒に更新する。 */
export type DocumentStateUpdate = (state: AppState) => Partial<AppState>;

export interface AppState
  extends ViewSlice,
    CanvasSlice,
    ExchangeSlice,
    DocumentSlice,
    TimelineSlice,
    RecomputeSlice,
    SketchSlice,
    ConstraintSlice,
    SelectionSlice,
    MeasureSlice,
    FileSlice,
    AssemblySlice,
    DrawingSlice,
    HelpSlice, SheetMetalSlice {}
