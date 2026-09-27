/**
 * 図形の測定値の結果の受け渡しと「いまの値」の判定(GR-14、計画書 geomref-plan.md §4(c))。
 *
 * 再計算は偽物(`createFakeRecompute`)を本物の `attachPartRecompute` へつなぎ、世代の予約・
 * 待ち行列・反映の順序は製品と同じ経路を通す。古い値(形の変更直後・取消・新規・開く・復元・
 * Undo/Redo・世代交代・履歴の途中・同じ `part-1` の別文書)を出さないことを状況ごとに確かめる。
 */
import {
  appendSolid,
  assignBodyAppearance,
  createAssemblyDocument,
  createDrawingDocument,
  createEmptyPartDocument,
  DEFAULT_APPEARANCE,
  type DocumentMathContext,
  type MathGeometryDefinition,
  type MathGeometryOutcome,
  type PartDocument,
  type PartRecomputeResult,
} from '@pointercad/model';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { attachPartRecompute } from '../store/attachKernel.js';
import {
  createFakeRecompute,
  extrudeFeature,
  partWithPoint,
  type PendingRecompute,
  resetTestStore,
  resultFor,
  tick,
} from '../store/testing/createTestStore.js';
import { useAppStore } from '../store/useAppStore.js';
import {
  currentMathGeometry,
  mathGeometryInputsFor,
  type MathGeometryUnresolvedReason,
  waitForCurrentMathGeometry,
} from './mathGeometryResults.js';

const TOLERANCE = { linearMm: 1e-6, angularRadians: 1e-6 } as const;

/** 立体 1 つの体積を測る定義(文書ID は既定の `part-1`)。 */
function volumeDefinition(id: string, name: string, featureId = 'extrude-1'): MathGeometryDefinition {
  return {
    id,
    documentId: 'part-1',
    name,
    quantity: { kind: 'volume', body: { kind: 'body', featureId } },
    tolerance: TOLERANCE,
  };
}

/** 押し出し 1 段(と追加の段)を持ち、図形の測定値を持つ部品。文書ID は既定の `part-1`。 */
function partWithGeometry(
  definitions: readonly MathGeometryDefinition[] = [volumeDefinition('geometry-1', '体積1')],
  extraSolids: readonly string[] = [],
): PartDocument {
  let document = appendSolid(partWithPoint(), extrudeFeature('extrude-1'));
  for (const id of extraSolids) {
    document = appendSolid(document, extrudeFeature(id));
  }
  return { ...document, mathGeometry: definitions };
}

/** 計算した文書のすべての定義を、同じ値で測った結果。 */
function measured(document: PartDocument, generation: number, value = 24000): PartRecomputeResult {
  return {
    ...resultFor(document),
    generation,
    mathGeometry: (document.mathGeometry ?? []).map((definition): MathGeometryOutcome => ({
      id: definition.id,
      documentId: document.id,
      generation,
      status: 'value',
      kind: 'real',
      value,
      unit: 'mm3',
      representation: 'geometry-double',
      tolerance: definition.tolerance,
    })),
  };
}

function settleMeasured(call: PendingRecompute, value = 24000): void {
  call.settle(measured(call.document, call.options.generation ?? 0, value));
}

/** いまの値の表。current でなければ理由付きで失敗させる。 */
function outcomesNow(): ReadonlyMap<string, MathGeometryOutcome> {
  const current = currentMathGeometry(useAppStore.getState());
  if (current.status !== 'current') {
    throw new Error(`current ではありません: ${current.status}`);
  }
  return current.outcomes;
}

/** 定義 1 件のいまの実数値(値でなければ null)。 */
function valueNow(id = 'geometry-1'): number | null {
  const outcome = outcomesNow().get(id);
  return outcome?.status === 'value' && outcome.kind === 'real' ? outcome.value : null;
}

function statusNow(): string {
  return currentMathGeometry(useAppStore.getState()).status;
}

/** いま画面に出ている部品へ渡す表(型は `DocumentMathContext.geometry` にそのまま渡せる)。 */
function inputsNow(): DocumentMathContext['geometry'] | null {
  const state = useAppStore.getState();
  return mathGeometryInputsFor(state, state.document);
}

