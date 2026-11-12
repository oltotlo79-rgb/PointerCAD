import { useAppStore } from '../store/useAppStore.js';
import { activeAssemblyDocument } from '../store/documentKind.js';
import { currentAssemblyMeshAdmission, currentAssemblyMeshPublication, type AssemblyMeshOwnership } from './assemblyMeshAdmission.js';
import type { AssemblyMateInputObservation } from './attachAssemblyInteraction.js';
import type { ViewportScene } from './createViewportScene.js';
import { assemblyBundleOf } from './viewportCanvasStoreViews.js';

/*
 * ViewportCanvas の組立の入力の準備と観測(FR-605・FR-106)。表示の受領が失効していれば
 * 同じ公開のまま所有を 1 回だけ取り直し(使い切り)、取り直した形が今の文書と一致した時だけ表示を作り直す。
 * 押下(prepareMateInput)と hover(prepareHoverInput)は同じ取り直しを共有する。合致入力の観測は判定・保留・
 * 内部 id だけを最後の 2 件まで持ち、座標・文書・例外の文言は残さない。
 */

/** 合致入力の観測の記録。部品の拾いでは判定・保留・内部idと、押下の時点の準備の判定(名前だけ)を持つ。 */
type MateInputRecord = Readonly<Partial<AssemblyMateInputObservation>> & {
  readonly readiness?: Readonly<{ ready: string; refresh: string | null }>;
};

/**
 * 押下の時点の準備の判定(拾いの null の理由の観測)。prepareMateInput が置き、同じ押下の最初の観測だけが入力へ結ぶ。
 * refresh は取り直しの結果の入れ物で、決着すると outcome に名前が入る。
 */
interface PreparedMateReadiness {
  readonly ready: string;
  readonly refresh: { readonly outcome: string | null } | null;
}

/**
 * hover の拾いが失効で表示を片付けた時の口(attachAssemblyInteraction の prepareHoverInput)。押下の prepareMateInput と
 * 同じ取り直し(pendingAssemblyRefresh・使い切りの refresh-spent)を共有し、押下の観測(preparedInput)へは結ばない。
 * 所有が今のままなら今の形で表示を作り直して true、取り直し中ならその結果、取り直せない時は false
 * (断った理由は assemblyReady が assemblyReadyRefusal に残す)。
 */
function hoverRefreshEntrance(ready: () => boolean, pending: WeakMap<AssemblyMeshOwnership, Promise<boolean>>,
  scene: Pick<ViewportScene, 'setAssembly'>, requestDraw: () => void): () => Promise<boolean> {
  return () => {
    if (ready()) {
      scene.setAssembly(assemblyBundleOf(useAppStore.getState()));
      requestDraw();
      return Promise.resolve(true);
    }
    const owner = useAppStore.getState().assemblyView?.meshOwnership;
    return (owner === undefined ? undefined : pending.get(owner)) ?? Promise.resolve(false);
  };
}

/** 準備の判定が借りるもの。描画の予約は描画の持ち主ができてから呼ばれる。 */
interface ViewportAssemblyInputDependencies {
  readonly scene: Pick<ViewportScene, 'setAssembly'>;
  readonly isAlive: () => boolean;
  readonly requestDraw: () => void;
}

export type ViewportAssemblyInput = ReturnType<typeof createViewportAssemblyInput>;

