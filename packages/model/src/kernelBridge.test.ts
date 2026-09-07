/**
 * Worker 版の橋(`createKernelBridge`)が、**Worker が黙ったまま壊れたとき**に
 * 待っている呼び出しを必ず終わらせることの検査(§2.9、§0.a-0.19、FR-504、NFR-RE-1)。
 *
 * これまで壊れた合図と競っていたのは `recomputeSolids` だけで、面の三角形分割・
 * オフセット・投影・断面・測定の 5 つは Worker が黙るとアプリが無言で固まった
 * (`docs/報告記録.md` 2026-09-06 12:04 の③)。ここでは 6 つすべてについて
 * 「応答が返らないまま壊れた合図が鳴ったら、拒否ではなく**断りの値**で解決する」を固定する。
 *
 * **実物の Worker も OCCT も起こさない。** `createKernelWorker` だけを、依頼を受け取っても
 * 何も返さない偽物へ差し替える(応答待ちの Promise が永遠に解決しない状態の再現)。
 * 壊れは `worker.addEventListener('error', …)` に届く 'error' の出来事で起こす
 * (`createKernelConnection` が実際に見張っているのがこの 2 つの出来事)。
 * 偽物で差し替える流儀は `measure/measureBridge.test.ts` の偽の `KernelApi` と同じ。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createKernelApi } from '@pointercad/kernel';
import * as Comlink from 'comlink';
import { loadOcctForNode } from '../../kernel/src/occt/loadOcct.node.js';

import {
  createKernelBridge,
  createDirectKernelBridge,
  KERNEL_BROKEN_MESSAGE,
  toPrintabilityOutcome,
  type SketchOffsetRequestItem,
  type SketchProjectionRequestItem,
} from './kernelBridge.js';
import { resolvePart, type ResolvedSolidStep } from './part/resolvePart.js';
import { appendSolid, createEmptyPartDocument, createPrimitiveFeature } from './part/createPartDocument.js';
import { recomputePart } from './part/recomputePart.js';
import { WORK_PLANES } from './sketch/planeMath.js';
import type { ResolvedFace } from './sketch/types.js';

const silentWorkers = vi.hoisted(() => {
  let reply: { readonly value: unknown } | undefined;
  let rejection: string | undefined;
  let throwOnPost = false;
  /**
   * 依頼を受け取っても何も返さない偽の Worker。Comlink はここへ依頼を投げるので、
   * 応答待ちの Promise は永遠に解決も拒否もしない(OCCT が abort() した後と同じ)。
   * `EventTarget` を継承しているので、検査から 'error' を出して壊れを起こせる。
   */
  class SilentWorker extends EventTarget {
    readonly requests = new EventTarget();
    readonly requestListeners = new Set<EventListenerOrEventListenerObject>();
    connected = false;

    postMessage(message: unknown, transfer: Transferable[] = []): void {
      if (this.connected) {
        const data: unknown = structuredClone(message, { transfer });
        queueMicrotask(() => this.requests.dispatchEvent(new MessageEvent('message', { data })));
        return;
      }
      if (throwOnPost) throw new Error('postMessage failed');
      if (rejection !== undefined && typeof message === 'object' && message !== null && 'id' in message) {
        const data = {
          id: message.id, type: 'HANDLER', name: 'throw',
          value: { isError: true, value: { name: 'Error', message: rejection } },
        };
        queueMicrotask(() => this.dispatchEvent(new MessageEvent('message', { data })));
        return;
      }
      if (reply !== undefined && typeof message === 'object' && message !== null && 'id' in message) {
        const data = { id: message.id, type: 'RAW', value: reply.value };
        queueMicrotask(() => this.dispatchEvent(new MessageEvent('message', { data })));
      }
      // 何も返さないことがこの偽物の役目。
    }

    terminate(): void {
      for (const listener of this.requestListeners) this.requests.removeEventListener('message', listener);
      this.requestListeners.clear();
      this.connected = false;
      // 持ち物が無いので閉じるものは無い。
    }
  }

  const created: SilentWorker[] = [];
  return {
    serverEndpoint() {
      const worker = created[created.length - 1];
      if (worker === undefined) throw new Error('Worker is required');
      worker.connected = true;
      return {
        postMessage(message: unknown, transfer: Transferable[] = []) {
          const data: unknown = structuredClone(message, { transfer });
          queueMicrotask(() => worker.dispatchEvent(new MessageEvent('message', { data })));
        },
        addEventListener(type: string, listener: EventListenerOrEventListenerObject) {
          worker.requestListeners.add(listener);
          worker.requests.addEventListener(type, listener);
        },
        removeEventListener(type: string, listener: EventListenerOrEventListenerObject) {
          worker.requestListeners.delete(listener);
          worker.requests.removeEventListener(type, listener);
        },
      };
    },
    rejectWith(message: string): void { rejection = message; },
    failPost(): void { throwOnPost = true; },
    respondWith(value: unknown): void {
      reply = { value };
    },
    create(): SilentWorker {
      const worker = new SilentWorker();
      created.push(worker);
      return worker;
    },
    /** いま使われている(最後に作られた)Worker が壊れたことにする。 */
    breakCurrent(): void {
      const worker = created[created.length - 1];
      if (worker === undefined) {
        throw new Error('偽の Worker がまだ 1 つも作られていません。');
      }
      worker.dispatchEvent(new Event('error'));
    },
    clear(): void {
      created.length = 0;
      reply = undefined;
      rejection = undefined;
      throwOnPost = false;
    },
  };
});

