/**
 * 押し出しの段階計算(確定前の計算と、成功したその結果の採用)の回帰テスト(EX-14)。
 * 計算は遅れて返す偽物で、届く順番と所有の変化を検査が決める。待ちは決まった回数の空回しでなく、
 * 計算の順番の持ち主が次の依頼を出したこと・ストアが変わったことを条件にする。
 * 参照の範囲は公開の `recomputePart` が作る実物を使う(型の抜け道や作り物の受領は使わない)。
 * 実カーネルの形の検査は別(Root が実 OCCT で行う)。
 */
import { expressionValueFromNumber } from '@pointercad/expression';
import {
  appendSolid,
  createEmptyPartDocument,
  KERNEL_BROKEN_MESSAGE,
  recomputePart,
  type KernelBridge,
  type PartDocument,
  type PartRecomputeOptions,
  type PartRecomputeResult,
} from '@pointercad/model';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createNumericInput, reduceNumericInput, type NumericInputState } from '../sketch/numericInput.js';
import { attachPartRecompute, type PartRecomputer } from '../store/attachKernel.js';
import { currentStagedSolid } from '../store/recomputeSlice.js';
import {
  bodyFor,
  documentWithPoint,
  extrudeFeature,
  partWithPoint,
  partWithThreeSolids,
  resetTestStore,
  resultFor,
} from '../store/testing/createTestStore.js';
import { useAppStore } from '../store/useAppStore.js';
import {
  cancelExtrusion,
  confirmExtrusion,
  type ExtrudeStageCandidate,
  stageExtrusion,
  stagedExtrusionFor,
  stagedExtrusionMessageKey,
} from './extrudePreview.js';

interface ControlledCall {
  readonly document: PartDocument;
  readonly options: PartRecomputeOptions;
  readonly settle: (result: PartRecomputeResult) => void;
  readonly fail: (error: Error) => void;
}

/** 呼ばれた順に覚え、検査が決めた時点で成功・失敗を返す計算。 */
function controlledRecompute(): { readonly calls: ControlledCall[]; readonly recompute: PartRecomputer } {
  const calls: ControlledCall[] = [];
  const recompute: PartRecomputer = (document, options) => new Promise<PartRecomputeResult>((resolve, reject) => {
    calls.push({ document, options, settle: resolve, fail: reject });
  });
  return { calls, recompute };
}

/** 条件が成り立つまで待つ(決まった回数の空回しはしない)。 */
async function until(condition: () => boolean): Promise<void> {
  await vi.waitFor(() => { if (!condition()) throw new Error('Condition not reached yet'); });
}

const reading = { status: 'known' as const, limitBytes: 1000, cacheActiveBytes: 130,
  cacheRetiredBytes: 110, cacheProtectedBytes: 240, retainedReplyBytes: 300, requestPeakReservedBytes: 1000 };
const finalReading = { status: 'known' as const, limitBytes: 1000, cacheActiveBytes: 130, cacheRetiredBytes: 0,
  cacheProtectedBytes: 130, displayBackingBytes: 60, replyBackingBytes: 60, retainedBackingBytes: 190,
  replyCloneReservedBytes: 60 };

function generationOf(call: ControlledCall): number {
  const generation = call.options.generation;
  if (generation === undefined) throw new Error('Every scheduled request carries its generation');
  return generation;
}

/** その依頼の世代・文書に対する、表示の量の受領(最終の受領つき)を持った成功の結果。 */
function success(call: ControlledCall, featureIds: readonly string[]): PartRecomputeResult {
  const generation = generationOf(call);
  return { ...resultFor(call.document), generation, bodies: featureIds.map(bodyFor),
    meshJsAccounting: { documentId: call.document.id, partId: call.document.id, generation,
      reading: { ...reading }, final: { ...finalReading } } };
}

function candidateOf(base: PartDocument, inputKey: string, distance = 10, featureId = 'extrude-new'): ExtrudeStageCandidate {
  return { base, document: appendSolid(base, { ...extrudeFeature(featureId), distance: expressionValueFromNumber(distance) }),
    featureId, inputKey };
}

/** 段階計算は開いている入力の窓のもの。検査でも実際の `openNumericInput` で押し出しの窓を開く。 */
function openExtrudeInput(): void {
  useAppStore.getState().openNumericInput(createNumericInput('extrude', 'extrudeDistance'), [10, 10]);
}

/** 開いている入力の窓を、実際の `updateNumericInput` で書き換える。 */
function updateInput(change: (state: NumericInputState) => NumericInputState): void {
  const input = useAppStore.getState().numericInput;
  if (input === null) throw new Error('The extrusion input must be open');
  useAppStore.getState().updateNumericInput(change(input));
}

/** 文書を 1 回編集して(取り消しの段を 1 つ作って)から計算の順番の持ち主をつなぎ、最初の計算を終える。 */
async function attachWith(document: PartDocument, firstBodies: readonly string[]) {
  useAppStore.getState().applyDocument(document);
  const control = controlledRecompute();
  const detach = attachPartRecompute(control.recompute);
  const first = control.calls[0];
  first.settle(success(first, firstBodies));
  await until(() => useAppStore.getState().completedGeneration === generationOf(first));
  openExtrudeInput();
  return { ...control, detach };
}

/**
 * 公開の `recomputePart` が作る実物の参照の範囲。発行の契約だけを持つ固定の計算部
 * (`createViewportScene.test.ts` の controlled provider と同じ作り)で、受領は発行しない。
 */
