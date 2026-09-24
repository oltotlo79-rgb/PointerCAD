/** bridge data exchanged through the model's kernel bridge. Types only; no Worker lifetime. */
import type {
  DrawingProjectionRequest,
  DrawingProjectionResult,
  DrawingSectionRequest,
  DrawingSectionResult,
} from '../drawing/resolveDrawing.js';
import type {
  AssemblyComponent,
} from '../assembly/types.js';
import type {
  ResolvedAssembly,
} from '../assembly/resolveAssembly.js';
import type {
  RigidPlacement,
} from '../assembly/placementMath.js';
import type {
  ResolvedSolidStep,
} from '../part/resolvePart.js';
import type {
  ResolvedFace,
} from '../sketch/types.js';
import type {
  SketchTessellationOutcome,
  SketchOffsetRequestItem,
  SketchOffsetResult,
  SketchProjectionRequestItem,
  SketchProjectionResult,
} from './sketchContracts.js';
import type {
  SolidBody,
  SolidRecomputeOutcome,
  PartCancelToken,
  SolidRecomputeOptions,
} from './solidContracts.js';
import type {
  MeasureTarget,
  MeasureOutcome,
  PrintabilityOutcome,
  PrintabilityOptions,
} from './analysisContracts.js';
import type {
  ShapeExportOptions,
  ShapeExportOutcome,
  ShapeImportOptions,
  ShapeImportOutcome,
} from './exchangeContracts.js';


/** model から幾何カーネルへの唯一の接点。ここ以外から kernel を呼ばない。 */
export interface KernelBridge {
  /** Read topology for current upstream steps without changing the displayed part. Older test bridges may omit it. */
  readCachedBodies?(steps: readonly ResolvedSolidStep[], featureIds: readonly string[]): Promise<SolidRecomputeOutcome>;
  /** 面の一覧をカーネルへ渡し、表示用の三角形を受け取る(FR-309)。 */
  tessellateSketchFaces(faces: readonly ResolvedFace[]): Promise<SketchTessellationOutcome>;
  /**
   * 解決済みの段を履歴順にカーネルへ渡し、表示用のボディを受け取る(FR-401〜404、要件§6.3)。
   * 文書が変わったときだけ呼ぶ。ホバー・選択・視点操作では呼ばない(§2.4)。
   *
   * Worker が壊れて応答しなくなったときは例外を投げず、進行中の依頼を
   * `KERNEL_BROKEN_MESSAGE` の失敗として解決する(§2.9、NFR-RE-1「止めずに警告する」)。
   * 次にこの関数を呼んだときは Worker を作り直してから依頼を出す。作り直すと
   * 形状キャッシュが空になるので、次の再計算は全段作り直しになる(遅くなるが落ちない)。
   */
  recomputeSolids(
    steps: readonly ResolvedSolidStep[],
    options?: SolidRecomputeOptions,
  ): Promise<SolidRecomputeOutcome>;
  /**
   * 輪郭を距離ぶんずらした曲線の列をカーネルへ頼む(FR-321、P4 タスク15)。
   * 何件でも 1 回の往復でまとめて頼め、1 件失敗しても残りは返る(FR-504)。
   */
  offsetSketchCurves(
    requests: readonly SketchOffsetRequestItem[],
  ): Promise<SketchOffsetResult>;
  /**
   * 立体の面・辺の輪郭を作図面へ投影した曲線をカーネルへ頼む(FR-325、P4 タスク25)。
   * 何件でも 1 回の往復でまとめて頼め、1 件失敗しても残りは返る(FR-504)。
   */
  projectSketchCurves(
    requests: readonly SketchProjectionRequestItem[],
  ): Promise<SketchProjectionResult>;
  /**
   * 立体と作図面の交線(断面の輪郭)をカーネルへ頼む(FR-325)。
   * **交わらないときは失敗ではなく曲線 0 本**で返る(断るのは呼び出し側)。
   */
  sectionSketchCurves(
    requests: readonly SketchProjectionRequestItem[],
  ): Promise<SketchProjectionResult>;
  /**
   * 覚えてある形を測る(FR-1101、FR-1102、P5 タスク29)。**再計算を起こさない読み取り**
   * (§0.a-0.30)。対象は立体を作ったフィーチャーの id で指し、`steps` から段の鍵
   * (`ResolvedSolidStep.key`)へ引き直してからカーネルへ渡す(外観の面の照合と同じ流儀)。
   *
   * **`steps` の中に鍵が引けない対象が 1 つでもあれば、カーネルを呼ばずに断る**
   * (測定は読み取りだけなので、ここから再計算を起こさない、§0.a-0.30)。
   */
  measure(
    steps: readonly ResolvedSolidStep[],
    targets: readonly MeasureTarget[],
    kind: 'distance' | 'massProperties',
  ): Promise<MeasureOutcome>;
  /**
   * 覚えてある形をファイルへ書き出す(FR-803、FR-804、P6 タスク32b)。**測定と同じく
   * 再計算を起こさない読み取り**で、対象は立体を作ったフィーチャーの id で指し、`steps` から
   * 段の鍵(`ResolvedSolidStep.key`)へ引き直してからカーネルへ渡す。
   *
   * **1 つでも鍵が引けなければ、カーネルを呼ばずに `kind: 'failed'` で断る**(一部だけ
   * 入ったファイルを渡さない、NFR-UX-5)。書けなかった理由も投げずに返す(NFR-RE-1)。
   */
  exportShapes(
    steps: readonly ResolvedSolidStep[],
    options: ShapeExportOptions,
  ): Promise<ShapeExportOutcome>;
  /**
   * ファイルから立体を読み込む(FR-802、FR-811、P6 タスク32b)。**今の文書には触れない**
   * ——読めた形を返すだけで、履歴へ積むかどうかは呼び出し側が決める(NFR-RE-1)。
   *
   * 読めなかった理由は投げずに `kind: 'failed'` で返す(文言の正本は幾何カーネル)。
   */
  importShape(options: ShapeImportOptions): Promise<ShapeImportOutcome>;
  /**
   * 3D プリント向けの点検(FR-815、P6 タスク46)。**測定・書き出しと同じく再計算を
   * 起こさない読み取り**で、対象は立体を作ったフィーチャーの id で指し、`steps` から
   * 段の鍵(`ResolvedSolidStep.key`)へ引き直してからカーネルへ渡す。
   *
   * **1 つでも鍵が引けなければ、カーネルを呼ばずに `kind: 'failed'` で断る**(測定と同じ、
   * §0.a-0.30)。点検できなかった理由も投げずに返す(NFR-RE-1)。
   *
   * 進み具合と中止は `options` に渡す(`recomputeSolids` と同じ形)。**中止しても結果は
   * 返る**(`PrintabilityReport.cancelled` が真になり、肉厚だけが測ったところまでになる)。
   */
  inspectPrintability(
    steps: readonly ResolvedSolidStep[],
    options: PrintabilityOptions,
  ): Promise<PrintabilityOutcome>;
  dispose(): void;
}

