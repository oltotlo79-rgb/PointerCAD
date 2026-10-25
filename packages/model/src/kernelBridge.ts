/**
 * model から幾何カーネルへの唯一の接点(計画書 docs/plans/P1-式とスケッチ.md タスク12、
 * docs/plans/P3-加工フィーチャー.md タスク17)。
 *
 * @pointercad/kernel の型はこの入口と kernelBridge/ 内の変換処理で使い、外へは model の型で返す
 * (P0 §0.11、rules/04-設計の規律.md の依存方向)。Workerの接続と実行はこの入口が所有し、変換処理は通信しない。
 */

import {
  createKernelWorker,
  createRuntimePhaseJournal,
  DEFAULT_ANGULAR_DEFLECTION,
  DEFAULT_LINEAR_DEFLECTION,
  makeSketchChamfer,
  makeSketchFillet,
  type createKernelApi,
  type FaceMeshData,
  type KernelApi,
  type ManagedKernelApi,
  type MaterialComparisonKernelApi,
  type InterferenceComponentSpec,
  type InterferenceRequest,
  type InterferenceResult,
  type InterferenceProgress,
  type PrintabilityProgress,
  type SketchTessellationFailure,
  type SolidProgress,
  type SolidRecomputeRequest,
} from '@pointercad/kernel';
import * as Comlink from 'comlink';
import type { AnalysisBoundaryReply } from './geometry/analysisMesh.js';
import { HOST_RECORD_BYTES, MeshHostRetention } from './kernelBridge/meshHostRetention.js';
import type { MaterialComparisonBridge, MaterialComparisonResult } from './kernelBridge/materialComparisonContracts.js';
import { readMaterialComparison } from './kernelBridge/readMaterialComparison.js';
export type { MaterialComparisonBridge, MaterialComparisonResult, MaterialComparisonGeometry, MaterialDifferenceRegion } from './kernelBridge/materialComparisonContracts.js';
import { readFunctionCurveGeometry, type FunctionKernelBridge } from './functionGeometry/functionCurveGeometry.js';
import type {
  DrawingProjectionResult,
  DrawingSectionResult,
} from './drawing/resolveDrawing.js';

import type { ExportMeshQuality } from './exchange/types.js';
import type { ResolvedSolidStep } from './part/resolvePart.js';

import type {
  ResolvedFace,
  SketchFaceMesh,
} from './sketch/types.js';

import { toFaceRequest } from './kernelBridge/curveConversions.js';
import {
  toOffsetItem, toOffsetResult, toProjectionItem, toSectionItem, toProjectionResult,
} from './kernelBridge/sketchConversions.js';
export { toOffsetResult, fromPlaneCurve, toProjectionResult } from './kernelBridge/sketchConversions.js';
import { toMeasureRequest, toMeasureOutcome } from './kernelBridge/measureConversions.js';
import { toShapeInspectRequest, toShapeInspectItems, printabilityProgressOf, toPrintabilityOutcome } from './kernelBridge/inspectionConversions.js';
export { toPrintabilityOutcome } from './kernelBridge/inspectionConversions.js';
import { toShapeExportItems, toShapeExportRequest, toShapeExportOutcome, toShapeImportRequest, toShapeImportOutcome } from './kernelBridge/exchangeConversions.js';
import { captureSolidRecomputeContext, toSolidRecomputeRequest, toSolidOutcome } from './kernelBridge/solidConversions.js';
export { toAppearanceQueries, toAppearanceMatches, toSolidOutcome } from './kernelBridge/solidConversions.js';
import type {
  SketchFaceFailure,
  SketchTessellationOutcome,
  SketchOffsetResult,
  SketchProjectionResult,
  SketchCornerSegment,
  SketchCornerPlane,
  SketchFilletGeometry,
  SketchChamferGeometry,
} from './kernelBridge/sketchContracts.js';
export type {
  SketchFaceFailure,
  SketchTessellationOutcome,
  SketchOffsetRequestItem,
  SketchOffsetContour,
  SketchOffsetEntry,
  SketchOffsetFailure,
  SketchOffsetResult,
  SketchProjectionRequestItem,
  SketchProjectionEntry,
  SketchProjectionFailure,
  SketchProjectionResult,
  SketchCornerSegment,
  SketchCornerPlane,
  SketchFilletGeometry,
  SketchChamferGeometry,
  SolidBodyMeshData,
} from './kernelBridge/sketchContracts.js';
import type {
  SolidRecomputeOutcome,
  PartProgressCallback,
  PartCancelToken,
} from './kernelBridge/solidContracts.js';
export type {
  SolidFaceEntry,
  SolidEdgeEntry,
  SolidVertexEntry,
  ThreadMarkEntry,
  SolidBodyKind,
  AppearanceFaceRequest,
  AppearanceMatchEntry,
  SolidBody,
  SolidBodyFailure,
  SolidRecomputeOutcome,
  PartProgress,
  PartProgressCallback,
  PartCancelToken,
  SolidRecomputeOptions,
  MateSubShapeGeometry,
} from './kernelBridge/solidContracts.js';
import type {
  MeasureOutcome,
  PrintabilityProgressCallback,
  PrintabilityOutcome,
} from './kernelBridge/analysisContracts.js';
import type { ShapeExportOutcome, ShapeImportOutcome } from './kernelBridge/exchangeContracts.js';
export type {
  MeasureTarget,
  MeasureOutcome,
  PrintabilityPhase,
  PrintabilityProgressView,
  PrintabilityProgressCallback,
  PrintabilitySummary,
  PrintabilityReport,
  PrintabilityMeshIdentity,
  PrintabilityOutcome,
  PrintabilityOptions,
} from './kernelBridge/analysisContracts.js';
export type {
  ExportColor,
  ExportFaceRange,
  ShapeExportBody,
  ShapeExportFormat,
  ShapeExportOptions,
  ExportedFile,
  ExportedMeshBody,
  ShapeExportOutcome,
  ShapeImportOptions,
  ImportedTriangles,
  ImportedBody,
  ShapeImportOutcome,
} from './kernelBridge/exchangeContracts.js';
import type {
  KernelBridge,
  MeshLedgerOwner, CurrentMeshLedgerInput, CurrentMeshLedgerReceipt, ReferenceMeshLeaseOptions, PartReleaseClaim, PartReleaseDisposition, SourceMeshBackingInspection,
  KernelHealth,
  KernelOperationStatus,
  ShapeAvailability,
  AssemblyKernelBridge,
  AssemblyInterferenceInput,
  AssemblyInterferencePairId,
  AssemblyInterferenceOptions,
  AssemblyInterferenceProgress,
  AssemblyInterferenceReport,
  AssemblyInterferenceRootFailure,
  AssemblyInterferenceResult,
  InterferenceKernelBridge,
  MonitoredKernelBridge,
  RuntimeUiContext,
  RuntimePhaseObservation,
  RuntimePhaseCapture,
  MainRuntimePhase,
  MainRuntimePhaseRecord,
  DrawingOperationProgress,
  DrawingKernelBridge,
} from './kernelBridge/bridgeContracts.js';
export type {
  KernelBridge,
  MeshLedgerOwner, CurrentMeshLedgerInput, CurrentMeshLedgerReceipt, ReferenceMeshLeaseOptions, PartReleaseClaim, PartReleaseDisposition, SourceMeshBackingInspection,
  KernelHealth,
  KernelOperationStatus,
  KernelOperationCounts,
  ShapeAvailability,
  AssemblyKernelBridge,
  AssemblyInterferenceInput,
  AssemblyInterferencePairId,
  AssemblyInterferenceOptions,
  AssemblyInterferenceProgress,
  AssemblyInterferenceMesh,
  AssemblyInterferencePair,
  AssemblyInterferencePairFailure,
  AssemblyInterferenceReport,
  AssemblyInterferenceRootFailure,
  AssemblyInterferenceResult,
  InterferenceKernelBridge,
  MonitoredKernelBridge,
  RuntimeUiContext,
  RuntimePhaseObservation,
  MainRuntimePhase,
  MainRuntimePhaseRecord,
  DrawingOperationOptions,
  DrawingOperationProgress,
  DrawingKernelBridge,
} from './kernelBridge/bridgeContracts.js';
export { toCurveSpec, toFaceRequest, fromCurveSpec } from './kernelBridge/curveConversions.js';
export { toSolidStepRequest } from './kernelBridge/solidRequests.js';

/**
 * 角を丸めた形を求める(FR-323)。角として成り立たないとき、半径が線の長さに
 * 収まらないときは日本語の `Error` を投げる(呼び出し側が断りへ直す)。
 */
export function sketchFilletGeometry(
  line1: SketchCornerSegment,
  line2: SketchCornerSegment,
  plane: SketchCornerPlane,
  radius: number,
): SketchFilletGeometry {
  return makeSketchFillet({
    line1: { kind: 'segment', from: line1.from, to: line1.to },
    line2: { kind: 'segment', from: line2.from, to: line2.to },
    plane,
    radius,
  });
}

/**
 * 角を面取りした形を求める(FR-323)。作図面を取らないのは、面取りの結果が
 * 2 つの絶対座標だけで決まるため(kernel の `makeSketchChamfer2d.ts` の注釈)。
 */
export function sketchChamferGeometry(
  line1: SketchCornerSegment,
  line2: SketchCornerSegment,
  distance1: number,
  distance2: number,
): SketchChamferGeometry {
  return makeSketchChamfer({
    line1: { kind: 'segment', from: line1.from, to: line1.to },
    line2: { kind: 'segment', from: line2.from, to: line2.to },
    distance1,
    distance2,
  });
}

/**
 * 対象の立体を作ったフィーチャーの id が、いま渡された `steps` の中に見つからなかったとき
 * (§0.a-0.30)。
 *
 * kernel(`worker/kernelApi.ts` の `MEASURE_MISSING_SHAPE_MESSAGE`)が形状キャッシュに
 * 鍵が無かったときに返すのと**同じ日本語**。kernel はこの文字列を輸出していない
 * (`KernelApi` の実装の中だけの定数)ので、断りの文言を 1 つに揃えるためここへ複製する。
 * **測定は再計算を起こさない読み取り**(§0.a-0.30)なので、鍵が引けない対象があるときは
 * カーネルを呼ばずにここで断る(古い・存在しない鍵で問い合わせて紛らわしい失敗を返させない)。
 */
const MEASURE_MISSING_SHAPE_MESSAGE = '測れませんでした。もう一度お試しください。';

/**
 * 書き出す立体の段の鍵が引けなかったとき。
 *
 * kernel(`worker/kernelApi.ts` の `MISSING_BODY_MESSAGE`)が形状キャッシュに鍵が無かった
 * ときに返すのと**同じ日本語**。kernel はこの文字列を輸出していないので、断りの文言を
 * 1 つに揃えるためここへ複製する(測定の `MEASURE_MISSING_SHAPE_MESSAGE` と同じ扱い)。
 * **1 つでも引けなければ書き出しごと断る**——一部だけ入ったファイルを渡すと、利用者は
 * 欠けに気づかないまま他の CAD へ持っていくことになる(NFR-UX-5)。
 */
const EXPORT_MISSING_SHAPE_MESSAGE = 'もとになる立体が見つかりませんでした。もう一度計算し直してください。';

/** カーネルが投げた理由を、そのまま画面へ出せる 1 行にする(文言の正本はカーネル側)。 */
function toFailureMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/* ------------------------------------------------------------------ *
 * 3D プリント向けの点検(FR-815、P6 §0.51・§0.53・§2.16、タスク46 = 43a)
 * ------------------------------------------------------------------ */

/**
 * 従来の点検依頼が使っていた、画面の一般既定と同じ細かさの対。
 *
 * 現在の Worker は点検に実際の表示メッシュを使い、この値では再メッシュ化しない。
 * 値を残すのは公開済みの依頼との互換と、粗さの定数を 1 か所から参照するためである。
 *
 * **数はカーネルの既定(`DEFAULT_LINEAR_DEFLECTION` / `DEFAULT_ANGULAR_DEFLECTION`)を
 * そのまま引く**——書き写すと、画面側の既定を変えたときにここだけ古くなる。
 * 書き出しの 3 択(`EXPORT_MESH_QUALITY`)にこの対は無い(`normal` は角度が 0.2 で、
 * 書き出しの精度のために画面より細かい)ので、別に 1 つ置いてある。
 */
export const DISPLAY_MESH_QUALITY: ExportMeshQuality = {
  deviationMm: DEFAULT_LINEAR_DEFLECTION,
  angularDeflectionRad: DEFAULT_ANGULAR_DEFLECTION,
};

/**
 * 点検の三角形ごとの真偽の読み出しと、しきい値の既定を**カーネルからそのまま出し直す**。
 *
 * このファイルの決まりは「kernel の**型**を外へ出さない」(冒頭の注釈)で、値の写しを
 * 禁じてはいない。ここで出し直すのは次の 3 つだけである。
 *
 * - `readPrintabilityFlag`: 詰めたビットの並べ方(下位ビットから)を知る唯一の関数。
 *   ui が同じ式を書き写すと、並べ方を変えたときに片方だけ古くなる
 *   (`sketchFilletGeometry` を model が写さずカーネルの式を使うのと同じ判断)。
 * - `DEFAULT_MIN_THICKNESS_MM` / `DEFAULT_OVERHANG_ANGLE_DEG`: 判定のしきい値の既定。
 *   プロパティ欄の初期値に要るが、数を写すと**画面に出る値と実際に使う値が食い違う**。
 *
 * どれも素の数と純関数で、`TopoDS_Shape` のようなカーネル固有の型は 1 つも通らない。
 */
export {
  DEFAULT_MIN_THICKNESS_MM,
  DEFAULT_OVERHANG_ANGLE_DEG,
  readPrintabilityFlag,
} from '@pointercad/kernel';

/**
 * 点検する立体が 1 つも指定されていないとき。
 *
 * カーネルは三角形が 0 枚のときに `PRINTABILITY_NO_TRIANGLE_MESSAGE`(「点検できる形が
 * ありません。」)で断るが、**立体を 1 つも渡さないなら Worker を起こす意味が無い**ので
 * 同じ日本語をここで返す(測定の `MEASURE_MISSING_SHAPE_MESSAGE` と同じ扱いで、
 * 文言をそろえるために複製する)。
 */
const PRINTABILITY_NO_BODY_MESSAGE = '点検できる形がありません。';

/* ------------------------------------------------------------------ *
 * 部分形状の選び直し(FR-325・FR-328〜330 の上流追従、P4 タスク25)— 同期の純関数
 * ------------------------------------------------------------------ */

export { selectSubShape, selectMateTargetGeometry, rematchSubShapeRef } from './kernelBridge/subShapeMatching.js';
export { resolveSubShapeReference, resolveReplacementSubShapeReference, createSubShapeReferenceResolver, SUB_SHAPE_AMBIGUITY_MARGIN, type SubShapeReferenceResolution } from './kernelBridge/referenceResolution.js';
export type { SubShapeMatchCandidate } from './kernelBridge/subShapeMatching.js';