const drawingSource = {
  sourceRef: 'source-1',
  sourceKind: 'part',
  fileName: 'box.pcad',
  path: '',
  contentHash: 'hash',
  importedAt: '2026-09-09T00:00:00.000Z',
} as const;

const detachers: (() => void)[] = [];

/** 偽の再計算をつなぐ。つないだ直後に今の文書の計算が 1 回予約される(世代1)。 */
function attachFake(): ReturnType<typeof createFakeRecompute> {
  const fake = createFakeRecompute();
  detachers.push(attachPartRecompute(fake.recompute));
  return fake;
}

/** 定義を持つ部品を開き、最初の計算(世代1、体積24000)を終えた状態にする。 */
async function openedPart(document: PartDocument = partWithGeometry()): Promise<ReturnType<typeof createFakeRecompute>> {
  useAppStore.getState().resetDocument(document);
  const fake = attachFake();
  settleMeasured(fake.calls[0]);
  await tick();
  expect(valueNow()).toBe(24000);
  return fake;
}

/** 形の欄(立体の並び)を変えた文書を適用する。 */
function changeShape(id = 'extrude-2'): PartDocument {
  useAppStore.getState().applyDocument(appendSolid(useAppStore.getState().document, extrudeFeature(id)));
  return useAppStore.getState().document;
}

beforeEach(() => {
  resetTestStore();
  // 世代は文書の作り直しでも戻らない欄なので、検査の間で持ち越さないよう明示的に戻す。
  useAppStore.setState({ requestedGeneration: 0, completedGeneration: 0, lastOutcome: 'idle' });
});

afterEach(() => {
  for (const detach of detachers.splice(0)) {
    detach();
  }
});