vi.mock('@pointercad/kernel', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@pointercad/kernel')>();
  // 差し替えるのは Worker の起動だけ。詰め替えの純関数(matchFace 等)は本物のまま使う。
  return { ...actual, createKernelWorker: () => silentWorkers.create() };
});

/** 面 1 枚。カーネルへは渡らない(黙ったまま壊れる)ので、型を満たすだけの値。 */
const FACE: ResolvedFace = {
  featureId: 'face-1',
  color: '#8899aa',
  curves: [
    { kind: 'segment', featureId: 'segment-1', from: [0, 0, 0], to: [10, 0, 0] },
    { kind: 'segment', featureId: 'segment-2', from: [10, 0, 0], to: [10, 10, 0] },
    { kind: 'segment', featureId: 'segment-3', from: [10, 10, 0], to: [0, 0, 0] },
  ],
};

const OFFSET_REQUEST: SketchOffsetRequestItem = {
  featureId: 'offset-1',
  curves: [{ kind: 'segment', featureId: 'segment-1', from: [0, 0, 0], to: [10, 0, 0] }],
  distance: 2,
  corner: 'round',
};

const PROJECTION_REQUEST: SketchProjectionRequestItem = {
  featureId: 'projection-1',
  bodyKey: 'key-1',
  source: null,
  plane: WORK_PLANES.xy,
};

/** 基本形状(球)の段 1 つ(`measure/measureBridge.test.ts` の `fakeStep` と同じ作り)。 */
function fakeStep(featureId: string, key: string): ResolvedSolidStep {
  return {
    featureId,
    name: featureId,
    key,
    visible: true,
    plan: {
      kind: 'primitive',
      origin: [0, 0, 0],
      axis: [0, 0, 1],
      shape: { kind: 'sphere', radius: 10 },
      originQuery: null,
      targetKey: null,
    },
  };
}

