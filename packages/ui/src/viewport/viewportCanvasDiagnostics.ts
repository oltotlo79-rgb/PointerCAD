import { observeThumbnailCaptureReasons, type createThumbnailCaptureReasonJournal } from '../file/thumbnail.js';
import { useAppStore } from '../store/useAppStore.js';
import type { CutPreview } from './createSolidLayer.js';
import type { ViewportMeshReservation, ViewportScene } from './createViewportScene.js';
import type { ViewportAssemblyInput } from './viewportCanvasAssemblyInput.js';
import type { PendingViewportReading, ViewportLifetime } from './viewportLifetime.js';
import type { createViewportMeshObservation, ViewportMeshObservationSnapshot } from './viewportMeshObservation.js';

/*
 * ViewportCanvas の検査専用の口(window.pcad*)。描画の完了の統計・視野・表示の予約・切断の予告・組立の
 * 表示の持ち主・メッシュの観測・保存の理由を、生きている装着の間だけ読めるようにする。StrictMode や複数の
 * 装着では最後に載った生きている口だけを公開し、外す時は自分の口の時だけ消す(製品の状態には含めない)。
 */

/** E2Eだけが読む、実際に完了したビューポート描画の統計。製品の状態には含めない。 */
interface ViewportRenderStats {
  readonly completedRenders: number;
  readonly lastCompletedAtMs: number;
  readonly totalSceneRenderMs: number;
  readonly totalDrawListenerMs: number;
  readonly cleanupStatus: 'active' | 'complete' | 'pending';
}

declare global {
  interface Window {
    /** 検査専用。`scene.render` が正常に戻った回数と最後の完了時刻を読む。 */
    pcadViewportRenderStats?: () => ViewportRenderStats;
    pcadViewportAssemblyOwner?: () => Readonly<Record<string, unknown>> | null;
    pcadViewportFramedBodies?: () => readonly string[];
    pcadThumbnailCaptureReasons?: () => ReturnType<ReturnType<typeof createThumbnailCaptureReasonJournal>['snapshot']>;
    /** 検査専用の表示コピー/属性予約会計。driverのGPU actualではない。 */
    pcadViewportMemoryStats?: () => ViewportMeshReservation | null;
    pcadViewportMeshObservation?: () => ViewportMeshObservationSnapshot;
    /** 検査専用。scene へ渡した最後の切断の予告(切断の予告の画面検査が予告の面を読む)。 */
    pcadViewportCutPreview?: () => CutPreview | null;
    pcadViewportRetiredCleanups?: () => { readonly pendingCount: number; readonly ownerCount: number; readonly admittedOwnerCount: number;
      readonly waitingCount: number; readonly scheduled: boolean; readonly sharedGpuPoolReservedBytes: number;
      readonly owners: readonly PendingViewportReading[] };
  }
}

/**
 * 検査専用の口 `window.pcadViewportCutPreview`を出している、生きているビューポートの読み取り。
 * 付けた順に積み、いちばん後に付けたものを公開する。外したら 1 つ前のものへ、最後の 1 つを外したら
 * 最初に付ける前の値へ戻す(取り付けと取り外しが対になる)。製品の経路からは読まない。
 */
const cutPreviewReaders: (() => CutPreview | null)[] = [];
let cutPreviewReaderBeforeAttach: (() => CutPreview | null) | undefined;

/** 読み取りを口へ付け、外す関数を返す(ビューポートの lifetime に登録する)。 */
function attachCutPreviewReader(read: () => CutPreview | null): () => void {
  if (cutPreviewReaders.length === 0) {
    cutPreviewReaderBeforeAttach = window.pcadViewportCutPreview;
  }
  cutPreviewReaders.push(read);
  window.pcadViewportCutPreview = read;
  return () => {
    const index = cutPreviewReaders.indexOf(read);
    if (index === -1) {
      return;
    }
    cutPreviewReaders.splice(index, 1);
    const restored = cutPreviewReaders.at(-1) ?? cutPreviewReaderBeforeAttach;
    if (restored === undefined) {
      delete window.pcadViewportCutPreview;
    } else {
      window.pcadViewportCutPreview = restored;
    }
  };
}