/** 1ジョブが貸すcallbackと、その輸送に使ったportの所有者。 */
interface KernelCallbackScope {
  readonly active: boolean;
  proxy<T extends object>(callback: T): T;
  serialize(callback: object): [MessagePort, Transferable[]];
  size(): number;
  close(): void;
}

const callbackOwners = new WeakMap<object, KernelCallbackScope>();
let callbackHandlerInstalled = false;

/** Worker側の標準proxy読み手を保ち、こちらが所有するportだけをジョブ終了時に閉じる。 */
function installCallbackHandler(): void {
  if (callbackHandlerInstalled) return;
  const original = Comlink.transferHandlers.get('proxy');
  if (original === undefined) throw new Error('Comlink proxy transfer handler is unavailable');
  Comlink.transferHandlers.set('proxy', {
    canHandle: original.canHandle.bind(original),
    deserialize: original.deserialize.bind(original),
    serialize(value: unknown) {
      if ((typeof value === 'object' && value !== null) || typeof value === 'function') {
        const owner = callbackOwners.get(value);
        if (owner !== undefined) return owner.serialize(value);
      }
      return original.serialize(value);
    },
  });
  callbackHandlerInstalled = true;
}

function createKernelCallbackScope(onClose: () => void): KernelCallbackScope {
  installCallbackHandler();
  const callbacks = new Set<object>();
  const cleanups = new Set<() => void>();
  let active = true;
  const scope: KernelCallbackScope = {
    get active() { return active; },
    proxy(callback) {
      callbacks.add(callback);
      callbackOwners.set(callback, scope);
      return Comlink.proxy(callback);
    },
    serialize(callback) {
      const { port1, port2 } = new MessageChannel();
      const listeners = new Set<EventListenerOrEventListenerObject>();
      const endpoint: Comlink.Endpoint = {
        postMessage: (message: unknown, transfer?: Transferable[]) => {
          if (active) port1.postMessage(message, transfer ?? []);
        },
        addEventListener: (type, listener) => {
          listeners.add(listener);
          port1.addEventListener(type, listener);
        },
        removeEventListener: (type, listener) => {
          listeners.delete(listener);
          port1.removeEventListener(type, listener);
        },
        start: () => port1.start(),
      };
      Comlink.expose(callback, endpoint);
      cleanups.add(() => {
        for (const listener of listeners) port1.removeEventListener('message', listener);
        listeners.clear();
        port1.close();
        port2.close();
      });
      return [port2, [port2]];
    },
    size: () => callbacks.size,
    close() {
      if (!active) return;
      active = false;
      for (const callback of callbacks) callbackOwners.delete(callback);
      callbacks.clear();
      for (const cleanup of cleanups) cleanup();
      cleanups.clear();
      onClose();
    },
  };
  return scope;
}

/** 進捗をComlinkで渡せる関数にし、終了後の遅れて届いた通知を捨てる。 */
function toProgressProxy(
  onProgress: PartProgressCallback | undefined,
  scope: KernelCallbackScope,
): ((progress: SolidProgress) => void) | undefined {
  if (onProgress === undefined) {
    return undefined;
  }
  return scope.proxy((progress: SolidProgress) => {
    if (!scope.active) return;
    onProgress({
      featureId: progress.stepId,
      index: progress.index,
      total: progress.total,
      label: progress.label,
    });
  });
}

/**
 * 点検の進捗を受け取る関数を Comlink.proxy で包む(`toProgressProxy` と同じ理由)。
 *
 * 写しそのもの(kernel の値 → model の 4 欄)は `printabilityProgressOf` が持つ。
 * **写さずにそのまま渡すことはしない**——kernel の値をそのまま外へ出すと、あとで
 * カーネル側に欄が増えたときに model の型に無い欄が混ざる(`toSolidBody` と同じ扱い)。
 */
function toPrintabilityProgressProxy(
  onProgress: PrintabilityProgressCallback | undefined,
  scope: KernelCallbackScope,
): ((progress: PrintabilityProgress) => void) | undefined {
  const copy = printabilityProgressOf(onProgress);
  return copy === undefined ? undefined : scope.proxy((progress: PrintabilityProgress) => {
    if (scope.active) copy(progress);
  });
}

declare global {
  interface Window {
    /**
     * **検査専用の口**(P5、NFR-PF-4 の E2E)。アプリはこの値を 1 か所も書かない。
     *
     * 正の数を入れておくと、立体の**段と段の間**(カーネルが中止を尋ねてくるところ)で
     * 毎回この ms だけ待ってから答える。頁の外(Playwright)から入れるためだけにあり、
     * 入っていなければ(通常の道では `undefined`)待ちは 1 ミリ秒も挟まらない。
     */
    pcadDebugStepDelayMs?: number;
  }
}

/**
 * 段と段の間に挟む検査専用の待ち(ms)。入っていなければ 0(= 待たない)。
 *
 * Node の検査や Worker の中には `window` が無いので、まず有無を見る。
 */
function debugStepDelayMs(): number {
  if (typeof window === 'undefined') {
    return 0;
  }
  const value = window.pcadDebugStepDelayMs;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return 0;
  }
  return value;
}

/**
 * 中止を尋ねる関数も同じ理由で Comlink.proxy で包む(§1.2-5)。
 *
 * ここに**検査専用の遅延の口**(`window.pcadDebugStepDelayMs`)を 1 つだけ挟んである。
 * カーネルは段と段の間でこの関数を `await` して答えを待つ(`recomputeSolids` の
 * 「中止の口が渡されているときだけ制御を譲る」)ので、ここで待つと**計算そのものが
 * その ms だけ延びる**。長い計算(NFR-PF-4 の帯と「中止」)を機械の速さに頼らず作れる。
 * CPU を絞って長い計算を作る手は、共有の遅いランナーでは検査が時間切れになった
 * (rules/06 10.14)。値が入っていない通常の道では `shouldCancel()` をそのまま返し、
 * 約束(Promise)すら作らない。
 */
function toCancelProxy(
  shouldCancel: PartCancelToken | undefined,
  scope: KernelCallbackScope,
): (() => boolean | Promise<boolean>) | undefined {
  if (shouldCancel === undefined) {
    return undefined;
  }
  return scope.proxy(() => {
    if (!scope.active) return true;
    const delayMs = debugStepDelayMs();
    if (delayMs === 0) {
      return shouldCancel();
    }
    return new Promise<boolean>((resolve) => {
      setTimeout(() => {
        resolve(!scope.active || shouldCancel());
      }, delayMs);
    });
  });
}

/** 面が消えたとき(カーネルが id を返さなかったとき)に付ける理由。 */
const MISSING_FACE_MESSAGE = 'カーネルから面が返りませんでした。';

/** 色が引けないときの塗り色。解決済みの面には必ず色があるので、通常は使わない。 */
const FALLBACK_FACE_COLOR = '#ffffff';

/**
 * カーネルの結果を model の言葉へ詰め替える。
 * 依頼したのに面もエラーも返らなかった id は、理由を補って失敗として扱う(FR-504)。
 */
function toOutcome(
  faces: readonly ResolvedFace[],
  meshes: readonly FaceMeshData[],
  failures: readonly SketchTessellationFailure[],
): SketchTessellationOutcome {
  const colorByFeature = new Map(faces.map((face) => [face.featureId, face.color]));
  const built: SketchFaceMesh[] = meshes.map((mesh) => ({
    featureId: mesh.id,
    color: colorByFeature.get(mesh.id) ?? FALLBACK_FACE_COLOR,
    positions: mesh.positions,
    normals: mesh.normals,
    indices: mesh.indices,
    triangleCount: mesh.triangleCount,
    // 線分1本あたり 6 要素(始点 xyz + 終点 xyz)の並び(docs/報告記録.md 2026-09-02 21:03)。
    boundaryPositions: mesh.boundaryPositions,
  }));

  const reported = new Set<string>(built.map((mesh) => mesh.featureId));
  const collected: SketchFaceFailure[] = failures.map((failure) => ({
    featureId: failure.id,
    message: failure.message,
  }));
  for (const failure of collected) {
    reported.add(failure.featureId);
  }
  for (const face of faces) {
    if (!reported.has(face.featureId)) {
      collected.push({ featureId: face.featureId, message: MISSING_FACE_MESSAGE });
    }
  }

  return { mesh: { faces: built }, failures: collected };
}

/**
 * Worker が壊れたときに利用者へ見せる理由(NFR-RE-1、§2.9、§0.a-0.19)。
 * OCCT の C++ 側が `abort()` すると WASM ごと止まり、以後どの依頼にも応答しなくなる。
 * この場合いまの再計算はやり直せないので、値を戻すよう案内する。
 */
export const KERNEL_BROKEN_MESSAGE =
  'カーネルが止まりました。値を元に戻してから、もう一度お試しください。';

/** Export meshing runs in a Worker; the bridge can stop even a synchronous native call. */
export const EXPORT_TIMEOUT_MS = 25_000;
export const EXPORT_TIMEOUT_MESSAGE = '書き出しが25秒を超えたため中止しました。形を確認してから、もう一度お試しください。';

function cachedBodySteps(steps: readonly ResolvedSolidStep[], ids: readonly string[]): readonly ResolvedSolidStep[] | null {
  if (new Set(ids).size !== ids.length) return null;
  const result: ResolvedSolidStep[] = [];
  for (const id of ids) {
    const matches = steps.filter(step => step.featureId === id);
    if (matches.length !== 1) return null;
    result.push(matches[0]);
  }
  return result;
}
function cachedBodyFailure(ids: readonly string[], message: string): SolidRecomputeOutcome {
  return { bodies: [], failures: ids.map(featureId => ({ featureId, message })), cacheHits: 0, cancelled: false, appearanceMatches: [] };
}

export function createKernelHealth(): KernelHealth {
  let broken = false;
  return {
    get broken(): boolean {
      return broken;
    },
    markBroken(): void {
      broken = true;
    },
    reset(): void {
      broken = false;
    },
  };
}

type InterruptedStatus = 'cancelled' | 'workerBroken';
type BrokenRace<T> =
  | { readonly kind: 'response'; readonly result: T }
  | { readonly kind: InterruptedStatus }
  | { readonly kind: 'aborted' }
  | { readonly kind: 'timeout' };

interface WorkerTimeout<T> {
  readonly milliseconds: number;
  readonly refuse: () => T;
  readonly terminateAndRestart: () => void;
}

interface WorkerCancellation<T> {
  readonly signal: AbortSignal;
  readonly refuse: () => T;
}

interface KernelConnection {
  readonly worker: Worker;
  readonly remote: Comlink.Remote<ReturnType<typeof createKernelApi>>;
  readonly waiters: Set<() => void>;
  readonly counts: Record<KernelOperationStatus, number>;
  readonly results: WeakMap<object, KernelOperationStatus>;
  readonly handleBroken: () => void;
  readonly closeTransport: () => void;
  interruption: InterruptedStatus | null;
  closed: boolean;
  terminationReturned: boolean;
  readonly beforeRequest: () => void;
}

function interruptKernelConnection(connection: KernelConnection, kind: InterruptedStatus): void {
  connection.interruption ??= kind;
  const waiting = [...connection.waiters];
  connection.waiters.clear();
  for (const notify of waiting) notify();
}

function createKernelConnection(
  onBroken: () => void,
  counts: Record<KernelOperationStatus, number>,
  results: WeakMap<object, KernelOperationStatus>,
  beforeRequest: () => void = () => undefined,
): KernelConnection {
  const worker = createKernelWorker();
  const localReplies = new EventTarget();
  const listeners = new Set<EventListenerOrEventListenerObject>();
  const unresolvedTransportReplies = new Set<string>();
  const handleTransportReply = (event: MessageEvent<unknown>): void => {
    if (typeof event.data === 'object' && event.data !== null && 'id' in event.data
      && typeof event.data.id === 'string') unresolvedTransportReplies.delete(event.data.id);
  };
  worker.addEventListener('message', handleTransportReply);
  function rejectClosedReply(id: string): void {
    localReplies.dispatchEvent(new MessageEvent('message', { data: {
      id, type: 'HANDLER', name: 'throw', value: { isError: true,
        value: { name: 'Error', message: 'Kernel transport closed before its reply was received', stack: '' } },
    } }));
  }
  const endpoint: Comlink.Endpoint = {
    postMessage(message: unknown, transfer?: Transferable[]) {
      // Comlink 4のreleaseProxyはvoidを返し、内部Promiseを呼出側ではcatchできない。
      // 終了するWorkerへRELEASEを送らず、その後始末だけをローカルで決着する。
      if (connection.closed && typeof message === 'object' && message !== null
        && 'type' in message && message.type === 'RELEASE' && 'id' in message) {
        localReplies.dispatchEvent(new MessageEvent('message', { data: { id: message.id, type: 'RAW', value: undefined } }));
        return;
      }
      const id = typeof message === 'object' && message !== null && 'id' in message
        && typeof message.id === 'string' ? message.id : null;
      if (connection.closed) { if (id !== null) rejectClosedReply(id); return; }
      if (id !== null) unresolvedTransportReplies.add(id);
      worker.postMessage(message, transfer ?? []);
    },
    addEventListener(type, listener) { listeners.add(listener); worker.addEventListener(type, listener); localReplies.addEventListener(type, listener); },
    removeEventListener(type, listener) { listeners.delete(listener); worker.removeEventListener(type, listener); localReplies.removeEventListener(type, listener); },
  };
  const connection: KernelConnection = {
    worker,
    beforeRequest,
    remote: Comlink.wrap<ReturnType<typeof createKernelApi>>(endpoint),
    waiters: new Set(),
    counts,
    results,
    interruption: null,
    closed: false,
    terminationReturned: false,
    closeTransport() {
      // Received replies have already left this set and retain their real raw adoption continuation.
      // Only calls with no received reply get a synthetic transport error, never a fabricated mesh.
      for (const id of unresolvedTransportReplies) rejectClosedReply(id);
      unresolvedTransportReplies.clear();
      for (const listener of listeners) { worker.removeEventListener('message', listener); localReplies.removeEventListener('message', listener); }
      listeners.clear();
      worker.removeEventListener('message', handleTransportReply);
    },
    handleBroken: () => {
      if (connection.closed) return;
      onBroken();
      interruptKernelConnection(connection, 'workerBroken');
    },
  };
  worker.addEventListener('error', connection.handleBroken);
  worker.addEventListener('messageerror', connection.handleBroken);
  return connection;
}