describe('いまの値の判定(currentMathGeometry)', () => {
  it('起動直後は控えが無く、計算が終わるまで computing', () => {
    const state = useAppStore.getState();
    expect(state.mathGeometryResult).toBeNull();
    expect(currentMathGeometry(state)).toEqual({ status: 'computing' });
  });

  it('形を変えた直後は computing で値を渡さず、その世代が終わると新しい値になる', async () => {
    const fake = await openedPart();
    changeShape();
    expect(fake.calls).toHaveLength(2);
    expect(statusNow()).toBe('computing');
    expect(inputsNow()).toBeNull();

    settleMeasured(fake.calls[1], 30000);
    await tick();
    expect(valueNow()).toBe(30000);
    expect(outcomesNow().get('geometry-1')?.generation).toBe(2);
  });

  it('計算中にさらに形を変えると、途中の世代の結果は捨てて最新の世代が終わるまで computing', async () => {
    const fake = await openedPart();
    changeShape('extrude-2');
    changeShape('extrude-3');
    // 走っている計算(世代2)は 1 本だけ。最新の文書は待ち行列に 1 つだけ入る。
    expect(fake.calls).toHaveLength(2);
    expect(statusNow()).toBe('computing');

    settleMeasured(fake.calls[1], 30000);
    await tick();
    // 世代2の結果は反映せずに次(世代3)を計算する。控えは世代1のまま残るが、古い世代なので値は出さない。
    expect(fake.calls).toHaveLength(3);
    expect(useAppStore.getState().mathGeometryResult?.generation).toBe(1);
    expect(useAppStore.getState().requestedGeneration).toBe(3);
    expect(statusNow()).toBe('computing');
    expect(inputsNow()).toBeNull();

    settleMeasured(fake.calls[2], 36000);
    await tick();
    expect(valueNow()).toBe(36000);
    expect(outcomesNow().get('geometry-1')?.generation).toBe(3);
  });

  it('中止した計算の後は cancelled で値を渡さず、外観だけ変えても computing へ戻らない', async () => {
    const fake = await openedPart();
    changeShape();
    useAppStore.getState().cancelRecompute();
    fake.calls[1].settle({ ...resultFor(fake.calls[1].document), generation: 2, cancelled: true });
    await tick();
    expect(useAppStore.getState().mathGeometryResult).toBeNull();
    expect(statusNow()).toBe('cancelled');
    expect(inputsNow()).toBeNull();

    // 外観だけの変更は再計算を起こさず、中止の知らせ(recomputeCancelled)だけが下りる。
    const document = useAppStore.getState().document;
    useAppStore.getState().applyDocument(assignBodyAppearance(document, 'extrude-1', DEFAULT_APPEARANCE));
    expect(useAppStore.getState().recomputeCancelled).toBe(false);
    expect(fake.calls).toHaveLength(2);
    expect(statusNow()).toBe('cancelled');
  });

  it('新規の直後は computing。前の文書(定義あり)の表は渡さず、定義の無い新しい文書には待たずに空の表を渡す', async () => {
    const fake = await openedPart();
    const previous = useAppStore.getState().document;
    const next = createEmptyPartDocument();
    useAppStore.getState().resetDocument(next);
    const state = useAppStore.getState();
    expect(state.document).toBe(next);
    expect(state.document.id).toBe(previous.id);
    expect(currentMathGeometry(state).status).toBe('computing');
    expect(mathGeometryInputsFor(state, previous)).toBeNull();
    expect(mathGeometryInputsFor(state, next)?.size).toBe(0);

    fake.calls[1].settle({ ...resultFor(fake.calls[1].document), generation: 2 });
    await tick();
    expect(outcomesNow().size).toBe(0);
  });

  it('開いた直後は computing。計算中だった前の文書(同じ part-1)の結果は捨て、開いた文書の値だけを出す', async () => {
    const fake = await openedPart();
    changeShape();
    // 前の文書の世代2が走っている間に、同じ文書ID(part-1)の別の文書を開く。
    const opened = partWithGeometry([volumeDefinition('geometry-1', '体積1')]);
    useAppStore.getState().applyDocument(opened, { replacesDocument: true });
    expect(useAppStore.getState().document).toBe(opened);
    expect(statusNow()).toBe('computing');
    expect(inputsNow()).toBeNull();

    settleMeasured(fake.calls[1], 99999);
    await tick();
    expect(fake.calls).toHaveLength(3);
    expect(fake.calls[2].document).toBe(opened);
    expect(statusNow()).toBe('computing');

    settleMeasured(fake.calls[2], 1000);
    await tick();
    expect(valueNow()).toBe(1000);
    expect(inputsNow()?.get('geometry-1')).toMatchObject({ status: 'value', value: 1000, generation: 3 });
  });

  it('復元の直後は computing。遅れて届いた前の文書(同じ part-1・同じ世代番号)の結果は控えない', async () => {
    const fake = await openedPart();
    const previous = useAppStore.getState().document;
    const restored = partWithGeometry([volumeDefinition('geometry-1', '体積1')]);
    useAppStore.getState().resetDocument(restored);
    const generation = useAppStore.getState().requestedGeneration;
    expect(statusNow()).toBe('computing');

    // 世代番号だけが一致する別文書の結果を、直接反映させても控えない。
    useAppStore.getState().applyRecompute(previous, measured(previous, generation, 99999));
    expect(useAppStore.getState().mathGeometryResult).toBeNull();
    expect(statusNow()).toBe('computing');
    expect(inputsNow()).toBeNull();

    settleMeasured(fake.calls[1], 2400);
    await tick();
    expect(valueNow()).toBe(2400);
  });

  it('Undo・Redo の直後は computing で、その世代が終わると戻した文書の値になる', async () => {
    const fake = await openedPart();
    changeShape();
    settleMeasured(fake.calls[1], 30000);
    await tick();
    expect(valueNow()).toBe(30000);

    useAppStore.getState().undo();
    expect(statusNow()).toBe('computing');
    expect(inputsNow()).toBeNull();
    settleMeasured(fake.calls[2], 24000);
    await tick();
    expect(valueNow()).toBe(24000);

    useAppStore.getState().redo();
    expect(statusNow()).toBe('computing');
    expect(inputsNow()).toBeNull();
    settleMeasured(fake.calls[3], 30000);
    await tick();
    expect(valueNow()).toBe(30000);
    expect(outcomesNow().get('geometry-1')?.generation).toBe(4);
  });

  it('いま依頼中でない世代の結果は控えず、控えた後に新しい世代を依頼すると computing', () => {
    const document = partWithGeometry();
    useAppStore.getState().resetDocument(document);
    useAppStore.getState().recordRecomputeRequest(5);

    useAppStore.getState().applyRecompute(document, measured(document, 4));
    expect(useAppStore.getState().mathGeometryResult).toBeNull();
    expect(statusNow()).toBe('computing');

    useAppStore.getState().applyRecompute(document, measured(document, 5));
    expect(valueNow()).toBe(24000);

    useAppStore.getState().recordRecomputeRequest(6);
    expect(statusNow()).toBe('computing');
    expect(inputsNow()).toBeNull();
  });

  it('履歴の途中を表示している間は timeline で値を渡さず、切った文書の結果も控えない', async () => {
    const fake = await openedPart(partWithGeometry(undefined, ['extrude-2']));
    useAppStore.getState().setTimelineIndex(0);
    expect(statusNow()).toBe('timeline');
    expect(inputsNow()).toBeNull();

    // つまみで切った文書(別の文書オブジェクト)の計算結果。
    const sliced = fake.calls[1];
    expect(sliced.document).not.toBe(useAppStore.getState().document);
    settleMeasured(sliced, 11111);
    await tick();
    expect(useAppStore.getState().mathGeometryResult).toBeNull();
    expect(statusNow()).toBe('timeline');

    // 末尾の項目を指すつまみは同じ文書を計算するが、途中表示の間はやはり控えない。
    useAppStore.getState().setTimelineIndex(1);
    expect(fake.calls[2].document).toBe(useAppStore.getState().document);
    settleMeasured(fake.calls[2], 22222);
    await tick();
    expect(useAppStore.getState().mathGeometryResult).toBeNull();
    expect(statusNow()).toBe('timeline');

    // つまみを末尾へ戻すと計算し直し、終わると値が出る。
    useAppStore.getState().setTimelineIndex(null);
    expect(statusNow()).toBe('computing');
    settleMeasured(fake.calls[3], 24000);
    await tick();
    expect(valueNow()).toBe(24000);
  });

  it.each(['assembly', 'drawing'] as const)('%s を開いている間は notPart で、裏の部品の値を渡さない', async (kind) => {
    const fake = await openedPart();
    const part = useAppStore.getState().document;
    if (kind === 'assembly') {
      useAppStore.getState().openAssembly(createAssemblyDocument('組み立て1'));
    } else {
      useAppStore.getState().openDrawing(createDrawingDocument('図面1', drawingSource));
    }
    const state = useAppStore.getState();
    expect(currentMathGeometry(state)).toEqual({ status: 'notPart' });
    expect(mathGeometryInputsFor(state, part)).toBeNull();

    // 部品へ戻ると計算し直し、終わるまでは値を出さない。
    if (kind === 'assembly') {
      useAppStore.getState().closeAssembly();
    } else {
      useAppStore.getState().closeDrawing();
    }
    expect(statusNow()).toBe('computing');
    const last = fake.calls[fake.calls.length - 1];
    settleMeasured(last, 24000);
    await tick();
    expect(valueNow()).toBe(24000);
  });

  it('外観だけの変更では計算し直さず値を保つ。計算中に外観を変えても、その世代の値を出す', async () => {
    const fake = await openedPart();
    const before = currentMathGeometry(useAppStore.getState());
    const colored = assignBodyAppearance(useAppStore.getState().document, 'extrude-1', DEFAULT_APPEARANCE);
    useAppStore.getState().applyDocument(colored);
    expect(fake.calls).toHaveLength(1);
    expect(useAppStore.getState().document).not.toBe(fake.calls[0].document);
    expect(currentMathGeometry(useAppStore.getState())).toBe(before);
    expect(inputsNow()?.get('geometry-1')).toMatchObject({ value: 24000 });

    // 形を変えて計算している間に外観だけを変える。外観の変更は再計算を起こさない。
    changeShape();
    const computed = fake.calls[1].document;
    useAppStore.getState().applyDocument(assignBodyAppearance(computed, 'extrude-2', DEFAULT_APPEARANCE));
    expect(fake.calls).toHaveLength(2);
    settleMeasured(fake.calls[1], 30000);
    await tick();
    expect(useAppStore.getState().document).not.toBe(computed);
    expect(valueNow()).toBe(30000);
    expect(inputsNow()?.get('geometry-1')).toMatchObject({ value: 30000 });
  });

  it('定義があるのに形を作れず測っていない結果は notEvaluated で、最初の失敗の理由を添える', async () => {
    useAppStore.getState().resetDocument(partWithGeometry());
    const fake = attachFake();
    fake.calls[0].settle({
      ...resultFor(fake.calls[0].document),
      generation: 1,
      errors: [
        { featureId: 'extrude-1', code: 'kernelFailed', message: '立体を作れませんでした' },
        { featureId: 'extrude-1', code: 'kernelFailed', message: '二つ目の理由' },
      ],
    });
    await tick();
    const state = useAppStore.getState();
    expect(state.mathGeometryResult?.evaluated).toBe(false);
    expect(currentMathGeometry(state)).toEqual({ status: 'notEvaluated', message: '立体を作れませんでした' });
    expect(inputsNow()).toBeNull();
  });

  it('計算そのものが例外で終わったら computing のまま止めず、その理由で notEvaluated にする', async () => {
    useAppStore.getState().resetDocument(partWithGeometry());
    detachers.push(attachPartRecompute(() => Promise.reject(new Error('計算できません'))));
    await tick();
    const state = useAppStore.getState();
    expect(state.lastOutcome).toBe('failed');
    expect(currentMathGeometry(state)).toEqual({ status: 'notEvaluated', message: '計算できません' });
    expect(inputsNow()).toBeNull();
  });

  it('定義の無い文書は測らなくても current(空)。計算中でも数式へは空の表を待たずに渡す', async () => {
    const document = appendSolid(partWithPoint(), extrudeFeature('extrude-1'));
    useAppStore.getState().resetDocument(document);
    const fake = attachFake();
    expect(statusNow()).toBe('computing');
    expect(inputsNow()?.size).toBe(0);

    fake.calls[0].settle({
      ...resultFor(fake.calls[0].document),
      generation: 1,
      errors: [{ featureId: 'extrude-1', code: 'kernelFailed', message: '立体を作れませんでした' }],
    });
    await tick();
    expect(useAppStore.getState().mathGeometryResult?.evaluated).toBe(false);
    expect(outcomesNow().size).toBe(0);
    expect(inputsNow()?.size).toBe(0);
  });

  it('定義ごとの未解決は理由5種と model の文をそのまま受け渡し、数式へ渡す表にも含める', async () => {
    const reasons = {
      'missing-reference': true,
      'failed-geometry': true,
      unsupported: true,
      'invalid-request': true,
      'ambiguous-reference': true,
    } satisfies Record<MathGeometryUnresolvedReason, true>;
    const reasonList = Object.keys(reasons).filter((reason): reason is MathGeometryUnresolvedReason => reason in reasons);
    const definitions = [
      volumeDefinition('geometry-value', '体積1'),
      ...reasonList.map((reason, index) => volumeDefinition(`geometry-${reason}`, `未解決${index + 1}`)),
    ];
    useAppStore.getState().resetDocument(partWithGeometry(definitions));
    const fake = attachFake();
    const call = fake.calls[0];
    const sent: MathGeometryOutcome[] = [
      ...(measured(call.document, 1).mathGeometry ?? []).filter((outcome) => outcome.id === 'geometry-value'),
      ...reasonList.map((reason): MathGeometryOutcome => ({
        id: `geometry-${reason}`,
        documentId: 'part-1',
        generation: 1,
        status: 'unresolved',
        reason,
        message: `model の理由の文: ${reason}`,
      })),
    ];
    call.settle({ ...resultFor(call.document), generation: 1, mathGeometry: sent });
    await tick();

    const outcomes = outcomesNow();
    expect(outcomes.size).toBe(6);
    for (const outcome of sent) {
      expect(outcomes.get(outcome.id)).toBe(outcome);
    }
    expect([...outcomes.values()].flatMap((outcome) => (outcome.status === 'unresolved' ? [outcome.reason] : [])).sort())
      .toEqual([...reasonList].sort());
    expect(inputsNow()).toBe(outcomes);
  });

  it('同じ状態には同じ物を返す(選択関数から呼んでも描き直しが止まる)', async () => {
    expect(currentMathGeometry(useAppStore.getState())).toBe(currentMathGeometry(useAppStore.getState()));
    await openedPart();
    const state = useAppStore.getState();
    const current = currentMathGeometry(state);
    expect(currentMathGeometry(state)).toBe(current);
    expect(currentMathGeometry({ ...state })).toBe(current);
    expect(mathGeometryInputsFor(state, state.document)).toBe(mathGeometryInputsFor(state, state.document));
  });
});