async function issuedScope() {
  function unused(): never { throw new Error('Unused geometry operation in the scope fixture'); }
  const bridge: KernelBridge = {
    tessellateSketchFaces: unused, offsetSketchCurves: unused, projectSketchCurves: unused,
    sectionSketchCurves: unused, measure: unused, exportShapes: unused, importShape: unused,
    inspectPrintability: unused, dispose: () => undefined,
    recomputeSolids: () => Promise.resolve({ bodies: [], cacheHits: 0, cancelled: false, failures: [] }),
    meshLedgerOwner: () => null,
    releaseReferenceMeshLease: () => Promise.resolve({ released: true }),
    captureCurrentMeshLedger: (input) => Promise.resolve({ status: 'unknown', observationId: input.observationId,
      reason: 'scope-fixture' }),
    currentMeshLedgerReceipt: () => false,
  };
  const result = await recomputePart(createEmptyPartDocument(), bridge, { generation: 1, partId: 'staged-scope-fixture' });
  const scope = result.referenceMeshScope;
  if (scope === undefined || !scope.current) throw new Error('A current model-created scope is required');
  return { scope, bridge };
}

beforeEach(() => {
  resetTestStore();
  useAppStore.setState({ requestedGeneration: 0, completedGeneration: 0, lastOutcome: 'idle',
    meshJsAccounting: null, partStager: null, stagedSolid: null });
});

describe('段階計算の採用(成功・1回のUndo・自動の再計算を重ねない)', () => {
  it('成功した文書と結果を確定前は反映せず、確定で1回のsetと1段のUndoで採用する', async () => {
    const { calls, detach } = await attachWith(appendSolid(partWithPoint(), extrudeFeature('first')), ['first']);
    try {
      const before = useAppStore.getState();
      expect(before.lastOutcome).toBe('success');
      const pastLength = before.undoStack.past.length;
      const candidate = candidateOf(before.document, 'distance=10');
      const staged = stageExtrusion(candidate);
      if (staged === null) throw new Error('Staging must start for the current document');
      expect(staged.status).toBe('pending');
      expect(staged.displayed).toBe(staged.placement.document);
      expect(stagedExtrusionMessageKey(useAppStore.getState())).toBe('numericInput.extrudePreviewComputing');
      expect(calls).toHaveLength(2);
      expect(calls[1].document).toBe(staged.placement.document);
      expect(generationOf(calls[1])).toBe(2);
      expect(calls[1].options.localMesh).toEqual({ maximumFloat32ErrorMm: 0.005, maximumLiveMeshBytes: 512 * 1024 * 1024 });
      // 段階計算は確定した文書の依頼・完了の世代の対を書き換えない。
      expect(useAppStore.getState().requestedGeneration).toBe(1);
      expect(useAppStore.getState().completedGeneration).toBe(1);
      calls[1].settle(success(calls[1], ['first', 'extrude-new']));
      await until(() => stagedExtrusionFor(useAppStore.getState(), 'distance=10')?.status === 'ready');
      const ready = stagedExtrusionFor(useAppStore.getState(), 'distance=10');
      expect(ready?.result?.generation).toBe(2);
      // 仮の形は自分の結果の受領を持つ(確定済みの受領を写さない)。
      expect(ready?.accounting?.receipt.generation).toBe(2);
      expect(ready?.accounting?.bodies).toBe(ready?.result?.bodies);
      expect(ready?.accounting?.document).toBe(staged.placement.document);
      expect(stagedExtrusionMessageKey(useAppStore.getState())).toBe('numericInput.extrudePreviewReady');
      // 確定までは文書・形・取り消しの段・世代は元のまま。
      const waiting = useAppStore.getState();
      expect(waiting.document).toBe(before.document);
      expect(waiting.undoStack).toBe(before.undoStack);
      expect(waiting.bodies).toBe(before.bodies);
      expect(waiting.requestedGeneration).toBe(1);
      expect(waiting.meshJsAccounting).toBe(before.meshJsAccounting);
      const adopted: string[] = [];
      const listened: number[] = [];
      const unsubscribe = useAppStore.subscribe((next, previous) => {
        if (next.document !== previous.document) listened.push(next.requestedGeneration);
      });
      expect(confirmExtrusion(candidate, (state) => { adopted.push(state.finalFeatureId); })).toBe('adopted');
      unsubscribe();
      const after = useAppStore.getState();
      // 文書の差し替えと形・世代の反映は同じ 1 回の通知で起きる(途中の状態を見せない)。
      expect(listened).toEqual([2]);
      expect(after.document).toBe(staged.placement.document);
      expect(after.undoStack.past).toHaveLength(pastLength + 1);
      expect(after.undoStack.past[pastLength]).toBe(before.document);
      expect(after.undoStack.present).toBe(after.document);
      expect(after.bodies).toBe(ready?.result?.bodies);
      expect(after.requestedGeneration).toBe(2);
      expect(after.completedGeneration).toBe(2);
      expect(after.lastOutcome).toBe('success');
      expect(after.isComputing).toBe(false);
      expect(after.meshJsAccounting?.document).toBe(after.document);
      expect(after.meshJsAccounting?.receipt.generation).toBe(2);
      expect(after.stagedSolid).toBeNull();
      expect(after.activeTool).toBe('select');
      expect(after.selection).toEqual(['extrude-new']);
      expect(adopted).toEqual(['extrude-new']);
      // 採用した文書はもう計算済み。採用は自動の再計算を起こさない。ふつうの編集(取り消し)は計算し直す。
      after.undo();
      expect(useAppStore.getState().document).toBe(before.document);
      expect(calls).toHaveLength(3);
      expect(calls[2].document).toBe(before.document);
    } finally { detach(); }
  });

  it('計算中の確定は成功し次第1回だけ採用し、重ねた確定で取り消しの段を増やさない', async () => {
    const { calls, detach } = await attachWith(appendSolid(partWithPoint(), extrudeFeature('first')), ['first']);
    try {
      const before = useAppStore.getState();
      const pastLength = before.undoStack.past.length;
      const candidate = candidateOf(before.document, 'k');
      let adoptedCount = 0;
      expect(confirmExtrusion(candidate, () => { adoptedCount += 1; })).toBe('pending');
      expect(confirmExtrusion(candidate, () => { adoptedCount += 1; })).toBe('pending');
      expect(stagedExtrusionMessageKey(useAppStore.getState())).toBe('numericInput.extrudeConfirming');
      expect(calls).toHaveLength(2);
      expect(useAppStore.getState().document).toBe(before.document);
      calls[1].settle(success(calls[1], ['first', 'extrude-new']));
      await until(() => adoptedCount > 0);
      const after = useAppStore.getState();
      expect(after.document.solids.map((solid) => solid.id)).toEqual(['first', 'extrude-new']);
      expect(after.undoStack.past).toHaveLength(pastLength + 1);
      expect(adoptedCount).toBe(1);
      // 採用の後に同じ候補で確定しても、元の文書から作った候補なので断る(2 段目を積まない)。
      expect(confirmExtrusion(candidate)).toBe('refused');
      expect(useAppStore.getState().undoStack.past).toHaveLength(pastLength + 1);
      expect(calls).toHaveLength(2);
    } finally { detach(); }
  });

  it('結合・切り取りでは最後の段のボディで成否を決める(道具の立体が消費されても成功)', async () => {
    const { calls, detach } = await attachWith(appendSolid(partWithPoint(), extrudeFeature('first')), ['first']);
    try {
      const base = useAppStore.getState().document;
      const candidate: ExtrudeStageCandidate = { base, featureId: 'cut-1', inputKey: 'cut',
        document: appendSolid(appendSolid(base, extrudeFeature('tool')), extrudeFeature('cut-1')) };
      let adopted = false;
      expect(confirmExtrusion(candidate, () => { adopted = true; })).toBe('pending');
      // 体積の増減で成否を決める規則は作らない。失敗の無い有効な最後のボディなら成功。
      calls[1].settle(success(calls[1], ['cut-1']));
      await until(() => adopted);
      const after = useAppStore.getState();
      expect(after.document.solids.map((solid) => solid.id)).toEqual(['first', 'tool', 'cut-1']);
      expect(after.bodies.map((body) => body.featureId)).toEqual(['cut-1']);
      expect(after.selection).toEqual(['cut-1']);
    } finally { detach(); }
  });
});