/**
 * Worker が壊れたかどうかを持つ小さな状態機械(§2.9)。
 * Worker そのものには触れないので、実物の Worker を起動できない Node のテストからも
 * 判断のロジックだけを確かめられる(docs/報告記録.md 2026-09-02 14:50 の④
 * 「Worker の実動作は Node では確かめられない」)。
 */
export interface KernelHealth {
  readonly broken: boolean;
  markBroken(): void;
  /** 作り直したことにする。 */
  reset(): void;
}

/** 既存の結果の型とは別に読む、RPCの決着理由。 */
export type KernelOperationStatus = 'success' | 'failed' | 'cancelled' | 'workerBroken';
export type KernelOperationCounts = Readonly<Record<KernelOperationStatus, number>>;

/** 部品単位の形の寿命と、再取得が必要な鍵。欠落を通常の計算失敗と混ぜない。 */
export interface ShapeAvailability {
  readonly partId: string;
  readonly missingKeys: readonly string[];
}

/** 既存のKernelBridge実装・テストダブルへ必須メソッドを増やさないための追加の口。 */
export interface AssemblyKernelBridge extends KernelBridge {
  releasePart(partId: string): Promise<void>;
  checkShapeAvailability(partId: string, bodyKeys: readonly string[]): Promise<ShapeAvailability>;
}

