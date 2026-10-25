/**
 * カーネル(Worker)の手立てをストアへ差し出す口(P6 タスク52 で `useAppStore.ts` から
 * 切り出した)。**ストアを読む側**なので、スライスからは参照しない(輪を作らないため)。
 */
import type { PcadAttachments } from '@pointercad/io';
import {
  affectsShape,
  documentUpTo,
  KERNEL_BROKEN_MESSAGE,
  type PartDocument,
  type PartRecomputeOptions,
  type PartRecomputeResult,
} from '@pointercad/model';
import type { ExchangeKernel } from '../file/exchangeFile.js';
import { referencedPartAttachments } from '../file/referencedPartAttachments.js';
import type { PartMeasurer } from '../solid/measureCommands.js';
import type { PartInspector } from '../solid/printCheckCommands.js';
import type { AppState } from './appState.js';
import {
  accountingSnapshot,
  captureStagedSolidOwnership,
  isStagedSolidOwnershipCurrent,
  meshReceiptOf,
  type PartStager,
  type RecomputeOutcome,
  type StagedAdoptionTicket,
  type StagedSolidFailure,
  type StagedSolidOwnership,
  type StagedSolidState,
} from './recomputeSlice.js';
import { activePartDocument } from './documentKind.js';
import { documentWithIssuanceLedger, prepareDocumentEdit } from './documentDerived.js';
import { useAppStore } from './useAppStore.js';

/**
 * 書き出し・読み込みの口を差し出す(FR-802、FR-803。P6 タスク32)。
 *
 * `attachPartMeasure` とまったく同じ形にしてある。**書き出しも読み込みも再計算を
 * 起こさない読み取り**なので、文書の変化は見張らない(差し出して、片付けで取り下げるだけ)。
 *
 * 戻り値を呼ぶと取り下げる。
 */
export function attachExchangeKernel(kernel: ExchangeKernel): () => void {
  useAppStore.getState().setExchangeKernel(kernel);
  return () => {
    // 自分が差し出したものが今も立っているときだけ下ろす(`attachPartMeasure` と同じ)。
    if (useAppStore.getState().exchangeKernel === kernel) {
      useAppStore.getState().setExchangeKernel(null);
    }
  };
}

/**
 * いまの添付の表(`.pcad` へ一緒に書くもの。P6 §0.a-0.55、タスク32)。
 *
 * **保存・自動保存はここ 1 か所から取る。** 3 つを別々に読み集めると、片方だけ渡し忘れた
 * ときに「開き直せないファイル」ができる(`packages/io` の `findMissingAttachment` が
 * `missingField` で断る)。下絵(`canvases`、タスク39)も同じ表に載る。
 */
export function currentPcadAttachments(document = useAppStore.getState().document): PcadAttachments {
  const state = useAppStore.getState();
  return referencedPartAttachments(document, {
    shapes: state.importedShapes,
    meshes: state.importedMeshes,
    canvases: state.canvases,
  });
}

/**
 * 形を測る手立てを差し出す(FR-1101、FR-1102。P5 タスク32)。
 *
 * カーネル(Worker)を持っているのは入口(`PointerCadApp`)だけなので、`attachPartRecompute`
 * と同じ流儀で外から差し込む。**測定は再計算を起こさない読み取り**(§0.a-0.30)なので、
 * 文書の変化は見張らない(差し出して、片付けで取り下げるだけ)。
 *
 * 戻り値を呼ぶと取り下げる。
 */
export function attachPartMeasure(measurer: PartMeasurer): () => void {
  useAppStore.getState().setPartMeasurer(measurer);
  return () => {
    // 自分が差し出したものが今も立っているときだけ下ろす(別の入口が差し替えた後に
    // 片付けが走っても、新しい手立てを消さない)。
    if (useAppStore.getState().partMeasurer === measurer) {
      useAppStore.getState().setPartMeasurer(null);
    }
  };
}

/**
 * 3D プリントの点検の手立てを差し出す(FR-815。P6 タスク46)。
 *
 * `attachPartMeasure` とまったく同じ形。**点検も再計算を起こさない読み取り**
 * (§0.a-0.30)なので、文書の変化は見張らない(差し出して、片付けで取り下げるだけ)。
 *
 * 戻り値を呼ぶと取り下げる。
 */
