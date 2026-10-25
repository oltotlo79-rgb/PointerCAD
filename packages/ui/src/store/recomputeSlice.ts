/**
 * 再計算の結果のスライス(立体・失敗・進み具合・中止。要件§6.3、NFR-PF-4)。
 * 分け方の約束は `viewSlice.ts` の冒頭にある(P6 タスク52)。
 */

import {
  affectsShape,
  documentUpTo,
  type AppearanceMatchEntry,
  type MathGeometryOutcome,
  type PartDocument,
  type PartProgress,
  type PartRecomputeError,
  type PartRecomputeResult,
  pushUndo,
  type SolidBody,
  type Vec3,
} from '@pointercad/model';
import type { StateCreator } from 'zustand';
import type { MathGeometryResultSnapshot } from '../math/mathGeometryResults.js';
import type { AppState } from './appState.js';
import {
  activeSketchErrors,
  activeSketchOf,
  constraintSummaryPatch,
  type DocumentEditPlacement,
  documentEditPatch,
  rememberTimelineHintShown,
} from './documentDerived.js';
import { activePartDocument } from './documentKind.js';

/** 検査口からも読める、最後に完了した再計算の結末。 */
export type RecomputeOutcome =
  | 'idle'
  | 'success'
  | 'failed'
  | 'cancelled'
  | 'workerBroken';

/** 形状計算部のメモリの量(NFR-PF-6)。model の `PartRecomputeResult.kernelMemory` と同じ形。 */
export type KernelMemoryState = NonNullable<PartRecomputeResult['kernelMemory']>;

/** Request-local reservation, not a persistent Worker/WASM memory reading. */
export interface MeshJsAccountingState {
  /** Full owning document; the computed prefix is certified once at adoption. */
  readonly document: PartDocument;
  readonly timelineIndex: AppState['timelineIndex'];
  readonly outcome: 'success' | 'failed';
  readonly activeDocumentId: AppState['activeDocumentId'];
  readonly bodies: readonly SolidBody[];
  readonly bodyLayouts: readonly MeshBodyLayout[];
  readonly mainMeshBacking?: PartRecomputeResult['mainMeshBacking'];
  readonly receipt: NonNullable<PartRecomputeResult['meshJsAccounting']>;
}

export interface MeshBodyLayout {
  readonly body: SolidBody;
  readonly mesh: SolidBody['mesh'];
  readonly positions: Float32Array;
  readonly normals: Float32Array;
  readonly indices: Uint32Array;
  readonly edges: Float32Array;
  readonly frame: SolidBody['coordinateFrame'];
  readonly origin: Vec3;
  readonly error: number | undefined;
  readonly budget: number | undefined;
  readonly byteLengths: readonly number[];
  readonly triangleCount: number;
}

/** Capture layout facts at receipt adoption, before the first viewport owner is created. */
export function captureMeshBodyLayout(body: SolidBody): MeshBodyLayout {
  const mesh = body.mesh;
  const origin: Vec3 = body.coordinateFrame === undefined ? [0, 0, 0]
    : [body.coordinateFrame.origin[0], body.coordinateFrame.origin[1], body.coordinateFrame.origin[2]];
  return Object.freeze({ body, mesh, positions: mesh.positions, normals: mesh.normals, indices: mesh.indices,
    edges: mesh.edgePositions, frame: body.coordinateFrame, origin: Object.freeze(origin),
    error: body.coordinateFrame?.maximumFloat32ErrorMm, budget: body.coordinateFrame?.maximumLiveMeshBytes,
    byteLengths: Object.freeze([mesh.positions.byteLength, mesh.normals.byteLength, mesh.indices.byteLength, mesh.edgePositions.byteLength]),
    triangleCount: mesh.triangleCount });
}