describe('計算の失敗は文書・形・取り消しの段に触れない', () => {
  it.each([
    { kind: 'failed', failure: 'failed', settle: (call: ControlledCall) => call.settle({ ...success(call, ['first']),
      errors: [{ featureId: 'extrude-new', code: 'kernelFailed', message: '立体を作れませんでした' }] }) },
    { kind: 'workerBroken', failure: 'workerBroken', settle: (call: ControlledCall) => call.settle({ ...success(call, ['first']),
      errors: [{ featureId: 'extrude-new', code: 'kernelFailed', message: KERNEL_BROKEN_MESSAGE }] }) },
    { kind: 'missing final body', failure: 'missingBody', settle: (call: ControlledCall) => call.settle(success(call, ['first'])) },
    { kind: 'invalid final body', failure: 'invalidBody', settle: (call: ControlledCall) => {
      const result = success(call, ['first', 'extrude-new']);
      call.settle({ ...result, bodies: result.bodies.map((body) => body.featureId === 'extrude-new' ? { ...body, isValid: false } : body) });
    } },
    { kind: 'another invalid body', failure: 'invalidBody', settle: (call: ControlledCall) => {
      const result = success(call, ['first', 'extrude-new']);
      call.settle({ ...result, bodies: result.bodies.map((body) => body.featureId === 'first' ? { ...body, isValid: false } : body) });
    } },
    { kind: 'duplicate body id', failure: 'invalidBody', settle: (call: ControlledCall) =>
      call.settle(success(call, ['first', 'extrude-new', 'extrude-new'])) },
    { kind: 'body outside the computed document', failure: 'invalidBody', settle: (call: ControlledCall) =>
      call.settle(success(call, ['first', 'extrude-new', 'unrelated'])) },
    { kind: 'missing final receipt', failure: 'accounting', settle: (call: ControlledCall) => {
      const result = success(call, ['first', 'extrude-new']);
      const receipt = result.meshJsAccounting;
      if (receipt === undefined) throw new Error('fixture receipt');
      call.settle({ ...result, meshJsAccounting: { documentId: receipt.documentId, partId: receipt.partId,
        generation: receipt.generation, reading: receipt.reading } });
    } },
    { kind: 'generation mismatch', failure: 'incomplete', settle: (call: ControlledCall) =>
      call.settle({ ...success(call, ['first', 'extrude-new']), generation: generationOf(call) + 100 }) },
    { kind: 'thrown', failure: 'thrown', settle: (call: ControlledCall) => call.fail(new Error('計算部が止まりました')) },
  ] as const)('$kind', async (scenario) => {
    const { calls, detach } = await attachWith(appendSolid(partWithPoint(), extrudeFeature('first')), ['first']);
    try {
      const before = useAppStore.getState();
      const candidate = candidateOf(before.document, 'k');
      let adopted = false;
      expect(confirmExtrusion(candidate, () => { adopted = true; })).toBe('pending');
      scenario.settle(calls[1]);
      await until(() => stagedExtrusionFor(useAppStore.getState(), 'k')?.status === 'failed');
      const after = useAppStore.getState();
      const staged = stagedExtrusionFor(after, 'k');
      expect(staged?.failure).toBe(scenario.failure);
      expect(staged?.result).toBeNull();
      expect(staged?.accounting).toBeNull();
      if (scenario.kind === 'thrown') expect(staged?.errorMessage).toBe('計算部が止まりました');
      if (scenario.kind === 'failed') expect(staged?.errors.map((error) => error.featureId)).toEqual(['extrude-new']);
      // 失敗の理由は利用者が次にすることを含む文言で出す。
      expect(stagedExtrusionMessageKey(after)?.startsWith('solidError.extrude')).toBe(true);
      expect(adopted).toBe(false);
      expect(after.document).toBe(before.document);
      expect(after.undoStack).toBe(before.undoStack);
      expect(after.bodies).toBe(before.bodies);
      expect(after.requestedGeneration).toBe(before.requestedGeneration);
      expect(after.completedGeneration).toBe(before.completedGeneration);
      expect(after.lastOutcome).toBe('success');
      expect(after.errorMessage).toBeNull();
      expect(after.meshJsAccounting).toBe(before.meshJsAccounting);
      expect(after.numericInput).not.toBeNull();
      const transient = ['workerBroken', 'thrown', 'incomplete', 'accounting'].includes(scenario.failure);
      if (transient) {
        // 一時的な失敗は、入力を変えずにもう一度押せば計算し直す(同じ入力の欄を打ち直させない)。
        expect(confirmExtrusion(candidate)).toBe('pending');
        expect(calls).toHaveLength(3);
        expect(useAppStore.getState().document).toBe(before.document);
      } else {
        // 形そのものの失敗は、同じ入力では同じ答え。確定を断り、計算し直さない。入力の窓は開いたまま。
        expect(confirmExtrusion(candidate)).toBe('refused');
        expect(calls).toHaveLength(2);
      }
    } finally { detach(); }
  });

  it('履歴全体の計算でも、無効・重複・文書に無いボディがあれば採用しない', async () => {
    useAppStore.getState().applyDocument(partWithThreeSolids());
    useAppStore.getState().setTimelineIndex(0);
    const { calls, recompute } = controlledRecompute();
    const detach = attachPartRecompute(recompute);
    try {
      calls[0].settle(success(calls[0], ['1']));
      await until(() => useAppStore.getState().completedGeneration === generationOf(calls[0]));
      openExtrudeInput();
      expect(confirmExtrusion(candidateOf(useAppStore.getState().document, 'k'))).toBe('pending');
      calls[1].settle(success(calls[1], ['3', 'outside']));
      await until(() => stagedExtrusionFor(useAppStore.getState(), 'k')?.status === 'failed');
      expect(stagedExtrusionFor(useAppStore.getState(), 'k')?.failure).toBe('invalidBody');
      expect(calls).toHaveLength(2);
    } finally { detach(); }
  });
});

