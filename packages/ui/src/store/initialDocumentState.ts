/**
 * 部品を作り直したときに戻す初期値(§0.a-0.2)。**1 か所にまとめる**ので、
 * 新しい欄を足すときはその機能のスライスの `*InitialState` にも名前を足す
 * (足し忘れると型検査が落ちる。P6 タスク52)。
 */
import { type ExpressionValue, expressionValueFromNumber } from '@pointercad/expression';
import type { ImportedMeshBytes } from '@pointercad/io';
import {
  createEmptyPartDocument,
  createUndoStack,
  DEFAULT_WORK_PLANE_ID,
  resolveSketch,
  WORK_PLANES,
} from '@pointercad/model';
import { createBrowserFileGateway } from '../file/fileGateway.js';
import { EMPTY_REFERENCE_DRAFT } from '../sketch/referenceCommands.js';
import { EMPTY_SHAPE_DRAFT } from '../sketch/shapeCommands.js';
import { DEFAULT_SNAP_KINDS } from '../sketch/snapMath.js';
import { DEFAULT_SPHERE_GRID_STEP_DEGREES } from '../viewport/buildSphereGrid.js';
import type { CanvasPixelSize } from '../viewport/canvasLayer.js';
import {
  activeSketchOf,
  EMPTY_NON_LENGTH_VARIABLES,
  EMPTY_PARAMETER_ANALYSIS,
  EMPTY_RESOLVED_REFERENCES,
  NO_CONSTRAINT_SUMMARIES,
  NO_CONSTRAINT_TARGETS,
} from './documentDerived.js';
import type { AssemblyInitialState } from './assemblySlice.js';
import { createDrawingInitialState, type DrawingInitialState } from './drawingSlice.js';
import type { CanvasInitialState } from './canvasSlice.js';
import type { ConstraintInitialState } from './constraintSlice.js';
import type { DocumentInitialState } from './documentSlice.js';
import type { ExchangeInitialState } from './exchangeSlice.js';
import type { FileInitialState } from './fileSlice.js';
import type { MeasureInitialState } from './measureSlice.js';
import type { RecomputeInitialState } from './recomputeSlice.js';
import type { SelectionInitialState } from './selectionSlice.js';
import type { SketchInitialState } from './sketchSlice.js';
import type { TimelineInitialState } from './timelineSlice.js';
import type { ViewInitialState } from './viewSlice.js';
import type { HelpInitialState } from './helpSlice.js';

/** `createInitialDocumentState` が返すもの。スライスごとの宣言を束ねる。 */
export type InitialDocumentState = ViewInitialState &
  CanvasInitialState &
  ExchangeInitialState &
  DocumentInitialState &
  TimelineInitialState &
  RecomputeInitialState &
  SketchInitialState &
  ConstraintInitialState &
  SelectionInitialState &
  MeasureInitialState &
  FileInitialState &
  AssemblyInitialState &
  DrawingInitialState & HelpInitialState;

/**
 * 球面の案内線の間隔の既定(度。FR-431、§0.a-0.21)。**数そのものは
 * `buildSphereGrid.ts` の 1 か所だけ**にあり、ここはそれを式へ直して持つ(FR-201)。
 */
const DEFAULT_SPHERE_GRID_STEP: ExpressionValue = expressionValueFromNumber(
  DEFAULT_SPHERE_GRID_STEP_DEGREES,
);