export interface ReferenceRepairBodiesState {
  readonly document: PartDocument;
  readonly activeDocumentId: AppState['activeDocumentId'];
  readonly generation: number;
  readonly bodies: readonly SolidBody[];
  readonly displayBodies: readonly SolidBody[];
  readonly scope: NonNullable<PartRecomputeResult['referenceMeshScope']>;
}
function referenceRepairBodiesOf(state: AppState, document: PartDocument, result: PartRecomputeResult): ReferenceRepairBodiesState | null {
  const scope = result.referenceMeshScope;
  if (scope === undefined || !scope.current || result.referenceBodies === undefined || result.cancelled
    || result.generation !== state.requestedGeneration || state.timelineIndex !== null
    || activePartDocument(state) === null || document !== state.document || scope.document !== document) return null;
  return Object.freeze({ document, activeDocumentId: state.activeDocumentId, generation: result.generation,
    bodies: result.referenceBodies, displayBodies: result.bodies, scope });
}
/** 再計算のスライスが持つ欄と操作。 */
export interface RecomputeSlice {
  readonly referenceRepairBodies: ReferenceRepairBodiesState | null;
  /** Resolved profiles paired with the owning document, session and generation; transient only. */
  readonly resolvedPartSketches: {
    readonly document: PartDocument;
    readonly activeDocumentId: AppState['activeDocumentId'];
    readonly generation: number;
    readonly sketches: readonly Pick<PartRecomputeResult['sketches'][number], 'sketchId' | 'resolved'>[];
  } | null;
  /** ソリッドのボディ(§0.a-0.5)。カーネルが返した三角形と稜線。 */
  readonly bodies: readonly SolidBody[];
  /**
   * 外観を割り当てた面が、いまの形のどの面に当たるか(FR-1106、P5 §2.2.3、タスク10)。
   *
   * 再計算のたびにカーネルが指紋で選び直した結果がそのまま入る。`faceIndex` が `null` の
   * ものは選び直せなかった割り当てで、その面は既定の外観で描き、警告を出す(タスク11・12)。
   * **割り当て自体は文書から消さない。**
   */
  readonly appearanceMatches: readonly AppearanceMatchEntry[];
  /** 部品の再計算で集めた失敗。スケッチ側もソリッド側も並ぶ(FR-504)。 */
  readonly partErrors: readonly PartRecomputeError[];
  /** 作り直さずに済んだ段の数(NFR-PF-3 の効き目)。 */
  readonly cacheHits: number;
  /** 計算の進み具合(NFR-PF-4)。計算していなければ null。 */
  readonly recomputeProgress: PartProgress | null;
  /**
   * 中止を頼んだ回数(NFR-PF-4)。`attachPartRecompute` は計算を始めるときの値を覚え、
   * それより増えていたら段と段の間で打ち切る。数で持つのは、止めたい計算が
   * 走っていないときに押されても次の計算へ引きずらないため(§0.a-0.22)。
   */
  readonly cancelRequestCount: number;
  /**
   * 直前の計算が中止で終わったか(NFR-PF-4)。中止は失敗ではないので `errorMessage` へは
   * 入れず、帯も赤くしない。次に文書が変わるか、次の計算が終われば消える
   * (時間で自動的に消さないのは、いつ消えるかを検査で決められるようにするため)。
   */
  readonly recomputeCancelled: boolean;
  /**
   * 図形の測定値の結果(ADD-23、計画書 geomref-plan.md §4(c)、GR-14)。計算した文書・世代と
   * 対で持つ。**画面はここを直接読んで値を出さない**——いまの値かどうかの判定は
   * `math/mathGeometryResults.ts` の `currentMathGeometry` だけが行う。中止・古い世代・
   * 履歴の途中・部品以外・形の違う文書の結果は控えず、前の値も残さない(null)。
   */
  readonly mathGeometryResult: MathGeometryResultSnapshot | null;
  /** `attachPartRecompute` が最後に開始を依頼した世代。起動前は 0。 */
  readonly requestedGeneration: number;
  /** 成功・失敗・取消・Worker 破損のいずれかで最後に完了した世代。起動前は 0。 */
  readonly completedGeneration: number;
  /** `completedGeneration` の結末。まだ 1 度も完了していなければ `idle`。 */
  readonly lastOutcome: RecomputeOutcome;
  /**
   * 形状計算部のメモリの量(NFR-PF-6、計画書 P12-28)。まだ 1 度も届いていなければ null。
   *
   * **量は計算部の事実で、文書の事実ではない**ので、文書を作り直しても戻さない
   * (`RecomputeInitialState` に入れない。世代の欄と同じ扱い)。量を添えない結果(ソリッドの段まで
   * 進まなかった・Worker が壊れた等)では前の量を持ち続ける。確保済みの量は計算部を作り直す
   * (画面を開き直す)まで減らないので、帯の警告は開き直して計算し直した後に消える。
   * 上限に近いかどうかの判断は `shell/statusText.ts` の `isKernelMemoryNearLimit` の 1 か所。
   */
  readonly kernelMemory: KernelMemoryState | null;
  /** Valid only for the paired document and currently requested generation. */
  readonly meshJsAccounting: MeshJsAccountingState | null;
  /** 部品まるごとの再計算の結果を反映する(要件§6.3)。 */
  readonly applyRecompute: (document: PartDocument, result: PartRecomputeResult) => void;
  /** 計算の進み具合を出す・消す(NFR-PF-4)。 */
  readonly setRecomputeProgress: (progress: PartProgress | null) => void;
  /** 計算を止めるよう頼む(NFR-PF-4)。段と段の間でしか止まらない(§2.6 の限界)。 */
  readonly cancelRecompute: () => void;
  /**
   * 形状計算部のメモリの量を控える(NFR-PF-6)。部品の再計算の量は `applyRecompute` が控える。
   * これは結果を `applyRecompute` へ渡さない経路(アセンブリの部品ごとの再計算)が使う。
   * 量が無い(undefined)ときは何もせず、前の量を持ち続ける。
   */
  readonly recordKernelMemory: (memory: KernelMemoryState | undefined) => void;
  /** 再計算を開始した世代を記録する(E2E の検査口、P7 タスク52)。 */
  readonly recordRecomputeRequest: (generation: number) => void;
  /** 再計算が終わった世代と結末を対で記録する(E2E の検査口、P7 タスク52)。 */
  readonly recordRecomputeCompletion: (
    generation: number,
    outcome: Exclude<RecomputeOutcome, 'idle'>,
  ) => void;
  /**
   * 段階計算の手立て(`attachPartRecompute` が差し出す)。計算部を持たない間は null。
   * 計算部の事実なので、文書を作り直しても戻さない(世代の欄と同じ扱い)。
   */
  readonly partStager: PartStager | null;
  /**
   * 最後に出した段階計算。**文書(.pcad)には入らない一時の控え**。いまのものかどうかは
   * 必ず `currentStagedSolid` で判定し、この欄を直接信じない(所有が変わると古くなる)。
   */
  readonly stagedSolid: StagedSolidState | null;
  readonly setPartStager: (stager: PartStager | null) => void;
  /** 計算の順番の持ち主だけが呼ぶ。段階計算の控えを差し替える。 */
  readonly publishStagedSolid: (staged: StagedSolidState | null) => void;
  /**
   * 成功した段階計算を確定する(札は 1 回きり)。所有を確かめ直し、1 回の set で、
   * 確かめた文書・つまみ・取り消しの 1 段・その結果の形と世代を一緒に反映する。
   * 採用できたら true。断ったときは何も変えない。
   */
  readonly adoptStagedSolid: (ticket: StagedAdoptionTicket) => boolean;
}