describe('所有が変わった段階計算は採用しない', () => {
  it('同じ文書へ戻る取り消し・やり直し(ABA)の後は、古い計算を採用しない', async () => {
    const { calls, detach } = await attachWith(appendSolid(partWithPoint(), extrudeFeature('first')), ['first']);
    try {
      const base = useAppStore.getState().document;
      const staged = stageExtrusion(candidateOf(base, 'k'));
      if (staged === null) throw new Error('Staging must start');
      const stagedCall = calls[1];
      expect(stagedCall.options.shouldCancel?.()).toBe(false);
      useAppStore.getState().undo();
      useAppStore.getState().redo();
      // 文書は同じ実体へ戻ったが、履歴は別の実体になった。
      expect(useAppStore.getState().document).toBe(base);
      expect(useAppStore.getState().undoStack).not.toBe(staged.ownership.undoStack);
      expect(stagedCall.options.shouldCancel?.()).toBe(true);
      stagedCall.settle(success(stagedCall, ['first', 'extrude-new']));
      // 予約されたふつうの計算(戻した文書)が、古い段階計算の処理を終えてから 1 本だけ走る。
      await until(() => calls.length === 3);
      expect(calls[2].document).toBe(base);
      expect(currentStagedSolid(useAppStore.getState())).toBeNull();
      expect(useAppStore.getState().partStager?.confirm(staged.ownership.inputRevision)).toBe('refused');
      expect(useAppStore.getState().document).toBe(base);
    } finally { detach(); }
  });

  it('計算中の編集で打ち切り、届いた結果を編集後の文書へ重ねない', async () => {
    const { calls, detach } = await attachWith(appendSolid(partWithPoint(), extrudeFeature('first')), ['first']);
    try {
      const candidate = candidateOf(useAppStore.getState().document, 'k');
      const staged = stageExtrusion(candidate);
      if (staged === null) throw new Error('Staging must start');
      expect(confirmExtrusion(candidate)).toBe('pending');
      useAppStore.getState().setSketch(documentWithPoint());
      const edited = useAppStore.getState().document;
      expect(calls[1].options.shouldCancel?.()).toBe(true);
      calls[1].settle(success(calls[1], ['first', 'extrude-new']));
      await until(() => calls.length === 3);
      expect(calls[2].document).toBe(edited);
      expect(useAppStore.getState().document).toBe(edited);
      expect(useAppStore.getState().document.solids.map((solid) => solid.id)).toEqual(['first']);
      expect(currentStagedSolid(useAppStore.getState())).toBeNull();
      // 確定を頼んだ後に変わったことを、もう一度押すよう促す文言で知らせる。
      expect(stagedExtrusionMessageKey(useAppStore.getState())).toBe('solidError.extrudeStale');
      expect(useAppStore.getState().partStager?.confirm(staged.ownership.inputRevision)).toBe('refused');
    } finally { detach(); }
  });

  it('成功した後でも、確定の前に対象(選択)が変われば採用しない', async () => {
    const { calls, detach } = await attachWith(appendSolid(partWithPoint(), extrudeFeature('first')), ['first']);
    try {
      const candidate = candidateOf(useAppStore.getState().document, 'k');
      stageExtrusion(candidate);
      calls[1].settle(success(calls[1], ['first', 'extrude-new']));
      await until(() => stagedExtrusionFor(useAppStore.getState(), 'k')?.status === 'ready');
      useAppStore.getState().setSelection(['first']);
      expect(stagedExtrusionFor(useAppStore.getState(), 'k')).toBeNull();
      expect(confirmExtrusion(candidate)).toBe('pending');
      expect(calls).toHaveLength(3);
      expect(useAppStore.getState().document).toBe(candidate.base);
    } finally { detach(); }
  });

  it('入力の窓を閉じたら段階計算を手放し、届いた結果も採用しない', async () => {
    const { calls, detach } = await attachWith(appendSolid(partWithPoint(), extrudeFeature('first')), ['first']);
    try {
      const candidate = candidateOf(useAppStore.getState().document, 'k');
      expect(confirmExtrusion(candidate)).toBe('pending');
      useAppStore.getState().closeNumericInput();
      expect(calls[1].options.shouldCancel?.()).toBe(true);
      calls[1].settle(success(calls[1], ['first', 'extrude-new']));
      // 次の段階計算が始まれば、前の計算の後始末は終わっている。
      openExtrudeInput();
      stageExtrusion(candidateOf(useAppStore.getState().document, 'next'));
      await until(() => calls.length === 3);
      expect(useAppStore.getState().document).toBe(candidate.base);
      expect(stagedExtrusionFor(useAppStore.getState(), 'k')).toBeNull();
    } finally { detach(); }
  });

  it('入力が変われば前の入力の計算を打ち切り、最新の入力だけを確定できる', async () => {
    const { calls, detach } = await attachWith(appendSolid(partWithPoint(), extrudeFeature('first')), ['first']);
    try {
      const base = useAppStore.getState().document;
      const first = stageExtrusion(candidateOf(base, 'distance=10', 10));
      // 同じ入力の作り直し(再描画)では計算し直さない。
      expect(stageExtrusion(candidateOf(base, 'distance=10', 10))).toBe(first);
      expect(calls).toHaveLength(2);
      const second = stageExtrusion(candidateOf(base, 'distance=20', 20));
      if (first === null || second === null) throw new Error('Staging must start');
      expect(second.ownership.inputRevision).toBeGreaterThan(first.ownership.inputRevision);
      expect(calls[1].options.shouldCancel?.()).toBe(true);
      // 共有の計算部へ同時に投げない。前の計算が返るまで次は始めない。
      expect(calls).toHaveLength(2);
      calls[1].settle(success(calls[1], ['first', 'extrude-new']));
      await until(() => calls.length === 3);
      expect(calls[2].document).toBe(second.placement.document);
      expect(generationOf(calls[2])).toBeGreaterThan(generationOf(calls[1]));
      expect(stagedExtrusionFor(useAppStore.getState(), 'distance=10')).toBeNull();
      expect(useAppStore.getState().partStager?.confirm(first.ownership.inputRevision)).toBe('refused');
      let adopted = false;
      expect(useAppStore.getState().partStager?.confirm(second.ownership.inputRevision, () => { adopted = true; })).toBe('pending');
      calls[2].settle(success(calls[2], ['first', 'extrude-new']));
      await until(() => adopted);
      const solid = useAppStore.getState().document.solids.find((item) => item.id === 'extrude-new');
      expect(solid?.kind === 'extrude' ? solid.distance : null).toEqual(expressionValueFromNumber(20));
    } finally { detach(); }
  });

  it('古い文書から作った候補は計算しない', async () => {
    const { calls, detach } = await attachWith(appendSolid(partWithPoint(), extrudeFeature('first')), ['first']);
    try {
      const stale = candidateOf(useAppStore.getState().document, 'k');
      useAppStore.getState().setSketch(documentWithPoint());
      expect(stageExtrusion(stale)).toBeNull();
      expect(confirmExtrusion(stale)).toBe('refused');
      expect(calls.filter((call) => call.document.solids.some((solid) => solid.id === 'extrude-new'))).toEqual([]);
    } finally { detach(); }
  });
});