/** テストで元へ戻せるよう、文書まわりの初期値を1箇所にまとめる。 */
export function createInitialDocumentState(): InitialDocumentState {
  // 起動時は空のスケッチ 1 本だけを持つ部品から始める(§0.a-0.2、NFR-UX-6 の空状態ガイド)。
  const document = createEmptyPartDocument();
  const sketch = activeSketchOf(document);
  return {
    helpTopicId: null,
    activeTool: 'select',
    // 'select' は立体を選ぶ道具(選択の種類の対応は selectionKindForTool の既定分岐、§0.a-0.6)。
    selectionKind: 'body',
    workPlaneId: DEFAULT_WORK_PLANE_ID,
    // 起動時の部品には基準ジオメトリが 1 つも無いので、作図面は基準の XY そのもの。
    workPlane: WORK_PLANES[DEFAULT_WORK_PLANE_ID],
    // 断面表示(FR-111、P6 タスク35)は切った状態から始める(費用ゼロ)。
    sectionView: null,
    // 3D プリントの点検(FR-815、P6 タスク42・43・46)。新しい部品はまだ点検していない。
    printability: null,
    printabilityOffsets: null,
    // 下絵(FR-332、P6 タスク39)。新しい部品は画像を 1 枚も持たない。
    canvases: new Map<string, Uint8Array>(),
    canvasMessage: null,
    canvasPixelSizes: new Map<string, CanvasPixelSize>(),
    // 起動時の部品は読み込んだ形を 1 つも持たない(FR-802、P6 タスク32)。
    importedShapes: new Map<string, Uint8Array>(),
    importedMeshes: new Map<string, ImportedMeshBytes>(),
    canvasScale: null,
    // 3D スケッチで押した場所の面(FR-330、タスク14)。まだ一度も押していない。
    freeSketchPlane: null,
    resolvedReferences: EMPTY_RESOLVED_REFERENCES,
    // 起動時の部品はパラメータを 1 つも持たない(FR-207、タスク11)。
    parameterAnalysis: EMPTY_PARAMETER_ANALYSIS,
    nonLengthVariables: EMPTY_NON_LENGTH_VARIABLES,
    document,
    documentVersion: 0,
    // つまみは常に末尾から始まる(§0.a-0.19。保存しないので開き直しても同じ)。
    timelineIndex: null,
    timelineNoticeKey: null,
    timelineRefusal: null,
    undoStack: createUndoStack(document),
    canUndo: false,
    canRedo: false,
    sketch,
    resolvedSketch: resolveSketch(sketch),
    sketchMesh: null,
    sketchErrors: [],
    // 起動時の部品は拘束を 1 つも持たない(FR-313、P4b タスク13)。
    constraintDiagnosis: null,
    constraintSummaries: NO_CONSTRAINT_SUMMARIES,
    activeConstraintKind: null,
    constraintTargets: NO_CONSTRAINT_TARGETS,
    constraintErrorMessage: null,
    constraintPrompt: null,
    selectedConstraintId: null,
    // 引っぱり(FR-313、P4b タスク14)。起動直後は何も掴んでいない。
    sketchDrag: null,
    dragResolved: null,
    dragRefusalKey: null,
    bodies: [],
    // 起動直後の部品には外観の割り当てが 1 つも無い(FR-1106、P5 タスク10)。
    appearanceMatches: [],
    partErrors: [],
    cacheHits: 0,
    recomputeProgress: null,
    cancelRequestCount: 0,
    recomputeCancelled: false,
    documentName: sketch.name,
    featureNames: [],
    isComputing: false,
    errorMessage: null,
    selection: [],
    hoveredElementId: null,
    snapEnabled: true,
    snapKinds: DEFAULT_SNAP_KINDS,
    sphereGridStep: DEFAULT_SPHERE_GRID_STEP,
    sphereGridAlwaysVisible: false,
    chaining: true,
    numericInput: null,
    numericInputAnchor: null,
    pendingStart: null,
    shapeDraft: EMPTY_SHAPE_DRAFT,
    shapeErrorMessage: null,
    referenceDraft: EMPTY_REFERENCE_DRAFT,
    referenceErrorMessage: null,
    snapIndicator: null,
    trackIndicator: null,
    inferredConstraints: null,
    editPreview: null,
    faceErrorKey: null,
    solidErrorKey: null,
    editErrorKey: null,
    appearanceErrorKey: null,
    editNoticeKey: null,
    originNoticeMessage: null,
    // 起動直後は何も測っていない(FR-1102、P5 タスク31・32)。
    measurement: null,
    massProperties: null,
    measureErrorKey: null,
    // 形を測る手立てはカーネルを持つ側が起動時に差し出す(P5 タスク32)。
    partMeasurer: null,
    // 3D プリントの点検の口(FR-815、P6 タスク46)。カーネルを積むまでは差し出されない。
    partInspector: null,
    isInspectingPrint: false,
    printCheckCancelRequested: false,
    printCheckErrorMessage: null,
    exchangeNotice: null,
    // 書き出し・読み込みの口も同じ(P6 タスク32)。差し出されるまでは理由つきで断る。
    exchangeKernel: null,
    // 起動直後は何も読み込んでいないので、単位を訊く小窓も出ていない(P6 タスク32b)。
    importUnitAsked: false,
    pickAnchor: null,
    // 起動直後はまだ保存も読込もしていない。口はブラウザ用から始める(§2.10)。
    fileGateway: createBrowserFileGateway(),
    fileName: null,
    savedDocument: null,
    captureThumbnail: null,
    capturePrintFrame: null,
    fileMessage: null,
    autoSaver: null,
    restorePrompt: null,
    /*
      起動直後はアセンブリを開いていない(P7 §0.a-0.10、タスク5)。1 つの窓で開く文書は
      1 つだけなので、ここが null のあいだは上の `document`(部品)が画面に出る。
      新規の部品を作ったときも null へ戻す(`documentSlice.ts` の `resetDocument`)。
    */
    assembly: null,
    ...createDrawingInitialState(),
    // 干渉解析の口はアプリ入口が起動後に差し出す。文書切替では取り下げない。
    assemblyInterferenceRunner: null,
    // 置換候補の形を一度だけ計算する口も、カーネルを積むまでは無い。
    assemblyReplacementRunner: null,
  };
}