export interface AssemblyInterferenceInput {
  readonly requestId: string;
  readonly components: readonly AssemblyComponent[];
  readonly resolved: ResolvedAssembly;
  readonly bodies: ReadonlyMap<string, readonly SolidBody[]>;
  readonly placements: ReadonlyMap<string, RigidPlacement>;
}
export type AssemblyInterferencePairId = readonly [string, string];
export interface AssemblyInterferenceOptions {
  readonly pairs?: readonly AssemblyInterferencePairId[];
  readonly ignoredPairs?: readonly AssemblyInterferencePairId[];
  readonly onProgress?: (progress: AssemblyInterferenceProgress) => void;
  readonly shouldCancel?: PartCancelToken;
}
export interface AssemblyInterferenceProgress {
  readonly requestId: string;
  readonly phase: 'prepare' | 'candidates' | 'common' | 'mesh';
  readonly completedPairs: number;
  readonly totalPairs: number;
  readonly completedComponents: number;
  readonly totalComponents: number;
  readonly currentPair?: AssemblyInterferencePairId;
}
export interface AssemblyInterferenceMesh {
  readonly positions: Float32Array;
  readonly normals: Float32Array;
  readonly indices: Uint32Array;
  readonly triangleCount: number;
}
export interface AssemblyInterferencePair {
  readonly aComponentId: string;
  readonly bComponentId: string;
  readonly volume: number;
  readonly mesh: AssemblyInterferenceMesh;
}
export interface AssemblyInterferencePairFailure {
  readonly pair: AssemblyInterferencePairId;
  readonly stage: 'input' | 'bounds' | 'union' | 'placement' | 'common' | 'mesh' | 'release';
  readonly code: 'unresolvedPart' | 'missingBody' | 'unsupportedBody' | 'invalidPlacement' | 'boundsFailed'
    | 'unionFailed' | 'meshFailed' | 'invalidInput' | 'buildFailed' | 'invalidResult' | 'measurementFailed'
    | 'occtException' | 'cleanupFailed';
  readonly message: string;
  readonly missingKeys?: readonly string[];
  readonly cleanupMessages?: readonly string[];
}
export interface AssemblyInterferenceReport {
  readonly requestId: string;
  readonly pairs: readonly AssemblyInterferencePair[];
  readonly failures: readonly AssemblyInterferencePairFailure[];
  readonly skips: readonly { readonly pair: AssemblyInterferencePairId; readonly reason: 'suppressed' | 'hidden' | 'ignored' }[];
  readonly totalPairCount: number;
  readonly checkedPairCount: number;
  readonly skippedPairCount: number;
  readonly pendingPairCount: number;
  readonly cancelled: boolean;
}
export interface AssemblyInterferenceRootFailure {
  readonly code: 'invalidRequest' | 'noComponents' | 'kernelUnavailable' | 'callbackFailed'
    | 'cleanupFailed' | 'unexpectedFailure' | 'workerBroken' | 'rpcFailed';
  readonly message: string;
  readonly cleanupMessages?: readonly string[];
}
export type AssemblyInterferenceResult = AssemblyInterferenceReport & (
  | { readonly kind: 'checked'; readonly failure: null }
  | { readonly kind: 'failed'; readonly failure: AssemblyInterferenceRootFailure });
export interface InterferenceKernelBridge extends AssemblyKernelBridge {
  checkInterference(input: AssemblyInterferenceInput, options?: AssemblyInterferenceOptions): Promise<AssemblyInterferenceResult>;
}

export interface MonitoredKernelBridge extends InterferenceKernelBridge {
  pendingWaiters(): number;
  operationCounts(): KernelOperationCounts;
  pendingCallbacks(): number;
  /** この橋のRPCが返した結果(または拒否理由)の分類。別の値ならundefined。 */
  operationStatus(result: unknown): KernelOperationStatus | undefined;
}

/** Web Worker内の幾何カーネルへつなぐ。ブラウザ・Electronのレンダラで使う。 */
export interface DrawingOperationOptions {
  readonly onProgress?: (progress: DrawingOperationProgress) => void;
  readonly shouldCancel?: () => boolean;
}

export interface DrawingOperationProgress {
  readonly completed: number;
  readonly total: number;
  readonly viewId: string | null;
}

export interface DrawingKernelBridge {
  hiddenLineViews(request: DrawingProjectionRequest, options?: DrawingOperationOptions): Promise<DrawingProjectionResult>;
  sectionViews(request: DrawingSectionRequest, options?: DrawingOperationOptions): Promise<DrawingSectionResult>;
}