/**
 * 部品を作り直すたびに初期値へ戻す欄(再計算)。
 * 実体は `initialDocumentState.ts` の `createInitialDocumentState` が 1 か所で作る。
 */
export type RecomputeInitialState = Pick<
  RecomputeSlice,
  | 'referenceRepairBodies'
  | 'resolvedPartSketches'
  | 'bodies'
  | 'appearanceMatches'
  | 'partErrors'
  | 'cacheHits'
  | 'recomputeProgress'
  | 'cancelRequestCount'
  | 'recomputeCancelled'
  | 'mathGeometryResult'
>;

/**
 * 図形の測定値の控えを作る(GR-14)。**前の値を残さない**: 中止・いま依頼中でない世代・
 * 履歴の途中(つまみで切った文書)・部品以外・形の欄が違う文書の結果では null を返す。
 *
 * 計算の間に形に関わらない欄(外観・名前)だけが変わった文書では、計算した文書のまま控える。
 * 外観だけの変更では再計算が起きない(`attachPartRecompute` の購読)ので、ここで捨てると値が
 * 「計算中」のまま戻らなくなるため。形の欄が変わっていれば新しい計算が必ず予約されている。
 * いまの値かどうかは `currentMathGeometry` が文書と世代でもう一度判定する。
 */
function mathGeometryResultOf(
  state: AppState,
  document: PartDocument,
  result: PartRecomputeResult,
): MathGeometryResultSnapshot | null {
  if (
    result.cancelled ||
    result.generation !== state.requestedGeneration ||
    state.timelineIndex !== null ||
    activePartDocument(state) === null ||
    document.id !== state.document.id ||
    affectsShape(document, state.document)
  ) {
    return null;
  }
  const outcomes = new Map<string, MathGeometryOutcome>();
  for (const outcome of result.mathGeometry ?? []) {
    // この文書・この世代の測定だけを控える(model は同じ値を付けて返す。念のため照合する)。
    if (outcome.documentId === document.id && outcome.generation === result.generation) {
      outcomes.set(outcome.id, outcome);
    }
  }
  return {
    document,
    generation: result.generation,
    evaluated: result.mathGeometry !== undefined,
    outcomes,
  };
}

type FinalMeshJsReading = NonNullable<NonNullable<PartRecomputeResult['meshJsAccounting']>['final']>;

/**
 * The kernel's post-token Worker union, re-checked after transport: each part fits inside the
 * union, the union does not exceed its parts, the clone equals the reply, and Worker-retained
 * buffers plus the clone fit the dispatch limit. This is not an RSS, GPU or process reading.
 */