/**
 * 表示の持ち主の診断(公開の口が呼ばれた時だけ読む。毎フレームは観測しない)。文書・本体は弱い識別番号だけにし、
 * 値を保持しない。識別番号はこの関数を呼んだ 1 回の表示の初期化の間だけ通じる。
 */
function createAssemblyOwnerDiagnostics(): (state: ReturnType<typeof useAppStore.getState>) => Readonly<Record<string, unknown>> {
  // Diagnostic metadata only. Weak identity tags never retain documents or bodies.
  const ownerIdentities = new WeakMap<object, number>();
  let nextOwnerIdentity = 0;
  const identityOf = (value: object | null): number | null => {
    if (value === null) return null;
    const previous = ownerIdentities.get(value);
    if (previous !== undefined) return previous;
    const identity = ++nextOwnerIdentity;
    ownerIdentities.set(value, identity);
    return identity;
  };
  const readOwnerCheck = (read: () => boolean): { readonly value: boolean | null; readonly error: string | null } => {
    try { return { value: read(), error: null }; }
    catch (error) { return { value: null, error: String(error) }; }
  };
  return (state) => {
    const view = state.assemblyView, owner = view?.meshOwnership;
    return { isComputing: state.isComputing, activeDocumentId: state.activeDocumentId,
      documentVersion: state.documentVersion, requestedGeneration: state.requestedGeneration,
      completedGeneration: state.completedGeneration, cancelRequestCount: state.cancelRequestCount,
      recomputeCancelled: state.recomputeCancelled, lastOutcome: state.lastOutcome, timelineIndex: state.timelineIndex,
      assemblyIdentity: identityOf(state.assembly), drawingIdentity: identityOf(state.drawing),
      assemblyLibraryIdentity: identityOf(state.assemblyLibrary), assemblyViewIdentity: identityOf(view),
      sourceDocumentIdentity: identityOf(view?.sourceDocument ?? null),
      sourceBodiesIdentity: identityOf(view?.bodies ?? null), ownershipIdentity: identityOf(owner ?? null),
      ownership: owner === undefined ? null : {
        documentIdentity: identityOf(owner.document), libraryIdentity: identityOf(owner.library),
        activeDocumentId: owner.activeDocumentId, documentVersion: owner.documentVersion,
        generation: owner.generation, outcome: owner.outcome, timelineIndex: owner.timelineIndex,
        cancelRequestCount: owner.cancelRequestCount, bodiesIdentity: identityOf(owner.bodies),
        receiptStatus: owner.receipt.status, backingInspectionStatus: owner.backingInspection.status,
        publicationCurrent: readOwnerCheck(() => owner.publicationCurrent()), receiptCurrent: readOwnerCheck(() => owner.receiptCurrent()),
        backingInspectionCurrent: readOwnerCheck(() => owner.backingInspectionCurrent()),
      } };
  };
}

/** 保存のサムネイルの理由の控えを観測し、口から読めるようにする(装着の初期化の最初に 1 回)。 */
export function publishThumbnailReasons(lifetime: ViewportLifetime,
  thumbnailReasons: ReturnType<typeof createThumbnailCaptureReasonJournal>): void {
  const readThumbnailReasons = () => thumbnailReasons.snapshot();
  lifetime.register('thumbnail reason observer', observeThumbnailCaptureReasons(thumbnailReasons.record));
  window.pcadThumbnailCaptureReasons = readThumbnailReasons;
  lifetime.register('thumbnail reason getter', () => {
    if (window.pcadThumbnailCaptureReasons === readThumbnailReasons) delete window.pcadThumbnailCaptureReasons;
  });
}

/** 描画の完了の統計。描画の持ち主が 1 回の描画ごとに書き、口が読む。 */
function createRenderStats(cleanupStatus: () => ViewportRenderStats['cleanupStatus']) {
  let completedRenders = 0;
  let lastCompletedAtMs = 0;
  let totalSceneRenderMs = 0;
  let totalDrawListenerMs = 0;
  return {
    read: (): ViewportRenderStats => ({
      completedRenders,
      lastCompletedAtMs,
      totalSceneRenderMs,
      totalDrawListenerMs,
      cleanupStatus: cleanupStatus(),
    }),
    /** `scene.render` が例外なく戻った実描画だけを、1回につきちょうど1つ数える。完了の時刻を返す。 */
    renderCompleted(renderStartedAt: number): number {
      completedRenders += 1;
      lastCompletedAtMs = globalThis.performance.now();
      totalSceneRenderMs += lastCompletedAtMs - renderStartedAt;
      return lastCompletedAtMs;
    },
    listenersCompleted(completedAt: number): void {
      totalDrawListenerMs += globalThis.performance.now() - completedAt;
    },
  };
}