function operationStatus(result: unknown): KernelOperationStatus {
  if (typeof result === 'object' && result !== null) {
    if (('cancelled' in result && result.cancelled === true) ||
        ('kind' in result && result.kind === 'cancelled')) return 'cancelled';
    if (('kind' in result && result.kind === 'failed') ||
        ('failures' in result && Array.isArray(result.failures) && result.failures.length > 0)) {
      return 'failed';
    }
  }
  return 'success';
}

/** 返す値を変えず、文書や結果の寿命を延ばさないWeakMapに決着理由を添える。 */
function rememberOperation<T>(connection: KernelConnection, status: KernelOperationStatus, result: T): T {
  connection.counts[status] += 1;
  if ((typeof result === 'object' && result !== null) || typeof result === 'function') {
    connection.results.set(result, status);
  }
  return result;
}

/**
 * Workerが黙ったまま壊れても全RPCを決着させる(§2.9)。共有Promiseのthenは使わず、
 * 呼び出しごとの通知を登録する。同期送信失敗もfinallyを通し、通知とcallbackを解放する。
 * 破損・disposeは既存のrefuseの値で返す。決着理由はoperationStatus(result)で区別する。
 */
async function raceWithBroken<T>(
  connection: KernelConnection,
  request: () => Promise<T>,
  refuse: () => T,
  callbacks?: KernelCallbackScope,
  timeout?: WorkerTimeout<T>,
  cancellation?: WorkerCancellation<T>,
  meshEffect: 'may-change-owned-mesh' | 'readonly-mesh-observation' = 'may-change-owned-mesh',
): Promise<T> {
  let notify: () => void = () => undefined;
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  let orphaned = false;
  let orphanReleased = false;
  let requestSettled = false;
  const releaseOrphan = (): void => {
    if (!orphaned || orphanReleased) return;
    orphanReleased = true;
    if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
    connection.waiters.delete(notify);
  };
  try {
    if (cancellation?.signal.aborted) {
      return rememberOperation(connection, 'cancelled', cancellation.refuse());
    }
    if (connection.interruption !== null) {
      return rememberOperation(connection, connection.interruption, refuse());
    }
    const interrupted = new Promise<BrokenRace<T>>((resolve) => {
      notify = () => resolve({ kind: connection.interruption ?? 'workerBroken' });
      connection.waiters.add(notify);
    });
    // An abandoned export still owns its native job and original deadline. Keep its
    // waiter until the underlying RPC finishes, the Worker closes, or time expires.
    void interrupted.then(releaseOrphan);
    const cancelled = cancellation === undefined ? null : new Promise<BrokenRace<T>>((resolve) => {
      abort = () => {
        if (requestSettled || connection.interruption !== null) return;
        orphaned = connection.waiters.size > 1;
        resolve({ kind: 'aborted' });
        if (!orphaned) timeout?.terminateAndRestart();
      };
      cancellation.signal.addEventListener('abort', abort, { once: true });
    });
    const pending: Promise<BrokenRace<T>>[] = [interrupted];
    if (timeout !== undefined) {
      pending.push(new Promise<BrokenRace<T>>((resolve) => {
        timeoutHandle = setTimeout(() => {
          if (orphaned) {
            if (!requestSettled && connection.interruption === null) timeout.terminateAndRestart();
            releaseOrphan();
          } else resolve({ kind: 'timeout' });
        }, timeout.milliseconds);
      }));
    }
    // Readonly membership must validate the issued epoch, not invalidate it itself.
    // Every mutating RPC keeps the default invalidation before dispatch.
    if (meshEffect === 'may-change-owned-mesh') connection.beforeRequest();
    pending.push(request().then(
      (result) => { requestSettled = true; releaseOrphan(); return { kind: 'response' as const, result }; },
      (error: unknown) => { requestSettled = true; releaseOrphan(); throw error; },
    ));
    if (cancelled !== null) pending.push(cancelled);
    if (cancellation?.signal.aborted) abort?.();
    const race = await Promise.race(pending);
    if (race.kind === 'timeout') {
      if (timeout === undefined) throw new Error('Export timeout configuration is missing');
      timeout.terminateAndRestart();
      return rememberOperation(connection, 'failed', timeout.refuse());
    }
    if (race.kind !== 'response') {
      if (race.kind === 'aborted') {
        if (cancellation === undefined) throw new Error('Export cancellation configuration is missing');
        return rememberOperation(connection, 'cancelled', cancellation.refuse());
      }
      return rememberOperation(connection, race.kind, refuse());
    }
    return rememberOperation(connection, operationStatus(race.result), race.result);
  } catch (error: unknown) {
    rememberOperation(connection, 'failed', error);
    throw error;
  } finally {
    if (abort !== undefined) cancellation?.signal.removeEventListener('abort', abort);
    if (!orphaned || orphanReleased) {
      if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
      connection.waiters.delete(notify);
    }
    callbacks?.close();
  }
}

/**
 * 壊れたときの断りの一覧。**依頼した 1 件ごとに 1 つ**、理由は `KERNEL_BROKEN_MESSAGE`。
 * 面・オフセット・投影・断面はどれも「1 件失敗しても残りは返す」形(FR-504)なので、
 * 全件をこの理由の失敗にすれば、呼び手は普段の失敗と同じ道で画面へ出せる。
 */
function brokenFailures(
  items: readonly { readonly featureId: string }[],
): readonly { readonly featureId: string; readonly message: string }[] {
  return items.map((item) => ({ featureId: item.featureId, message: KERNEL_BROKEN_MESSAGE }));
}

/** 接続を締める。壊れた Worker への解放要求が失敗しても、後始末は続ける(NFR-RE-1)。 */
function closeKernelConnection(connection: KernelConnection): void {
  if (connection.terminationReturned) return;
  connection.closed = true;
  interruptKernelConnection(connection, 'cancelled');
  connection.worker.removeEventListener('error', connection.handleBroken);
  connection.worker.removeEventListener('messageerror', connection.handleBroken);
  // Comlink.releaseProxy synchronously clears its resolver Map. Settle actual
  // unreceived transport requests first, while those exact resolvers still exist.
  // Received replies already left this set and keep their raw adoption continuation.
  connection.closeTransport();
  try {
    connection.remote[Comlink.releaseProxy]();
  } catch {
    // Worker がすでに応答しない状態では解放の要求自体が失敗しうるが、
    // 呼び出し側は必ず worker.terminate() へ進むので実害は無い。
  }
  connection.worker.terminate();
  connection.terminationReturned = true;
}

/** 保存配置へ後退せず、現在表示されている世界配置と完了body群をawait前に写す。 */
function toInterferenceRequest(input: AssemblyInterferenceInput, options: AssemblyInterferenceOptions): InterferenceRequest {
  return {
    requestId: input.requestId,
    components: input.components.map((component): InterferenceComponentSpec => {
      const componentId = component.id;
      if (component.suppressed) return { kind: 'excluded', componentId, reason: 'suppressed' };
      if (!component.visible) return { kind: 'excluded', componentId, reason: 'hidden' };
      const partKey = input.resolved.partKeys.get(componentId);
      const part = partKey === undefined ? undefined : input.resolved.parts.get(partKey);
      if (partKey === undefined || part === undefined || part.errors.length > 0) return {
        kind: 'unavailable', componentId, code: 'unresolvedPart', message: '部品の計算結果がありません。',
      };
      const placement = input.placements.get(componentId);
      if (placement === undefined) return { kind: 'unavailable', componentId, code: 'invalidPlacement', message: '部品の現在の位置がありません。' };
      const completed = input.bodies.get(partKey);
      if (completed === undefined || part.liveBodyIds.length === 0) return { kind: 'unavailable', componentId,
        code: 'missingBody', message: '部品の立体の計算が完了していません。' };
      const bodyKeys: string[] = [];
      for (const id of part.liveBodyIds) {
        const body = completed.find((entry) => entry.featureId === id);
        const step = part.steps.find((entry) => entry.featureId === id && entry.visible);
        if (body === undefined) return { kind: 'unavailable', componentId, code: 'missingBody',
          message: '部品の立体の計算が完了していません。', ...(step === undefined ? {} : { missingKeys: [step.key] }) };
        if (body.bodyKind !== 'solid') return { kind: 'unavailable', componentId, code: 'unsupportedBody', message: '面や三角形だけの部品は調べられません。' };
        if (step === undefined || !body.isValid) return { kind: 'unavailable', componentId, code: 'missingBody', message: '部品の立体を取得できません。' };
        bodyKeys.push(step.key);
      }
      return { kind: 'ready', componentId, bodyKeys: [...new Set(bodyKeys)].sort(), placement: {
        position: [...placement.position],
        rotation: [...placement.rotation],
      } };
    }),
    ...(options.pairs === undefined ? {} : { pairs: options.pairs.map(([a, b]): AssemblyInterferencePairId => [a, b]) }),
    ...(options.ignoredPairs === undefined ? {} : { ignoredPairs: options.ignoredPairs.map(([a, b]): AssemblyInterferencePairId => [a, b]) }),
  };
}

function interferenceProgressOf(progress: InterferenceProgress): AssemblyInterferenceProgress {
  return { requestId: progress.requestId, phase: progress.phase, completedPairs: progress.completedPairs,
    totalPairs: progress.totalPairs, completedComponents: progress.completedComponents, totalComponents: progress.totalComponents,
    ...(progress.currentPair === undefined ? {} : { currentPair: [progress.currentPair[0], progress.currentPair[1]] }) };
}

function toInterferenceResult(result: InterferenceResult): AssemblyInterferenceResult {
  const report: AssemblyInterferenceReport = {
    requestId: result.requestId, totalPairCount: result.totalPairCount, checkedPairCount: result.checkedPairCount,
    skippedPairCount: result.skippedPairCount, pendingPairCount: result.pendingPairCount, cancelled: result.cancelled,
    pairs: result.pairs.map((pair) => ({ aComponentId: pair.aComponentId, bComponentId: pair.bComponentId,
      volume: pair.volume, mesh: { positions: pair.mesh.positions, normals: pair.mesh.normals,
        indices: pair.mesh.indices, triangleCount: pair.mesh.triangleCount } })),
    failures: result.failures.map((failure) => ({ pair: [failure.pair[0], failure.pair[1]], stage: failure.stage,
      code: failure.code, message: failure.message,
      ...(failure.missingKeys === undefined ? {} : { missingKeys: [...failure.missingKeys] }),
      ...(failure.cleanupMessages === undefined ? {} : { cleanupMessages: [...failure.cleanupMessages] }) })),
    skips: result.skips.map((skip) => ({ pair: [skip.pair[0], skip.pair[1]], reason: skip.reason })),
  };
  return result.kind === 'checked' ? { ...report, kind: 'checked', failure: null }
    : { ...report, kind: 'failed', failure: { code: result.failure.code, message: result.failure.message,
      ...(result.failure.cleanupMessages === undefined ? {} : { cleanupMessages: [...result.failure.cleanupMessages] }) } };
}

/** 輸送自体が決着しなかった組はpending。計算済み・clearを捏造しない。 */
function refusedInterference(request: InterferenceRequest, failure: AssemblyInterferenceRootFailure, cancelled = false): AssemblyInterferenceResult {
  const total = request.pairs === undefined ? request.components.length * (request.components.length - 1) / 2
    : new Set(request.pairs.map(([a, b]) => JSON.stringify([a, b].sort()))).size;
  const report: AssemblyInterferenceReport = { requestId: request.requestId, pairs: [], failures: [], skips: [],
    totalPairCount: total, checkedPairCount: 0, skippedPairCount: 0, pendingPairCount: total, cancelled };
  return cancelled ? { ...report, kind: 'checked', failure: null } : { ...report, kind: 'failed', failure };
}


const MESH_LEDGER_LIMIT_BYTES = 512 * 1024 * 1024;
/** One actual bridge instance owns this registered main-realm ledger, across Worker restarts. */
type CurrentWorkerMeshQuery = NonNullable<KernelApi['readCurrentMeshAccounting']>;
type CurrentWorkerMeshObservation = Awaited<ReturnType<CurrentWorkerMeshQuery>>;
type ReferenceMeshLeaseDisposition = Awaited<ReturnType<NonNullable<KernelApi['releaseReferenceMeshLease']>>>;
// Record bounds follow the 512 MiB capacity (one per HOST_RECORD_BYTES = 131,072), not a fixed 128 owners (EX12).
const realmMeshHost = MeshHostRetention.forCapacity(MESH_LEDGER_LIMIT_BYTES);
let nextMeshProvider = 0;
const realmMeshProviders = new Map<number, {
  readonly connectionEpoch: number;
  readonly query: CurrentWorkerMeshQuery;
  readonly issued: WeakSet<MeshLedgerOwner>;
  readonly ownerCoverageReason: () => string | null;
}>();
interface MeshLedgerValidationEvent {
  readonly seq: number;
  readonly providerId: number;
  readonly reason: string | null;
  readonly issuedHostEpoch: number | null;
  readonly beforeObservationHostEpoch: number;
  readonly observedHostEpoch: number | null;
  readonly pendingCloneBytes: number | null;
  readonly issuedProviderCount: number | null;
  readonly actualProviderCount: number;
}
const meshLedgerValidations: MeshLedgerValidationEvent[] = [];
let meshLedgerValidationSequence = 0, meshLedgerValidationDropped = 0, meshLedgerValidationFailures = 0;
function recordMeshLedgerValidation(value: Omit<MeshLedgerValidationEvent, 'seq'>): void {
  try {
    if (!Number.isSafeInteger(meshLedgerValidationSequence + 1)) throw new RangeError('Diagnostic sequence overflow');
    if (meshLedgerValidations.length === 128) { meshLedgerValidations.shift(); meshLedgerValidationDropped += 1; }
    meshLedgerValidations.push(Object.freeze({ seq: ++meshLedgerValidationSequence, ...value }));
  } catch { meshLedgerValidationFailures += 1; }
}
/** No census/query/prune: snapshots only primitive observations already made by ordinary guards. */
export function readMeshLedgerDiagnostics() {
  return Object.freeze({ host: realmMeshHost.readDiagnostics(), validations: Object.freeze(meshLedgerValidations.slice()),
    dropped: meshLedgerValidationDropped, failures: meshLedgerValidationFailures,
    coverage: 'existing-main-ledger-validation-and-host-epoch-mutations-only', acceptanceComplete: false });
}
declare global { interface Window { pcadMeshLedgerDiagnostics?: typeof readMeshLedgerDiagnostics } }