export function finalMeshAccountingFits(final: FinalMeshJsReading | undefined,
  limitBytes: number): final is FinalMeshJsReading {
  if (final === undefined || final.status !== 'known' || final.limitBytes !== limitBytes) return false;
  const values = [final.cacheActiveBytes, final.cacheRetiredBytes, final.cacheProtectedBytes,
    final.displayBackingBytes, final.replyBackingBytes, final.retainedBackingBytes, final.replyCloneReservedBytes];
  if (!values.every(value => Number.isSafeInteger(value) && value >= 0)) return false;
  const cacheBytes = final.cacheActiveBytes + final.cacheRetiredBytes;
  const partsBytes = cacheBytes + final.displayBackingBytes + final.replyBackingBytes;
  const totalBytes = final.retainedBackingBytes + final.replyCloneReservedBytes;
  return Number.isSafeInteger(cacheBytes) && Number.isSafeInteger(partsBytes) && Number.isSafeInteger(totalBytes)
    && final.cacheProtectedBytes <= cacheBytes && cacheBytes <= final.retainedBackingBytes
    && final.displayBackingBytes <= final.retainedBackingBytes && final.replyBackingBytes <= final.retainedBackingBytes
    && final.retainedBackingBytes <= partsBytes && final.replyCloneReservedBytes === final.replyBackingBytes
    && totalBytes <= limitBytes;
}

/** documentUpTo only slices these two arrays; all other shape fields retain their identities. */
function matchesDisplayedDocument(state: AppState, document: PartDocument): boolean {
  if (document.id !== state.document.id) return false;
  if (state.timelineIndex === null) return !affectsShape(document, state.document);
  const shown = documentUpTo(state.document, state.timelineIndex);
  return document.references.length === shown.references.length
    && document.references.every((entry, index) => entry === shown.references[index])
    && document.solids.length === shown.solids.length
    && document.solids.every((entry, index) => entry === shown.solids[index])
    && !affectsShape(document, { ...state.document, references: document.references, solids: document.solids });
}

type MeshJsReceipt = NonNullable<PartRecomputeResult['meshJsAccounting']>;

/**
 * The result-local half of receipt adoption: a known, bounded receipt of this very result and
 * document. Store-state pairing (requested generation, displayed document) is checked separately.
 */
export function meshReceiptOf(document: PartDocument, result: PartRecomputeResult): MeshJsReceipt | null {
  const receipt = result.meshJsAccounting;
  if (receipt === undefined || receipt.reading.status !== 'known' || result.cancelled
    || receipt.generation !== result.generation || receipt.documentId !== document.id) return null;
  const reading = receipt.reading;
  const counts = [reading.limitBytes, reading.cacheActiveBytes, reading.cacheRetiredBytes,
    reading.cacheProtectedBytes, reading.retainedReplyBytes, reading.requestPeakReservedBytes];
  const cacheBytes = reading.cacheActiveBytes + reading.cacheRetiredBytes;
  const reservedBytes = cacheBytes + reading.retainedReplyBytes;
  if (typeof receipt.partId !== 'string' || receipt.partId.length === 0
    || !Number.isSafeInteger(receipt.generation) || receipt.generation < 0
    || !counts.every(value => Number.isSafeInteger(value) && value >= 0)
    || reading.limitBytes === 0 || reading.limitBytes > 512 * 1024 * 1024
    || !Number.isSafeInteger(cacheBytes) || !Number.isSafeInteger(reservedBytes)
    || reading.cacheProtectedBytes > cacheBytes || reservedBytes > reading.requestPeakReservedBytes
    || reading.requestPeakReservedBytes > reading.limitBytes) return null;
  // A present post-token union must be valid; local admission later requires it to be present.
  if (receipt.final !== undefined && !finalMeshAccountingFits(receipt.final, reading.limitBytes)) return null;
  return receipt;
}

function meshJsAccountingOf(
  state: AppState,
  document: PartDocument,
  result: PartRecomputeResult,
): MeshJsAccountingState | null {
  const receipt = meshReceiptOf(document, result);
  if (receipt === null || result.generation !== state.requestedGeneration
    || (result.errors.length !== 0 && (receipt.final === undefined || result.bodies.length === 0
      || result.bodies.some(body => !body.isValid || result.errors.some(error => error.featureId === body.featureId))))
    || !matchesDisplayedDocument(state, document) || activePartDocument(state) === null) return null;
  return accountingSnapshot(state.document, state.timelineIndex, state.activeDocumentId, result, receipt);
}

/**
 * One frozen copy of a result's own receipt paired with the exact bodies and their layouts.
 * The committed path pairs it with the store's document; a staged result pairs it with its own
 * prepared document. Neither path copies or relabels the other's receipt.
 */
export function accountingSnapshot(
  document: PartDocument,
  timelineIndex: AppState['timelineIndex'],
  activeDocumentId: AppState['activeDocumentId'],
  result: PartRecomputeResult,
  receipt: MeshJsReceipt,
): MeshJsAccountingState {
  return Object.freeze({ document, timelineIndex,
    outcome: result.errors.length === 0 ? 'success' : 'failed', activeDocumentId, bodies: result.bodies,
    ...(result.mainMeshBacking === undefined ? {} : { mainMeshBacking: Object.freeze({
      ...result.mainMeshBacking, buffers: Object.freeze([...result.mainMeshBacking.buffers]),
    }) }),
    bodyLayouts: Object.freeze(result.bodies.map(captureMeshBodyLayout)), receipt: Object.freeze({
    documentId: receipt.documentId, partId: receipt.partId, generation: receipt.generation,
    reading: Object.freeze({ ...receipt.reading }),
    ...(receipt.final === undefined ? {} : { final: Object.freeze({ ...receipt.final }) }),
  }) });
}