describe('同じWorker接続で異なるSTEP原本を持つ2文書を交互に解決する', () => {
  it('同じshapeRefでも半径10/20の球の体積を混同せず、再訪は両方キャッシュに当たる', async () => {
    silentWorkers.clear();
    const api = createKernelApi(loadOcctForNode);
    const bridge = createKernelBridge();
    // Workerの輸送だけを同一プロセスで再現し、ComlinkとOCCTとキャッシュは実物を使う。
    Comlink.expose(api, silentWorkers.serverEndpoint());
    try {
      const documents = [];
      for (const radius of [10, 20]) {
        const source: ResolvedSolidStep = {
          ...fakeStep('source', `source-${radius}`),
          plan: {
            kind: 'primitive', origin: [0, 0, 0], axis: [0, 0, 1],
            shape: { kind: 'sphere', radius }, originQuery: null, targetKey: null,
          },
        };
        const progress = vi.fn();
        const cancel = vi.fn(() => false);
        // 中止は段と段の間だけ尋ねる契約。2段にして実際のcallback往復も検査する。
        const computed = await bridge.recomputeSolids([
          { ...source, featureId: 'prelude', visible: false }, source,
        ], {
          partId: `source-${radius}`, onProgress: progress, shouldCancel: cancel,
        });
        expect(computed.failures).toEqual([]);
        expect(computed.cacheHits).toBe(1);
        expect(progress).toHaveBeenCalled();
        expect(cancel).toHaveBeenCalledTimes(1);
        expect(bridge.pendingCallbacks()).toBe(0);
        const step = await api.exportShapes({
          partId: `source-${radius}`, format: 'step',
          bodies: [{ bodyKey: source.key, name: null, color: null }],
        });
        if (step.format !== 'step') throw new Error('STEPが必要');
        const imported = await bridge.importShape({ format: 'step', fileName: `${radius}.step`, bytes: step.bytes });
        if (imported.kind !== 'imported') throw new Error('取り込み結果が必要');
        const body = imported.bodies[0];
        if (body.bodyKind === 'mesh') throw new Error('B-repが必要');
        const document = appendSolid(createEmptyPartDocument(), {
          id: 'importedSolid-1', name: '読み込み', kind: 'importedSolid', suppressed: false,
          shapeRef: 'shape-1', bodyKind: 'solid',
          source: { format: 'step', fileName: `${radius}.step`, unit: 'mm', byteLength: step.bytes.length },
        });
        const resolved = resolvePart(document, { importedShapes: new Map([['shape-1', body.brepBytes]]) });
        documents.push({ resolved, radius });
      }
      expect(documents[0].resolved.steps[0].key).not.toBe(documents[1].resolved.steps[0].key);
      for (let visit = 0; visit < 4; visit += 1) {
        const { resolved, radius } = documents[visit % 2];
        const result = await bridge.recomputeSolids(resolved.steps, { partId: `part-${radius}` });
        expect(result.failures).toEqual([]);
        expect(result.bodies[0].volume).toBeCloseTo(4 * Math.PI * radius ** 3 / 3, 5);
        expect(result.cacheHits).toBe(visit < 2 ? 0 : 1);
      }
      expect(bridge.pendingWaiters()).toBe(0);
    } finally { bridge.dispose(); }
  }, 180_000);
});

describe('部品の識別子を kernel へ素通しする', () => {
  it.each([undefined, 'part:library-a'])('再計算・全書き出し形式・点検へ partId=%s を渡す', async (partId) => {
    const api = createKernelApi(() => Promise.reject(new Error('OCCT はこの検査では起動しない')));
    const recompute = vi.spyOn(api, 'recomputeSolids').mockResolvedValue({
      bodies: [], failures: [], cacheHits: 0, cancelled: false,
    });
    const exported = vi.spyOn(api, 'exportShapes').mockRejectedValue(new Error('依頼の受信までを検査'));
    const inspected = vi.spyOn(api, 'inspectPrintability').mockRejectedValue(new Error('依頼の受信までを検査'));
    const bridge = createDirectKernelBridge(api);
    const steps = [fakeStep('body-1', 'key-1')];
    try {
      await bridge.recomputeSolids(steps, { partId });
      expect(recompute.mock.calls[0][0]).toMatchObject({ partId });
      recompute.mockClear();
      const document = createEmptyPartDocument();
      await recomputePart(appendSolid(document, createPrimitiveFeature(document, 'box')), bridge, { partId });
      expect(recompute).toHaveBeenCalledTimes(1);
      expect(recompute.mock.calls[0][0]).toMatchObject({ partId });
      for (const format of ['step', 'stl', 'obj', 'gltf', 'mesh'] as const) {
        await bridge.exportShapes(steps, {
          partId, format, bodies: [{ featureId: 'body-1', name: null, color: null }],
          meshQuality: { deviationMm: 0.1, angularDeflectionRad: 0.5 },
          withColors: true, ascii: false, baseName: 'part',
        });
      }
      expect(exported).toHaveBeenCalledTimes(5);
      for (const [request] of exported.mock.calls) {
        expect(request).toMatchObject({ partId, bodies: [{ bodyKey: 'key-1' }] });
      }
      await bridge.inspectPrintability(steps, { partId, bodies: ['body-1'] });
      expect(inspected.mock.calls[0][0]).toMatchObject({ partId, bodies: [{ bodyKey: 'key-1' }] });
    } finally {
      bridge.dispose();
    }
  });
});