function createBridgeMeshLedger(sameRealm: boolean) {
  const host = realmMeshHost;
  if (!Number.isSafeInteger(nextMeshProvider + 1)) throw new RangeError('Mesh provider ID overflow');
  const providerId = ++nextMeshProvider;
  let connectionEpoch = 0;
  const ownerCoverageReasons = new Set<string>();
  const ownerCoverageReason = (): string | null => ownerCoverageReasons.values().next().value ?? null;
  const logicalDisplayOwners = new Map<string, MeshLedgerOwner>();
  const bodyOwners = new WeakMap<readonly import('./kernelBridge/solidContracts.js').SolidBody[], MeshLedgerOwner>();
  const issued = new WeakSet<MeshLedgerOwner>();
  const backingInspections = new WeakMap<SourceMeshBackingInspection, CurrentMeshLedgerReceipt>();
  const receipts = new WeakSet<CurrentMeshLedgerReceipt>();
  let nextDispatch = 0;
  function dispatch(partId: string, generation: number, kind: 'display' | 'hidden', steps: readonly ResolvedSolidStep[]): MeshLedgerOwner {
    if (!Number.isSafeInteger(nextDispatch + 1)) throw new RangeError('Mesh dispatch ID overflow');
    const owner: MeshLedgerOwner = Object.freeze({ dispatchId: `mesh-${providerId}-${connectionEpoch}-${++nextDispatch}`, partId, generation, kind,
      steps: Object.freeze(steps.map(step => Object.freeze({ id: step.featureId, key: step.key }))) });
    issued.add(owner); return owner;
  }
  async function reserve(owner: MeshLedgerOwner, requested: number,
    shouldCancel: () => boolean | Promise<boolean>, alive: () => boolean) {
    return host.reserveReplyWhenReady(owner.dispatchId, requested, shouldCancel, alive);
  }
  async function admitReply(owner: MeshLedgerOwner, metadata: {
    readonly owner: MeshLedgerOwner; readonly replyBackingBytes: number; readonly workerRetainedBackingBytes: number;
  }, alive: () => boolean): Promise<boolean> {
    if (!alive() || metadata.owner.dispatchId !== owner.dispatchId || metadata.owner.partId !== owner.partId
      || metadata.owner.generation !== owner.generation || metadata.owner.kind !== owner.kind
      || metadata.owner.steps.length !== owner.steps.length || !metadata.owner.steps.every((step, index) =>
        step.id === owner.steps[index]?.id && step.key === owner.steps[index]?.key)
      || !Number.isSafeInteger(metadata.replyBackingBytes) || metadata.replyBackingBytes < 0
      || !Number.isSafeInteger(metadata.workerRetainedBackingBytes) || metadata.workerRetainedBackingBytes < 0) return false;
    const reservation = host.replyReservation(owner.dispatchId);
    if (reservation === null || metadata.replyBackingBytes > reservation) return false;
    const before = host.observe();
    if (before.status !== 'known') return false;
    const others = [...realmMeshProviders.entries()].filter(([id]) => id !== providerId);
    const snapshots = await Promise.all(others.map(async ([id, provider]) => ({ id, provider,
      reading: await provider.query({ observationId: `pre-clone:${owner.dispatchId}`, limitBytes: MESH_LEDGER_LIMIT_BYTES, expectedOwners: [] }) })));
    let workerBytes = metadata.workerRetainedBackingBytes;
    for (const snapshot of snapshots) {
      const reading = snapshot.reading;
      if (realmMeshProviders.get(snapshot.id) !== snapshot.provider || reading.status !== 'known'
        || !Number.isSafeInteger(reading.reading.retainedBackingBytes) || reading.reading.retainedBackingBytes < 0) return false;
      workerBytes += reading.reading.retainedBackingBytes;
    }
    const after = host.observe();
    return alive() && after.status === 'known' && after.epoch === before.epoch
      && realmMeshProviders.size === others.length + 1
      && Number.isSafeInteger(workerBytes + after.retainedBackingBytes + after.pendingCloneBytes - reservation + metadata.replyBackingBytes)
      && workerBytes + after.retainedBackingBytes + after.pendingCloneBytes - reservation + metadata.replyBackingBytes <= MESH_LEDGER_LIMIT_BYTES;
  }
  function adopt(owner: MeshLedgerOwner, raw: import('@pointercad/kernel').SolidRecomputeResult): void {
    const buffers: ArrayBuffer[] = [];
    for (const body of raw.bodies) {
      for (const buffer of [body.positions.buffer, body.normals.buffer, body.indices.buffer, body.edgePositions.buffer]) {
        if (!(buffer instanceof ArrayBuffer)) {
          // Shared backing is outside this Weak ArrayBuffer registry; retain pending reservation and unknown.
          host.markCoverageUnknown('unsupported-reply-backing');
          throw new RangeError('Host mesh adoption unavailable: unsupported-reply-backing');
        }
        buffers.push(buffer);
      }
    }
    // Register the raw clone even when conversion later rejects/cancels it.
    const reading = host.adoptReply(owner.dispatchId, owner.dispatchId, buffers);
    if (reading.status !== 'known') throw new RangeError(`Host mesh adoption unavailable: ${reading.reason}`);
  }
  function bind(owner: MeshLedgerOwner, result: SolidRecomputeOutcome): SolidRecomputeOutcome {
    bodyOwners.set(result.bodies, owner);
    if (owner.kind === 'display') {
      const previous = logicalDisplayOwners.get(owner.partId);
      // Dispatch-order logical supersession is metadata retirement only, never a UI/native release claim.
      if (previous === undefined || previous.generation <= owner.generation) {
        if (previous !== undefined) host.revokeOwner(previous.dispatchId);
        logicalDisplayOwners.set(owner.partId, owner);
      } else host.revokeOwner(owner.dispatchId);
    }
    return result;
  }
  async function capture(input: CurrentMeshLedgerInput,
    _query?: NonNullable<KernelApi['readCurrentMeshAccounting']>): Promise<CurrentMeshLedgerReceipt> {
    void _query; // Historical callback parameter; real registered providers supply the global observations.
    input = { observationId: input.observationId, owners: Object.freeze([...input.owners]) };
    const refused = (reason: string): CurrentMeshLedgerReceipt => ({ status: 'unknown', observationId: input.observationId, reason });
    if (sameRealm) return refused('direct-realm-union-unavailable');
    const providers = [...realmMeshProviders.entries()];
    if (providers.length === 0 || providers.length > 128) return refused('provider-capacity');
    for (const [, provider] of providers) {
      const reason = provider.ownerCoverageReason();
      if (reason !== null) return refused(reason);
    }
    if (input.owners.some(owner => providers.filter(([, provider]) => provider.issued.has(owner)).length !== 1))
      return refused('unissued-owner');
    const before = host.observe();
    if (before.status !== 'known') return refused(before.reason);
    if (before.pendingCloneBytes !== 0) return refused('pending-reply');
    const snapshots = await Promise.all(providers.map(async ([id, provider]) => ({
      id, provider, reading: await provider.query({ observationId: input.observationId, limitBytes: MESH_LEDGER_LIMIT_BYTES,
        expectedOwners: input.owners.filter(owner => provider.issued.has(owner)) })
    })));
    const unknownSnapshot = snapshots.find(snapshot => snapshot.reading.status !== 'known');
    if (unknownSnapshot !== undefined && unknownSnapshot.reading.status === 'unknown') return refused(unknownSnapshot.reading.reason);
    const confirmations = await Promise.all(snapshots.map(async snapshot => ({
      id: snapshot.id, provider: snapshot.provider,
      reading: await snapshot.provider.query({ observationId: input.observationId, limitBytes: MESH_LEDGER_LIMIT_BYTES,
        expectedOwners: input.owners.filter(owner => snapshot.provider.issued.has(owner)),
        expectedEpoch: snapshot.reading.status === 'known' ? snapshot.reading.epoch : undefined })
    })));
    const after = host.observe();
    let workerRetainedBackingBytes = 0;
    const workerEpochs: { providerId: number; connectionEpoch: number; cache: number; owners: number }[] = [];
    for (const confirmation of confirmations) {
      const current = realmMeshProviders.get(confirmation.id);
      if (current !== confirmation.provider) return refused('worker-connection-changed');
      const value = confirmation.reading;
      if (value.status !== 'known') return refused(value.reason);
      const first = snapshots.find(snapshot => snapshot.id === confirmation.id)?.reading;
      if (first === undefined || first.status !== 'known' || value.observationId !== input.observationId
        || value.epoch.cache !== first.epoch.cache || value.epoch.owners !== first.epoch.owners
        || ![value.epoch.cache, value.epoch.owners, value.hiddenBackingBytes,
          value.reading.retainedBackingBytes, value.reading.cacheActiveBytes,
          value.reading.cacheRetiredBytes, value.reading.cacheProtectedBytes,
          value.reading.displayBackingBytes].every(number => Number.isSafeInteger(number) && number >= 0)
        || value.reading.limitBytes !== MESH_LEDGER_LIMIT_BYTES
        || value.reading.replyBackingBytes !== 0 || value.reading.replyCloneReservedBytes !== 0
        || value.reading.displayBackingBytes > value.reading.retainedBackingBytes
        || value.hiddenBackingBytes > value.reading.retainedBackingBytes
        || value.reading.cacheActiveBytes + value.reading.cacheRetiredBytes > value.reading.retainedBackingBytes)
        return refused('invalid-worker-snapshot');
      workerRetainedBackingBytes += value.reading.retainedBackingBytes;
      workerEpochs.push({ providerId: confirmation.id, connectionEpoch: current.connectionEpoch, ...value.epoch });
    }
    if (providers.length !== realmMeshProviders.size) return refused('worker-provider-changed');
    if (after.status !== 'known') return refused(after.reason);
    if (after.epoch !== before.epoch || after.pendingCloneBytes !== 0) return refused('host-epoch-changed');
    const admittedBoundBytes = workerRetainedBackingBytes + after.retainedBackingBytes;
    if (!Number.isSafeInteger(admittedBoundBytes)) return refused('overflow');
    if (admittedBoundBytes > MESH_LEDGER_LIMIT_BYTES) return refused('budget-exceeded');
    if (workerEpochs.length === 0) return refused('worker-epoch-missing');
    const receipt: CurrentMeshLedgerReceipt = Object.freeze({ status: 'known', observationId: input.observationId, hostEpoch: after.epoch,
      workerEpochs: Object.freeze(workerEpochs.map(epoch => Object.freeze(epoch))),
      owners: input.owners, limitBytes: MESH_LEDGER_LIMIT_BYTES,
      workerRetainedBackingBytes,
      hostRetainedBackingBytes: after.retainedBackingBytes, pendingCloneReservedBytes: 0,
      admittedBoundBytes, coverage: 'registered-solid-mesh-backings-only',
      unobserved: ['native', 'gpu', 'wasm', 'mesh-metadata', 'other-providers'] as const });
    receipts.add(receipt); return receipt;
  }
  function current(receipt: CurrentMeshLedgerReceipt): boolean {
    const beforeObservationHostEpoch = host.diagnosticEpoch();
    const reading = host.observe(); // The original single observation; diagnostics never add one.
    const issuedKnown = receipts.has(receipt) && receipt.status === 'known';
    const reason = !issuedKnown ? 'unissued-or-unknown-receipt'
      : reading.status !== 'known' ? reading.reason
      : receipt.hostEpoch !== reading.epoch ? 'host-epoch-changed'
      : reading.pendingCloneBytes !== 0 ? 'pending-reply'
      : receipt.workerEpochs.length !== realmMeshProviders.size ? 'worker-provider-count-changed'
      : !receipt.workerEpochs.every(epoch => realmMeshProviders.get(epoch.providerId)?.connectionEpoch === epoch.connectionEpoch)
        ? 'worker-connection-changed' : null;
    recordMeshLedgerValidation({ providerId, reason,
      issuedHostEpoch: issuedKnown ? receipt.hostEpoch : null, beforeObservationHostEpoch,
      observedHostEpoch: reading.status === 'known' ? reading.epoch : null,
      pendingCloneBytes: reading.pendingCloneBytes,
      issuedProviderCount: issuedKnown ? receipt.workerEpochs.length : null, actualProviderCount: realmMeshProviders.size });
    return reason === null;
  }
  async function inspectSourceMeshBackings(receipt: CurrentMeshLedgerReceipt, buffers: readonly ArrayBufferLike[]): Promise<SourceMeshBackingInspection> {
    const unknown = (reason: string): SourceMeshBackingInspection => ({ status: 'unknown', reason });
    if (!current(receipt) || receipt.status !== 'known') return unknown('unissued-or-stale-receipt');
    // Same capacity-derived record bound as the realm ledger (512 MiB / 4 KiB), not a fixed 4,096 UI backings.
    if (buffers.length > MESH_LEDGER_LIMIT_BYTES / HOST_RECORD_BYTES) return unknown('input-capacity');
    buffers = Object.freeze([...buffers]);
    const fresh = await capture({ observationId: `${receipt.observationId}:backing-membership`, owners: receipt.owners });
    if (fresh.status !== 'known') return unknown(fresh.reason);
    if (!current(receipt) || fresh.hostEpoch !== receipt.hostEpoch
      || fresh.workerRetainedBackingBytes !== receipt.workerRetainedBackingBytes
      || fresh.hostRetainedBackingBytes !== receipt.hostRetainedBackingBytes
      || fresh.workerEpochs.length !== receipt.workerEpochs.length
      || fresh.workerEpochs.some((epoch, index) => {
        const old = receipt.workerEpochs[index];
        return old === undefined || old.providerId !== epoch.providerId || old.connectionEpoch !== epoch.connectionEpoch
          || old.cache !== epoch.cache || old.owners !== epoch.owners;
      })) return unknown('global-epoch-changed');
    const membership = host.inspectBackings(receipt.hostEpoch, buffers);
    if (membership.status !== 'known') return unknown(membership.reason);
    const inspection: SourceMeshBackingInspection = Object.freeze({ status: 'known', hostEpoch: membership.epoch,
      inputBackingBytes: membership.inputBackingBytes, additionalBackingBytes: membership.additionalBackingBytes,
      sameSourceBackings: membership.sameSourceBackings, coverage: 'registered-main-solid-backings-only',
      unobserved: ['native', 'gpu', 'wasm', 'mesh-metadata', 'other-providers'] as const });
    backingInspections.set(inspection, receipt); return inspection;
  }
  function attachWorker(query: CurrentWorkerMeshQuery | null): void {
    host.advanceEpoch();
    for (const owner of logicalDisplayOwners.values()) host.revokeOwner(owner.dispatchId);
    logicalDisplayOwners.clear();
    connectionEpoch += 1;
    ownerCoverageReasons.clear();
    if (!Number.isSafeInteger(connectionEpoch)) { host.markCoverageUnknown('connection-epoch-overflow'); return; }
    if (query === null) realmMeshProviders.delete(providerId);
    else realmMeshProviders.set(providerId, { connectionEpoch, query, issued, ownerCoverageReason });
  }
  /** Short-circuit refusal metadata: no observation or inspection of an unissued receipt. */
  function refuse(reason: string): false {
    recordMeshLedgerValidation({ providerId, reason, issuedHostEpoch: null,
      beforeObservationHostEpoch: host.diagnosticEpoch(), observedHostEpoch: null, pendingCloneBytes: null,
      issuedProviderCount: null, actualProviderCount: realmMeshProviders.size });
    return false;
  }
  return { host, dispatch, reserve, admitReply, adopt, bind, capture, issued, attachWorker, refuse,
    ownerCoverageReason,
    retire: (owner: MeshLedgerOwner) => {
      host.revokeOwner(owner.dispatchId);
      if (logicalDisplayOwners.get(owner.partId) === owner) logicalDisplayOwners.delete(owner.partId);
    },
    connectionEpoch: () => connectionEpoch,
    markOwnerCoverageUnknown: (reason: string) => { ownerCoverageReasons.add(reason); host.advanceEpoch(); },
    clearOwnerCoverageReason: (reason: string) => { if (ownerCoverageReasons.delete(reason)) host.advanceEpoch(); },
    current, inspectSourceMeshBackings,
    currentSourceMeshBackingInspection: (inspection: SourceMeshBackingInspection, receipt: CurrentMeshLedgerReceipt) => {
      if (inspection.status !== 'known') return refuse('backing-inspection-unknown');
      if (backingInspections.get(inspection) !== receipt) return refuse('unissued-or-different-receipt-inspection');
      return current(receipt);
    },
    owner: (bodies: readonly import('./kernelBridge/solidContracts.js').SolidBody[]) => bodyOwners.get(bodies) ?? null };
}