/** 結果の参照の範囲を控えに採れなかったときは、その範囲だけを閉じる(共有の計算部は閉じない)。 */
function adoptReferenceScope(state: AppState, document: PartDocument, result: PartRecomputeResult): ReferenceRepairBodiesState | null {
  const referenceRepairBodies = referenceRepairBodiesOf(state, document, result);
  if (referenceRepairBodies === null && result.referenceMeshScope !== undefined) void result.referenceMeshScope.close();
  return referenceRepairBodies;
}

/**
 * 部品まるごとの再計算の結果を反映する差分(`applyRecompute` の本体。要件§6.3)。
 * 押し出しの確定(段階計算の採用、`adoptStagedSolid`)も、採用後の状態を `state` に
 * 渡して同じ差分を使う。結果の欄を 2 か所で別々に組み立てない。
 */
function recomputeResultPatch(
  state: AppState,
  document: PartDocument,
  result: PartRecomputeResult,
  referenceRepairBodies: ReferenceRepairBodiesState | null,
  acceptResolvedSketches: boolean,
): Partial<AppState> {
  const sketch = activeSketchOf(document);
  const active = result.sketches.find((entry) => entry.sketchId === sketch.id);
  return {
    resolvedPartSketches: acceptResolvedSketches && !result.cancelled && result.errors.length === 0
      && result.generation === state.requestedGeneration && state.timelineIndex === null
      && activePartDocument(state) !== null && document.id === state.document.id
      && !affectsShape(document, state.document)
      ? { document, activeDocumentId: state.activeDocumentId, generation: result.generation,
        sketches: result.sketches.map(({ sketchId, resolved }) => ({ sketchId, resolved })) }
      : null,
    resolvedSketch: active === undefined ? state.resolvedSketch : active.resolved,
    sketchMesh: active === undefined ? state.sketchMesh : active.mesh,
    sketchErrors:
      active === undefined
        ? state.sketchErrors
        : activeSketchErrors(sketch, active, result.errors),
    // 拘束の診断(FR-313、タスク13)。いま編集しているスケッチのぶんだけを控える。
    constraintDiagnosis: active === undefined ? state.constraintDiagnosis : active.diagnosis,
    ...(active === undefined
      ? { constraintSummaries: state.constraintSummaries }
      : constraintSummaryPatch(sketch, active.resolved, active.diagnosis)),
    // 確定した形が届いたので、引っぱっている間の仮の形は用済み(タスク14)。
    dragResolved: active === undefined ? state.dragResolved : null,
    // 途中で打ち切られた結果は「作れたところまで」でしかないので、前のボディを
    // 半分だけの形へ置き換えない(NFR-PF-4、§2.6 の限界)。
    bodies: result.cancelled ? state.bodies : result.bodies,
    sheetMetalBodies: result.cancelled ? state.sheetMetalBodies : (result.sheetMetalBodies ?? new Map()),
    // 外観の面の照合(FR-1106)はボディと対で意味を持つので、ボディを差し替えたときだけ
    // 一緒に差し替える(打ち切られた結果の照合は「作れたところまで」でしかない)。
    appearanceMatches: result.cancelled
      ? state.appearanceMatches
      : (result.appearanceMatches ?? []),
    partErrors: result.errors,
    cacheHits: result.cacheHits,
    // 図形の測定値(GR-14)。控えるかどうかの条件は mathGeometryResultOf の 1 か所。
    mathGeometryResult: mathGeometryResultOf(state, document, result),
    ...(result.parameterAnalysis === undefined || result.cancelled || result.generation !== state.requestedGeneration
      || document.id !== state.document.id || document.parameters !== state.document.parameters ? {} : {
        parameterAnalysis: result.parameterAnalysis, nonLengthVariables: result.parameterAnalysis.nonLengthVariables,
      }),
    documentName: sketch.name,
    featureNames: sketch.features.map((feature) => feature.name),
    isComputing: false,
    recomputeProgress: null,
    // 中止で終わったことは帯で短く知らせる。最後まで走ったならその知らせは消す。
    recomputeCancelled: result.cancelled,
    // 幾何カーネルを積んで少なくとも 1 回計算が終わった(§0.a-0.23 ⑨)。
    // 購読通知(subscribe)の中で set を入れ子にしないよう、ここへ直接含める。
    kernelLoaded: true,
    // 形状計算部のメモリの量(NFR-PF-6)。取り消した結果でも計算部の事実なので控える。
    // 量を添えない結果では前の量を持ち続ける(`recordKernelMemory` と同じ決め)。
    kernelMemory: result.kernelMemory ?? state.kernelMemory,
    meshJsAccounting: meshJsAccountingOf(state, document, result),
    referenceRepairBodies,
  };
}