describe('数式へ渡す値(mathGeometryInputsFor)', () => {
  it('いま画面に出ている部品の文書そのものにだけ、その世代の完了した結果を渡す', async () => {
    await openedPart();
    const state = useAppStore.getState();
    const inputs = mathGeometryInputsFor(state, state.document);
    expect(inputs?.get('geometry-1')).toMatchObject({ status: 'value', value: 24000, documentId: 'part-1', generation: 1 });
    // 中身も文書ID(part-1)も同じ写しでも、画面に出ている文書でなければ渡さない。
    const copy: PartDocument = { ...state.document };
    expect(copy.id).toBe(state.document.id);
    expect(mathGeometryInputsFor(state, copy)).toBeNull();
    // 型の上でも DocumentMathContext.geometry へそのまま渡せる。
    const geometry: DocumentMathContext['geometry'] = inputs ?? undefined;
    expect(geometry?.size).toBe(1);
  });
});

describe('いまの値になるまで待つ(waitForCurrentMathGeometry)', () => {
  it('計算中は待ち、その世代が終わると current を返す', async () => {
    const fake = await openedPart();
    changeShape();
    let settled = false;
    const waiting = waitForCurrentMathGeometry().then((result) => {
      settled = true;
      return result;
    });
    await tick();
    expect(settled).toBe(false);

    settleMeasured(fake.calls[1], 30000);
    const result = await waiting;
    expect(result.status).toBe('current');
    expect(result.status === 'current' ? result.outcomes.get('geometry-1') : null).toMatchObject({ value: 30000 });
  });

  it('中止の合図で aborted を返し、購読を外す', async () => {
    const fake = await openedPart();
    changeShape();
    const subscribe = useAppStore.subscribe;
    let unsubscribed = 0;
    const spy = vi.spyOn(useAppStore, 'subscribe').mockImplementation((listener) => {
      const off = subscribe(listener);
      return () => {
        unsubscribed += 1;
        off();
      };
    });
    try {
      const controller = new AbortController();
      const waiting = waitForCurrentMathGeometry(controller.signal);
      expect(spy).toHaveBeenCalledTimes(1);
      controller.abort();
      await expect(waiting).resolves.toEqual({ status: 'aborted' });
      expect(unsubscribed).toBe(1);

      // 中止済みの合図なら購読せずにすぐ返す。
      await expect(waitForCurrentMathGeometry(controller.signal)).resolves.toEqual({ status: 'aborted' });
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
    settleMeasured(fake.calls[1], 30000);
    await tick();
    expect(valueNow()).toBe(30000);
  });

  it('取消・測れない・部品以外は、自然には値にならないのですぐその判定を返す', async () => {
    const fake = await openedPart();
    changeShape();
    useAppStore.getState().cancelRecompute();
    fake.calls[1].settle({ ...resultFor(fake.calls[1].document), generation: 2, cancelled: true });
    await tick();
    await expect(waitForCurrentMathGeometry()).resolves.toEqual({ status: 'cancelled' });

    changeShape('extrude-3');
    fake.calls[2].settle({
      ...resultFor(fake.calls[2].document),
      generation: 3,
      errors: [{ featureId: 'extrude-3', code: 'kernelFailed', message: '立体を作れませんでした' }],
    });
    await tick();
    await expect(waitForCurrentMathGeometry()).resolves.toEqual({ status: 'notEvaluated', message: '立体を作れませんでした' });

    useAppStore.getState().openAssembly(createAssemblyDocument('組み立て1'));
    await expect(waitForCurrentMathGeometry()).resolves.toEqual({ status: 'notPart' });
  });

  it('履歴の途中表示の間は待ち続け、つまみを末尾へ戻して計算が終わると current を返す', async () => {
    const fake = await openedPart(partWithGeometry(undefined, ['extrude-2']));
    useAppStore.getState().setTimelineIndex(0);
    let settled = false;
    const waiting = waitForCurrentMathGeometry().then((result) => {
      settled = true;
      return result;
    });
    settleMeasured(fake.calls[1], 11111);
    await tick();
    expect(settled).toBe(false);

    useAppStore.getState().setTimelineIndex(null);
    await tick();
    expect(settled).toBe(false);
    settleMeasured(fake.calls[2], 24000);
    const result = await waiting;
    expect(result.status === 'current' ? result.outcomes.get('geometry-1') : null).toMatchObject({ value: 24000, generation: 3 });
  });
});