/** Metadata only. Recording never owns a mesh, callback proxy, document or native resource. */
export function createMainPhaseObserver(readUi?: () => RuntimeUiContext) {
  const records: MainRuntimePhaseRecord[] = [];
  const journal = createRuntimePhaseJournal<MainRuntimePhaseRecord>();
  let lastSeq = 0, dropped = 0, clockDiscontinuities = 0, missingContexts = 0;
  let previous: { epochMs: number; monoMs: number } | null = null;
  const contexts = new Map<string, RuntimeUiContext | null>();
  function record(phase: MainRuntimePhase, epoch: number, owner: MeshLedgerOwner | null): void {
    let ui: RuntimeUiContext | null = null;
    if (owner !== null) {
      if (phase === 'dispatch') {
        try {
          const input = readUi?.();
          if (input !== undefined && typeof input.activeDocumentId === 'string' && input.activeDocumentId.length <= 512
            && input.activeDocumentId.length > 0 && Number.isSafeInteger(input.documentVersion) && input.documentVersion >= 0
            && ['part', 'assembly', 'drawing', 'empty'].includes(input.documentKind)) {
            ui = Object.freeze({ activeDocumentId: input.activeDocumentId,
              documentVersion: input.documentVersion, documentKind: input.documentKind });
          }
        } catch { /* A diagnostic getter cannot change dispatch/geometry/cleanup. */ }
        if (ui === null) missingContexts += 1;
        contexts.set(owner.dispatchId, ui);
        if (contexts.size > 256) {
          const oldest = contexts.keys().next().value;
          if (oldest !== undefined) contexts.delete(oldest);
        }
      } else ui = contexts.get(owner.dispatchId) ?? null;
    }
    let epochMs: number | null = null, monoMs: number | null = null;
    try {
      const wall = Date.now(), mono = performance.now();
      if (Number.isFinite(wall) && wall >= 0 && Number.isFinite(mono) && mono >= 0) {
        epochMs = wall; monoMs = mono;
        if (previous !== null && (mono < previous.monoMs
          || Math.abs((wall - previous.epochMs) - (mono - previous.monoMs)) > 1000)) clockDiscontinuities += 1;
        previous = { epochMs: wall, monoMs: mono };
      } else clockDiscontinuities += 1;
    } catch { clockDiscontinuities += 1; }
    if (!Number.isSafeInteger(lastSeq + 1)) { dropped += 1; return; }
    records.push(Object.freeze({ seq: ++lastSeq, phase, connectionEpoch: epoch,
      dispatchId: owner?.dispatchId ?? null, partId: owner?.partId ?? null,
      generation: owner?.generation ?? null, kind: owner?.kind ?? null, ui, epochMs, monoMs }));
    const recorded = records.at(-1);
    if (recorded !== undefined) journal.record(recorded);
    if (records.length > 256) { records.shift(); dropped += 1; }
  }
  return { record, beginCapture: (nonce: string): void => { journal.begin(nonce, lastSeq); },
    readCapture: (nonce: string, acknowledge: number | null) => journal.read(nonce, acknowledge),
    endCapture: (nonce: string): void => { journal.end(nonce); }, snapshot(): RuntimePhaseObservation['main'] {
    return Object.freeze({ capacity: 256, lastSeq, dropped, clockDiscontinuities, missingContexts,
      records: Object.freeze([...records]) });
  } };
}