/** 完了した世代と結末を対で記録する差分(`recordRecomputeCompletion` の本体)。 */
function completionPatch(
  state: AppState,
  completedGeneration: number,
  lastOutcome: Exclude<RecomputeOutcome, 'idle'>,
): Pick<AppState, 'completedGeneration' | 'lastOutcome' | 'meshJsAccounting'> {
  return { completedGeneration, lastOutcome,
    meshJsAccounting: lastOutcome === state.meshJsAccounting?.outcome
      && state.meshJsAccounting?.receipt.generation === completedGeneration
      && completedGeneration === state.requestedGeneration
      && state.meshJsAccounting.bodies === state.bodies
      && state.meshJsAccounting.activeDocumentId === state.activeDocumentId
      && state.meshJsAccounting.timelineIndex === state.timelineIndex
      && activePartDocument(state) !== null && !state.recomputeCancelled
      && state.meshJsAccounting.document.id === state.document.id
      && !affectsShape(state.meshJsAccounting.document, state.document)
      ? state.meshJsAccounting : null };
}

/*
 * 段階計算(押し出しの確定前の計算)。設計: 候補は文書の外で、通常の編集と同じ整え
 * (`prepareDocumentEdit`)を通した「実際に保存される文書」として、`attachPartRecompute`
 * の 1 本ずつの順番に載せて計算する。確定は成功した**その文書と結果**を 1 回の set で
 * 採用し、取り消しの段はちょうど 1 つ積む。先に反映して失敗したら戻す、はしない。
 *
 * `documentVersion` は編集の世代ではない(ふつうの編集では増えない)ので、所有の判定には
 * 使わない。文書・履歴(Undo の段)・作業中の文書・つまみ・選択・添付の表・中止の回数の
 * 実体の一致と、段階計算を出した手立て自身の所有(取消の通し番号)の両方で判定する。
 */

/** 段階計算を出した時点の所有。どれか 1 つでも変われば、その計算は採用できない。 */
export interface StagedSolidOwnership {
  readonly stager: PartStager;
  readonly document: PartDocument;
  /** Undo/Redo で同じ文書へ戻っても、履歴は新しい実体になる(ABA を見分ける)。 */
  readonly undoStack: AppState['undoStack'];
  readonly activeDocumentId: AppState['activeDocumentId'];
  readonly timelineIndex: AppState['timelineIndex'];
  /** 対象(輪郭・相手の立体)を選び直したら、前の入力の計算は使わない。 */
  readonly selection: AppState['selection'];
  readonly importedShapes: AppState['importedShapes'];
  readonly importedMeshes: AppState['importedMeshes'];
  readonly cancelRequestCount: number;
  /**
   * 入力欄の通し番号(`sketchSlice.ts` の `numericInputRevision`)。開き直し・閉じる・値や選択肢など
   * 意味の変わる更新で進む(焦点の移動だけでは進まない)。計算中の確定・表示中の仮の形の両方が、
   * 始めたときの入力欄・入力の意味のままであることをストアの値だけで確かめる。
   */
  readonly numericInputRevision: number;
  /** 意味の同じ入力ごとに手立てが 1 つ振る番号。確定はこの番号の入力にだけ効く。 */
  readonly inputRevision: number;
}

/** 段階計算の依頼。`candidate` は `base` から純関数で作った、末尾へ積んだ形の文書。 */
export interface StagedSolidRequest {
  readonly base: PartDocument;
  readonly candidate: PartDocument;
  /** 最後に作られる立体の id(結合・切り取りなら、ブーリアンの段)。 */
  readonly finalFeatureId: string;
  /** 入力の意味の指紋。同じ指紋・同じ所有なら計算をやり直さない。 */
  readonly fingerprint: string;
}

export interface StagedSolidState {
  readonly ownership: StagedSolidOwnership;
  readonly fingerprint: string;
  readonly finalFeatureId: string;
  /** 通常の編集と同じ整えを通した、確定で保存される文書とつまみ。 */
  readonly placement: DocumentEditPlacement;
  /** 画面に出す範囲(つまみが途中なら、差し込んだ段まで)。`placement.document` と同じこともある。 */
  readonly displayed: PartDocument;
  readonly status: 'pending' | 'ready' | 'failed';
  /** `displayed` を計算した成功の結果(ready のときだけ)。 */
  readonly result: PartRecomputeResult | null;
  /**
   * その結果自身の表示の量の受領を、確定で保存される文書・つまみと対にした控え(ready のときだけ)。
   * 仮の形を画面に入れる判定(`solidMeshAdmission.ts`)が使う。確定済みの受領は使わない。
   */
  readonly accounting: MeshJsAccountingState | null;
  /** つまみが途中のとき、履歴全体を確かめた計算の世代(証拠。採用はしない)。 */
  readonly wholeGeneration: number | null;
  readonly errors: readonly PartRecomputeError[];
  /** 計算そのものが投げた理由(Worker の失敗など)。 */
  readonly errorMessage: string | null;
  /** 採用できない理由の種類(failed のときだけ)。画面の文言は呼び出し側が i18n で選ぶ。 */
  readonly failure: StagedSolidFailure | null;
  /** 確定を頼まれ、成功し次第そのまま採用する。 */
  readonly confirmRequested: boolean;
}