describe('取消・切り離しと参照の範囲の後始末', () => {
  it('段階計算をやめると打ち切り、届いた結果の範囲だけを閉じる(計算部は閉じない)', async () => {
    const { calls, detach } = await attachWith(appendSolid(partWithPoint(), extrudeFeature('first')), ['first']);
    const { scope, bridge } = await issuedScope();
    const close = vi.spyOn(scope, 'close');
    const dispose = vi.spyOn(bridge, 'dispose');
    try {
      const before = useAppStore.getState();
      expect(confirmExtrusion(candidateOf(before.document, 'k'))).toBe('pending');
      cancelExtrusion();
      expect(useAppStore.getState().stagedSolid).toBeNull();
      expect(calls[1].options.shouldCancel?.()).toBe(true);
      calls[1].settle({ ...success(calls[1], ['first', 'extrude-new']), referenceMeshScope: scope });
      await until(() => close.mock.calls.length === 1);
      expect(scope.readsClosed).toBe(true);
      expect(dispose).not.toHaveBeenCalled();
      expect(useAppStore.getState().stagedSolid).toBeNull();
      expect(useAppStore.getState().document).toBe(before.document);
      expect(useAppStore.getState().undoStack).toBe(before.undoStack);
    } finally { detach(); }
  });

  it.each(['rejected', 'superseded'] as const)('%s の結果の範囲を閉じ、閉じる処理の失敗も扱う', async (scenario) => {
    const { calls, detach } = await attachWith(appendSolid(partWithPoint(), extrudeFeature('first')), ['first']);
    const { scope } = await issuedScope();
    const close = vi.spyOn(scope, 'close').mockRejectedValueOnce(new Error('lease return failed'));
    try {
      stageExtrusion(candidateOf(useAppStore.getState().document, 'k'));
      if (scenario === 'superseded') {
        calls[1].settle({ ...success(calls[1], ['first', 'extrude-new']), referenceMeshScope: scope });
        await until(() => stagedExtrusionFor(useAppStore.getState(), 'k')?.status === 'ready');
        // 持っていた成功の結果も、新しい入力に置き換えたら手放す。
        stageExtrusion(candidateOf(useAppStore.getState().document, 'k2', 20));
      } else {
        // 最後の立体が無い結果は採用しない。その結果の範囲も閉じる。
        calls[1].settle({ ...success(calls[1], ['first']), referenceMeshScope: scope });
      }
      await until(() => close.mock.calls.length === 1);
      expect(useAppStore.getState().document.solids.map((solid) => solid.id)).toEqual(['first']);
    } finally { detach(); }
  });

  it('利用者の中止(計算を止める)も段階計算の所有を手放す', async () => {
    const { calls, detach } = await attachWith(appendSolid(partWithPoint(), extrudeFeature('first')), ['first']);
    try {
      const candidate = candidateOf(useAppStore.getState().document, 'k');
      stageExtrusion(candidate);
      useAppStore.getState().cancelRecompute();
      expect(calls[1].options.shouldCancel?.()).toBe(true);
      expect(currentStagedSolid(useAppStore.getState())).toBeNull();
      calls[1].settle({ ...success(calls[1], []), cancelled: true });
      stageExtrusion(candidateOf(useAppStore.getState().document, 'next'));
      await until(() => calls.length === 3);
      expect(useAppStore.getState().document).toBe(candidate.base);
    } finally { detach(); }
  });

  it('計算部を切り離すと手立てを下ろし、遅れて届いた結果を採用しない', async () => {
    const { calls, detach } = await attachWith(appendSolid(partWithPoint(), extrudeFeature('first')), ['first']);
    const { scope } = await issuedScope();
    const close = vi.spyOn(scope, 'close');
    const candidate = candidateOf(useAppStore.getState().document, 'k');
    expect(confirmExtrusion(candidate)).toBe('pending');
    detach();
    expect(useAppStore.getState().partStager).toBeNull();
    expect(useAppStore.getState().stagedSolid).toBeNull();
    expect(calls[1].options.shouldCancel?.()).toBe(true);
    calls[1].settle({ ...success(calls[1], ['first', 'extrude-new']), referenceMeshScope: scope });
    await until(() => close.mock.calls.length === 1);
    expect(useAppStore.getState().document).toBe(candidate.base);
    expect(confirmExtrusion(candidate)).toBe('refused');
  });
});