export function createKernelBridge(readUi?: () => RuntimeUiContext): MonitoredKernelBridge & DrawingKernelBridge & FunctionKernelBridge & MaterialComparisonBridge {
  const health = createKernelHealth();
  const ledger = createBridgeMeshLedger(false);
  try { if (typeof window !== 'undefined') window.pcadMeshLedgerDiagnostics = readMeshLedgerDiagnostics; }
  catch { meshLedgerValidationFailures += 1; }
  const phases = createMainPhaseObserver(readUi);
  const phaseEpochs = new WeakMap<MeshLedgerOwner, number>();
  const connectionEpochs = new WeakMap<KernelConnection, number>();
  let phaseCapture: { readonly nonce: string; readonly active: KernelConnection; readonly epoch: number } | null = null;
  const observe = (phase: MainRuntimePhase, owner: MeshLedgerOwner, active: KernelConnection): void =>
    phases.record(phase, phaseEpochs.get(owner) ?? connectionEpochs.get(active) ?? 0, owner);
  const partClaims = new WeakSet<PartReleaseClaim>();
  const displayConnections = new WeakMap<MeshLedgerOwner, number>();
  let closedThroughEpoch = 0;
  const hiddenCleanup = new Map<string, { readonly owner: MeshLedgerOwner; readonly active: KernelConnection }>();
  const failedHiddenCleanup = new Set<string>();
  const returnedHiddenOwners = new WeakSet<MeshLedgerOwner>();
  const closedHiddenOwners = new WeakSet<MeshLedgerOwner>();
  const pendingReplyCleanup = new Map<string, { readonly owner: MeshLedgerOwner; readonly active: KernelConnection }>();
  const counts: Record<KernelOperationStatus, number> = {
    success: 0, failed: 0, cancelled: 0, workerBroken: 0,
  };
  const callbackScopes = new Set<KernelCallbackScope>();
  const results = new WeakMap<object, KernelOperationStatus>();
  let disposed = false;
  let connection = createKernelConnection(() => { phases.record('connection-interrupted', ledger.connectionEpoch(), null); health.markBroken(); ledger.host.advanceEpoch(); }, counts, results, () => ledger.host.advanceEpoch());
  function attachCurrentWorker(): void {
    const active = connection;
    ledger.attachWorker(query => {
      if (connection !== active || active.closed || active.interruption !== null) return Promise.resolve({
        status: 'unknown', observationId: query.observationId, reason: 'connection-changed' });
      const read = active.remote.readCurrentMeshAccounting;
      if (typeof read !== 'function') return Promise.resolve({ status: 'unknown', observationId: query.observationId, reason: 'unsupported-provider' });
      // Comlink creates a callable proxy even for absent remote properties. Only a received reply proves capability.
      return read(query).catch((): CurrentWorkerMeshObservation => ({
        status: 'unknown', observationId: query.observationId, reason: 'provider-reply-unavailable' }));
    });
  }
  attachCurrentWorker();
  connectionEpochs.set(connection, ledger.connectionEpoch());
  async function acknowledgeReceived(owner: MeshLedgerOwner, active: KernelConnection): Promise<void> {
    if (active.closed) { ledger.host.revokeOwner(owner.dispatchId); return; }
    const reason = `receiver-acknowledgement:${owner.dispatchId}`;
    try {
      const acknowledge = active.remote.acknowledgeMeshReply;
      if (typeof acknowledge === 'function') {
        const result = await acknowledge(owner);
        if (result.acknowledged || result.absent === true) {
          observe(result.acknowledged ? 'receiver-acknowledged' : 'receiver-absent', owner, active);
          pendingReplyCleanup.delete(owner.dispatchId); ledger.clearOwnerCoverageReason(reason); return;
        }
      }
    } catch { /* An unacknowledged real Worker reply must remain reachable. */ }
    observe('receiver-ack-failed', owner, active);
    if (active.closed) ledger.host.revokeOwner(owner.dispatchId);
    else {
      pendingReplyCleanup.set(owner.dispatchId, { owner, active });
      ledger.markOwnerCoverageUnknown(reason);
    }
  }
  function retireTerminatedOwnerMetadata(active: KernelConnection): void {
    if (!active.terminationReturned) return;
    closedThroughEpoch = Math.max(closedThroughEpoch, ledger.connectionEpoch());
    // Worker.terminate returned after transport/proxy cleanup. This is a logical worker
    // lifetime receipt only; native/physical collection and main-thread weak buffers remain unobserved.
    for (const [id, held] of hiddenCleanup) {
      if (held.active !== active) continue;
      hiddenCleanup.delete(id); failedHiddenCleanup.delete(id); closedHiddenOwners.add(held.owner);
      ledger.clearOwnerCoverageReason(`uncertified-hidden-cleanup:${id}`); ledger.host.revokeOwner(id);
    }
    for (const [id, held] of pendingReplyCleanup) {
      if (held.active !== active) continue;
      pendingReplyCleanup.delete(id); ledger.clearOwnerCoverageReason(`receiver-acknowledgement:${id}`);
    }
  }
  function callbackScope(): KernelCallbackScope {
    const scope = createKernelCallbackScope(() => callbackScopes.delete(scope));
    callbackScopes.add(scope);
    return scope;
  }

  function closeObservedConnection(active: KernelConnection): void {
    const epoch = connectionEpochs.get(active) ?? ledger.connectionEpoch();
    phases.record('connection-close-request', epoch, null);
    try { closeKernelConnection(active); }
    catch (error) { phases.record('connection-close-failed', epoch, null); throw error; }
    phases.record('connection-closed', epoch, null);
  }
  /**
   * 壊れた Worker を締めて作り直す(§2.9、§0.a-0.19)。形状キャッシュは Worker の中にあるので
   * 作り直すと空になり、次の再計算は全段作り直しになる(遅くなるが落ちない、この限界は
   * `KernelBridge.recomputeSolids` の doc comment にも書いた)。
   */
  function restart(): void {
    closeObservedConnection(connection);
    retireTerminatedOwnerMetadata(connection);
    ledger.attachWorker(null);
    health.reset();
    connection = createKernelConnection(() => { phases.record('connection-interrupted', ledger.connectionEpoch(), null); health.markBroken(); ledger.host.advanceEpoch(); }, counts, results, () => ledger.host.advanceEpoch());
    attachCurrentWorker();
    connectionEpochs.set(connection, ledger.connectionEpoch());
  }

  return {
    readRuntimePhases(): Promise<RuntimePhaseObservation> {
      const active = connection, epoch = ledger.connectionEpoch();
      const initial = phases.snapshot();
      const observation = (worker: RuntimePhaseObservation['worker'], reason: string | null): RuntimePhaseObservation => ({
        status: reason === null ? 'observed' : 'unknown', reason, connectionEpoch: epoch,
        main: phases.snapshot(), worker,
        coverage: 'runSolidRecompute-call-plus-admission-preclone-and-main-lifetime',
        transport: 'preclone-to-resolved-main-reply-envelope',
        unobserved: ['internal-native-subcalls', 'exact-serialization', 'driver-upload', 'physical-resident',
          'continuous-highwater', 'assembly-source-library-mapping'],
      });
      if (disposed || active.closed || active.interruption !== null) return Promise.resolve(observation(null, 'transport-unavailable'));
      return raceWithBroken<RuntimePhaseObservation>(active, async () => {
        try {
          const read = active.remote.readRuntimePhases;
          if (typeof read !== 'function') return observation(null, 'unsupported-provider');
          const worker = await read();
          const isArray = (value: unknown): boolean => Array.isArray(value);
          if (worker === undefined || worker.capacity !== 256 || !isArray(worker.records)
            || worker.records.length > 256 || worker.coverage !== 'runSolidRecompute-call-plus-admission-preclone'
            || ![worker.lastSeq, worker.dropped, worker.clockDiscontinuities, worker.missingOwners, worker.ownerConflicts]
              .every(value => Number.isSafeInteger(value) && value >= 0)) return observation(null, 'provider-reply-unavailable');
          const workerKeys = ['capacity', 'lastSeq', 'dropped', 'clockDiscontinuities', 'missingOwners',
            'ownerConflicts', 'records', 'coverage', 'unobserved'];
          const recordKeys = ['seq', 'phase', 'dispatchId', 'partId', 'generation', 'kind', 'epochMs', 'monoMs'];
          if (Object.keys(worker).length !== workerKeys.length || !Object.keys(worker).every(key => workerKeys.includes(key))
            || !isArray(worker.unobserved) || !['internal-native-subcalls', 'exact-serialization', 'driver-upload', 'physical-resident']
              .every(value => worker.unobserved.some(item => item === value))
            || !worker.records.every(record => record !== null && typeof record === 'object'
              && Object.keys(record).length === recordKeys.length && Object.keys(record).every(key => recordKeys.includes(key))))
            return observation(null, 'non-metadata-worker-reply');
          const current = phases.snapshot();
          const allowedPhases = ['native-build-start', 'native-build-return', 'native-build-throw', 'native-build-cancelled',
            'geometry-cancel-check', 'geometry-cancel-request', 'geometry-cancel-check-throw', 'reply-preclone',
            'reply-admission-rejected', 'owner-rejected'];
          if (!worker.records.every(record => Number.isSafeInteger(record.seq) && record.seq > 0
            && record.seq <= worker.lastSeq && allowedPhases.includes(record.phase)
            && (record.epochMs === null || Number.isFinite(record.epochMs) && record.epochMs >= 0)
            && (record.monoMs === null || Number.isFinite(record.monoMs) && record.monoMs >= 0)))
            return observation(null, 'invalid-worker-record');
          if (!worker.records.every((record, index) => index === 0 || record.seq > (worker.records[index - 1]?.seq ?? Infinity)))
            return observation(null, 'invalid-worker-sequence');
          if (!worker.records.every(record => typeof record.dispatchId === 'string' && record.dispatchId.length > 0
            && record.dispatchId.length <= 512 && typeof record.partId === 'string' && record.partId.length > 0
            && record.partId.length <= 512 && typeof record.generation === 'number'
            && Number.isSafeInteger(record.generation) && record.generation >= 0
            && (record.kind === 'display' || record.kind === 'hidden')
            && current.records.some(main => main.phase === 'dispatch'
            && main.connectionEpoch === epoch && main.dispatchId === record.dispatchId && main.partId === record.partId
            && main.generation === record.generation && main.kind === record.kind)))
            return observation(worker, 'unmatched-worker-owner');
          if (disposed || connection !== active || active.closed || active.interruption !== null || ledger.connectionEpoch() !== epoch)
            return observation(worker, 'connection-changed');
          if (current.lastSeq !== initial.lastSeq) return observation(worker, 'main-changed-during-read');
          if (pendingReplyCleanup.size > 0) return observation(worker, 'receiver-ack-unsettled');
          if (failedHiddenCleanup.size > 0) return observation(worker, 'hidden-cleanup-unsettled');
          const incomplete = current.dropped + current.clockDiscontinuities + current.missingContexts
            + worker.dropped + worker.clockDiscontinuities + worker.missingOwners + worker.ownerConflicts;
          return observation(worker, incomplete > 0 ? 'metadata-incomplete' : worker.records.length === 0 ? 'no-worker-phases' : null);
        } catch { return observation(null, 'provider-reply-unavailable'); }
      }, () => observation(null, 'transport-unavailable'), undefined, undefined, undefined, 'readonly-mesh-observation');
    },
    async beginRuntimePhaseCapture(nonce): Promise<void> {
      if (phaseCapture !== null || disposed || connection.closed || connection.interruption !== null)
        throw new Error('Runtime phase capture unavailable');
      const active = connection;
      phases.beginCapture(nonce);
      phaseCapture = { nonce, active, epoch: ledger.connectionEpoch() };
      try {
        await raceWithBroken(active, async () => {
          const begin = active.remote.beginRuntimePhaseCapture;
          if (typeof begin !== 'function') throw new Error('Runtime phase capture unsupported');
          await begin(nonce);
          if (connection !== active || active.closed || active.interruption !== null)
            throw new Error('Runtime phase capture connection changed');
        }, () => { throw new Error('Runtime phase capture transport unavailable'); },
        undefined, undefined, undefined, 'readonly-mesh-observation');
      } catch (error) {
        if (phaseCapture?.nonce === nonce) { phases.endCapture(nonce); phaseCapture = null; }
        if (!active.closed && active.interruption === null) {
          try {
            await raceWithBroken(active, async () => {
              const end = active.remote.endRuntimePhaseCapture;
              if (typeof end !== 'function') throw new Error('Phase capture rollback unsupported');
              await end(nonce);
            }, () => { throw new Error('Phase capture rollback transport unavailable'); },
            undefined, undefined, undefined, 'readonly-mesh-observation');
          } catch (cleanupError) {
            throw new AggregateError([error, cleanupError], 'Runtime phase capture start and rollback failed', { cause: cleanupError });
          }
        }
        throw new Error('Runtime phase capture start failed', { cause: error });
      }
    },
    readRuntimePhaseCapture(nonce, mainAcknowledge, workerAcknowledge): Promise<RuntimePhaseCapture> {
      const capture = phaseCapture;
      if (capture === null || capture.nonce !== nonce || capture.active !== connection
        || disposed || connection.closed || connection.interruption !== null || capture.epoch !== ledger.connectionEpoch())
        return Promise.reject(new Error('Runtime phase capture owner/connection differs'));
      return raceWithBroken(capture.active, async () => {
        const read = capture.active.remote.readRuntimePhaseCapture;
        if (typeof read !== 'function') throw new Error('Runtime phase journal unsupported');
        const worker = await read(nonce, workerAcknowledge);
        if (phaseCapture !== capture || connection !== capture.active || capture.active.closed
          || capture.active.interruption !== null || capture.epoch !== ledger.connectionEpoch())
          throw new Error('Runtime phase capture changed during read');
        return { nonce, connectionEpoch: capture.epoch, main: phases.readCapture(nonce, mainAcknowledge), worker };
      }, () => { throw new Error('Runtime phase capture transport unavailable'); },
      undefined, undefined, undefined, 'readonly-mesh-observation');
    },
    async endRuntimePhaseCapture(nonce): Promise<void> {
      const capture = phaseCapture;
      if (capture === null || capture.nonce !== nonce) throw new Error('Runtime phase capture owner differs');
      try {
        await raceWithBroken(capture.active, async () => {
          const end = capture.active.remote.endRuntimePhaseCapture;
          if (typeof end !== 'function') throw new Error('Runtime phase journal unsupported');
          await end(nonce);
        }, () => { throw new Error('Runtime phase capture transport unavailable'); },
        undefined, undefined, undefined, 'readonly-mesh-observation');
      } finally {
        if (phaseCapture === capture) { phases.endCapture(nonce); phaseCapture = null; }
      }
    },
    pendingWaiters: () => connection.waiters.size,
    meshLedgerOwner: ledger.owner,
    inspectSourceMeshBackings: async (receipt, buffers) => {
      const unknown = (): SourceMeshBackingInspection => ({ status: 'unknown', reason: 'transport-unavailable' });
      const active = connection;
      if (disposed || active.closed || active.interruption !== null) return unknown();
      return raceWithBroken<SourceMeshBackingInspection>(active, async () => {
        try { return await ledger.inspectSourceMeshBackings(receipt, buffers); }
        catch { return { status: 'unknown', reason: 'membership-provider-unavailable' }; }
      }, unknown, undefined, undefined, undefined, 'readonly-mesh-observation');
    },
    currentSourceMeshBackingInspection: (inspection, receipt) => {
      if (disposed) return ledger.refuse('bridge-disposed');
      if (connection.interruption !== null) return ledger.refuse('transport-interrupted');
      return ledger.currentSourceMeshBackingInspection(inspection, receipt);
    },
    capturePartReleaseClaim(bodies) {
      const owner = ledger.owner(bodies);
      if (owner === null || owner.kind !== 'display' || !ledger.issued.has(owner)) return null;
      const epoch = displayConnections.get(owner);
      if (epoch === undefined) return null;
      const claim: PartReleaseClaim = Object.freeze({ owner, connectionEpoch: epoch });
      partClaims.add(claim); return claim;
    },
    async releasePartClaim(claim): Promise<PartReleaseDisposition> {
      if (!partClaims.has(claim) || claim.owner.kind !== 'display') return { status: 'unavailable', reason: 'unissued-claim' };
      if (claim.connectionEpoch <= closedThroughEpoch) { ledger.retire(claim.owner); return { status: 'closed' }; }
      const active = connection;
      if (disposed || claim.connectionEpoch !== ledger.connectionEpoch() || active.closed || active.interruption !== null)
        return { status: 'unavailable', reason: 'transport-unavailable' };
      const unavailable = (): PartReleaseDisposition => ({ status: 'unavailable', reason: 'transport-unavailable' });
      return raceWithBroken<PartReleaseDisposition>(active, async () => {
        try {
        const read = active.remote.readPartOwnership, release = active.remote.releaseOwnedPart;
        if (typeof read !== 'function' || typeof release !== 'function') return { status: 'unavailable', reason: 'unsupported-part-provider' };
        const current = await read(claim.owner);
        if (connection !== active || active.closed || active.interruption !== null) return unavailable();
        if (current.status !== 'current') {
          if (current.status === 'absent') ledger.retire(claim.owner);
          return current;
        }
        const returned = await release(claim.owner, current.epoch);
        // A received actual return remains proof even if the transport subsequently breaks;
        // closure of an unreceived operation returns unavailable instead.
        if (returned.status === 'released' || returned.status === 'absent') ledger.retire(claim.owner);
        return returned;
        } catch { return { status: 'unavailable', reason: 'part-release-reply-unavailable' }; }
      }, unavailable);
    },
    currentMeshLedgerReceipt: receipt => {
      if (disposed) return ledger.refuse('bridge-disposed');
      if (connection.interruption !== null) return ledger.refuse('transport-interrupted');
      return ledger.current(receipt);
    },
    async captureCurrentMeshLedger(input) {
      const active = connection;
      const unknown = (): CurrentMeshLedgerReceipt => ({ status: 'unknown', observationId: input.observationId, reason: 'transport-unavailable' });
      return raceWithBroken(active, () => ledger.capture(input, query => {
        if (connection !== active || active.closed || active.interruption !== null) return Promise.resolve({
          status: 'unknown', observationId: query.observationId, reason: 'connection-changed' });
        const read = active.remote.readCurrentMeshAccounting;
        if (typeof read !== 'function') return Promise.resolve({ status: 'unknown', observationId: query.observationId, reason: 'unsupported-provider' });
        return read(query).catch((): CurrentWorkerMeshObservation => ({
          status: 'unknown', observationId: query.observationId, reason: 'provider-reply-unavailable' }));
      }), unknown, undefined, undefined, undefined, 'readonly-mesh-observation');
    },
    async releaseReferenceMeshLease(owner) {
      if (!ledger.issued.has(owner) || owner.kind !== 'hidden') return { released: false };
      const held = hiddenCleanup.get(owner.dispatchId);
      if (held === undefined) {
        if (returnedHiddenOwners.has(owner)) return { released: false, absent: true };
        if (closedHiddenOwners.has(owner)) return { released: false, closed: true };
        return { released: false };
      }
      if (held.owner !== owner) return { released: false };
      const active = held.active;
      if (active.closed || active !== connection) { failedHiddenCleanup.add(owner.dispatchId); return { released: false }; }
      const release = active.remote.releaseReferenceMeshLease;
      if (typeof release !== 'function') { failedHiddenCleanup.add(owner.dispatchId); return { released: false }; }
      try {
        const result = await raceWithBroken<ReferenceMeshLeaseDisposition>(active, () => release(owner), () => ({ released: false }));
        if (result.released || result.absent === true) {
          hiddenCleanup.delete(owner.dispatchId); failedHiddenCleanup.delete(owner.dispatchId); returnedHiddenOwners.add(owner);
          ledger.clearOwnerCoverageReason(`uncertified-hidden-cleanup:${owner.dispatchId}`);
          ledger.host.revokeOwner(owner.dispatchId);
        } else failedHiddenCleanup.add(owner.dispatchId);
        return result;
      } catch (error) { failedHiddenCleanup.add(owner.dispatchId); throw error; }
    },
    pendingReferenceMeshCleanup: () => failedHiddenCleanup.size + pendingReplyCleanup.size,
    async retryReferenceMeshCleanup() {
      let released = 0;
      for (const id of failedHiddenCleanup) {
        const held = hiddenCleanup.get(id);
        if (held === undefined) continue;
        // A transport closure is not a measured native free or successful owner ACK.
        if (held.active.closed || held.active !== connection) continue;
        try {
          const release = held.active.remote.releaseReferenceMeshLease;
          if (typeof release === 'function') {
            const result = await release(held.owner);
            if (result.released || result.absent === true) {
              hiddenCleanup.delete(id); failedHiddenCleanup.delete(id); returnedHiddenOwners.add(held.owner); ledger.clearOwnerCoverageReason(`uncertified-hidden-cleanup:${id}`);
              ledger.host.revokeOwner(id); released += 1;
            }
          }
        } catch { /* Retain the real failed owner for the bridge/application lifetime. */ }
      }
      for (const [id, held] of pendingReplyCleanup) {
        if (held.active.closed || held.active !== connection) continue;
        await acknowledgeReceived(held.owner, held.active);
        if (!pendingReplyCleanup.has(id)) released += 1;
      }
      return { released, retained: failedHiddenCleanup.size + pendingReplyCleanup.size };
    },
    async compareMaterials(beforeKeys, afterKeys, shouldCancel): Promise<MaterialComparisonResult> {
      const active = connection, callbacks = callbackScope();
      const failed = (): MaterialComparisonResult => active.interruption === 'cancelled'
        ? { kind: 'cancelled' } : { kind: 'failed', message: KERNEL_BROKEN_MESSAGE };
      return raceWithBroken(active, async () => {
        try { return readMaterialComparison(await active.remote.compareMaterials({ beforeKeys, afterKeys },
          toCancelProxy(shouldCancel, callbacks))); }
        catch (error) { return { kind: 'failed' as const, message: toFailureMessage(error) }; }
      }, failed, callbacks);
    },
    async hiddenLineViews(request, options = {}) {
      if (health.broken && !disposed) restart();
      const active = connection;
      const failed = (): DrawingProjectionResult => ({ views: [], cancelled: false,
        failures: [{ viewId: null, bodyId: null, message: KERNEL_BROKEN_MESSAGE }] });
      const callbacks = callbackScope();
      const progress = options.onProgress;
      return raceWithBroken(active, () => active.remote.hiddenLineViews(request,
        progress === undefined ? undefined : callbacks.proxy((value: DrawingOperationProgress) => { if (callbacks.active) progress(value); }),
        toCancelProxy(options.shouldCancel, callbacks)).catch(failed), failed, callbacks);
    },
    async sectionViews(request, options = {}) {
      if (health.broken && !disposed) restart();
      const active = connection;
      const failed = (): DrawingSectionResult => ({ viewId: request.view.id, visible: [], hidden: [], cuttingCurves: [], cancelled: false,
        failures: [{ viewId: request.view.id, bodyId: null, message: KERNEL_BROKEN_MESSAGE }] });
      const callbacks = callbackScope();
      const progress = options.onProgress;
      return raceWithBroken(active, () => active.remote.sectionViews(request,
        progress === undefined ? undefined : callbacks.proxy((value: DrawingOperationProgress) => { if (callbacks.active) progress(value); }),
        toCancelProxy(options.shouldCancel, callbacks)).catch(failed), failed, callbacks);
    },
    operationCounts: () => ({ ...counts }),
    operationStatus: (result) =>
      (typeof result === 'object' && result !== null) || typeof result === 'function'
        ? results.get(result) : undefined,
    pendingCallbacks: () => [...callbackScopes].reduce((sum, scope) => sum + scope.size(), 0),
    async checkInterference(input, options = {}): Promise<AssemblyInterferenceResult> {
      const request = toInterferenceRequest(input, options);
      const active = connection;
      const callbacks = callbackScope();
      const onProgress = options.onProgress;
      const progress = onProgress === undefined ? undefined : callbacks.proxy((value: InterferenceProgress) => {
        if (callbacks.active) onProgress(interferenceProgressOf(value));
      });
      return raceWithBroken(active, async () => {
        try {
          return toInterferenceResult(await active.remote.checkInterference(request, progress,
            toCancelProxy(options.shouldCancel ?? (() => false), callbacks), 'message'));
        } catch (error) {
          return refusedInterference(request, { code: 'rpcFailed', message: toFailureMessage(error) });
        }
      }, () => refusedInterference(request, { code: 'workerBroken', message: KERNEL_BROKEN_MESSAGE },
        active.interruption === 'cancelled'), callbacks);
    },
    async buildAnalysisSurfaceMesh(request): Promise<AnalysisBoundaryReply> {
      if (health.broken && !disposed) restart();
      const active = connection;
      const captured = structuredClone(request);
      return raceWithBroken<AnalysisBoundaryReply>(active, async () => {
        try {
          return await active.remote.buildAnalysisSurfaceMesh(captured);
        } catch (error) {
          return { kind: 'failed', bodyKey: captured.bodyKey, code: 'rpc-failed',
            message: toFailureMessage(error), faceIndex: null };
        }
      }, () => ({ kind: 'failed', bodyKey: captured.bodyKey, code: 'worker-broken',
        message: KERNEL_BROKEN_MESSAGE, faceIndex: null }));
    },
    async releasePart(partId): Promise<void> {
      const active = connection;
      return raceWithBroken(active, () => active.remote.releasePart(partId), () => undefined);
    },
    async checkShapeAvailability(partId, bodyKeys): Promise<ShapeAvailability> {
      const active = connection;
      return raceWithBroken(
        active,
        () => active.remote.checkShapeAvailability(partId, bodyKeys),
        () => ({ partId, missingKeys: [...new Set(bodyKeys)] }),
      );
    },
    async tessellateSketchFaces(faces): Promise<SketchTessellationOutcome> {
      if (faces.length === 0) {
        return { mesh: { faces: [] }, failures: [] };
      }
      // 前の依頼の途中で Worker が壊れていたら、今回の依頼を出す前に作り直す。
      if (health.broken && !disposed) {
        restart();
      }
      const active = connection;
      // 線・円弧の折れ線は UI が自前で作るので、カーネルへは面だけを頼む
      // (マウス操作のたびに Worker を往復させないため、NFR-PF-1、計画書 §2.7)。
      return raceWithBroken(
        active,
        () => active.remote
          .tessellateSketch({
            curves: [],
            faces: faces.map((face) => toFaceRequest(face)),
          })
          .then((result) => toOutcome(faces, result.faces, result.failures)),
        // 面は 1 枚も作れていないので、頼んだ全部を壊れた理由の失敗にする(FR-504)。
        () => ({ mesh: { faces: [] }, failures: brokenFailures(faces) }),
      );
    },

    async recomputeSolids(steps, options = {}): Promise<SolidRecomputeOutcome> {
      if (steps.length === 0 && options.localMesh === undefined) {
        return { bodies: [], failures: [], cacheHits: 0, cancelled: false, appearanceMatches: [] };
      }
      // 前の依頼の途中で Worker が壊れていたら、今回の依頼を出す前に作り直す(§2.9)。
      if (health.broken && !disposed) {
        restart();
      }
      const active = connection;
      let request: SolidRecomputeRequest = toSolidRecomputeRequest(steps, options);
      const owner = ledger.dispatch(request.partId ?? 'part:current', request.generation ?? 0, 'display', steps);
      displayConnections.set(owner, ledger.connectionEpoch());
      phaseEpochs.set(owner, ledger.connectionEpoch());
      const reservation = await ledger.reserve(owner, request.localMesh?.maximumLiveMeshBytes ?? MESH_LEDGER_LIMIT_BYTES,
        options.shouldCancel ?? (() => false), () => connection === active && !active.closed && active.interruption === null);
      if (reservation.status === 'stopped' && active.interruption === 'workerBroken')
        return rememberOperation(active, 'workerBroken', { bodies: [], failures: brokenFailures(steps.filter(step => step.visible)),
          cacheHits: 0, cancelled: false, appearanceMatches: [] });
      if (reservation.status !== 'reserved') return rememberOperation(active,
        reservation.status === 'cancelled' || reservation.status === 'stopped' ? 'cancelled' : 'failed', { bodies: [],
        failures: reservation.status === 'cancelled' || reservation.status === 'stopped' ? []
          : steps.filter(step => step.visible).map(step => ({ featureId: step.featureId,
            message: reservation.status === 'timeout' ? '表示メッシュの空きを待つ時間が上限を超えました。再度操作してください。'
              : '表示メッシュの空き容量を確認できません。' })),
        cacheHits: 0, cancelled: reservation.status === 'cancelled' || reservation.status === 'stopped', appearanceMatches: [] });
      // The await above can yield after this exact slot was reserved but before any RPC was sent.
      // Only this definitely unsent slot may settle here; received/in-flight replies keep their own continuation.
      if (connection !== active || active.closed || active.interruption !== null) {
        ledger.host.settleWithoutReply(owner.dispatchId);
        return rememberOperation(active, active.interruption ?? 'cancelled', { bodies: [],
          failures: active.interruption === 'workerBroken' ? brokenFailures(steps.filter(step => step.visible)) : [],
          cacheHits: 0, cancelled: active.interruption !== 'workerBroken', appearanceMatches: [] });
      }
      const granted = reservation.bytes;
      if (request.localMesh !== undefined) request = { ...request, localMesh: { ...request.localMesh, maximumLiveMeshBytes: granted } };
      const context = captureSolidRecomputeContext(request);
      const shouldCancel = options.shouldCancel;
      const callbacks = callbackScope();
      // 第 2 引数は全体のテッセレーションの粗さ。段の種類ごとの既定はカーネルが持っており
      // (toSolidRecomputeRequest の注釈)、ここで値を渡すとその既定が負けるので undefined。
      return raceWithBroken(
        active,
        () => {
          observe('dispatch', owner, active);
          return active.remote
          .recomputeSolids(
            request,
            undefined,
            toProgressProxy(options.onProgress, callbacks),
            toCancelProxy(shouldCancel === undefined ? undefined : () => {
              try {
                const cancelled = shouldCancel();
                if (cancelled) observe('geometry-cancel-request', owner, active);
                return cancelled;
              } catch (error) { observe('geometry-cancel-throw', owner, active); throw error; }
            }, callbacks),
            owner,
            callbacks.proxy((metadata: Parameters<NonNullable<Parameters<KernelApi['recomputeSolids']>[5]>>[0]) => ledger.admitReply(owner, metadata,
              () => connection === active && !active.closed && active.interruption === null)),
          )
          .then(async (result) => {
            observe('raw-received', owner, active);
            ledger.adopt(owner, result);
            observe('adopted', owner, active);
            await acknowledgeReceived(owner, active);
            return ledger.bind(owner, toSolidOutcome(steps, result, options.appearance ?? [], context));
          }, async (error: unknown) => {
            observe('reply-rejected', owner, active);
            // Actual RPC rejection or closed endpoint: this call has delivered no raw result to this continuation.
            try { if (!active.closed) await acknowledgeReceived(owner, active); }
            finally { ledger.host.settleWithoutReply(owner.dispatchId); }
            throw error;
          });
        },
        // Worker がこの依頼の途中で壊れた。拒否せずに理由つきの失敗として解決する
        // (recomputePart.ts が kernelFailed として拾う。§0.a-0.19「拒否しない」)。
        // 消費されて画面に出ないはずの段(visible: false)は、成功しても失敗しても
        // 利用者には見えないので失敗に数えない(toSolidOutcome の扱いと揃える)。
        () => ({
          bodies: [],
          failures: brokenFailures(steps.filter((step) => step.visible)),
          cacheHits: 0,
          cancelled: false,
          // 照合そのものを行えていないので空で返す。ここで全件を「見つからない」にすると、
          // 段の失敗の警告に「色を付けた面が見つかりません」を重ねてしまう(FR-504)。
          appearanceMatches: [],
        }),
        callbacks,
      );
    },

    async offsetSketchCurves(requests): Promise<SketchOffsetResult> {
      if (requests.length === 0) {
        return { results: [], failures: [] };
      }
      // 前の依頼の途中で Worker が壊れていたら、今回の依頼を出す前に作り直す(§2.9)。
      if (health.broken && !disposed) {
        restart();
      }
      const active = connection;
      return raceWithBroken(
        active,
        () => active.remote
          .offsetSketchCurves({ items: requests.map((request) => toOffsetItem(request)) })
          .then((outcome) => toOffsetResult(requests, outcome)),
        () => ({ results: [], failures: brokenFailures(requests) }),
      );
    },

    async functionSketchCurves(input) {
      if (health.broken && !disposed) restart();
      const active = connection;
      return raceWithBroken(active,
        () => active.remote.functionSketchCurves({ components: input.components, bounds: input.bounds,
          ...(input.bezier === undefined ? {} : { bezier: input.bezier }),
          // Certified smooth components must reach the kernel, or it would build the polyline instead.
          ...(input.splines === undefined ? {} : { splines: input.splines }) })
          .then((outcome) => readFunctionCurveGeometry(outcome, input)),
        () => ({ status: 'failed', message: KERNEL_BROKEN_MESSAGE }),
      );
    },

    async projectSketchCurves(requests): Promise<SketchProjectionResult> {
      if (requests.length === 0) {
        return { results: [], failures: [] };
      }
      if (health.broken && !disposed) {
        restart();
      }
      const active = connection;
      return raceWithBroken(
        active,
        () => active.remote
          .projectSketchCurves({ items: requests.map((request) => toProjectionItem(request)) })
          .then((outcome) => toProjectionResult(requests, outcome)),
        () => ({ results: [], failures: brokenFailures(requests) }),
      );
    },

    async sectionSketchCurves(requests): Promise<SketchProjectionResult> {
      if (requests.length === 0) {
        return { results: [], failures: [] };
      }
      if (health.broken && !disposed) {
        restart();
      }
      const active = connection;
      return raceWithBroken(
        active,
        () => active.remote
          .sectionSketchCurves({ items: requests.map((request) => toSectionItem(request)) })
          .then((outcome) => toProjectionResult(requests, outcome)),
        () => ({ results: [], failures: brokenFailures(requests) }),
      );
    },

    async readCachedBodies(steps, ids, lease): Promise<SolidRecomputeOutcome> {
      const selected = cachedBodySteps(steps, ids);
      if (selected === null) return cachedBodyFailure(ids, MEASURE_MISSING_SHAPE_MESSAGE);
      if (health.broken && !disposed) restart();
      const active = connection;
      const uncertified = lease === undefined;
      if (uncertified) ledger.markOwnerCoverageUnknown('uncertified-hidden-read');
      const context: ReferenceMeshLeaseOptions = lease ?? { partId: 'reference:legacy', generation: 0, maximumLiveMeshBytes: MESH_LEDGER_LIMIT_BYTES };
      const owner = ledger.dispatch(context.partId, context.generation, 'hidden', selected);
      phaseEpochs.set(owner, ledger.connectionEpoch());
      const reservation = await ledger.reserve(owner, context.maximumLiveMeshBytes,
        context.shouldCancel ?? (() => false), () => connection === active && !active.closed && active.interruption === null);
      if (reservation.status !== 'reserved') {
        if (reservation.status === 'stopped' && active.interruption === 'workerBroken')
          return rememberOperation(active, 'workerBroken', cachedBodyFailure(ids, KERNEL_BROKEN_MESSAGE));
        if (reservation.status === 'cancelled' || reservation.status === 'stopped') return rememberOperation(active, 'cancelled', {
          bodies: [], failures: [], cacheHits: 0, cancelled: true });
        return rememberOperation(active, 'failed', cachedBodyFailure(ids, reservation.status === 'timeout'
          ? '表示メッシュの空きを待つ時間が上限を超えました。再度操作してください。' : '表示メッシュの空き容量を確認できません。'));
      }
      // A hidden read has the same reserve-before-dispatch window; no Worker token exists yet.
      if (connection !== active || active.closed || active.interruption !== null) {
        ledger.host.settleWithoutReply(owner.dispatchId);
        return rememberOperation(active, active.interruption ?? 'cancelled', active.interruption === 'workerBroken'
          ? cachedBodyFailure(ids, KERNEL_BROKEN_MESSAGE) : { bodies: [], failures: [], cacheHits: 0, cancelled: true });
      }
      const granted = reservation.bytes;
      const callbacks = callbackScope();
      hiddenCleanup.set(owner.dispatchId, { owner, active });
      return raceWithBroken(active,
        () => {
          observe('dispatch', owner, active);
          return active.remote.readCachedBodies(selected.map(step => ({ id: step.featureId, key: step.key })),
          { owner, limitBytes: granted, ...(context.localMesh === undefined ? {} : { localMesh: { ...context.localMesh, maximumLiveMeshBytes: granted } }) },
          callbacks.proxy((metadata: Parameters<NonNullable<Parameters<KernelApi['recomputeSolids']>[5]>>[0]) => ledger.admitReply(owner, metadata,
            () => connection === active && !active.closed && active.interruption === null)))
          .then(async result => {
            observe('raw-received', owner, active);
            ledger.adopt(owner, result);
            observe('adopted', owner, active);
            await acknowledgeReceived(owner, active);
            if (uncertified && !active.closed) {
              const reason = `uncertified-hidden-cleanup:${owner.dispatchId}`;
              let returned = false;
              try {
                const release = active.remote.releaseReferenceMeshLease;
                if (typeof release === 'function') {
                  const disposition = await release(owner);
                  returned = disposition.released || disposition.absent === true;
                }
              } catch { /* Real reply already adopted; preserve functional result plus failed owner. */ }
              if (returned) {
                hiddenCleanup.delete(owner.dispatchId); failedHiddenCleanup.delete(owner.dispatchId);
                returnedHiddenOwners.add(owner); ledger.host.revokeOwner(owner.dispatchId);
                ledger.clearOwnerCoverageReason(reason);
              } else {
                failedHiddenCleanup.add(owner.dispatchId); ledger.markOwnerCoverageUnknown(reason);
              }
            }
            const converted = toSolidOutcome(selected, result);
            return uncertified ? converted : ledger.bind(owner, converted);
          }, async (error: unknown) => {
            observe('reply-rejected', owner, active);
            if (owner !== undefined) {
              try { if (!active.closed) await acknowledgeReceived(owner, active); }
              finally { ledger.host.settleWithoutReply(owner.dispatchId); }
            }
            throw error;
          }).catch(async (error: unknown) => {
            if (!active.closed) {
              try {
                const release = active.remote.releaseReferenceMeshLease;
                if (typeof release === 'function') {
                  const result = await release(owner);
                  if (result.released || result.absent === true) {
                    hiddenCleanup.delete(owner.dispatchId); failedHiddenCleanup.delete(owner.dispatchId);
                    returnedHiddenOwners.add(owner); ledger.host.revokeOwner(owner.dispatchId);
                  } else failedHiddenCleanup.add(owner.dispatchId);
                } else failedHiddenCleanup.add(owner.dispatchId);
              } catch { failedHiddenCleanup.add(owner.dispatchId); }
            }
            throw error;
          });
        },
        () => cachedBodyFailure(ids, KERNEL_BROKEN_MESSAGE), callbacks);
    },

    async measure(steps, targets, kind): Promise<MeasureOutcome> {
      const request = toMeasureRequest(steps, targets, kind);
      if (request === null) {
        // 鍵が引けない対象があるので、Worker を起こさずここで断る(§0.a-0.30)。
        return { kind: 'failed', message: MEASURE_MISSING_SHAPE_MESSAGE };
      }
      // 前の依頼の途中で Worker が壊れていたら、今回の依頼を出す前に作り直す(§2.9)。
      if (health.broken && !disposed) {
        restart();
      }
      const active = connection;
      return raceWithBroken(
        active,
        () => active.remote.measure(request).then((result) => toMeasureOutcome(result)),
        // 測定の結果には「壊れた」を表す種類が無いので、呼び手が既に扱っている断り
        // (`kind: 'failed'`。理由の文はそのまま画面へ出る)で解決する。
        () => ({ kind: 'failed', message: KERNEL_BROKEN_MESSAGE }),
      );
    },

    async exportShapes(steps, options): Promise<ShapeExportOutcome> {
      if (options.signal?.aborted) return { kind: 'cancelled' };
      const items = toShapeExportItems(steps, options.bodies);
      if (items === null) {
        // 鍵が引けない立体があるので、Worker を起こさずここで断る(NFR-UX-5)。
        return { kind: 'failed', message: EXPORT_MISSING_SHAPE_MESSAGE };
      }
      // 前の依頼の途中で Worker が壊れていたら、今回の依頼を出す前に作り直す(§2.9)。
      if (health.broken && !disposed) {
        restart();
      }
      const active = connection;
      return raceWithBroken(
        active,
        () => active.remote.exportShapes(toShapeExportRequest(items, options)).then(
          (result) => toShapeExportOutcome(result, options),
          // カーネルが断ったとき(鍵が消えていた・書けなかった)は理由をそのまま持ち回る。
          // **拒否のまま競わせない**——拒否は `raceWithBroken` を素通りしてしまうため。
          (error: unknown) => ({ kind: 'failed', message: toFailureMessage(error) }),
        ),
        // 書き出しの結果には「壊れた」を表す種類が無いので、呼び手が既に扱っている断り
        // (`kind: 'failed'`。理由の文はそのまま画面へ出る)で解決する。
        () => ({ kind: 'failed', message: KERNEL_BROKEN_MESSAGE }),
        undefined,
        {
          milliseconds: EXPORT_TIMEOUT_MS,
          refuse: () => ({ kind: 'failed', message: EXPORT_TIMEOUT_MESSAGE }),
          terminateAndRestart: () => { if (!disposed && connection === active) restart(); },
        },
        options.signal === undefined ? undefined : {
          signal: options.signal,
          refuse: (): ShapeExportOutcome => ({ kind: 'cancelled' }),
        },
      );
    },

    async importShape(options): Promise<ShapeImportOutcome> {
      // 前の依頼の途中で Worker が壊れていたら、今回の依頼を出す前に作り直す(§2.9)。
      if (health.broken && !disposed) {
        restart();
      }
      const active = connection;
      return raceWithBroken(
        active,
        () => active.remote.importShape(toShapeImportRequest(options)).then(
          (result) => toShapeImportOutcome(result),
          (error: unknown) => ({ kind: 'failed', message: toFailureMessage(error) }),
        ),
        () => ({ kind: 'failed', message: KERNEL_BROKEN_MESSAGE }),
      );
    },

    async inspectPrintability(steps, options): Promise<PrintabilityOutcome> {
      if (options.bodies.length === 0) {
        // 点検する形が 1 つも無いので Worker を起こさない(§0.a-0.30)。
        return { kind: 'failed', message: PRINTABILITY_NO_BODY_MESSAGE };
      }
      const items = toShapeInspectItems(steps, options.bodies);
      if (items === null) {
        // 鍵が引けない立体があるので、Worker を起こさずここで断る(測定と同じ)。
        return { kind: 'failed', message: EXPORT_MISSING_SHAPE_MESSAGE };
      }
      // 前の依頼の途中で Worker が壊れていたら、今回の依頼を出す前に作り直す(§2.9)。
      if (health.broken && !disposed) {
        restart();
      }
      const active = connection;
      const callbacks = callbackScope();
      return raceWithBroken(
        active,
        () => active.remote
          .inspectPrintability(
            toShapeInspectRequest(items, options, DISPLAY_MESH_QUALITY),
            toPrintabilityProgressProxy(options.onProgress, callbacks),
            toCancelProxy(options.shouldCancel, callbacks),
          )
          .then(
            (result) => toPrintabilityOutcome(result),
            // カーネルが断ったとき(鍵が消えていた・三角形が 0 枚)は理由をそのまま持ち回る。
            // **拒否のまま競わせない**——拒否は `raceWithBroken` を素通りしてしまうため。
            (error: unknown) => ({ kind: 'failed', message: toFailureMessage(error) }),
          ),
        // 点検の結果には「壊れた」を表す種類が無いので、呼び手が既に扱っている断り
        // (`kind: 'failed'`。理由の文はそのまま画面へ出る)で解決する。
        () => ({ kind: 'failed', message: KERNEL_BROKEN_MESSAGE }),
        callbacks,
      );
    },

    dispose(): void {
      disposed = true;
      if (phaseCapture !== null) { phases.endCapture(phaseCapture.nonce); phaseCapture = null; }
      closeObservedConnection(connection);
      retireTerminatedOwnerMetadata(connection);
      ledger.attachWorker(null);
      for (const scope of callbackScopes) scope.close();
    },
  };
}