export function attachPartInspector(inspector: PartInspector): () => void {
  useAppStore.getState().setPartInspector(inspector);
  return () => {
    if (useAppStore.getState().partInspector === inspector) {
      useAppStore.getState().setPartInspector(null);
    }
  };
}

/** Shared Part/assembly display precision and request-local JS ceiling. */
export const LOCAL_DISPLAY_MESH_BUDGET = Object.freeze({
  maximumFloat32ErrorMm: 0.005, maximumLiveMeshBytes: 512 * 1024 * 1024,
});

/**
 * 部品を 1 回計算するもの。実物は `recomputePart(document, bridge, options)`。
 * カーネル(Worker)を持たない検査では偽物を差し込めるよう、関数の型で受ける。
 */
export type PartRecomputer = (
  document: PartDocument,
  options: PartRecomputeOptions,
) => Promise<PartRecomputeResult>;

/**
 * 文書の変化を見張り、変わるたびに再計算を予約する(要件§6.3)。
 *
 * 1 本ずつしか走らせない。計算中に文書が何度変わっても覚えるのは**最新の 1 つだけ**で、
 * 間に挟まった版は捨てる。連続入力のたびに Worker を往復させて詰まらせないため
 * (NFR-PF-1)。古い版の結果は捨てるので、`isComputing` が下りるのは最新の計算が
 * 終わったときだけになる。失敗しても例外を投げず、理由を画面に出す(FR-504、NFR-RE-1)。
 *
 * 依頼のたびに世代番号を 1 つ増やして渡す(NFR-PF-4)。E2E が今回の依頼を区別できるよう、
 * 開始した世代と完了した世代・結末だけはストアにも記録する(P7 タスク52)。この欄の変更は
 * 下の購読条件(文書とタイムラインだけ)に当たらないので、再計算を再帰的に予約しない。
 * 中止は `cancelRecompute` が数える回数で拾う。
 *
 * 押し出しの確定前の段階計算(`PartStager`)も**同じ 1 本ずつの順番**に載せる
 * (共有の計算部へ同時に投げない)。ふつうの編集の計算が常に先で、段階計算は空いたときに
 * 走る。段階計算の世代も同じ数から振る(確定した文書の依頼・完了の世代の対は書き換えない)。
 * 採用は成功した文書と結果を 1 回の set で反映し、その採用が起こす再計算だけを
 * 1 回きりの札で外す(ふつうの編集の再計算は外さない)。
 *
 * 戻り値を呼ぶと見張りをやめる。
 */