describe('順番と、つまみが途中のときの差し込み', () => {
  it('ふつうの計算の最中は待ち、終わってから段階計算を始める', async () => {
    useAppStore.getState().applyDocument(appendSolid(partWithPoint(), extrudeFeature('first')));
    const { calls, recompute } = controlledRecompute();
    const detach = attachPartRecompute(recompute);
    try {
      openExtrudeInput();
      const staged = stageExtrusion(candidateOf(useAppStore.getState().document, 'k'));
      expect(staged?.status).toBe('pending');
      // 共有の計算部へ同時に投げない。ふつうの計算が先。
      expect(calls).toHaveLength(1);
      calls[0].settle(success(calls[0], ['first']));
      await until(() => calls.length === 2);
      expect(useAppStore.getState().completedGeneration).toBe(1);
      expect(calls[1].document).toBe(staged?.placement.document);
      expect(generationOf(calls[1])).toBe(2);
    } finally { detach(); }
  });

  it('つまみが途中なら、差し込んだ文書の履歴全体と表示の範囲を確かめ、その文書とつまみを採用する', async () => {
    useAppStore.getState().applyDocument(partWithThreeSolids());
    useAppStore.getState().setTimelineIndex(0);
    const { calls, recompute } = controlledRecompute();
    const detach = attachPartRecompute(recompute);
    try {
      expect(calls[0].document.solids.map((solid) => solid.id)).toEqual(['1']);
      calls[0].settle(success(calls[0], ['1']));
      await until(() => useAppStore.getState().completedGeneration === generationOf(calls[0]));
      openExtrudeInput();
      const before = useAppStore.getState();
      const pastLength = before.undoStack.past.length;
      const candidate = candidateOf(before.document, 'k');
      const staged = stageExtrusion(candidate);
      if (staged === null) throw new Error('Staging must start');
      // 通常の編集と同じ整え: つまみの位置へ差し込み、つまみを差し込んだ段へ進める。
      expect(staged.placement.inserted).toBe(true);
      expect(staged.placement.timelineIndex).toBe(1);
      expect(staged.placement.document.solids.map((solid) => solid.id)).toEqual(['1', 'extrude-new', '2', '3']);
      expect(staged.displayed.solids.map((solid) => solid.id)).toEqual(['1', 'extrude-new']);
      // 先に履歴全体(後ろの段が壊れていないか)を確かめる。
      expect(calls[1].document).toBe(staged.placement.document);
      calls[1].settle(success(calls[1], ['3']));
      await until(() => calls.length === 3);
      expect(calls[2].document).toBe(staged.displayed);
      expect(generationOf(calls[2])).toBe(generationOf(calls[1]) + 1);
      calls[2].settle(success(calls[2], ['1', 'extrude-new']));
      await until(() => stagedExtrusionFor(useAppStore.getState(), 'k')?.status === 'ready');
      const ready = stagedExtrusionFor(useAppStore.getState(), 'k');
      expect(ready?.wholeGeneration).toBe(generationOf(calls[1]));
      expect(ready?.accounting?.timelineIndex).toBe(1);
      expect(confirmExtrusion(candidate)).toBe('adopted');
      const after = useAppStore.getState();
      expect(after.document).toBe(staged.placement.document);
      expect(after.timelineIndex).toBe(1);
      expect(after.timelineNoticeKey).toBe('timeline.inserted');
      expect(after.undoStack.past).toHaveLength(pastLength + 1);
      // 採用するのは表示の範囲の結果とその世代(履歴全体の世代は証拠として控えるだけ)。
      expect(after.requestedGeneration).toBe(generationOf(calls[2]));
      expect(after.completedGeneration).toBe(generationOf(calls[2]));
      expect(after.bodies.map((body) => body.featureId)).toEqual(['1', 'extrude-new']);
      expect(after.meshJsAccounting?.document).toBe(after.document);
      expect(after.meshJsAccounting?.timelineIndex).toBe(1);
      expect(calls).toHaveLength(3);
    } finally { detach(); }
  });

  it('つまみが途中で履歴全体が失敗したら、表示の範囲を計算せず採用もしない', async () => {
    useAppStore.getState().applyDocument(partWithThreeSolids());
    useAppStore.getState().setTimelineIndex(0);
    const { calls, recompute } = controlledRecompute();
    const detach = attachPartRecompute(recompute);
    try {
      calls[0].settle(success(calls[0], ['1']));
      await until(() => useAppStore.getState().completedGeneration === generationOf(calls[0]));
      openExtrudeInput();
      const before = useAppStore.getState();
      expect(confirmExtrusion(candidateOf(before.document, 'k'))).toBe('pending');
      calls[1].settle({ ...success(calls[1], ['1', 'extrude-new']),
        errors: [{ featureId: '2', code: 'kernelFailed', message: '後ろの段が作れませんでした' }] });
      await until(() => stagedExtrusionFor(useAppStore.getState(), 'k')?.status === 'failed');
      expect(calls).toHaveLength(2);
      expect(stagedExtrusionFor(useAppStore.getState(), 'k')?.failure).toBe('failed');
      expect(useAppStore.getState().document).toBe(before.document);
      expect(useAppStore.getState().timelineIndex).toBe(0);
      expect(useAppStore.getState().undoStack).toBe(before.undoStack);
    } finally { detach(); }
  });
});