type PartLifetimeApi = KernelApi & Pick<AssemblyKernelBridge, 'releasePart' | 'checkShapeAvailability'>;

/** Node統合検査用。基底の旧overload/fakeへ新しい必須能力を要求しない。 */
export function createDirectInterferenceKernelBridge(api: ManagedKernelApi): InterferenceKernelBridge {
  const bridge = createDirectKernelBridge(api);
  let disposed = false;
  return {
    ...bridge,
    async checkInterference(input, options = {}): Promise<AssemblyInterferenceResult> {
      const request = toInterferenceRequest(input, options);
      const onProgress = options.onProgress;
      const shouldCancel = options.shouldCancel;
      try {
        return toInterferenceResult(await api.checkInterference(request,
          onProgress === undefined ? undefined : (progress) => { if (!disposed) onProgress(interferenceProgressOf(progress)); },
          () => disposed || (shouldCancel?.() ?? false)));
      } catch (error) { return refusedInterference(request, { code: 'rpcFailed', message: toFailureMessage(error) }); }
    },
    dispose() { disposed = true; bridge.dispose(); },
  };
}

/** 実OCCT統合検査用。既存の部分的なKernelApiへ比較能力を要求しない。 */
export function createDirectMaterialComparisonBridge(api: MaterialComparisonKernelApi): AssemblyKernelBridge & DrawingKernelBridge & FunctionKernelBridge & MaterialComparisonBridge {
  const bridge = createDirectKernelBridge(api); let disposed = false;
  return { ...bridge,
    async compareMaterials(beforeKeys, afterKeys, shouldCancel) {
      if (disposed) return { kind: 'cancelled' };
      try { return readMaterialComparison(await api.compareMaterials({ beforeKeys, afterKeys },
        () => disposed || (shouldCancel?.() ?? false))); }
      catch (error) { return { kind: 'failed', message: toFailureMessage(error) }; }
    },
    dispose() { disposed = true; bridge.dispose(); },
  };
}