export function attachPartRecompute(recompute: PartRecomputer): () => void {
  let detached = false;
  let running = false;
  /** 実行中に届いた最新の文書。1 つだけ持つ。 */
  let queued: PartDocument | null = null;
  /** 依頼ごとに 1 つ増える世代番号。1 から始まる。 */
  let generation = useAppStore.getState().requestedGeneration;
  /** 段階計算の所有の通し番号。手放すたびに 1 つ進み、戻らない(取消の判定)。 */
  let stagedEpoch = 0;
  /** 意味の違う入力ごとに 1 つ振る番号。確定はこの番号の入力にだけ効く。 */
  let inputRevision = 0;
  /** いまの段階計算(1 つだけ)。 */
  let staged: StagedJob | null = null;
  /** 採用の最中だけ立つ 1 回きりの札。その採用の通知の再計算だけを外す。 */
  let adopting: AdoptionInProgress | null = null;

  interface StagedJob {
    readonly epoch: number;
    readonly ownership: StagedSolidOwnership;
    state: StagedSolidState;
    /** 順番を待っている(まだ計算を始めていない)。 */
    waiting: boolean;
    /** 採用まで持つ、画面に出す範囲の成功した結果(参照の範囲の持ち主)。 */
    held: PartRecomputeResult | null;
    onAdopted: ((adopted: StagedSolidState) => void) | null;
  }

  interface AdoptionInProgress {
    readonly job: StagedJob;
    readonly document: PartDocument;
    readonly timelineIndex: AppState['timelineIndex'];
    readonly generation: number;
  }

  function outcomeOf(result: PartRecomputeResult): Exclude<RecomputeOutcome, 'idle'> {
    if (result.cancelled) {
      return 'cancelled';
    }
    if (result.errors.some((error) => error.message === KERNEL_BROKEN_MESSAGE)) {
      return 'workerBroken';
    }
    return result.errors.length === 0 ? 'success' : 'failed';
  }

  /** 1 本分が終わったときの後始末。次に回す文書があれば返す。 */
  function takeQueued(): PartDocument | null {
    running = false;
    const next = queued;
    queued = null;
    return next;
  }

  /** ふつうの計算と段階計算が同じ数から世代を振る(単調に増え、使い回さない)。 */
  function nextGeneration(): number {
    generation = Math.max(generation, useAppStore.getState().requestedGeneration) + 1;
    return generation;
  }

  function start(document: PartDocument): void {
    running = true;
    const current = nextGeneration();
    useAppStore.getState().recordRecomputeRequest(current);
    // 利用者の中止は「この計算を始めた後に頼まれたか」で判る。新しい文書の予約と
    // 世代の交代は下の shouldCancel で別に拾う。
    const cancelBaseline = useAppStore.getState().cancelRequestCount;
    // 前の計算の進み具合は用済み。計算中の札は applyDocument が立てるのでここでは触らない。
    useAppStore.getState().setRecomputeProgress(null);

    void recompute(document, {
      generation: current,
      // Keep display vertices near their body origin before conversion to Float32.
      // Full and prefix views still require this request's final memory receipt.
      localMesh: { ...LOCAL_DISPLAY_MESH_BUDGET },
      onProgress: (progress) => {
        // 古い世代の通知は捨てる。画面の進み具合を決めるのは最新の計算だけ。
        if (detached || current !== generation || activePartDocument(useAppStore.getState()) === null) {
          return;
        }
        useAppStore.getState().setRecomputeProgress(progress);
      },
      shouldCancel: () =>
        detached || activePartDocument(useAppStore.getState()) === null ||
        useAppStore.getState().cancelRequestCount > cancelBaseline ||
        queued !== null ||
        generation !== current,
      /*
       * 読み込んだ形の B-rep(FR-802、P6 §0.a-0.9)。**渡さないと `importedSolid` の段が
       * 「読み込んだ形が見つかりません」で失敗する。** 表は文書と一緒に差し替わるので、
       * 依頼を出すそのときの表を読む(`PointerCadApp` の覚え書きと同じ約束)。
       */
      importedShapes: useAppStore.getState().importedShapes,
      importedMeshes: useAppStore.getState().importedMeshes,
    }).then(
      (result) => {
        if (detached) {
          return;
        }
        const next = takeQueued();
        if (activePartDocument(useAppStore.getState()) === null) return;
        if (next !== null) {
          // もっと新しい文書が来ている。この結果は使わずに次を計算する。
          useAppStore.getState().recordRecomputeCompletion(current, 'cancelled');
          start(next);
          return;
        }
        useAppStore.getState().applyRecompute(document, result);
        useAppStore.getState().recordRecomputeCompletion(current, outcomeOf(result));
        resumeStaged();
      },
      (error: unknown) => {
        if (detached) {
          return;
        }
        const next = takeQueued();
        if (activePartDocument(useAppStore.getState()) === null) return;
        if (next !== null) {
          useAppStore.getState().recordRecomputeCompletion(current, 'cancelled');
          start(next);
          return;
        }
        useAppStore.getState().setError(error instanceof Error ? error.message : String(error));
        useAppStore.getState().recordRecomputeCompletion(current, 'failed');
        resumeStaged();
      },
    );
  }

  function request(document: PartDocument): void {
    if (running) {
      queued = document;
      return;
    }
    start(document);
  }

  /** その段階計算を、いまも自分が持っているか(通し番号と所有の欄の両方)。 */
  function ownedBy(job: StagedJob): boolean {
    return !detached && staged === job && stagedEpoch === job.epoch
      && isStagedSolidOwnershipCurrent(useAppStore.getState(), job.ownership);
  }

  /**
   * 結果が持つ参照の範囲だけを手放す。**共有の計算部(bridge)は閉じない**(取消のために
   * 計算部を捨てると、確定済みの形の計算まで止まる)。手放せなかった範囲は範囲自身が
   * 失敗として持ち続ける。
   */
  function releaseScope(result: PartRecomputeResult | null): void {
    const scope = result?.referenceMeshScope;
    if (scope === undefined) return;
    void scope.close().catch(() => false);
  }

  /** いまの段階計算を手放す(購読の中からも呼ぶので、ストアへは書かない)。 */
  function dropStaged(): void {
    const job = staged;
    if (job === null) return;
    staged = null;
    stagedEpoch += 1;
    releaseScope(job.held);
    job.held = null;
  }

  function publish(job: StagedJob, next: StagedSolidState): void {
    job.state = next;
    useAppStore.getState().publishStagedSolid(next);
  }

  function publishFailure(job: StagedJob, failure: StagedSolidFailure,
    errors: StagedSolidState['errors'], errorMessage: string | null): void {
    publish(job, Object.freeze({ ...job.state, status: 'failed', result: null, accounting: null, errors, errorMessage, failure }));
  }

  /** 段階計算の 1 回分。世代は順番の持ち主が振り、所有が変われば段の間で打ち切る。 */
  async function computeStaged(job: StagedJob, document: PartDocument): Promise<{
    readonly generation: number;
    readonly result: PartRecomputeResult;
  }> {
    const current = nextGeneration();
    const result = await recompute(document, {
      generation: current,
      localMesh: { ...LOCAL_DISPLAY_MESH_BUDGET },
      shouldCancel: () => !ownedBy(job) || queued !== null,
      importedShapes: job.ownership.importedShapes,
      importedMeshes: job.ownership.importedMeshes,
    });
    return { generation: current, result };
  }

  async function runStaged(job: StagedJob): Promise<void> {
    running = true;
    job.waiting = false;
    try {
      const { placement, displayed, finalFeatureId } = job.state;
      let wholeGeneration: number | null = null;
      if (displayed !== placement.document) {
        // つまみが途中: 画面に出す範囲が成功しても、後ろの段が壊れていれば確定しない。
        // 履歴全体は確かめるだけで採用しないので、参照の範囲はすぐ手放す。
        const whole = await computeStaged(job, placement.document);
        releaseScope(whole.result);
        if (!ownedBy(job)) return;
        const failure = stagedFailure(placement.document, whole.generation, whole.result, null);
        if (failure !== null) {
          publishFailure(job, failure, whole.result.errors, null);
          return;
        }
        wholeGeneration = whole.generation;
      }
      const shown = await computeStaged(job, displayed);
      if (!ownedBy(job)) {
        releaseScope(shown.result);
        return;
      }
      const failure = stagedFailure(displayed, shown.generation, shown.result, finalFeatureId);
      if (failure !== null) {
        releaseScope(shown.result);
        publishFailure(job, failure, shown.result.errors, null);
        return;
      }
      const receipt = meshReceiptOf(displayed, shown.result);
      if (receipt === null) {
        // stagedFailure already required this receipt; a disappearing one is not admitted.
        releaseScope(shown.result);
        publishFailure(job, 'accounting', [], null);
        return;
      }
      job.held = shown.result;
      // The preview pairs this result's own receipt with the document that confirmation stores.
      const accounting = accountingSnapshot(placement.document, placement.timelineIndex,
        job.ownership.activeDocumentId, shown.result, receipt);
      publish(job, Object.freeze({ ...job.state, status: 'ready', result: shown.result, accounting, wholeGeneration }));
    } catch (error: unknown) {
      if (ownedBy(job)) publishFailure(job, 'thrown', [], error instanceof Error ? error.message : String(error));
    } finally {
      running = false;
      const next = queued;
      queued = null;
      if (!detached) {
        if (next !== null && activePartDocument(useAppStore.getState()) !== null) start(next);
        else resumeStaged();
      }
    }
  }

  /** 順番が空いたら、待っている段階計算を走らせるか、頼まれている確定を採用する。 */
  function resumeStaged(): void {
    const job = staged;
    if (running || job === null || !ownedBy(job)) return;
    if (job.waiting) void runStaged(job);
    else if (job.state.status === 'ready' && job.state.confirmRequested) adopt(job);
  }

  /** 成功した段階計算を 1 回の set で採用する。採用の通知の再計算だけを外す。 */
  function adopt(job: StagedJob): boolean {
    const result = job.state.result;
    if (running || result === null || !ownedBy(job)) return false;
    const ticket: StagedAdoptionTicket = Object.freeze({ stager, staged: job.state });
    adopting = { job, document: job.state.placement.document, timelineIndex: job.state.placement.timelineIndex,
      generation: result.generation };
    let adopted: boolean;
    try {
      adopted = useAppStore.getState().adoptStagedSolid(ticket);
    } finally {
      adopting = null;
    }
    if (!adopted) {
      dropStaged();
      if (useAppStore.getState().stagedSolid === job.state) useAppStore.getState().publishStagedSolid(null);
      return false;
    }
    // 結果と参照の範囲はストアへ渡した(控えに採るか閉じるかはストアが決めた)。
    job.held = null;
    if (staged === job) {
      staged = null;
      stagedEpoch += 1;
    }
    job.onAdopted?.(job.state);
    return true;
  }

  const stager: PartStager = {
    stage: (request) => {
      const state = useAppStore.getState();
      if (detached || state.partStager !== stager || activePartDocument(state) === null
        || request.base !== state.document) return null;
      const existing = staged;
      // 同じ入力なら計算し直さない。ただし一時的な失敗(計算部の異常・打ち切り・受領の欠け)は、
      // 入力を変えずにもう一度頼んだら計算し直す(形そのものの失敗は同じ理由を返す)。
      if (existing !== null && ownedBy(existing) && existing.state.fingerprint === request.fingerprint
        && existing.state.finalFeatureId === request.finalFeatureId
        && !(existing.state.status === 'failed' && isTransientFailure(existing.state.failure))) return existing.state;
      dropStaged();
      inputRevision += 1;
      const ownership = captureStagedSolidOwnership(state, stager, inputRevision);
      if (ownership === null) return null;
      // 通常の編集と同じ整え(つまみへの差し込み・掃除・発行の控え)を通した、保存される文書。
      const placed = prepareDocumentEdit(state, request.candidate, false);
      const document = documentWithIssuanceLedger(state, placed.document, false);
      const placement = document === placed.document ? placed : { ...placed, document };
      const job: StagedJob = { epoch: stagedEpoch, ownership, waiting: true, held: null, onAdopted: null,
        state: Object.freeze({ ownership, fingerprint: request.fingerprint, finalFeatureId: request.finalFeatureId,
          placement, displayed: documentUpTo(placement.document, placement.timelineIndex), status: 'pending',
          result: null, accounting: null, wholeGeneration: null, errors: [], errorMessage: null, failure: null,
          confirmRequested: false }) };
      staged = job;
      useAppStore.getState().publishStagedSolid(job.state);
      resumeStaged();
      return job.state;
    },
    confirm: (revision, onAdopted) => {
      const job = staged;
      if (job === null || !ownedBy(job) || job.ownership.inputRevision !== revision
        || job.state.status === 'failed') return 'refused';
      // 2 回目の確定は同じ採用を待つだけ(取り消しの段を 2 つ積まない)。
      if (job.state.confirmRequested) return 'pending';
      job.onAdopted = onAdopted ?? null;
      publish(job, Object.freeze({ ...job.state, confirmRequested: true }));
      if (job.state.status === 'ready' && !running) return adopt(job) ? 'adopted' : 'refused';
      return 'pending';
    },
    cancel: () => {
      dropStaged();
      // 手放した後に残っている控え(古くなった確定の頼みを含む)も消す。次の入力の窓へ持ち越さない。
      if (useAppStore.getState().stagedSolid !== null) useAppStore.getState().publishStagedSolid(null);
    },
    owns: (candidate) => !detached && staged !== null && staged.state === candidate && staged.epoch === stagedEpoch,
  };

  /**
   * 計算に渡す文書。**保存されるのは常に `document`(全体)で、ここで切ったものは
   * 画面に出す形を決めるためだけに使う**(FR-506、タスク19 の落とし穴)。
   * つまみが末尾(`null`)のときは `documentUpTo` が同じ文書をそのまま返す(`===`)ので、
   * これまでの経路と 1 ミリ秒も変わらない(NFR-PF-3)。
   */
  function shownDocument(state: AppState): PartDocument {
    return documentUpTo(state.document, state.timelineIndex);
  }

  useAppStore.getState().setPartStager(stager);
  if (activePartDocument(useAppStore.getState()) !== null) request(shownDocument(useAppStore.getState()));

  const unsubscribe = useAppStore.subscribe((next, previous) => {
    // 採用の札: 採用したその文書・つまみ・世代の通知だけは、もう計算済みなので投げない。
    // 札は採用の最中(同期の 1 回の set)しか立たず、ふつうの編集の通知は外さない。
    const adoption = adopting;
    if (adoption !== null && next.document === adoption.document && next.timelineIndex === adoption.timelineIndex
      && next.requestedGeneration === adoption.generation) {
      return;
    }
    // 編集・Undo/Redo・文書の切替・つまみ・選択・添付・中止で所有が変われば、段階計算を手放す
    // (計算中なら段の間で打ち切られ、届いた結果は採用しない)。
    if (staged !== null && staged !== adoption?.job && !isStagedSolidOwnershipCurrent(next, staged.ownership)) {
      dropStaged();
    }
    if (activePartDocument(next) === null) {
      queued = null;
      return;
    }
    // つまみを動かしたときも計算し直す(FR-507)。切った文書のフィーチャーは複製されない
    // ので段の鍵は変わらず、前半の段は全部キャッシュに当たる(§2.7)。
    // **外観の割り当てだけが変わったときは投げない**(FR-1106〜1110、要件§4.12、
    // P5 §2.3.2)。色を変えるたびに 100 フィーチャーの解決と Worker の往復が起きるのを
    // 避けるための、P5 で最も効く 1 行。形の変化の判定は `model` の `affectsShape` が正本。
    if (
      activePartDocument(previous) === null || affectsShape(previous.document, next.document) ||
      next.timelineIndex !== previous.timelineIndex || next.importedMeshes !== previous.importedMeshes
    ) {
      request(shownDocument(next));
    }
  });

  return () => {
    detached = true;
    queued = null;
    unsubscribe();
    dropStaged();
    // 自分が差し出した手立てが今も立っているときだけ下ろす(段階計算の控えも一緒に消える)。
    if (useAppStore.getState().partStager === stager) useAppStore.getState().setPartStager(null);
  };
}