describe('入力欄の持ち主: 実際の openNumericInput / updateNumericInput で古い計算を採用しない(EX-14)', () => {
  it('計算中の確定の後に値を変えたら、届いた古い結果を採用せず、その範囲を閉じる', async () => {
    const { calls, detach } = await attachWith(appendSolid(partWithPoint(), extrudeFeature('first')), ['first']);
    const { scope } = await issuedScope();
    const close = vi.spyOn(scope, 'close');
    try {
      const before = useAppStore.getState();
      let adopted = false;
      expect(confirmExtrusion(candidateOf(before.document, 'distance=5', 5), () => { adopted = true; })).toBe('pending');
      updateInput((input) => reduceNumericInput(input, { type: 'edit', index: 0, source: '10' }));
      expect(useAppStore.getState().numericInputRevision).toBeGreaterThan(before.numericInputRevision);
      expect(calls[1].options.shouldCancel?.()).toBe(true);
      expect(currentStagedSolid(useAppStore.getState())).toBeNull();
      calls[1].settle({ ...success(calls[1], ['first', 'extrude-new']), referenceMeshScope: scope });
      await until(() => close.mock.calls.length === 1);
      const after = useAppStore.getState();
      expect(adopted).toBe(false);
      expect(after.document).toBe(before.document);
      expect(after.undoStack).toBe(before.undoStack);
      expect(after.numericInput).not.toBeNull();
      expect(stagedExtrusionMessageKey(after)).toBe('solidError.extrudeStale');
    } finally { detach(); }
  });

  it('表示中の仮の形の後に選択肢を変えたら、仮の形を手放してその範囲を閉じる', async () => {
    const { calls, detach } = await attachWith(appendSolid(partWithPoint(), extrudeFeature('first')), ['first']);
    const { scope } = await issuedScope();
    const close = vi.spyOn(scope, 'close');
    try {
      const before = useAppStore.getState();
      stageExtrusion(candidateOf(before.document, 'k'));
      calls[1].settle({ ...success(calls[1], ['first', 'extrude-new']), referenceMeshScope: scope });
      await until(() => stagedExtrusionFor(useAppStore.getState(), 'k')?.status === 'ready');
      updateInput((input) => reduceNumericInput(input, { type: 'choose', key: 'extrudeEnd', value: 'toNext' }));
      expect(useAppStore.getState().numericInput?.choices.find((choice) => choice.key === 'extrudeEnd')?.value).toBe('toNext');
      expect(stagedExtrusionFor(useAppStore.getState(), 'k')).toBeNull();
      expect(close).toHaveBeenCalledTimes(1);
      expect(useAppStore.getState().document).toBe(before.document);
      expect(useAppStore.getState().undoStack).toBe(before.undoStack);
    } finally { detach(); }
  });

  it.each(['another tool', 'identical new session'] as const)(
    '入力欄を閉じずに %s を開いたら、前の入力欄の計算を採用しない', async (scenario) => {
      const { calls, detach } = await attachWith(appendSolid(partWithPoint(), extrudeFeature('first')), ['first']);
      try {
        const before = useAppStore.getState();
        let adopted = false;
        expect(confirmExtrusion(candidateOf(before.document, 'k'), () => { adopted = true; })).toBe('pending');
        const replacement = scenario === 'another tool'
          ? createNumericInput('revolve', 'revolveAngle')
          : createNumericInput('extrude', 'extrudeDistance');
        // No intermediate close: the store replaces a non-null input directly.
        useAppStore.getState().openNumericInput(replacement, [20, 20]);
        expect(useAppStore.getState().numericInput).toBe(replacement);
        expect(calls[1].options.shouldCancel?.()).toBe(true);
        expect(currentStagedSolid(useAppStore.getState())).toBeNull();
        calls[1].settle(success(calls[1], ['first', 'extrude-new']));
        stageExtrusion(candidateOf(before.document, 'after'));
        await until(() => calls.length === 3);
        expect(adopted).toBe(false);
        expect(useAppStore.getState().document).toBe(before.document);
        expect(useAppStore.getState().undoStack).toBe(before.undoStack);
      } finally { detach(); }
    });

  it('値を変えて元へ戻しても(ABA)、変える前の計算は採用しない', async () => {
    const { calls, detach } = await attachWith(appendSolid(partWithPoint(), extrudeFeature('first')), ['first']);
    try {
      const before = useAppStore.getState();
      const original = before.numericInput;
      if (original === null) throw new Error('input open');
      let adopted = false;
      const staged = stageExtrusion(candidateOf(before.document, 'k'));
      if (staged === null) throw new Error('Staging must start');
      expect(confirmExtrusion(candidateOf(before.document, 'k'), () => { adopted = true; })).toBe('pending');
      updateInput((input) => reduceNumericInput(input, { type: 'edit', index: 0, source: '10' }));
      updateInput(() => original);
      // The meaning is A again, but the input changed in between: the earlier calculation stays released.
      expect(useAppStore.getState().numericInput).toBe(original);
      expect(currentStagedSolid(useAppStore.getState())).toBeNull();
      expect(useAppStore.getState().partStager?.confirm(staged.ownership.inputRevision)).toBe('refused');
      calls[1].settle(success(calls[1], ['first', 'extrude-new']));
      stageExtrusion(candidateOf(before.document, 'after'));
      await until(() => calls.length === 3);
      expect(adopted).toBe(false);
      expect(useAppStore.getState().document).toBe(before.document);
      expect(useAppStore.getState().undoStack).toBe(before.undoStack);
    } finally { detach(); }
  });

  it('焦点を動かしただけなら持ち主は変わらず、計算中の確定はそのまま採用する', async () => {
    const { calls, detach } = await attachWith(appendSolid(partWithPoint(), extrudeFeature('first')), ['first']);
    try {
      const before = useAppStore.getState();
      let adopted = false;
      expect(confirmExtrusion(candidateOf(before.document, 'k'), () => { adopted = true; })).toBe('pending');
      const revision = useAppStore.getState().numericInputRevision;
      updateInput((input) => reduceNumericInput(input, { type: 'focus', index: 1 }));
      expect(useAppStore.getState().numericInput?.focusedIndex).toBe(1);
      expect(useAppStore.getState().numericInputRevision).toBe(revision);
      expect(calls[1].options.shouldCancel?.()).toBe(false);
      calls[1].settle(success(calls[1], ['first', 'extrude-new']));
      await until(() => adopted);
      expect(useAppStore.getState().document.solids.map((solid) => solid.id)).toEqual(['first', 'extrude-new']);
      expect(useAppStore.getState().undoStack.past).toHaveLength(before.undoStack.past.length + 1);
    } finally { detach(); }
  });

  it('一時的な失敗の後は、入力を変えずにもう一度確定すれば計算し直して採用する', async () => {
    const { calls, detach } = await attachWith(appendSolid(partWithPoint(), extrudeFeature('first')), ['first']);
    try {
      const before = useAppStore.getState();
      const candidate = candidateOf(before.document, 'k');
      expect(confirmExtrusion(candidate)).toBe('pending');
      calls[1].fail(new Error('計算部が一時的に止まりました'));
      await until(() => stagedExtrusionFor(useAppStore.getState(), 'k')?.failure === 'thrown');
      expect(useAppStore.getState().document).toBe(before.document);
      expect(useAppStore.getState().undoStack).toBe(before.undoStack);
      let adopted = false;
      expect(confirmExtrusion(candidate, () => { adopted = true; })).toBe('pending');
      expect(calls).toHaveLength(3);
      calls[2].settle(success(calls[2], ['first', 'extrude-new']));
      await until(() => adopted);
      expect(useAppStore.getState().document.solids.map((solid) => solid.id)).toEqual(['first', 'extrude-new']);
      expect(useAppStore.getState().undoStack.past).toHaveLength(before.undoStack.past.length + 1);
    } finally { detach(); }
  });
});