function hasPartLifetime(api: KernelApi): api is PartLifetimeApi {
  return 'releasePart' in api && typeof api.releasePart === 'function' &&
    'checkShapeAvailability' in api && typeof api.checkShapeAvailability === 'function';
}

/**
 * Worker を通さず、同じプロセスの `KernelApi` へ直につなぐ橋(P4 タスク25)。
 *
 * **本番では使わない。** ブラウザ・Electron は必ず `createKernelBridge`(Worker 版)を使う
 * (幾何カーネルは Web Worker 上で動かす、rules/04・NFR-PF-4)。この関数があるのは、
 * **Node の検査で「部品文書の経路が実カーネルで最後まで通る」ことを確かめる**ためである
 * (t21 の教訓: 偽の橋だけでは配線もれが見つからない。`docs/報告記録.md` 2026-09-04 21:05)。
 *
 * Worker が無いので壊れの検知・作り直し(§2.9)は持たない。`dispose` も何もしない
 * (形状キャッシュは渡された `KernelApi` の持ち物で、寿命は呼び出し側が決める)。
 */
export function createDirectKernelBridge(api: PartLifetimeApi): AssemblyKernelBridge & DrawingKernelBridge & FunctionKernelBridge;
export function createDirectKernelBridge(api: KernelApi): KernelBridge & DrawingKernelBridge & FunctionKernelBridge;
export function createDirectKernelBridge(api: KernelApi): KernelBridge & DrawingKernelBridge & FunctionKernelBridge {
  return {
    async functionSketchCurves(input) {
      return readFunctionCurveGeometry(await api.functionSketchCurves({ components: input.components, bounds: input.bounds,
        ...(input.bezier === undefined ? {} : { bezier: input.bezier }),
        ...(input.splines === undefined ? {} : { splines: input.splines }) }), input);
    },
    hiddenLineViews: (request, options = {}) => api.hiddenLineViews(request, options.onProgress, options.shouldCancel),
    sectionViews: (request, options = {}) => api.sectionViews(request, options.onProgress, options.shouldCancel),
    ...(hasPartLifetime(api) ? {
      releasePart: (partId: string) => api.releasePart(partId),
      checkShapeAvailability: (partId: string, bodyKeys: readonly string[]) =>
        api.checkShapeAvailability(partId, bodyKeys),
    } : {}),
    async tessellateSketchFaces(faces): Promise<SketchTessellationOutcome> {
      if (faces.length === 0) {
        return { mesh: { faces: [] }, failures: [] };
      }
      const result = await api.tessellateSketch({
        curves: [],
        faces: faces.map((face) => toFaceRequest(face)),
      });
      return toOutcome(faces, result.faces, result.failures);
    },

    async recomputeSolids(steps, options = {}): Promise<SolidRecomputeOutcome> {
      if (steps.length === 0 && options.localMesh === undefined) {
        return { bodies: [], failures: [], cacheHits: 0, cancelled: false, appearanceMatches: [] };
      }
      const request: SolidRecomputeRequest = toSolidRecomputeRequest(steps, options);
      const context = captureSolidRecomputeContext(request);
      // Comlink を通らないので、進捗・中止の関数は proxy で包まずそのまま渡せる。
      const result = await api.recomputeSolids(
        request,
        undefined,
        options.onProgress === undefined
          ? undefined
          : (progress: SolidProgress) =>
              options.onProgress?.({
                featureId: progress.stepId,
                index: progress.index,
                total: progress.total,
                label: progress.label,
              }),
        options.shouldCancel,
      );
      return toSolidOutcome(steps, result, options.appearance ?? [], context);
    },

    async offsetSketchCurves(requests): Promise<SketchOffsetResult> {
      if (requests.length === 0) {
        return { results: [], failures: [] };
      }
      const outcome = await api.offsetSketchCurves({
        items: requests.map((request) => toOffsetItem(request)),
      });
      return toOffsetResult(requests, outcome);
    },

    async projectSketchCurves(requests): Promise<SketchProjectionResult> {
      if (requests.length === 0) {
        return { results: [], failures: [] };
      }
      const outcome = await api.projectSketchCurves({
        items: requests.map((request) => toProjectionItem(request)),
      });
      return toProjectionResult(requests, outcome);
    },

    async sectionSketchCurves(requests): Promise<SketchProjectionResult> {
      if (requests.length === 0) {
        return { results: [], failures: [] };
      }
      const outcome = await api.sectionSketchCurves({
        items: requests.map((request) => toSectionItem(request)),
      });
      return toProjectionResult(requests, outcome);
    },

    async readCachedBodies(steps, ids): Promise<SolidRecomputeOutcome> {
      const selected = cachedBodySteps(steps, ids);
      if (selected === null) return cachedBodyFailure(ids, MEASURE_MISSING_SHAPE_MESSAGE);
      return toSolidOutcome(selected, await api.readCachedBodies(selected.map(step => ({ id: step.featureId, key: step.key }))));
    },

    async measure(steps, targets, kind): Promise<MeasureOutcome> {
      const request = toMeasureRequest(steps, targets, kind);
      if (request === null) {
        // 鍵が引けない対象があるので、カーネルを呼ばずここで断る(§0.a-0.30)。
        return { kind: 'failed', message: MEASURE_MISSING_SHAPE_MESSAGE };
      }
      const result = await api.measure(request);
      return toMeasureOutcome(result);
    },

    async exportShapes(steps, options): Promise<ShapeExportOutcome> {
      if (options.signal?.aborted) return { kind: 'cancelled' };
      const items = toShapeExportItems(steps, options.bodies);
      if (items === null) {
        // 鍵が引けない立体があるので、カーネルを呼ばずここで断る(NFR-UX-5)。
        return { kind: 'failed', message: EXPORT_MISSING_SHAPE_MESSAGE };
      }
      try {
        const result = await api.exportShapes(toShapeExportRequest(items, options));
        return options.signal?.aborted ? { kind: 'cancelled' } : toShapeExportOutcome(result, options);
      } catch (error) {
        if (options.signal?.aborted) return { kind: 'cancelled' };
        // Worker 版と同じく、断りは投げずに理由つきの失敗で返す(NFR-RE-1)。
        return { kind: 'failed', message: toFailureMessage(error) };
      }
    },

    async importShape(options): Promise<ShapeImportOutcome> {
      try {
        return toShapeImportOutcome(await api.importShape(toShapeImportRequest(options)));
      } catch (error) {
        return { kind: 'failed', message: toFailureMessage(error) };
      }
    },

    async inspectPrintability(steps, options): Promise<PrintabilityOutcome> {
      if (options.bodies.length === 0) {
        return { kind: 'failed', message: PRINTABILITY_NO_BODY_MESSAGE };
      }
      const items = toShapeInspectItems(steps, options.bodies);
      if (items === null) {
        // 鍵が引けない立体があるので、カーネルを呼ばずここで断る(§0.a-0.30)。
        return { kind: 'failed', message: EXPORT_MISSING_SHAPE_MESSAGE };
      }
      try {
        // Comlink を通らないので、進捗・中止の関数は proxy で包まずそのまま渡せる。
        return toPrintabilityOutcome(
          await api.inspectPrintability(
            toShapeInspectRequest(items, options, DISPLAY_MESH_QUALITY),
            printabilityProgressOf(options.onProgress),
            options.shouldCancel,
          ),
        );
      } catch (error) {
        // Worker 版と同じく、断りは投げずに理由つきの失敗で返す(NFR-RE-1)。
        return { kind: 'failed', message: toFailureMessage(error) };
      }
    },

    dispose(): void {
      // Worker を持たないので閉じるものが無い。
    },
  };
}