/**
 * 入力を変えずに頼み直せば結果が変わりうる失敗(計算部が投げた・壊れた・打ち切られた・受領が欠けた)。
 * 形そのものの失敗(failed・missingBody・invalidBody)は同じ入力では同じ答えになるので含めない。
 */
function isTransientFailure(failure: StagedSolidFailure | null): boolean {
  return failure === 'thrown' || failure === 'workerBroken' || failure === 'incomplete' || failure === 'accounting';
}

/**
 * 段階計算の結果を採用できない理由。成功は**実際の形**で決める。
 *
 * - 世代が依頼と一致し、打ち切られておらず、失敗が 0 件であること。
 * - 表示の量の受領が、この結果・この文書のもので範囲内であり、最終の受領も揃っていること
 *   (画面に入れる判定が後で必ず要求する)。
 * - 計算した範囲(画面に出す範囲・履歴全体のどちらも)のボディは、全てが有効で、ボディの id が
 *   重ならず、計算した文書の立体のフィーチャーであること。`recomputePart` のボディは
 *   解決した立体の段(`resolvePart` の段は文書の立体フィーチャーから作る)の id を
 *   そのまま持つ(`solidConversions.ts` の `featureId: mesh.id`)ので、どれかが外れたら
 *   その結果は採用しない。
 * - 画面に出す範囲(`finalFeatureId` を渡す)では、さらに作った最後の立体のボディがあること。
 *   履歴全体(`finalFeatureId` が null)では、後ろの段が作った立体を使うこともあるので
 *   その立体の有無は問わない。
 *
 * 交わらない結合や計算部の失敗は `errors` に残るので 'failed' になる。ボディの有無だけで
 * 計算部の成功とはみなさない。体積の増減で成否を決める規則はここでは作らない。
 */
function stagedFailure(
  document: PartDocument,
  generation: number,
  result: PartRecomputeResult,
  finalFeatureId: string | null,
): StagedSolidFailure | null {
  if (result.cancelled || result.generation !== generation) return 'incomplete';
  if (result.errors.some((error) => error.message === KERNEL_BROKEN_MESSAGE)) return 'workerBroken';
  if (result.errors.length !== 0) return 'failed';
  const receipt = meshReceiptOf(document, result);
  if (receipt === null || receipt.final === undefined) return 'accounting';
  const solidIds = new Set(document.solids.map((solid) => solid.id));
  const seen = new Set<string>();
  for (const body of result.bodies) {
    if (!body.isValid || seen.has(body.featureId) || !solidIds.has(body.featureId)) return 'invalidBody';
    seen.add(body.featureId);
  }
  if (finalFeatureId !== null && !seen.has(finalFeatureId)) return 'missingBody';
  return null;
}