describe('createKernelBridge: Worker が黙ったまま壊れたとき(§2.9)', () => {
  beforeEach(() => {
    silentWorkers.clear();
  });

  it('RPC を25回成功させた後の破損待機登録数は0', async () => {
    silentWorkers.respondWith({ results: [{ id: 'offset-1', contours: [] }], failures: [] });
    const bridge = createKernelBridge();
    try {
      for (let index = 0; index < 25; index += 1) {
        await bridge.offsetSketchCurves([OFFSET_REQUEST]);
      }
      expect(bridge.pendingWaiters()).toBe(0);
      expect(bridge.operationCounts().success).toBe(25);
    } finally {
      silentWorkers.breakCurrent();
      bridge.dispose();
    }
  });

  it('個別RPCが拒否されても待機を解除しfailedとして数える', async () => {
    silentWorkers.rejectWith('operation failed');
    const bridge = createKernelBridge();
    try {
      await expect(bridge.offsetSketchCurves([OFFSET_REQUEST])).rejects.toThrow('operation failed');
      expect(bridge.pendingWaiters()).toBe(0);
      expect(bridge.operationCounts()).toEqual({ success: 0, failed: 1, cancelled: 0, workerBroken: 0 });
    } finally { bridge.dispose(); }
  });

  it('破損時に進行中の25件すべてをworkerBrokenで決着させる', async () => {
    const bridge = createKernelBridge();
    const requests = Array.from({ length: 25 }, () => bridge.offsetSketchCurves([OFFSET_REQUEST]));
    expect(bridge.pendingWaiters()).toBe(25);
    silentWorkers.breakCurrent();
    expect(bridge.pendingWaiters()).toBe(0);
    const results = await Promise.all(requests);
    expect(results).toHaveLength(25);
    for (const result of results) {
      expect(result.failures[0]?.message).toBe(KERNEL_BROKEN_MESSAGE);
      expect(bridge.operationStatus(result)).toBe('workerBroken');
    }
    expect(bridge.operationCounts()).toEqual({ success: 0, failed: 0, cancelled: 0, workerBroken: 25 });
    bridge.dispose();
  });

  it('disposeは25件を決着させ、再呼び出しでもWorkerを再開しない', async () => {
    const bridge = createKernelBridge();
    const requests = Array.from({ length: 25 }, () => bridge.offsetSketchCurves([OFFSET_REQUEST]));
    bridge.dispose();
    bridge.dispose();
    expect(bridge.pendingWaiters()).toBe(0);
    const outcomes = await Promise.all(requests);
    expect(outcomes).toHaveLength(25);
    for (const outcome of outcomes) expect(bridge.operationStatus(outcome)).toBe('cancelled');
    await bridge.offsetSketchCurves([OFFSET_REQUEST]);
    expect(bridge.operationCounts()).toEqual({ success: 0, failed: 0, cancelled: 26, workerBroken: 0 });
    expect(bridge.pendingWaiters()).toBe(0);
  });

  it.each(['success', 'failed', 'cancelled', 'workerBroken', 'dispose', 'postFailure'] as const)(
    '%sの後は進捗/中止callbackの登録とportが残らない', async (ending) => {
      const closed = vi.spyOn(MessagePort.prototype, 'close');
      if (ending === 'success' || ending === 'cancelled') {
        silentWorkers.respondWith({ bodies: [], failures: [], cacheHits: 0, cancelled: ending === 'cancelled' });
      } else if (ending === 'failed') {
        silentWorkers.rejectWith('job failed');
      } else if (ending === 'postFailure') {
        silentWorkers.failPost();
      }
      const bridge = createKernelBridge();
      try {
        const running = bridge.recomputeSolids([{ ...fakeStep('body-1', 'key-1'), visible: false }], {
          onProgress: () => undefined, shouldCancel: () => false,
        });
        if (ending === 'workerBroken') silentWorkers.breakCurrent();
        if (ending === 'dispose') bridge.dispose();
        if (ending === 'failed' || ending === 'postFailure') await expect(running).rejects.toThrow();
        else await running;
        expect(bridge.pendingWaiters()).toBe(0);
        expect(bridge.pendingCallbacks()).toBe(0);
        expect(closed).toHaveBeenCalledTimes(4);
        const status = ending === 'dispose' ? 'cancelled' : ending === 'postFailure' ? 'failed' : ending;
        expect(bridge.operationCounts()[status]).toBe(1);
      } finally {
        // 同期post失敗の設定を戻してからremoteを解放する。
        silentWorkers.clear();
        bridge.dispose();
        closed.mockRestore();
      }
    },
  );

  it('tessellateSketchFaces は頼んだ面ぶんの断りで解決する', async () => {
    const bridge = createKernelBridge();
    const pending = bridge.tessellateSketchFaces([FACE]);
    silentWorkers.breakCurrent();

    await expect(pending).resolves.toEqual({
      mesh: { faces: [] },
      failures: [{ featureId: 'face-1', message: KERNEL_BROKEN_MESSAGE }],
    });
    bridge.dispose();
  });

  it('recomputeSolids は画面に出る段ぶんの断りで解決する', async () => {
    const bridge = createKernelBridge();
    const pending = bridge.recomputeSolids([fakeStep('body-1', 'key-1')]);
    silentWorkers.breakCurrent();

    await expect(pending).resolves.toEqual({
      bodies: [],
      failures: [{ featureId: 'body-1', message: KERNEL_BROKEN_MESSAGE }],
      cacheHits: 0,
      cancelled: false,
      appearanceMatches: [],
    });
    bridge.dispose();
  });

  it('offsetSketchCurves は頼んだ件ぶんの断りで解決する', async () => {
    const bridge = createKernelBridge();
    const pending = bridge.offsetSketchCurves([OFFSET_REQUEST]);
    silentWorkers.breakCurrent();

    await expect(pending).resolves.toEqual({
      results: [],
      failures: [{ featureId: 'offset-1', message: KERNEL_BROKEN_MESSAGE }],
    });
    bridge.dispose();
  });

  it('projectSketchCurves は頼んだ件ぶんの断りで解決する', async () => {
    const bridge = createKernelBridge();
    const pending = bridge.projectSketchCurves([PROJECTION_REQUEST]);
    silentWorkers.breakCurrent();

    await expect(pending).resolves.toEqual({
      results: [],
      failures: [{ featureId: 'projection-1', message: KERNEL_BROKEN_MESSAGE }],
    });
    bridge.dispose();
  });

  it('sectionSketchCurves は頼んだ件ぶんの断りで解決する', async () => {
    const bridge = createKernelBridge();
    const pending = bridge.sectionSketchCurves([PROJECTION_REQUEST]);
    silentWorkers.breakCurrent();

    await expect(pending).resolves.toEqual({
      results: [],
      failures: [{ featureId: 'projection-1', message: KERNEL_BROKEN_MESSAGE }],
    });
    bridge.dispose();
  });

  it('measure は「測れなかった」(kind: failed)で解決する', async () => {
    const bridge = createKernelBridge();
    const pending = bridge.measure(
      [fakeStep('body-1', 'key-1')],
      [{ bodyFeatureId: 'body-1', subShape: null }],
      'massProperties',
    );
    silentWorkers.breakCurrent();

    // 測定の結果には「壊れた」を表す種類が無いので、呼び手が既に扱っている
    // `kind: 'failed'` で断る(理由の文はそのまま画面へ出る)。
    await expect(pending).resolves.toEqual({
      kind: 'failed',
      message: KERNEL_BROKEN_MESSAGE,
    });
    bridge.dispose();
  });

  it('exportShapes は「書き出せなかった」(kind: failed)で解決する', async () => {
    const bridge = createKernelBridge();
    const pending = bridge.exportShapes([fakeStep('body-1', 'key-1')], {
      format: 'step',
      bodies: [{ featureId: 'body-1', name: '球1', color: null }],
      meshQuality: null,
      withColors: true,
      ascii: false,
      baseName: 'model',
    });
    silentWorkers.breakCurrent();

    // 書き出しにも「壊れた」の種類は無いので、測定と同じ `kind: 'failed'` で断る。
    // ここで拒否(throw)にすると、書き出しのパネルが理由の出ないまま固まる。
    await expect(pending).resolves.toEqual({
      kind: 'failed',
      message: KERNEL_BROKEN_MESSAGE,
    });
    bridge.dispose();
  });

  it('inspectPrintability は「点検できなかった」(kind: failed)で解決する', async () => {
    const bridge = createKernelBridge();
    const pending = bridge.inspectPrintability([fakeStep('body-1', 'key-1')], {
      bodies: ['body-1'],
    });
    silentWorkers.breakCurrent();

    // 点検にも「壊れた」の種類は無いので、測定・書き出しと同じ `kind: 'failed'` で断る。
    // ここで拒否(throw)にすると、点検を押した画面が理由の出ないまま固まる(§0.a-0.19)。
    await expect(pending).resolves.toEqual({
      kind: 'failed',
      message: KERNEL_BROKEN_MESSAGE,
    });
    bridge.dispose();
  });

  it('importShape は「読み込めなかった」(kind: failed)で解決する', async () => {
    const bridge = createKernelBridge();
    const pending = bridge.importShape({
      format: 'step',
      fileName: 'box.step',
      bytes: new Uint8Array([1, 2, 3]),
    });
    silentWorkers.breakCurrent();

    await expect(pending).resolves.toEqual({
      kind: 'failed',
      message: KERNEL_BROKEN_MESSAGE,
    });
    bridge.dispose();
  });
});

describe('点検結果の表示メッシュ同一性', () => {
  it('bodyKey・meshRevision・triangleCount を model の結果へそのまま写す', () => {
    const outcome = toPrintabilityOutcome({
      triangleCount: 1,
      thinTriangles: new Uint8Array([0]),
      overhangTriangles: new Uint8Array([0]),
      openEdgeTriangles: new Uint8Array([0]),
      meshes: [{ bodyKey: 'key-1', meshRevision: 7, triangleCount: 1 }],
      summary: {
        triangleCount: 1,
        degenerateCount: 0,
        inspectedTriangleCount: 1,
        thinCount: 0,
        overhangCount: 0,
        openEdgeCount: 0,
        openEdgeTriangleCount: 0,
        watertight: true,
        minThicknessFoundMm: 10,
        minThicknessMm: 0.8,
        overhangAngleDeg: 45,
        cellSizeMm: 1.6,
      },
      cancelled: false,
    });

    expect(outcome.kind).toBe('inspected');
    if (outcome.kind !== 'inspected') {
      return;
    }
    expect(outcome.report.meshes).toEqual([
      { bodyKey: 'key-1', meshRevision: 7, triangleCount: 1 },
    ]);
  });
});
