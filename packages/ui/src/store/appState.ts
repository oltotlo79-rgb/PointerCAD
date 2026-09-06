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
    FileSlice {}