/**
 * 段階計算を採用できない理由。形の成功は**実際の形**で決める(文書が作れただけでは成功にしない)。
 * - failed: 計算部・解決が失敗を返した(交わらない結合・カーネルの失敗など。理由は `errors`)。
 * - workerBroken: 計算部が壊れた。
 * - thrown: 計算の呼び出しそのものが投げた(理由は `errorMessage`)。
 * - incomplete: 打ち切られた・世代が食い違う結果(途中までの形を採用しない)。
 * - missingBody: 画面に出す範囲に、作った立体の有効なボディが無い。
 * - invalidBody: 履歴全体の計算で、残るボディに無効なもの・重複・文書に無いものがある。
 * - accounting: 表示の量の受領(最終の受領を含む)が無い・範囲外。
 */
export type StagedSolidFailure =
  | 'failed' | 'workerBroken' | 'thrown' | 'incomplete' | 'missingBody' | 'invalidBody' | 'accounting';

/** 確定の頼みの答え。adopted = いま採用した、pending = 計算が終わり次第採用する。 */
export type StagedConfirmation = 'adopted' | 'pending' | 'refused';

/** `attachPartRecompute` が差し出す段階計算の手立て(実物は計算の順番の持ち主)。 */
export interface PartStager {
  /** 前の段階計算を打ち切って新しく計算する。同じ指紋・同じ所有なら今のものを返す。 */
  readonly stage: (request: StagedSolidRequest) => StagedSolidState | null;
  /** その入力の番号の計算を確定する。番号が違う・失敗・古い計算は断る。 */
  readonly confirm: (inputRevision: number, onAdopted?: (adopted: StagedSolidState) => void) => StagedConfirmation;
  /** 段階計算をやめる(Escape・道具を閉じる)。確定済みの文書には触れない。 */
  readonly cancel: () => void;
  /** その段階計算を、いまも自分が持っているか(取消の通し番号まで含めて)。 */
  readonly owns: (staged: StagedSolidState) => boolean;
}

/** 計算の順番の持ち主が採用のときだけ発行する、1 回きりの札。 */
export interface StagedAdoptionTicket {
  readonly stager: PartStager;
  readonly staged: StagedSolidState;
}

/**
 * いまの状態で段階計算の所有を作る。部品を開いていない・手立てが違う・入力の窓が開いていない
 * ときは null(段階計算は開いている入力の窓のもの。窓を閉じたら手放す)。
 */
export function captureStagedSolidOwnership(
  state: AppState,
  stager: PartStager,
  inputRevision: number,
): StagedSolidOwnership | null {
  if (activePartDocument(state) === null || state.partStager !== stager || state.numericInput === null) return null;
  return Object.freeze({ stager, document: state.document, undoStack: state.undoStack,
    activeDocumentId: state.activeDocumentId, timelineIndex: state.timelineIndex, selection: state.selection,
    importedShapes: state.importedShapes, importedMeshes: state.importedMeshes,
    cancelRequestCount: state.cancelRequestCount, numericInputRevision: state.numericInputRevision, inputRevision });
}

/**
 * 所有の欄がすべて同じ実体のままか。値が同じでも作り直されたものは別とみなす。
 * 入力の窓を閉じた(Escape・道具の切り替え・確定後)・開き直した・入力の意味を変えたときも
 * 今のものではない(入力欄の通し番号。焦点の移動だけでは変わらない)。
 */
export function isStagedSolidOwnershipCurrent(state: AppState, ownership: StagedSolidOwnership): boolean {
  return activePartDocument(state) !== null && state.partStager === ownership.stager && state.numericInput !== null
    && state.document === ownership.document && state.undoStack === ownership.undoStack
    && state.activeDocumentId === ownership.activeDocumentId && state.timelineIndex === ownership.timelineIndex
    && state.selection === ownership.selection && state.importedShapes === ownership.importedShapes
    && state.importedMeshes === ownership.importedMeshes && state.cancelRequestCount === ownership.cancelRequestCount
    && state.numericInputRevision === ownership.numericInputRevision;
}

/** いまの段階計算。所有が変わった・手立てが手放した計算は null(古い計算を出さない)。 */
export function currentStagedSolid(state: AppState): StagedSolidState | null {
  const staged = state.stagedSolid;
  return staged !== null && isStagedSolidOwnershipCurrent(state, staged.ownership) && staged.ownership.stager.owns(staged)
    ? staged : null;
}