export function createViewportAssemblyInput(deps: ViewportAssemblyInputDependencies) {
  const { scene } = deps;
  const pendingAssemblyRefresh = new WeakMap<AssemblyMeshOwnership, Promise<boolean>>();
  const refusedAssemblyRefresh = new WeakSet<AssemblyMeshOwnership>();
  // 拾いの null の理由の観測: 最後に表示の準備を断った理由と、最後の所有の取り直しの結果(名前だけ)。
  let assemblyReadyRefusal: string | null = null;
  let assemblyRefreshOutcome: string | null = null;
  // 入力ごとの判定: assemblyReady の1回の呼出しの断りと、その取り直しの結果を、同じ押下の最初の観測へ結ぶ。
  let readyCallRefusal: string | null = null;
  const refuseReady = (reason: string): false => { assemblyReadyRefusal = reason; readyCallRefusal = reason; return false; };
  const refreshOutcomeCells = new WeakMap<Promise<boolean>, { outcome: string | null }>();
  const mateInputs: MateInputRecord[] = [];
  // 押下の時点の準備の判定。prepareMateInput が置き、同じ押下の最初の観測だけが入力へ結ぶ。
  // 明示の型を変数と WeakMap で共有する(初期値 null の直後の typeof は null へ絞られ、NonNullable が never になるため)。
  let preparedInput: PreparedMateReadiness | null = null;
  const inputReadiness = new WeakMap<AssemblyMateInputObservation, PreparedMateReadiness>();
  let inputDocumentGeneration = 0;
  const inputSnapshots = new WeakMap<AssemblyMateInputObservation, {
    readonly epoch: number; readonly snapshot: MateInputRecord;
  }>();

  /** 表示を今の受領で出してよいか。断る時は理由を残し、取り直せる所有なら 1 回だけ取り直しを始める。 */
  function assemblyReady(): boolean {
    readyCallRefusal = null;
    const state = useAppStore.getState(), owner = state.assemblyView?.meshOwnership;
    if (activeAssemblyDocument(state) === null || owner === undefined) return true;
    const bundle = assemblyBundleOf(state);
    try {
      if (currentAssemblyMeshAdmission({ bundle, ownership: owner, state }, state)) return true;
      if (!currentAssemblyMeshPublication(owner, state)) return refuseReady('publication-stale');
      if (owner.receipt.status !== 'known') return refuseReady('receipt-unknown');
      if (owner.backingInspection.status !== 'known') return refuseReady('backing-unknown');
      if (owner.refreshOwnership === undefined) return refuseReady('no-refresh');
      if (refusedAssemblyRefresh.has(owner)) return refuseReady('refresh-spent');
      if (pendingAssemblyRefresh.has(owner)) return refuseReady('refresh-pending');
    } catch { refusedAssemblyRefresh.add(owner); return refuseReady('threw'); }
    const refresh = owner.refreshOwnership;
    if (refresh === undefined) return refuseReady('no-refresh');
    const cell: { outcome: string | null } = { outcome: null };
    const settleRefresh = (outcome: string): void => { assemblyRefreshOutcome = outcome; cell.outcome = outcome; };
    const pending = Promise.resolve().then(() => {
      if (!deps.isAlive() || !currentAssemblyMeshPublication(owner, useAppStore.getState())) return null;
      return refresh(owner);
    }).then(fresh => {
      if (!deps.isAlive() || fresh === null || fresh === owner) {
        settleRefresh(!deps.isAlive() ? 'dead' : fresh === null ? 'none' : 'same-owner');
        return false;
      }
      const current = useAppStore.getState();
      if (current.assemblyView?.meshOwnership !== fresh || fresh.document !== owner.document
        || fresh.library !== owner.library || fresh.activeDocumentId !== owner.activeDocumentId
        || fresh.documentVersion !== owner.documentVersion || fresh.generation !== owner.generation
        || fresh.cancelRequestCount !== owner.cancelRequestCount || fresh.timelineIndex !== owner.timelineIndex
        || fresh.outcome !== owner.outcome || fresh.bodies !== owner.bodies || fresh.sources !== owner.sources
        || !currentAssemblyMeshPublication(fresh, current)) { settleRefresh('fresh-mismatch'); return false; }
      const freshBundle = assemblyBundleOf(current);
      if (!currentAssemblyMeshAdmission({ bundle: freshBundle, ownership: fresh, state: current }, current)) {
        settleRefresh('fresh-admission'); return false;
      }
      scene.setAssembly(freshBundle);
      deps.requestDraw();
      settleRefresh('applied');
      return true;
    }).catch(() => { settleRefresh('threw'); return false; }) // Fail closed; never reoffer the rejected owner.
      .finally(() => {
        refusedAssemblyRefresh.add(owner);
        if (pendingAssemblyRefresh.get(owner) === pending) pendingAssemblyRefresh.delete(owner);
      });
    pendingAssemblyRefresh.set(owner, pending);
    refreshOutcomeCells.set(pending, cell);
    return refuseReady('refresh-started');
  }

  /** 押下の時点の判定を控え、表示の準備が整うまでの待ち(準備済みなら null)を返す。 */
  function prepareMateInput(): Promise<boolean> | null {
    const owner = useAppStore.getState().assemblyView?.meshOwnership;
    const ready = assemblyReady();
    const waiting = ready ? null
      : (owner === undefined ? undefined : pendingAssemblyRefresh.get(owner)) ?? Promise.resolve(false);
    const prepared: PreparedMateReadiness = { ready: ready ? 'ready' : readyCallRefusal ?? 'unknown',
      refresh: waiting === null ? null : refreshOutcomeCells.get(waiting) ?? { outcome: 'not-offered' } };
    preparedInput = prepared;
    // 結ばれずに残った判定を、後の別の押下へ渡さない。
    void Promise.resolve().then(() => { if (preparedInput === prepared) preparedInput = null; });
    return waiting;
  }

  const observeMateInput = (input: AssemblyMateInputObservation): void => {
    if (!deps.isAlive()) return;
    const previous = inputSnapshots.get(input);
    if (previous !== undefined && previous.epoch !== inputDocumentGeneration) return;
    if (previous === undefined && preparedInput !== null) {
      inputReadiness.set(input, preparedInput); preparedInput = null;
    }
    const readiness = inputReadiness.get(input);
    // 部品の記録は判定・保留・内部idだけ。座標、文書、例外の文言は保持しない。
    const snapshot: MateInputRecord = input.componentPick !== undefined
      ? Object.freeze({ inputGate: input.inputGate, deferred: input.deferred, deferredReason: input.deferredReason,
        waiting: input.waiting, componentPick: Object.freeze({ ...input.componentPick }),
        readiness: readiness === undefined ? undefined : Object.freeze({ ready: readiness.ready,
          refresh: readiness.refresh === null ? null : readiness.refresh.outcome ?? 'unsettled' }) })
      : Object.freeze({ ...input, clientPoint: Object.freeze([...input.clientPoint] as const),
        ...(input.canvasPoint === undefined ? {} : { canvasPoint: Object.freeze([...input.canvasPoint] as const) }),
        ...(input.scene === undefined ? {} : { scene: Object.freeze({ ...input.scene }) }),
        ...(input.hit === undefined || input.hit === null ? {} : { hit: Object.freeze({ ...input.hit }) }) });
    if (previous !== undefined) {
      const index = mateInputs.indexOf(previous.snapshot);
      if (index < 0) return;
      mateInputs[index] = snapshot;
    } else {
      mateInputs.push(snapshot);
      if (mateInputs.length > 2) mateInputs.shift();
    }
    inputSnapshots.set(input, { epoch: inputDocumentGeneration, snapshot });
  };

  return {
    assemblyReady,
    prepareMateInput,
    observeMateInput,
    prepareHoverInput: hoverRefreshEntrance(assemblyReady, pendingAssemblyRefresh, scene, deps.requestDraw),
    /** 取り直し中の所有の待ち。保存のサムネイルが同じ公開を待つ。 */
    pendingRefresh: (owner: AssemblyMeshOwnership): Promise<boolean> | undefined => pendingAssemblyRefresh.get(owner),
    /** 観測の口が読む、最後の 2 件の記録と、最後の断りと取り直しの結果(名前だけ)。 */
    observationSnapshot: () => ({ mateInputs: [...mateInputs], assemblyReadyRefusal, assemblyRefreshOutcome }),
    clearMateInputs: (): void => { mateInputs.length = 0; },
    /** 文書が替わった時は、保留中の古い入力の記録を復活させない。 */
    startDocumentInputs: (): void => {
      inputDocumentGeneration += 1;
      mateInputs.length = 0;
    },
  };
}