export type ViewportRenderStatsRecorder = ReturnType<typeof createRenderStats>;

/** 装着ごとの口が読むもの。 */
interface SceneDiagnosticsSources {
  readonly lifetime: ViewportLifetime;
  readonly scene: ViewportScene;
  readonly isAlive: () => boolean;
  readonly viewportOwnerId: string;
  readonly observation: ReturnType<typeof createViewportMeshObservation>;
  readonly assemblyInput: Pick<ViewportAssemblyInput, 'observationSnapshot' | 'clearMateInputs'>;
  readonly readRetiredViewports: NonNullable<Window['pcadViewportRetiredCleanups']>;
}

/**
 * scene を作った後の検査専用の口を、片付けの登録と組で公開する。描画の統計の書き手と、scene へ渡した
 * 最後の切断の予告を控えて渡す関数を返す。
 */
export function publishSceneDiagnostics(sources: SceneDiagnosticsSources) {
  const { lifetime, scene, isAlive, viewportOwnerId, observation, assemblyInput } = sources;
  const stats = createRenderStats(() => isAlive() ? 'active' : lifetime.pendingCount === 0 ? 'complete' : 'pending');
  const readRenderStats = stats.read;
  // StrictModeや将来の複数mountでは、最後に載った生きている口だけを公開する。
  lifetime.register('render observation', () => {
    if (window.pcadViewportRenderStats === readRenderStats) delete window.pcadViewportRenderStats;
  });
  window.pcadViewportRenderStats = readRenderStats;
  const readFramedBodies = (): readonly string[] => isAlive() ? scene.fullyFramedBodyIds() : [];
  lifetime.register('frame observation', () => {
    if (window.pcadViewportFramedBodies === readFramedBodies) delete window.pcadViewportFramedBodies;
  });
  window.pcadViewportFramedBodies = readFramedBodies;
  const readMemoryStats = (): ViewportMeshReservation | null => isAlive() ? scene.meshReservation() : null;
  lifetime.register('memory observation', () => {
    if (window.pcadViewportMemoryStats === readMemoryStats) delete window.pcadViewportMemoryStats;
  });
  window.pcadViewportMemoryStats = readMemoryStats;
  // 切断の予告は、scene へ渡した最後の値だけを検査専用の口から読めるようにする(製品の状態には含めない)。
  let lastCutPreview: CutPreview | null = null;
  const showCutPreview = (preview: CutPreview | null): void => {
    lastCutPreview = preview;
    scene.setCutPreview(preview);
  };
  const readCutPreview = (): CutPreview | null => isAlive() ? lastCutPreview : null;
  lifetime.register('cut preview observation', attachCutPreviewReader(readCutPreview));
  // Diagnostic metadata only. Weak identity tags never retain documents or bodies.
  const describeAssemblyOwner = createAssemblyOwnerDiagnostics();
  // Same publication lifetime as the existing owner getter; no per-frame observation.
  const readAssemblyOwner = (): Readonly<Record<string, unknown>> | null => isAlive() ? {
    viewportOwnerId, ...assemblyInput.observationSnapshot(), ...describeAssemblyOwner(useAppStore.getState()),
  } : null;
  lifetime.register('assembly ownership observation', () => {
    assemblyInput.clearMateInputs();
    if (window.pcadViewportAssemblyOwner === readAssemblyOwner) delete window.pcadViewportAssemblyOwner;
  });
  window.pcadViewportAssemblyOwner = readAssemblyOwner;
  const readMeshObservation = (): ViewportMeshObservationSnapshot => observation.snapshot();
  lifetime.register('mesh observation getter', () => {
    if (window.pcadViewportMeshObservation === readMeshObservation) delete window.pcadViewportMeshObservation;
  });
  window.pcadViewportMeshObservation = readMeshObservation;
  window.pcadViewportRetiredCleanups = sources.readRetiredViewports;
  return { stats, showCutPreview };
}