function adoptable(state: AppState, ticket: StagedAdoptionTicket): boolean {
  const staged = ticket.staged;
  return staged.status === 'ready' && staged.result !== null && state.stagedSolid === staged
    && staged.ownership.stager === ticket.stager && currentStagedSolid(state) === staged;
}

export const createRecomputeSlice: StateCreator<
  AppState,
  [],
  [],
  Omit<RecomputeSlice, keyof RecomputeInitialState>
> = (set, get, store) => {
  // The store's actual document/reset/request/cancel publication owns retirement of this scope.
  store.subscribe((next, previous) => {
    const before = previous.referenceRepairBodies;
    if (before !== null && (next.referenceRepairBodies !== before || next.document !== before.document
      || next.activeDocumentId !== before.activeDocumentId || next.requestedGeneration !== before.generation
      || next.cancelRequestCount !== previous.cancelRequestCount)) void before.scope.close();
  });
  /** 使い終えた採用の札。同じ札で 2 回採用しない(取り消しの段は 1 つだけ)。 */
  const consumedTickets = new WeakSet<StagedAdoptionTicket>();
  // Capture the request owner before async work. A same-shape reopen must not relabel its result.
  let resolvedSketchRequest: { readonly document: PartDocument; readonly activeDocumentId: AppState['activeDocumentId'];
    readonly generation: number; readonly cancelRequestCount: number } | null = null;
  return {
  // 文書を作り直しても世代を巻き戻さないため、createInitialDocumentState には含めない。
  requestedGeneration: 0,
  completedGeneration: 0,
  lastOutcome: 'idle',
  kernelMemory: null,
  meshJsAccounting: null,
  partStager: null,
  stagedSolid: null,
  setPartStager: (partStager) => {
    if (get().partStager !== partStager) set({ partStager, stagedSolid: null });
  },
  publishStagedSolid: (stagedSolid) => {
    set({ stagedSolid });
  },
  adoptStagedSolid: (ticket) => {
    if (consumedTickets.has(ticket) || !adoptable(get(), ticket)) return false;
    let adopted = false;
    set((state) => {
      const staged = ticket.staged, result = staged.result;
      if (consumedTickets.has(ticket) || result === null || !adoptable(state, ticket)) return {};
      consumedTickets.add(ticket);
      adopted = true;
      // 取り消しの段はちょうど 1 つ。確かめた文書そのものを積む(作り直さない)。
      const stack = pushUndo(state.undoStack, staged.placement.document);
      const documentFields = documentEditPatch(state, staged.placement, stack, false, undefined);
      // 採用した結果の世代を、依頼した世代として同時に記録する(古い結果を採用しない判定と同じ形)。
      const requested: AppState = { ...state, ...documentFields, requestedGeneration: result.generation,
        meshJsAccounting: null, referenceRepairBodies: null };
      const recomputeFields = recomputeResultPatch(requested, staged.displayed, result,
        adoptReferenceScope(requested, staged.displayed, result), true);
      const recomputed: AppState = { ...requested, ...recomputeFields };
      return { ...documentFields, requestedGeneration: result.generation, ...recomputeFields,
        ...completionPatch(recomputed, result.generation, 'success'), stagedSolid: null };
    });
    if (adopted) rememberTimelineHintShown(get());
    return adopted;
  },
  applyRecompute: (document, result) => {
    set((state) => {
      const request = resolvedSketchRequest;
      const current = request !== null && request.generation === result.generation
        && request.activeDocumentId === state.activeDocumentId && request.cancelRequestCount === state.cancelRequestCount
        && request.document.id === document.id && !affectsShape(request.document, document);
      return recomputeResultPatch(state, document, result, adoptReferenceScope(state, document, result), current);
    });
  },
  setRecomputeProgress: (recomputeProgress) => {
    set({ recomputeProgress });
  },
  cancelRecompute: () => {
    set((state) => ({ cancelRequestCount: state.cancelRequestCount + 1, meshJsAccounting: null, resolvedPartSketches: null, referenceRepairBodies: null }));
  },
  recordKernelMemory: (memory) => {
    if (memory !== undefined) {
      set({ kernelMemory: memory });
    }
  },
  recordRecomputeRequest: (requestedGeneration) => {
    set(state => {
      resolvedSketchRequest = { document: state.document, activeDocumentId: state.activeDocumentId,
        generation: requestedGeneration, cancelRequestCount: state.cancelRequestCount };
      return { requestedGeneration, meshJsAccounting: null, resolvedPartSketches: null, referenceRepairBodies: null };
    });
  },
  recordRecomputeCompletion: (completedGeneration, lastOutcome) => {
    set(state => completionPatch(state, completedGeneration, lastOutcome));
  },
  };
};
