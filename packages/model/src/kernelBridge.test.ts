import { createMainPhaseObserver, readMeshLedgerDiagnostics } from './kernelBridge.js';
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

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createKernelApi } from '@pointercad/kernel';
import type { AnalysisBoundaryReply, AnalysisBoundaryRequest } from './geometry/analysisMesh.js';
import type { SolidRecomputeRequest, SolidRecomputeResult } from '@pointercad/kernel';
import { exactExpressionValueFromNumber, expressionValueFromNumber } from '@pointercad/expression';
import * as Comlink from 'comlink';
import { loadOcctForNode } from '../../kernel/src/occt/loadOcct.node.js';
import { createShapeCache, type AcquiringShapeCache } from '../../kernel/src/worker/shapeCache.js';
import type { CachedSolid } from '../../kernel/src/worker/recomputeSolids.js';
import * as interferenceCommon from '../../kernel/src/occt/intersectionVolume.js';
import * as interferenceMesh from '../../kernel/src/occt/exportMesh.js';

import {
  createKernelBridge,
  createDirectKernelBridge,
  createDirectInterferenceKernelBridge,
  type MeshLedgerOwner,
  type AssemblyInterferenceInput,
  type AssemblyInterferenceResult,
  type AssemblyInterferenceProgress,
  KERNEL_BROKEN_MESSAGE,
  EXPORT_TIMEOUT_MS,
  EXPORT_TIMEOUT_MESSAGE,
  type ShapeExportOptions,
  toPrintabilityOutcome,
  selectMateTargetGeometry,
  type SolidBody,
  type SketchOffsetRequestItem,
  type SketchProjectionRequestItem,
} from './kernelBridge.js';
import { resolvePart, type ResolvedSolidStep } from './part/resolvePart.js';
import { appendSolid, createEmptyPartDocument, createPrimitiveFeature } from './part/createPartDocument.js';
import { recomputePart } from './part/recomputePart.js';
import { readReferenceBodies, ReferenceMeshScope } from './part/readReferenceBodies.js';
import { WORK_PLANES } from './sketch/planeMath.js';
import { createDrawingDocument } from './drawing/createDrawingDocument.js';
import { createDrawingResolveKernel, resolveDrawing } from './drawing/resolveDrawing.js';
import type { ResolvedCurve, ResolvedFace } from './sketch/types.js';
import type { SubShapeRef } from './geometry/subShapeRef.js';
import type { Vec3 } from './sketch/vec3.js';
import { createAssemblyDocument, DEFAULT_COMPONENT_PLACEMENT } from './assembly/createAssemblyDocument.js';
import { IDENTITY_PLACEMENT, type RigidPlacement } from './assembly/placementMath.js';
import type { ResolvedAssembly } from './assembly/resolveAssembly.js';
import type { AssemblyComponent, Mate, MateKind } from './assembly/types.js';
import { resolveMateTarget } from './assembly/constraints/mateTargets.js';
import { prepareMateResiduals, buildMateResidualReport, type MateResidualInput } from './assembly/constraints/mateResiduals.js';
import { collectMateVariables } from './assembly/constraints/mateVariables.js';

const silentWorkers = vi.hoisted(() => {
  let reply: { readonly value: unknown } | undefined;
  let rejection: string | undefined;
  let throwOnPost = false;
  let clonedReplyObserver: ((message: unknown) => void) | undefined;
  let receivedReplyObserver: ((message: unknown) => void) | undefined;
  let nextCreated: (() => void) | undefined;
  let postedRequestObserver: ((message: unknown) => void) | undefined;
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
      postedRequestObserver?.(message);
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
          clonedReplyObserver?.(data);
          queueMicrotask(() => {
            worker.dispatchEvent(new MessageEvent('message', { data }));
            receivedReplyObserver?.(data);
          });
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
    observeClonedReplies(observer: (message: unknown) => void): void { clonedReplyObserver = observer; },
    observeReceivedReplies(observer: (message: unknown) => void): void { receivedReplyObserver = observer; },
    observePostedRequests(observer: (message: unknown) => void): void { postedRequestObserver = observer; },
    connectNextCreated(callback: () => void): void { nextCreated = callback; },
    rejectWith(message: string): void { rejection = message; },
    failPost(): void { throwOnPost = true; },
    respondWith(value: unknown): void {
      reply = { value };
    },
    create(): SilentWorker {
      const worker = new SilentWorker();
      created.push(worker);
      const connect = nextCreated; nextCreated = undefined; connect?.();
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
      clonedReplyObserver = undefined; receivedReplyObserver = undefined; nextCreated = undefined;
      postedRequestObserver = undefined;
      created.length = 0;
      reply = undefined;
      rejection = undefined;
      throwOnPost = false;
    },
  };
});

describe('G2 JS receipt through real Comlink and direct dispatch', () => {
  beforeEach(() => silentWorkers.clear());
  function reply(limitBytes: number, cacheActiveBytes = 13): SolidRecomputeResult {
    return { bodies: [], failures: [], cacheHits: 0, cancelled: false, meshJsAccounting: {
      status: 'known', limitBytes, cacheActiveBytes, cacheRetiredBytes: 11,
      cacheProtectedBytes: 24, retainedReplyBytes: 30, requestPeakReservedBytes: 100,
    }, meshJsFinalAccounting: finalReading(limitBytes, cacheActiveBytes) };
  }
  /** Post-token union of an empty reply: only the cache remains, the retired copy is released. */
  function finalReading(limitBytes: number, cacheActiveBytes = 13) {
    return { status: 'known' as const, limitBytes, cacheActiveBytes, cacheRetiredBytes: 0,
      cacheProtectedBytes: 0, displayBackingBytes: 0, replyBackingBytes: 0,
      retainedBackingBytes: cacheActiveBytes, replyCloneReservedBytes: 0 };
  }

  it.each([false, true])('binds an empty local reply to immutable dispatch, Worker=%s', async worker => {
    const api = createKernelApi(loadOcctForNode);
    const requests: SolidRecomputeRequest[] = [];
    let announce: () => void = () => { throw new Error('dispatch wait not initialized'); };
    const reached = new Promise<void>(resolve => { announce = resolve; });
    let settle: ((value: SolidRecomputeResult) => void) | undefined;
    const compute = vi.spyOn(api, 'recomputeSolids').mockImplementation(request => {
      requests.push(request); announce();
      return new Promise<SolidRecomputeResult>(resolve => { settle = resolve; });
    });
    const bridge = worker ? createKernelBridge() : createDirectKernelBridge(api);
    if (worker) Comlink.expose(api, silentWorkers.serverEndpoint());
    const options = { partId: 'dispatch-A', generation: 7,
      localMesh: { maximumFloat32ErrorMm: 1e-4, maximumLiveMeshBytes: 1000 } };
    try {
      const pending = bridge.recomputeSolids([], options);
      await reached;
      options.partId = 'later-B'; options.generation = 8; options.localMesh.maximumLiveMeshBytes = 999;
      expect(requests).toHaveLength(1);
      expect(requests[0].partId).toBe('dispatch-A');
      expect(requests[0].generation).toBe(7);
      expect(requests[0].localMesh?.maximumLiveMeshBytes).toBe(1000);
      if (settle === undefined) throw new Error('dispatch resolver missing');
      settle(reply(1000));
      const result = await pending;
      expect(result.meshJsAccounting).toEqual({ partId: 'dispatch-A', generation: 7,
        reading: { status: 'known', limitBytes: 1000, cacheActiveBytes: 13, cacheRetiredBytes: 11,
          cacheProtectedBytes: 24, retainedReplyBytes: 30, requestPeakReservedBytes: 100 },
        final: finalReading(1000) });
      expect(result.kernelMemory).toBeUndefined();
      await bridge.recomputeSolids([]);
      expect(compute).toHaveBeenCalledTimes(1);
    } finally { compute.mockRestore(); bridge.dispose(); }
  });

  it.each([false, true])('does not relabel replies completing in reverse order, Worker=%s', async worker => {
    const api = createKernelApi(loadOcctForNode);
    const pending: { request: SolidRecomputeRequest; settle: (value: SolidRecomputeResult) => void }[] = [];
    let announce: () => void = () => { throw new Error('dispatch wait not initialized'); };
    const reached = new Promise<void>(resolve => { announce = resolve; });
    const compute = vi.spyOn(api, 'recomputeSolids').mockImplementation(request =>
      new Promise<SolidRecomputeResult>(settle => {
        pending.push({ request, settle }); if (pending.length === 2) announce();
      }));
    const bridge = worker ? createKernelBridge() : createDirectKernelBridge(api);
    if (worker) Comlink.expose(api, silentWorkers.serverEndpoint());
    try {
      const localMesh = { maximumFloat32ErrorMm: 1e-4, maximumLiveMeshBytes: 1000 };
      const a = bridge.recomputeSolids([], { partId: 'A', generation: 11, localMesh });
      const b = bridge.recomputeSolids([], { partId: 'B', generation: 12, localMesh });
      await reached;
      const second = pending.find(entry => entry.request.partId === 'B');
      const first = pending.find(entry => entry.request.partId === 'A');
      if (second === undefined || first === undefined) throw new Error('both dispatches required');
      second.settle(reply(1000, 23));
      const bResult = await b;
      first.settle(reply(1000));
      const aResult = await a;
      expect(bResult.meshJsAccounting?.partId).toBe('B');
      expect(bResult.meshJsAccounting?.generation).toBe(12);
      expect(aResult.meshJsAccounting?.partId).toBe('A');
      expect(aResult.meshJsAccounting?.generation).toBe(11);
      if (aResult.meshJsAccounting?.reading.status !== 'known'
        || bResult.meshJsAccounting?.reading.status !== 'known') throw new Error('known receipts required');
      expect(aResult.meshJsAccounting.reading.cacheActiveBytes).toBe(13);
      expect(bResult.meshJsAccounting.reading.cacheActiveBytes).toBe(23);
    } finally { compute.mockRestore(); bridge.dispose(); }
  });

  it.each([false, true])('accepts the real kernel post-token union for a local part, Worker=%s', async worker => {
    const api = createKernelApi(loadOcctForNode);
    // Keep the raw kernel reply typed; the spy's recorded results are untyped.
    const original = api.recomputeSolids.bind(api);
    const captured: { raw?: SolidRecomputeResult } = {};
    const compute = vi.spyOn(api, 'recomputeSolids').mockImplementation(async (...args) => {
      const raw = await original(...args);
      captured.raw = raw;
      return raw;
    });
    const bridge = worker ? createKernelBridge() : createDirectKernelBridge(api);
    if (worker) Comlink.expose(api, silentWorkers.serverEndpoint());
    const options = { partId: 'real-final', generation: 3,
      localMesh: { maximumFloat32ErrorMm: 1e-4, maximumLiveMeshBytes: 64 * 1024 * 1024 } };
    try {
      const empty = createEmptyPartDocument();
      const part = appendSolid(empty, createPrimitiveFeature(empty, 'box'));
      const recomputed = await recomputePart(part, bridge, options);
      expect(recomputed.errors).toEqual([]);
      expect(recomputed.bodies).toHaveLength(1);
      expect(compute).toHaveBeenCalledTimes(1);
      const kernelFinal = captured.raw?.meshJsFinalAccounting;
      if (kernelFinal?.status !== 'known') throw new Error('the real kernel must report a known final union');
      const receipt = recomputed.meshJsAccounting;
      expect(receipt?.final).toEqual(kernelFinal);
      const arrays = new Set(recomputed.bodies.flatMap(body => [body.mesh.positions.buffer,
        body.mesh.normals.buffer, body.mesh.indices.buffer, body.mesh.edgePositions.buffer]));
      const replyBytes = [...arrays].reduce((sum, buffer) => sum + buffer.byteLength, 0);
      expect(kernelFinal.replyBackingBytes).toBe(replyBytes);
      expect(kernelFinal.displayBackingBytes).toBe(replyBytes);
      expect(kernelFinal.cacheRetiredBytes).toBe(0);
      expect(kernelFinal.retainedBackingBytes).toBe(kernelFinal.cacheActiveBytes + replyBytes);
      expect(kernelFinal.retainedBackingBytes + kernelFinal.replyCloneReservedBytes)
        .toBeLessThanOrEqual(options.localMesh.maximumLiveMeshBytes);
    } finally {
      compute.mockRestore();
      bridge.dispose();
      await api.releasePart('real-final');
    }
  });

  it('broken transport returns no zero-filled local receipt', async () => {
    const bridge = createKernelBridge();
    try {
      const pending = bridge.recomputeSolids([fakeStep('shape', 'shape-key')], {
        localMesh: { maximumFloat32ErrorMm: 1e-4, maximumLiveMeshBytes: 1000 },
      });
      silentWorkers.breakCurrent();
      const result = await pending;
      expect(result.meshJsAccounting).toBeUndefined();
      expect(result.bodies).toEqual([]);
      expect(result.failures).toHaveLength(1);
      expect(result.failures[0].message).toBe(KERNEL_BROKEN_MESSAGE);
    } finally { bridge.dispose(); }
  });
});

describe.each([false, true])('G2 terminal facts through actual conversion, Worker=%s', worker => {
  beforeEach(() => silentWorkers.clear());
  const options = { partId: 'terminal-session', generation: 7,
    localMesh: { maximumFloat32ErrorMm: 1e-4, maximumLiveMeshBytes: 1000 } };

  function terminalReply(accounting: 'missing' | 'unknown' | 'known', cancelled: boolean,
    failed: boolean): SolidRecomputeResult {
    const partial: SolidRecomputeResult['bodies'][number] = {
      id: 'shape', coordinateFrame: { space: 'local', origin: [Number.NaN, 0, 0],
        maximumFloat32ErrorMm: 1e-4, maximumLiveMeshBytes: 999 },
      positions: new Float32Array([0, 0, 0]), normals: new Float32Array([0, 0, 1]),
      indices: new Uint32Array([0, 0, 0]), edgePositions: new Float32Array([0, 0, 0, 1, 0, 0]),
      triangleCount: 1, faceCount: 0, edgeCount: 0, volume: 1, bodyKind: 'solid',
      faces: [], edges: [], vertices: [], threadMarks: [],
    };
    const sidecar = accounting === 'missing' ? {} : { meshJsAccounting: accounting === 'known'
      ? { status: 'known' as const, limitBytes: 1000, cacheActiveBytes: 130, cacheRetiredBytes: 110,
          cacheProtectedBytes: 240, retainedReplyBytes: 300, requestPeakReservedBytes: 1000 }
      : { status: 'unknown' as const, limitBytes: 1000, reason: 'overflow' as const } };
    return { bodies: [partial], failures: failed ? [{ id: 'failed-shape', message: 'local budget exhausted' }] : [],
      cacheHits: 7, cancelled, memory: { wasmHeapBytes: 91, wasmHeapLimitBytes: 100 }, ...sidecar };
  }

  it.each([
    ['missing', false], ['missing', true], ['unknown', false], ['unknown', true], ['known', false], ['known', true],
  ] as const)(
    'keeps cancellation and WASM with %s accounting, failures=%s, through bridge and Part', async (accounting, failed) => {
      const api = createKernelApi(loadOcctForNode);
      const raw = terminalReply(accounting, true, failed);
      const compute = vi.spyOn(api, 'recomputeSolids').mockResolvedValue(raw);
      const monitored = worker ? createKernelBridge() : undefined;
      const bridge = monitored ?? createDirectKernelBridge(api);
      if (worker) Comlink.expose(api, silentWorkers.serverEndpoint());
      try {
        const outcome = await bridge.recomputeSolids([fakeStep('shape', 'shape-key')], options);
        expect(outcome.cancelled).toBe(true);
        expect(outcome.bodies).toEqual([]);
        expect(outcome.failures).toEqual(failed
          ? [{ featureId: 'failed-shape', message: 'local budget exhausted' }] : []);
        expect(outcome.cacheHits).toBe(7);
        expect(outcome.kernelMemory).toEqual({ usedBytes: 91, limitBytes: 100 });
        expect('meshJsAccounting' in outcome).toBe(false);
        if (monitored !== undefined) expect(monitored.operationStatus(outcome)).toBe('cancelled');
        const empty = createEmptyPartDocument();
        const part = appendSolid(empty, createPrimitiveFeature(empty, 'box'));
        const recomputed = await recomputePart(part, bridge, options);
        expect(recomputed.cancelled).toBe(true);
        expect(recomputed.bodies).toEqual([]);
        expect(recomputed.errors).toEqual([]);
        expect(recomputed.kernelMemory).toEqual({ usedBytes: 91, limitBytes: 100 });
        expect(recomputed.meshJsAccounting).toBeUndefined();
        expect(compute).toHaveBeenCalledTimes(2);
        if (monitored !== undefined) {
          expect(monitored.operationCounts()).toEqual({ success: 0, failed: 0, cancelled: 2, workerBroken: 0 });
          expect(monitored.pendingWaiters()).toBe(0);
          expect(monitored.pendingCallbacks()).toBe(0);
        }
      } finally { compute.mockRestore(); bridge.dispose(); }
    });

  it.each(['missing', 'unknown', 'known'] as const)(
    'preserves existing noncancelled failure facts with %s accounting', async accounting => {
      const api = createKernelApi(loadOcctForNode);
      const compute = vi.spyOn(api, 'recomputeSolids').mockResolvedValue(terminalReply(accounting, false, true));
      const monitored = worker ? createKernelBridge() : undefined;
      const bridge = monitored ?? createDirectKernelBridge(api);
      if (worker) Comlink.expose(api, silentWorkers.serverEndpoint());
      try {
        const outcome = await bridge.recomputeSolids([fakeStep('shape', 'shape-key')], options);
        expect(outcome.cancelled).toBe(false);
        expect(outcome.failures).toEqual([{ featureId: 'failed-shape', message: 'local budget exhausted' }]);
        expect(outcome.bodies).toEqual([]);
        expect(outcome.kernelMemory).toEqual({ usedBytes: 91, limitBytes: 100 });
        expect('meshJsAccounting' in outcome).toBe(false);
        if (monitored !== undefined) {
          expect(monitored.operationStatus(outcome)).toBe('failed');
          expect(monitored.pendingWaiters()).toBe(0);
          expect(monitored.pendingCallbacks()).toBe(0);
        }
      } finally { compute.mockRestore(); bridge.dispose(); }
    });

  it.each(['missing', 'unknown'] as const)(
    'rejects a successful %s reply through bridge and Part instead of certifying zero', async accounting => {
      const api = createKernelApi(loadOcctForNode);
      const raw = { ...terminalReply(accounting, false, false), bodies: [] };
      const compute = vi.spyOn(api, 'recomputeSolids').mockResolvedValue(raw);
      const monitored = worker ? createKernelBridge() : undefined;
      const bridge = monitored ?? createDirectKernelBridge(api);
      if (worker) Comlink.expose(api, silentWorkers.serverEndpoint());
      try {
        await expect(bridge.recomputeSolids([fakeStep('shape', 'shape-key')], options)).rejects.toThrow(RangeError);
        const empty = createEmptyPartDocument();
        const part = appendSolid(empty, createPrimitiveFeature(empty, 'box'));
        const recomputed = await recomputePart(part, bridge, options);
        expect(recomputed.cancelled).toBe(false);
        expect(recomputed.bodies).toEqual([]);
        expect(recomputed.errors.some(error => error.code === 'kernelFailed')).toBe(true);
        expect(recomputed.meshJsAccounting).toBeUndefined();
        expect(recomputed.kernelMemory).toBeUndefined();
        expect(compute).toHaveBeenCalledTimes(2);
        if (monitored !== undefined) {
          expect(monitored.operationCounts()).toEqual({ success: 0, failed: 2, cancelled: 0, workerBroken: 0 });
          expect(monitored.pendingWaiters()).toBe(0);
          expect(monitored.pendingCallbacks()).toBe(0);
        }
      } finally { compute.mockRestore(); bridge.dispose(); }
    });
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
    const nativeRecompute = api.recomputeSolids.bind(api);
    let nativeCancelChecks = 0;
    const nativeCalls = vi.spyOn(api, 'recomputeSolids').mockImplementation((request, options, progress, cancel, owner, admission) =>
      nativeRecompute(request, options, progress, async () => { nativeCancelChecks += 1; return await cancel?.() ?? false; }, owner, admission));
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
        nativeCancelChecks = 0;
        const cancel = vi.fn(() => false);
        // 初段を含む各段の開始前に中止を確認する。輸送越しでも初回進捗より先に届く。
        const computed = await bridge.recomputeSolids([
          { ...source, featureId: 'prelude', visible: false }, source,
        ], {
          partId: `source-${radius}`, onProgress: progress, shouldCancel: cancel,
        });
        expect(computed.failures).toEqual([]);
        // The tracked prelude cannot be a same-owner cache hit. This same-request sphere
        // copy has no origin rebinder (primitiveReuse supports box/cylinder only).
        expect(computed.cacheHits).toBe(0);
        expect(computed.bodies).toHaveLength(1);
        const sourceBody = computed.bodies[0];
        expect(sourceBody.featureId).toBe(source.featureId);
        expect(sourceBody.origins).toEqual({ version: 1, state: 'untracked', reason: 'unsupported-producer' });
        expect(sourceBody.volume).toBeCloseTo(4 * Math.PI * radius ** 3 / 3, 5);
        expect(progress).toHaveBeenCalled();
        expect(nativeCancelChecks).toBe(2); // One actual kernel check before each of the two steps.
        expect(cancel.mock.calls.length - nativeCancelChecks).toBe(1); // Independent main-side predispatch check.
        const nativeDispatchOrder = nativeCalls.mock.invocationCallOrder.at(-1);
        if (nativeDispatchOrder === undefined) throw new Error('Actual native dispatch required');
        expect(cancel.mock.invocationCallOrder[0]).toBeLessThan(nativeDispatchOrder);
        expect(cancel.mock.invocationCallOrder[0]).toBeLessThan(progress.mock.invocationCallOrder[0]);
        expect(bridge.pendingCallbacks()).toBe(0);
        // The same source owner must still hit the real cache; do not merely accept fewer hits.
        const revisited = await bridge.recomputeSolids([source], { partId: `source-${radius}` });
        expect(revisited.failures).toEqual([]);
        expect(revisited.cacheHits).toBe(1);
        expect(revisited.bodies).toHaveLength(1);
        expect(revisited.bodies[0].origins).toEqual(sourceBody.origins);
        expect(revisited.bodies[0].volume).toBeCloseTo(4 * Math.PI * radius ** 3 / 3, 5);
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
        // STEP/B-rep imports preserve shape bytes, not the primitive's construction origins.
        expect(result.bodies[0].origins).toEqual({ version: 1, state: 'untracked', reason: 'unsupported-producer' });
      }
      // Separate native calls reset primitiveReuse's per-request prototype map. These
      // single-step spheres take makePrimitive, so owner changes exercise the tracked
      // cache guard without assuming that a copied/imported sphere has native history.
      const ownerA = fakeStep('cache-owner-a', 'tracked-owner-control');
      const ownerB = { ...ownerA, featureId: 'cache-owner-b' };
      for (const [index, ownedStep] of [ownerA, ownerB, ownerB].entries()) {
        const owned = await bridge.recomputeSolids([ownedStep], { partId: 'tracked-owner-control' });
        expect(owned.failures).toEqual([]);
        expect(owned.cacheHits).toBe(index === 2 ? 1 : 0);
        expect(owned.bodies).toHaveLength(1);
        const ownedBody = owned.bodies[0];
        expect(ownedBody.featureId).toBe(ownedStep.featureId);
        expect(ownedBody.volume).toBeCloseTo(4 * Math.PI * 10 ** 3 / 3, 5);
        const origins = ownedBody.origins;
        if (origins?.state !== 'tracked') throw new Error('Fresh native sphere origin required');
        expect(origins.bindings).toHaveLength(1);
        expect(origins.bindings[0].origin).toEqual({ version: 1, shapeKind: 'face',
          identity: { kind: 'sphere-face', featureId: ownedStep.featureId, role: 'surface' } });
        expect(origins.bindings[0].state).toBe('unique');
      }
      expect(bridge.pendingWaiters()).toBe(0);
    } finally { nativeCalls.mockRestore(); bridge.dispose(); }
  }, 180_000);
});

describe('解析軸上点を実OCCTから合致へ渡す(P7-14b)', () => {
  function axisStep(kind: 'cylinder' | 'cone'): ResolvedSolidStep {
    const vertices: readonly Vec3[] = kind === 'cylinder'
      ? [[0, 0, 0], [5, 0, 0], [5, 0, 10], [0, 0, 10]]
      : [[0, 0, 0], [5, 0, 0], [0, 0, 10]];
    const profile = vertices.map((from, index): ResolvedCurve => ({
      kind: 'segment', featureId: `profile-${index}`, from, to: vertices[(index + 1) % vertices.length],
    }));
    return { featureId: 'axis-solid', name: kind, key: `axis-${kind}`, visible: true,
      plan: { kind: 'revolve', profile, axisOrigin: [0, 0, 0], axisDirection: [0, 0, 1], angle: Math.PI } };
  }

  async function withBody(
    kind: 'cylinder' | 'cone',
    inspect: (body: SolidBody, step: ResolvedSolidStep) => void,
    workerTransport = false,
  ): Promise<void> {
    const api = createKernelApi(loadOcctForNode);
    silentWorkers.clear();
    const bridge = workerTransport ? createKernelBridge() : createDirectKernelBridge(api);
    if (workerTransport) Comlink.expose(api, silentWorkers.serverEndpoint());
    try {
      const step = axisStep(kind);
      const result = await bridge.recomputeSolids([step], { partId: 'axis-part' });
      expect(result.failures).toEqual([]);
      expect(result.bodies).toHaveLength(1);
      inspect(result.bodies[0], step);
    } finally {
      await api.releasePart('axis-part');
      bridge.dispose();
    }
  }

  function faceReference(body: SolidBody, kind: 'cylinder' | 'cone'): SubShapeRef {
    const face = body.faces.find((entry) => entry.surfaceKind === kind);
    if (face === undefined) throw new Error('解析面が必要');
    // 文書に残るのは旧来の指紋だけ。axisOriginを手入力しない。
    return { bodyFeatureId: body.featureId, index: face.index,
      fingerprint: { kind: 'face', surfaceKind: face.surfaceKind, area: face.area,
        position: face.centroid, axis: face.axis, radius: face.radius } };
  }

  function residualInput(body: SolidBody, step: ResolvedSolidStep, ref: SubShapeRef, kind: MateKind): MateResidualInput {
    const components: AssemblyComponent[] = ['a', 'b'].map((id) => ({
      id, name: id, source: { kind: 'part', partRef: 'axis-part' },
      placement: DEFAULT_COMPONENT_PLACEMENT, fixed: id === 'b', visible: true, suppressed: false,
    }));
    const placements = new Map<string, RigidPlacement>([
      ['a', IDENTITY_PLACEMENT],
      ['b', kind === 'tangent' ? { ...IDENTITY_PLACEMENT, position: [0, 5, 0] } : IDENTITY_PLACEMENT],
    ]);
    const part = { ...resolvePart(createEmptyPartDocument()), steps: [step], liveBodyIds: [body.featureId] };
    const resolved: ResolvedAssembly = { parts: new Map([['axis-part', part]]), placements,
      partKeys: new Map([['a', 'axis-part'], ['b', 'axis-part']]), errors: [] };
    const mate: Mate = { id: 'mate-1', name: kind, kind,
      a: { kind: 'subShape', componentId: 'a', ref },
      b: { kind: 'origin', componentId: 'b', element: kind === 'tangent' ? 'xz' : 'z' },
      flipped: false, suppressed: false };
    const a = resolveMateTarget(mate.a, resolved, {
      subShape: (key, reference) => key === 'axis-part' ? selectMateTargetGeometry(body, reference) : null,
    });
    const b = resolveMateTarget(mate.b, resolved);
    if (!a.ok || !b.ok) throw new Error('合致対象の解決が必要');
    const prepared = prepareMateResiduals({ mates: [mate], targets: new Map([[mate.id, { a: a.target, b: b.target }]]), placements });
    expect(prepared.skipped).toEqual([]);
    expect(prepared.mates).toHaveLength(1);
    return { mates: prepared.mates, placements,
      variableSet: collectMateVariables({ ...createAssemblyDocument('組'), components }), characteristicLength: 1 };
  }

  function closePoint(actual: Vec3 | null | undefined, expected: Vec3): void {
    if (actual == null) throw new Error('解析点が必要');
    expected.forEach((value, index) => expect(Math.abs(actual[index] - value)).toBeLessThanOrEqual(1e-9));
  }

  it('Comlink往復で面・辺の解析点と重心を別々に保持する', async () => {
    await withBody('cylinder', (body) => {
      const face = body.faces.find((entry) => entry.surfaceKind === 'cylinder');
      if (face === undefined) throw new Error('円筒面が必要');
      closePoint(face.axisOrigin, [0, 0, 0]);
      closePoint(face.centroid, [0, 10 / Math.PI, 5]);
      const circles = body.edges.filter((edge) => edge.curveKind === 'circle');
      expect(circles).toHaveLength(2);
      for (const edge of circles) {
        const z = edge.midpoint[2] > 5 ? 10 : 0;
        closePoint(edge.axisOrigin, [0, 0, z]);
        closePoint(edge.midpoint, [0, 10 / Math.PI, z]);
      }
    }, true);
  });

  it('半円筒の古い指紋を実体から解決すると同心4行がゼロになる', async () => {
    await withBody('cylinder', (body, step) => {
      const input = residualInput(body, step, faceReference(body, 'cylinder'), 'concentric');
      const report = buildMateResidualReport(input);
      expect(report.skipped).toEqual([]);
      expect(report.rows).toHaveLength(4);
      expect(report.rows.every((row) => Math.abs(row.value) <= 1e-12)).toBe(true);
    });
  });

  it('実円筒の支持平面は接線2行がゼロ、傾けたtrialは方向残差が残る', async () => {
    await withBody('cylinder', (body, step) => {
      const input = residualInput(body, step, faceReference(body, 'cylinder'), 'tangent');
      const report = buildMateResidualReport(input);
      expect(report.skipped).toEqual([]);
      expect(report.rows).toHaveLength(2);
      expect(report.rows.every((row) => Math.abs(row.value) <= 1e-12)).toBe(true);
      const increments = input.variableSet.initial.map(() => 0);
      const column = input.variableSet.columnOf('a', 'rx');
      if (column === null) throw new Error('回転列が必要');
      increments[column] = Math.PI / 6;
      const tilted = buildMateResidualReport({ ...input, increments });
      expect(tilted.skipped).toEqual([]);
      expect(Math.abs(tilted.rows[0].value)).toBeGreaterThan(0.49);
    });
  });

  it('実半円錐の軸を重心から分離し、同心4行へ渡す', async () => {
    await withBody('cone', (body, step) => {
      const ref = faceReference(body, 'cone');
      const geometry = selectMateTargetGeometry(body, ref);
      closePoint(geometry?.axisOrigin, [0, 0, 0]);
      closePoint(geometry?.position, [0, 20 / (3 * Math.PI), 10 / 3]);
      const input = residualInput(body, step, ref, 'concentric');
      expect(input.mates[0].a.kind).toBe('axis');
      expect(input.mates[0].a.radius).toBeNull();
      const rows = buildMateResidualReport(input).rows;
      expect(rows).toHaveLength(4);
      expect(rows.every((row) => Math.abs(row.value) <= 1e-12)).toBe(true);
    });
  });

  it('実半円辺の中心を橋で取り直し、円周長の全周判定に依存せず同心へ渡す', async () => {
    await withBody('cylinder', (body, step) => {
      const edge = body.edges.find((entry) => entry.curveKind === 'circle');
      if (edge === undefined) throw new Error('円辺が必要');
      const ref: SubShapeRef = { bodyFeatureId: body.featureId, index: edge.index,
        fingerprint: { kind: 'edge', curveKind: edge.curveKind, length: edge.length,
          position: edge.midpoint, axis: edge.axis, radius: edge.radius } };
      expect(Math.abs(edge.length - 5 * Math.PI)).toBeLessThanOrEqual(1e-9);
      const input = residualInput(body, step, ref, 'concentric');
      const rows = buildMateResidualReport(input).rows;
      expect(rows).toHaveLength(4);
      expect(rows.every((row) => Math.abs(row.value) <= 1e-12)).toBe(true);
    });
  });

  it('古い面番号は現在の面へ照合し、別ボディや消えた面へ戻らない', async () => {
    await withBody('cylinder', (body) => {
      const ref = faceReference(body, 'cylinder');
      const changed = { ...body, faces: body.faces.map((face) => ({ ...face, index: face.index + 40 })) };
      const geometry = selectMateTargetGeometry(changed, ref);
      closePoint(geometry?.axisOrigin, [0, 0, 0]);
      expect(selectMateTargetGeometry({ ...body, featureId: 'other' }, ref)).toBeNull();
      expect(selectMateTargetGeometry({ ...body, faces: [] }, ref)).toBeNull();
    });
  });
});

describe('部品の識別子を kernel へ素通しする', () => {
  it('直接の橋も部品の解放と構造化した欠落確認を同じAPIへ渡す', async () => {
    const api = createKernelApi(() => Promise.reject(new Error('OCCTは使わない')));
    const release = vi.spyOn(api, 'releasePart');
    const check = vi.spyOn(api, 'checkShapeAvailability');
    const bridge = createDirectKernelBridge(api);
    await expect(bridge.checkShapeAvailability('part-2', ['shape-b'])).resolves.toEqual({
      partId: 'part-2', missingKeys: ['shape-b'],
    });
    await bridge.releasePart('part-2');
    expect(check).toHaveBeenCalledWith('part-2', ['shape-b']);
    expect(release).toHaveBeenCalledWith('part-2');
    bridge.dispose();
  });

  it('配置済み測定は明示body keyと世界配置を失わずkernelへ渡す', async () => {
    const api = createKernelApi(() => Promise.reject(new Error('OCCTは使わない')));
    const measure = vi.spyOn(api, 'measure').mockResolvedValue({ kind: 'distance', distance: 30,
      pointA: [20, 0, 0], pointB: [50, 0, 0], inner: false });
    const bridge = createDirectKernelBridge(api);
    try {
      const first = { position: [0, 0, 0] as const, rotation: [0, 0, 0, 1] as const };
      const second = { position: [50, 0, 0] as const, rotation: [0, 0, 0, 1] as const };
      await bridge.measure([], [
        { bodyFeatureId: 'same-id', bodyKey: 'part-a:body', subShape: null, placement: first },
        { bodyFeatureId: 'same-id', bodyKey: 'part-b:body', subShape: null, placement: second },
      ], 'distance');
      expect(measure).toHaveBeenCalledWith({ kind: 'distance', targets: [
        { bodyKey: 'part-a:body', subShape: null, placement: first },
        { bodyKey: 'part-b:body', subShape: null, placement: second },
      ] });
    } finally { bridge.dispose(); }
  });

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

describe('current native shape survives export preview cancellation', () => {
  beforeEach(() => silentWorkers.clear());

  it('reopened ordinary Part reaches its exact native key after a lone STL preview is cancelled', async () => {
    const api = createKernelApi(loadOcctForNode);
    const created = vi.spyOn(silentWorkers, 'create');
    const bridge = createKernelBridge();
    Comlink.expose(api, silentWorkers.serverEndpoint());
    const nativeExport = api.exportShapes.bind(api);
    let release = (): void => { throw new Error('preview gate missing'); };
    const gate = new Promise<void>(resolve => { release = resolve; });
    let started = (): void => { throw new Error('preview start missing'); };
    const entered = new Promise<void>(resolve => { started = resolve; });
    const exported = vi.spyOn(api, 'exportShapes').mockImplementationOnce(async request => {
      started();
      await gate;
      return nativeExport(request);
    });
    try {
      const empty = createEmptyPartDocument();
      const feature = createPrimitiveFeature(empty, 'box');
      const exact = exactExpressionValueFromNumber;
      const document = { ...appendSolid(empty, { ...feature, id: 'pg5a-box-1000000000',
        origin: { kind: 'coordinate' as const, value: { mode: 'absolute' as const,
          x: exact(1e9 + 3 / 128), y: exact(1e9 + 5 / 128), z: exact(1e9 + 7 / 128) } },
        shape: { kind: 'box' as const, sizeX: exact(0.5), sizeY: exact(0.375), sizeZ: exact(0.25) } }),
        id: 'pg5a-part-1000000000' };
      // Opened data is independently resolved, exactly as the UI's read-only exporter does.
      const reopened = structuredClone(document);
      const steps = resolvePart(reopened).steps;
      const current = await recomputePart(reopened, bridge, { generation: 7,
        localMesh: { maximumFloat32ErrorMm: 1e-4, maximumLiveMeshBytes: 512 * 1024 * 1024 } });
      expect(current.errors).toEqual([]);
      expect(current.bodies.map(body => body.featureId)).toEqual(['pg5a-box-1000000000']);
      const options: ShapeExportOptions = { format: 'stl', bodies: [{ featureId: 'pg5a-box-1000000000',
        name: null, color: null }], meshQuality: { deviationMm: 0.1, angularDeflectionRad: 0.5 },
        withColors: false, ascii: false, baseName: 'pg5a' };
      const controller = new AbortController();
      const pending = bridge.exportShapes(steps, { ...options, signal: controller.signal });
      await entered;
      // If cancellation closes the Worker, its replacement truthfully has no native shape.
      silentWorkers.connectNextCreated(() => Comlink.expose(createKernelApi(loadOcctForNode), silentWorkers.serverEndpoint()));
      controller.abort();
      await expect(pending).resolves.toEqual({ kind: 'cancelled' });
      release();
      const result = await bridge.exportShapes(steps, options);
      expect(result).toEqual({ kind: 'failed',
        message: 'STL に書き出せる面がありません。原点に近い位置へ移動するか、STEP を使ってください。' });
      expect(created).toHaveBeenCalledTimes(1);
      expect(exported.mock.calls.at(-1)?.[0]).toMatchObject({ partId: undefined,
        bodies: [{ bodyKey: steps[0].key }] });
      expect(await bridge.checkShapeAvailability('part:current', [steps[0].key, 'missing-key']))
        .toEqual({ partId: 'part:current', missingKeys: ['missing-key'] });
      await expect(bridge.exportShapes([], options)).resolves.toEqual({ kind: 'failed',
        message: 'もとになる立体が見つかりませんでした。もう一度計算し直してください。' });
      await expect(bridge.exportShapes(steps.map(step => ({ ...step, key: 'missing-key' })), options))
        .resolves.toEqual({ kind: 'failed',
          message: 'もとになる立体が見つかりませんでした。もう一度計算し直してください。' });
    } finally { release(); exported.mockRestore(); bridge.dispose(); created.mockRestore(); }
  });

  it.each(['wrong-part', 'wrong-feature', 'superseded-key'] as const)(
    'does not preserve a Worker for a %s association', async mismatch => {
      const api = createKernelApi(loadOcctForNode);
      const created = vi.spyOn(silentWorkers, 'create');
      const bridge = createKernelBridge();
      Comlink.expose(api, silentWorkers.serverEndpoint());
      const exported = vi.spyOn(api, 'exportShapes');
      try {
        const steps = [fakeStep('body-1', 'key-1')];
        await bridge.recomputeSolids(steps, { partId: 'live-part', generation: 7 });
        if (mismatch === 'superseded-key') {
          await bridge.recomputeSolids([fakeStep('body-1', 'key-2')], { partId: 'live-part', generation: 8 });
        }
        let started = (): void => { throw new Error('preview start missing'); };
        const entered = new Promise<void>(resolve => { started = resolve; });
        exported.mockImplementationOnce(() => { started(); return new Promise(() => undefined); });
        const controller = new AbortController();
        const featureId = mismatch === 'wrong-feature' ? 'other-feature' : 'body-1';
        const pending = bridge.exportShapes(steps.map(step => ({ ...step, featureId })), {
          partId: mismatch === 'wrong-part' ? 'other-part' : 'live-part', format: 'step',
          bodies: [{ featureId, name: null, color: null }], meshQuality: null,
          withColors: false, ascii: false, baseName: 'part', signal: controller.signal });
        await entered;
        controller.abort();
        await expect(pending).resolves.toEqual({ kind: 'cancelled' });
        expect(created).toHaveBeenCalledTimes(2);
        expect(bridge.pendingWaiters()).toBe(0);
      } finally { exported.mockRestore(); bridge.dispose(); created.mockRestore(); }
    },
  );

  it('a cancelled preview with a current owner still closes a silent native job at the original deadline', async () => {
    const api = createKernelApi(loadOcctForNode);
    const created = vi.spyOn(silentWorkers, 'create');
    const bridge = createKernelBridge();
    Comlink.expose(api, silentWorkers.serverEndpoint());
    const controller = new AbortController();
    const exported = vi.spyOn(api, 'exportShapes');
    try {
      const steps = [fakeStep('body-1', 'key-1')];
      await bridge.recomputeSolids(steps, { partId: 'live-part', generation: 7 });
      let started = (): void => { throw new Error('preview start missing'); };
      const entered = new Promise<void>(resolve => { started = resolve; });
      exported.mockImplementationOnce(() => { started(); return new Promise(() => undefined); });
      vi.useFakeTimers();
      const pending = bridge.exportShapes(steps, { partId: 'live-part', format: 'step',
        bodies: [{ featureId: 'body-1', name: null, color: null }], meshQuality: null,
        withColors: false, ascii: false, baseName: 'part', signal: controller.signal });
      await entered;
      controller.abort();
      await expect(pending).resolves.toEqual({ kind: 'cancelled' });
      expect(created).toHaveBeenCalledTimes(1);
      expect(bridge.pendingWaiters()).toBe(1);
      await vi.advanceTimersByTimeAsync(EXPORT_TIMEOUT_MS - 1);
      expect(created).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(created).toHaveBeenCalledTimes(2);
      expect(bridge.pendingWaiters()).toBe(0);
      expect(bridge.operationCounts()).toEqual({ success: 1, failed: 0, cancelled: 1, workerBroken: 0 });
    } finally { vi.useRealTimers(); exported.mockRestore(); bridge.dispose(); created.mockRestore(); }
  });
});

describe('createKernelBridge: Worker が黙ったまま壊れたとき(§2.9)', () => {
  beforeEach(() => {
    silentWorkers.clear();
  });

  const exportOptions = (signal?: AbortSignal): ShapeExportOptions => ({
    format: 'step', bodies: [{ featureId: 'body-1', name: null, color: null }],
    meshQuality: null, withColors: false, ascii: false, baseName: 'model',
    ...(signal === undefined ? {} : { signal }),
  });
  const coldRecomputeReply = () => ({
    bodies: [{ id: 'body-1', positions: Float32Array.of(0, 0, 0, 1, 0, 0, 0, 1, 0),
      normals: Float32Array.of(0, 0, 1, 0, 0, 1, 0, 0, 1), indices: Uint32Array.of(0, 1, 2),
      edgePositions: new Float32Array(), triangleCount: 1, faceCount: 0, edgeCount: 0,
      volume: 1, bodyKind: 'solid', faces: [], edges: [], vertices: [], threadMarks: [] }],
    failures: [], cacheHits: 0, cancelled: false,
  });

  it('開始前取消は送信0、唯一の実行中export取消だけWorkerを止め、旧返信を採らない', async () => {
    const created = vi.spyOn(silentWorkers, 'create');
    const bridge = createKernelBridge();
    try {
      const first = created.mock.results[0];
      if (first?.type !== 'return') throw new Error('first Worker missing');
      const sent = vi.spyOn(first.value, 'postMessage');
      const terminated = vi.spyOn(first.value, 'terminate');
      const prior = new AbortController();
      prior.abort();
      await expect(bridge.exportShapes([fakeStep('body-1', 'key-1')], exportOptions(prior.signal)))
        .resolves.toEqual({ kind: 'cancelled' });
      expect(sent).not.toHaveBeenCalled();
      expect(bridge.operationCounts()).toEqual({ success: 0, failed: 0, cancelled: 0, workerBroken: 0 });

      const controller = new AbortController();
      const running = bridge.exportShapes([fakeStep('body-1', 'key-1')], exportOptions(controller.signal));
      expect(bridge.pendingWaiters()).toBe(1);
      const original = sent.mock.calls.find(([message]) =>
        typeof message === 'object' && message !== null && 'type' in message && message.type === 'APPLY')?.[0];
      if (typeof original !== 'object' || original === null || !('id' in original)) {
        throw new Error('original export request missing');
      }
      controller.abort();
      await expect(running).resolves.toEqual({ kind: 'cancelled' });
      expect(terminated).toHaveBeenCalledTimes(1);
      expect(created).toHaveBeenCalledTimes(2);
      expect(bridge.pendingWaiters()).toBe(0);
      first.value.dispatchEvent(new MessageEvent('message', { data: {
        id: original.id, type: 'RAW', value: { format: 'step', bytes: Uint8Array.of(9), colorWritten: false },
      } }));
      await Promise.resolve();
      expect(bridge.operationCounts()).toEqual({ success: 0, failed: 0, cancelled: 1, workerBroken: 0 });

      silentWorkers.respondWith(coldRecomputeReply());
      const cold = await bridge.recomputeSolids([fakeStep('body-1', 'key-1')]);
      expect(cold).toMatchObject({ cacheHits: 0, failures: [], cancelled: false });
      expect(cold.bodies).toHaveLength(1);
      const completed = new AbortController();
      silentWorkers.respondWith({ format: 'step', bytes: Uint8Array.of(1), colorWritten: false });
      await expect(bridge.exportShapes([fakeStep('body-1', 'key-1')], exportOptions(completed.signal)))
        .resolves.toMatchObject({ kind: 'files', files: [{ bytes: Uint8Array.of(1) }] });
      expect(bridge.operationCounts()).toEqual({ success: 2, failed: 0, cancelled: 1, workerBroken: 0 });
      completed.abort();
      expect(created).toHaveBeenCalledTimes(2);
      expect(bridge.pendingWaiters()).toBe(0);
      expect(bridge.operationCounts()).toEqual({ success: 2, failed: 0, cancelled: 1, workerBroken: 0 });
    } finally { bridge.dispose(); created.mockRestore(); }
  });

  it('並行measureがある取消はAだけ即決着し、Bと旧Workerを止めず遅いAを捨てる', async () => {
    const created = vi.spyOn(silentWorkers, 'create');
    const bridge = createKernelBridge();
    try {
      const first = created.mock.results[0];
      if (first?.type !== 'return') throw new Error('first Worker missing');
      const sent = vi.spyOn(first.value, 'postMessage');
      const terminated = vi.spyOn(first.value, 'terminate');
      const controller = new AbortController();
      const a = bridge.exportShapes([fakeStep('body-1', 'key-1')], exportOptions(controller.signal));
      const b = bridge.measure([fakeStep('body-1', 'key-1')],
        [{ bodyFeatureId: 'body-1', subShape: null }], 'distance');
      const applies = sent.mock.calls.map(([message]) => message).filter((message) =>
        typeof message === 'object' && message !== null && 'type' in message && message.type === 'APPLY');
      expect(applies).toHaveLength(2);
      const [aRequest, bRequest] = applies;
      if (typeof aRequest !== 'object' || aRequest === null || !('id' in aRequest)
          || typeof bRequest !== 'object' || bRequest === null || !('id' in bRequest)) {
        throw new Error('concurrent request IDs missing');
      }
      controller.abort();
      await expect(a).resolves.toEqual({ kind: 'cancelled' });
      expect(terminated).not.toHaveBeenCalled();
      expect(bridge.pendingWaiters()).toBe(2); // A's native lease and B's caller.
      first.value.dispatchEvent(new MessageEvent('message', { data: { id: bRequest.id, type: 'RAW',
        value: { kind: 'distance', distance: 2, pointA: [0, 0, 0], pointB: [2, 0, 0], inner: false } } }));
      await expect(b).resolves.toMatchObject({ kind: 'distance', distance: 2 });
      first.value.dispatchEvent(new MessageEvent('message', { data: { id: aRequest.id, type: 'RAW',
        value: { format: 'step', bytes: Uint8Array.of(9), colorWritten: false } } }));
      for (let turn = 0; turn < 20 && bridge.pendingWaiters() !== 0; turn += 1) {
        await Promise.resolve();
      }
      expect(bridge.operationCounts()).toEqual({ success: 1, failed: 0, cancelled: 1, workerBroken: 0 });
      expect(bridge.pendingWaiters()).toBe(0);
      expect(terminated).not.toHaveBeenCalled();
    } finally { bridge.dispose(); created.mockRestore(); }
  });

  it('新しいexport Bが同じWorkerで待つ間に旧Aを取消してもBは成功する', async () => {
    const created = vi.spyOn(silentWorkers, 'create');
    const bridge = createKernelBridge();
    try {
      const first = created.mock.results[0];
      if (first?.type !== 'return') throw new Error('first Worker missing');
      const sent = vi.spyOn(first.value, 'postMessage');
      const terminated = vi.spyOn(first.value, 'terminate');
      const old = new AbortController();
      const a = bridge.exportShapes([fakeStep('body-1', 'key-1')], exportOptions(old.signal));
      const b = bridge.exportShapes([fakeStep('body-1', 'key-1')], exportOptions());
      const applies = sent.mock.calls.map(([message]) => message).filter((message) =>
        typeof message === 'object' && message !== null && 'type' in message && message.type === 'APPLY');
      expect(applies).toHaveLength(2);
      const [aRequest, bRequest] = applies;
      if (typeof aRequest !== 'object' || aRequest === null || !('id' in aRequest)
          || typeof bRequest !== 'object' || bRequest === null || !('id' in bRequest)) {
        throw new Error('concurrent export request IDs missing');
      }
      old.abort();
      await expect(a).resolves.toEqual({ kind: 'cancelled' });
      expect(terminated).not.toHaveBeenCalled();
      first.value.dispatchEvent(new MessageEvent('message', { data: { id: bRequest.id, type: 'RAW',
        value: { format: 'step', bytes: Uint8Array.of(2), colorWritten: false } } }));
      await expect(b).resolves.toMatchObject({ kind: 'files', files: [{ bytes: Uint8Array.of(2) }] });
      const unhandled: unknown[] = [];
      const onUnhandled = (reason: unknown): void => { unhandled.push(reason); };
      process.on('unhandledRejection', onUnhandled);
      try {
        first.value.dispatchEvent(new MessageEvent('message', { data: { id: aRequest.id, type: 'HANDLER',
          name: 'throw', value: { isError: true, value: { name: 'Error', message: 'late A rejection' } } } }));
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        expect(unhandled).toEqual([]);
      } finally { process.off('unhandledRejection', onUnhandled); }
      expect(created).toHaveBeenCalledTimes(1);
      expect(bridge.pendingWaiters()).toBe(0);
      expect(bridge.operationCounts()).toEqual({ success: 1, failed: 0, cancelled: 1, workerBroken: 0 });
    } finally { bridge.dispose(); created.mockRestore(); }
  });

  it('direct bridgeは開始前取消でnativeを呼ばず、同期native中の取消は返却時にだけ判定する', async () => {
    const api = createKernelApi(() => Promise.reject(new Error('OCCT unused')));
    const exportShapes = vi.spyOn(api, 'exportShapes');
    const bridge = createDirectKernelBridge(api);
    try {
      const before = new AbortController();
      before.abort();
      await expect(bridge.exportShapes([fakeStep('body-1', 'key-1')], exportOptions(before.signal)))
        .resolves.toEqual({ kind: 'cancelled' });
      expect(exportShapes).not.toHaveBeenCalled();
      const during = new AbortController();
      exportShapes.mockImplementation(() => {
        during.abort();
        return Promise.resolve({ format: 'step', bytes: Uint8Array.of(1), colorWritten: false });
      });
      await expect(bridge.exportShapes([fakeStep('body-1', 'key-1')], exportOptions(during.signal)))
        .resolves.toEqual({ kind: 'cancelled' });
      expect(exportShapes).toHaveBeenCalledTimes(1);
    } finally { bridge.dispose(); }
  });

  it('並行取消で残るnative Aは元25秒で復旧し、旧期限は新Workerへ作用しない', async () => {
    vi.useFakeTimers();
    const created = vi.spyOn(silentWorkers, 'create');
    const bridge = createKernelBridge();
    try {
      const first = created.mock.results[0];
      if (first?.type !== 'return') throw new Error('first Worker missing');
      const terminated = vi.spyOn(first.value, 'terminate');
      const controller = new AbortController();
      const a = bridge.exportShapes([fakeStep('body-1', 'key-1')], exportOptions(controller.signal));
      const b = bridge.measure([fakeStep('body-1', 'key-1')],
        [{ bodyFeatureId: 'body-1', subShape: null }], 'distance');
      controller.abort();
      await expect(a).resolves.toEqual({ kind: 'cancelled' });
      await vi.advanceTimersByTimeAsync(EXPORT_TIMEOUT_MS - 1);
      expect(terminated).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(terminated).toHaveBeenCalledTimes(1);
      await expect(b).resolves.toEqual({ kind: 'failed', message: KERNEL_BROKEN_MESSAGE });
      expect(bridge.operationCounts()).toEqual({ success: 0, failed: 0, cancelled: 2, workerBroken: 0 });
      expect(bridge.pendingWaiters()).toBe(0);
      silentWorkers.respondWith(coldRecomputeReply());
      const cold = await bridge.recomputeSolids([fakeStep('body-1', 'key-1')]);
      expect(cold).toMatchObject({ cacheHits: 0, failures: [], cancelled: false });
      expect(cold.bodies).toHaveLength(1);
      silentWorkers.respondWith({ format: 'step', bytes: Uint8Array.of(1), colorWritten: false });
      await expect(bridge.exportShapes([fakeStep('body-1', 'key-1')], exportOptions()))
        .resolves.toMatchObject({ kind: 'files' });
      await vi.advanceTimersByTimeAsync(EXPORT_TIMEOUT_MS);
      expect(created).toHaveBeenCalledTimes(2);
      expect(bridge.operationCounts()).toEqual({ success: 2, failed: 0, cancelled: 2, workerBroken: 0 });
    } finally { bridge.dispose(); created.mockRestore(); vi.useRealTimers(); }
  });

  const analysisRequest = (): AnalysisBoundaryRequest => ({
    bodyKey: 'analysis-key', boundary: 'open', linearDeflection: 0.02, angularDeflection: 0.15,
    freeformRefinement: { maximumChordDeviationMm: 0.02, maximumVolumeDeviationMm3: 0.1,
      maximumNodes: 1024, maximumTriangles: 2048 },
  });

  it('forwards analysis to the existing Worker with an owned request snapshot and unchanged reply', async () => {
    const reply: AnalysisBoundaryReply = { kind: 'mesh', bodyKey: 'analysis-key', mesh: {
      units: 'mm', boundary: 'open', coordinates: Float64Array.of(0, 0, 0, 1, 0, 0, 0, 1, 0),
      nodeKinds: Uint8Array.of(0, 0, 0), triangles: Uint32Array.of(0, 1, 2),
      triangleFaces: Uint32Array.of(0), nodeCount: 3, triangleCount: 1,
      faces: [{ index: 0, triangleCount: 1, reversed: false, seamEdges: 0,
        degeneratedEdges: 0, collapsedPoleTriangles: 0 }],
      edges: [{ index: 0, degenerated: false, uses: 1, nodes: [0, 1] },
        { index: 1, degenerated: false, uses: 1, nodes: [1, 2] },
        { index: 2, degenerated: false, uses: 1, nodes: [2, 0] }],
      metrics: { totalAreaMm2: 0.5, signedVolumeMm3: 0, minTriangleAreaMm2: 0.5,
        maxTriangleAreaMm2: 0.5, minAngleDeg: 45, maxAngleDeg: 90,
        maxBoundNodeOffsetMm: 0, freeEdges: 3, components: 1 },
      mesher: { done: true, status: 0 }, deflection: { linear: 0.02, angular: 0.15 },
    } };
    silentWorkers.respondWith(reply);
    const sent: unknown[] = [];
    silentWorkers.observePostedRequests(message => sent.push(message));
    const created = vi.spyOn(silentWorkers, 'create');
    const bridge = createKernelBridge();
    try {
      const request = { ...analysisRequest() };
      const expected = structuredClone(request);
      const pending = bridge.buildAnalysisSurfaceMesh(request);
      request.bodyKey = 'mutated-after-dispatch';
      expect(await pending).toEqual(reply);
      expect(sent).toContainEqual(expect.objectContaining({ type: 'APPLY',
        path: ['buildAnalysisSurfaceMesh'], argumentList: [{ type: 'RAW', value: expected }] }));
      expect(created).toHaveBeenCalledTimes(1);
      expect(bridge.pendingWaiters()).toBe(0);
      expect(bridge.operationCounts().success).toBe(1);
    } finally { bridge.dispose(); created.mockRestore(); }
  });

  it('preserves the native analysis refusal including its body, face and reason', async () => {
    const reply: AnalysisBoundaryReply = { kind: 'failed', bodyKey: 'analysis-key',
      code: 'triangle-limit', message: 'native capacity refused', faceIndex: 4 };
    silentWorkers.respondWith(reply);
    const bridge = createKernelBridge();
    try {
      const result = await bridge.buildAnalysisSurfaceMesh(analysisRequest());
      expect(result).toEqual(reply);
      expect(bridge.operationStatus(result)).toBe('failed');
      expect(bridge.pendingWaiters()).toBe(0);
    } finally { bridge.dispose(); }
  });

  it('returns an explicit analysis RPC failure and releases its waiter', async () => {
    silentWorkers.rejectWith('analysis RPC failed');
    const bridge = createKernelBridge();
    try {
      const result = await bridge.buildAnalysisSurfaceMesh(analysisRequest());
      expect(result).toEqual({ kind: 'failed', bodyKey: 'analysis-key', code: 'rpc-failed',
        message: 'analysis RPC failed', faceIndex: null });
      expect(bridge.operationStatus(result)).toBe('failed');
      expect(bridge.pendingWaiters()).toBe(0);
    } finally { bridge.dispose(); }
  });

  it.each(['dispose', 'broken'] as const)('settles the actual analysis request after %s without another Worker', async ending => {
    const created = vi.spyOn(silentWorkers, 'create');
    const bridge = createKernelBridge();
    try {
      const pending = bridge.buildAnalysisSurfaceMesh(analysisRequest());
      expect(bridge.pendingWaiters()).toBe(1);
      if (ending === 'dispose') bridge.dispose(); else silentWorkers.breakCurrent();
      const result = await pending;
      expect(result).toMatchObject({ kind: 'failed', bodyKey: 'analysis-key', code: 'worker-broken', faceIndex: null });
      expect(bridge.operationStatus(result)).toBe(ending === 'dispose' ? 'cancelled' : 'workerBroken');
      expect(bridge.pendingWaiters()).toBe(0);
      expect(created).toHaveBeenCalledTimes(1);
    } finally { bridge.dispose(); created.mockRestore(); }
  });

  it('releasePartの成功後は待機登録が0', async () => {
    silentWorkers.respondWith(undefined);
    const bridge = createKernelBridge();
    try {
      await bridge.releasePart('part-2');
      expect(bridge.pendingWaiters()).toBe(0);
      expect(bridge.operationCounts().success).toBe(1);
    } finally { bridge.dispose(); }
  });

  it('releasePartの拒否後も待機登録が0', async () => {
    silentWorkers.rejectWith('release failed');
    const bridge = createKernelBridge();
    try {
      await expect(bridge.releasePart('part-2')).rejects.toThrow('release failed');
      expect(bridge.pendingWaiters()).toBe(0);
      expect(bridge.operationCounts().failed).toBe(1);
    } finally { bridge.dispose(); }
  });

  it.each(['dispose', 'broken'] as const)('releasePartを%sで決着させる', async (ending) => {
    const bridge = createKernelBridge();
    const pending = bridge.releasePart('part-2');
    expect(bridge.pendingWaiters()).toBe(1);
    if (ending === 'dispose') bridge.dispose();
    else silentWorkers.breakCurrent();
    await pending;
    expect(bridge.pendingWaiters()).toBe(0);
    expect(bridge.operationCounts()[ending === 'dispose' ? 'cancelled' : 'workerBroken']).toBe(1);
    bridge.dispose();
  });

  it('欠落のpartIdとmissingKeysを構造化したまま公開する', async () => {
    silentWorkers.respondWith({ partId: 'part-2', missingKeys: ['shape-b'] });
    const bridge = createKernelBridge();
    try {
      const result = await bridge.checkShapeAvailability('part-2', ['shape-a', 'shape-b']);
      expect(result).toEqual({ partId: 'part-2', missingKeys: ['shape-b'] });
      expect(bridge.pendingWaiters()).toBe(0);
    } finally { bridge.dispose(); }
  });

  it('欠落確認中の破損は全鍵の再取得を通知し、永遠に待たない', async () => {
    const bridge = createKernelBridge();
    const pending = bridge.checkShapeAvailability('part-2', ['shape-b', 'shape-b']);
    silentWorkers.breakCurrent();
    const result = await pending;
    expect(result).toEqual({ partId: 'part-2', missingKeys: ['shape-b'] });
    expect(bridge.operationStatus(result)).toBe('workerBroken');
    expect(bridge.pendingWaiters()).toBe(0);
    bridge.dispose();
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
      const Channel = MessageChannel, channels: MessageChannel[] = [];
      const allocated = vi.spyOn(globalThis, 'MessageChannel').mockImplementation(function () {
        const channel = new Channel(); channels.push(channel); return channel;
      });
      let sent: () => void = () => { throw new Error('Dispatch handshake not installed'); };
      const dispatched = new Promise<void>(resolve => { sent = resolve; });
      silentWorkers.observePostedRequests(message => {
        if (typeof message === 'object' && message !== null && 'type' in message && message.type === 'APPLY'
          && 'path' in message && Array.isArray(message.path) && message.path[0] === 'recomputeSolids') sent();
      });
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
        // Transport cleanup is tested after the actual request, independently of the unsent-window regression.
        if (ending === 'workerBroken' || ending === 'dispose') await dispatched;
        if (ending === 'workerBroken') silentWorkers.breakCurrent();
        if (ending === 'dispose') bridge.dispose();
        if (ending === 'failed' || ending === 'postFailure') await expect(running).rejects.toThrow();
        else await running;
        expect(bridge.pendingWaiters()).toBe(0);
        expect(bridge.pendingCallbacks()).toBe(0);
        // Progress, cancellation and pre-clone admission each own one actual channel pair.
        expect(channels).toHaveLength(3);
        const ports = channels.flatMap(channel => [channel.port1, channel.port2]);
        expect(new Set(ports).size).toBe(6);
        for (const port of ports) expect(closed.mock.contexts.filter(context => context === port)).toHaveLength(1);
        expect(closed.mock.contexts.every(context => ports.some(port => port === context))).toBe(true);
        const status = ending === 'dispose' ? 'cancelled' : ending === 'postFailure' ? 'failed' : ending;
        expect(bridge.operationCounts()[status]).toBe(1);
      } finally {
        // 同期post失敗の設定を戻してからremoteを解放する。
        silentWorkers.clear();
        bridge.dispose();
        allocated.mockRestore(); closed.mockRestore();
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

  it('同期nativeが応答しない出力を25秒でWorkerごと止め、旧結果を成功にしない', async () => {
    vi.useFakeTimers();
    const created = vi.spyOn(silentWorkers, 'create');
    const bridge = createKernelBridge();
    try {
      const first = created.mock.results[0];
      if (first?.type !== 'return') throw new Error('first Worker missing');
      const terminated = vi.spyOn(first.value, 'terminate');
      const pending = bridge.exportShapes([fakeStep('body-1', 'key-1')], {
        format: 'stl', bodies: [{ featureId: 'body-1', name: '球1', color: null }],
        meshQuality: { deviationMm: 0.005, angularDeflectionRad: 0.2 },
        withColors: false, ascii: false, baseName: 'model',
      });
      await vi.advanceTimersByTimeAsync(EXPORT_TIMEOUT_MS - 1);
      expect(terminated).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await expect(pending).resolves.toEqual({ kind: 'failed', message: EXPORT_TIMEOUT_MESSAGE });
      expect(terminated).toHaveBeenCalledTimes(1);
      expect(created).toHaveBeenCalledTimes(2);
      expect(bridge.pendingWaiters()).toBe(0);
    } finally {
      bridge.dispose();
      vi.useRealTimers();
    }
  });

  it('STEP の同期native無応答も25秒で止め、旧応答を採らず次のWorkerで成功する', async () => {
    vi.useFakeTimers();
    const created = vi.spyOn(silentWorkers, 'create');
    created.mockClear();
    const bridge = createKernelBridge();
    const options = {
      format: 'step' as const,
      bodies: [{ featureId: 'body-1', name: '球1', color: null }],
      meshQuality: null,
      withColors: true, ascii: false, baseName: 'model',
    };
    try {
      const first = created.mock.results[0];
      if (first?.type !== 'return') throw new Error('first Worker missing');
      const sent = vi.spyOn(first.value, 'postMessage');
      const terminated = vi.spyOn(first.value, 'terminate');
      const pending = bridge.exportShapes([fakeStep('body-1', 'key-1')], options);
      await vi.advanceTimersByTimeAsync(EXPORT_TIMEOUT_MS - 1);
      const originalCall = sent.mock.calls.find(([message]) =>
        typeof message === 'object' && message !== null && 'type' in message && message.type === 'APPLY');
      const original = originalCall?.[0];
      if (typeof original !== 'object' || original === null || !('id' in original)) {
        throw new Error(`original STEP request missing: ${JSON.stringify(sent.mock.calls)}`);
      }
      expect(terminated).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await expect(pending).resolves.toEqual({ kind: 'failed', message: EXPORT_TIMEOUT_MESSAGE });
      expect(terminated).toHaveBeenCalledTimes(1);
      expect(created).toHaveBeenCalledTimes(2);
      expect(bridge.pendingWaiters()).toBe(0);
      first.value.dispatchEvent(new MessageEvent('message', { data: {
        id: original.id, type: 'RAW',
        value: { format: 'step', bytes: Uint8Array.of(9), colorWritten: false },
      } }));
      await Promise.resolve();
      expect(bridge.operationCounts().success).toBe(0);
      silentWorkers.respondWith({ format: 'step', bytes: Uint8Array.of(1, 2), colorWritten: false });
      await expect(bridge.exportShapes([fakeStep('body-1', 'key-1')], options)).resolves.toEqual({
        kind: 'files', files: [{ fileName: 'model.step', bytes: Uint8Array.of(1, 2) }],
        droppedTriangleCount: 0,
      });
      expect(bridge.operationCounts()).toEqual({ success: 1, failed: 1, cancelled: 0, workerBroken: 0 });
      expect(bridge.pendingWaiters()).toBe(0);
    } finally {
      bridge.dispose();
      vi.useRealTimers();
    }
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

describe('P7-25 干渉の実カーネルと輸送', () => {
  const cleanups: (() => Promise<void>)[] = [];
  beforeEach(() => silentWorkers.clear());
  afterEach(async () => { vi.restoreAllMocks(); for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
  function component(id: string, partRef = 'part-a'): AssemblyComponent {
    return { id, name: id, source: { kind: 'part', partRef }, placement: DEFAULT_COMPONENT_PLACEMENT,
      fixed: true, suppressed: false, visible: true };
  }
  async function fixture(multi = false, capacity = 16) {
    const cache = createShapeCache<CachedSolid>(capacity);
    const api = createKernelApi(loadOcctForNode, cache);
    const direct = createDirectInterferenceKernelBridge(api);
    let document = createEmptyPartDocument();
    document = appendSolid(document, createPrimitiveFeature(document, 'box'));
    if (multi) document = appendSolid(document, { ...createPrimitiveFeature(document, 'box'),
      shape: { kind: 'box', sizeX: expressionValueFromNumber(10), sizeY: expressionValueFromNumber(10), sizeZ: expressionValueFromNumber(10) } });
    let resolved = resolvePart(document);
    const computed = await recomputePart(document, direct, { partId: 'part-a', onResolved: (value) => { resolved = value; } });
    expect(computed.errors).toEqual([]);
    const parts = new Map([['part-a', resolved]]);
    const partKeys = new Map([['a', 'part-a'], ['b', 'part-a']]);
    const placements = new Map<string, RigidPlacement>([['a', IDENTITY_PLACEMENT], ['b', { ...IDENTITY_PLACEMENT, position: [15, 0, 0] }]]);
    const bodies = new Map<string, readonly SolidBody[]>([['part-a', computed.bodies]]);
    const input: AssemblyInterferenceInput = { requestId: 'document-25:version-4', components: [component('a'), component('b')],
      resolved: { parts, partKeys, placements, errors: [] }, bodies, placements };
    cleanups.push(async () => { direct.dispose(); await api.releasePart('part-a'); await api.releasePart('part-b'); cache.clear(); });
    return { api, cache, direct, input, document, resolved, parts, partKeys, placements, bodies, computed };
  }
  function check(result: AssemblyInterferenceResult, expectedPairs = 1): void {
    expect(result.kind).toBe('checked'); expect(result.failures).toEqual([]); expect(result.pairs).toHaveLength(expectedPairs);
    expect(result.totalPairCount).toBe(result.checkedPairCount + result.skippedPairCount + result.failures.length + result.pendingPairCount);
  }
  function connected(api: ReturnType<typeof createKernelApi>) {
    const bridge = createKernelBridge(); Comlink.expose(api, silentWorkers.serverEndpoint());
    cleanups.push(() => { bridge.dispose(); return Promise.resolve(); }); return bridge;
  }
  it.each([false, true])('P8 部品の再計算から図面のHLRと断面まで実カーネルへ通る(Worker=%s)', async (worker) => {
    const api = createKernelApi(loadOcctForNode);
    const bridge = worker ? connected(api) : createDirectKernelBridge(api);
    const empty = createEmptyPartDocument();
    const part = appendSolid(empty, createPrimitiveFeature(empty, 'box'));
    const source = { sourceRef: 'drawing-source', sourceKind: 'part' as const, contentHash: 'box-v1', fileName: 'box.pcad', path: '', importedAt: '2026-09-09T00:00:00Z' };
    const document = createDrawingDocument('図面', source);
    const drawing = { ...document, views: [{ id: 'front', name: '正面図', kind: 'front' as const, position: [100, 100] as const,
      scale: null, direction: [0, 0, 1] as const, xDir: [1, 0, 0] as const, showHidden: true, showCenterLines: true, layerId: 'visible' }] };
    const resolver = createDrawingResolveKernel(bridge, async () => {
      let resolved = resolvePart(part);
      const result = await recomputePart(part, bridge, { partId: 'drawing-source', onResolved: (value) => { resolved = value; } });
      expect(result.errors).toEqual([]);
      const visible = new Set(result.bodies.map((body) => body.featureId));
      return { bodyIds: resolved.steps.filter((step) => visible.has(step.featureId)).map((step) => step.key), center: [0, 0, 0] };
    });
    try {
      const projected = await resolveDrawing(drawing, resolver);
      expect(projected.ok).toBe(true);
      if (projected.ok) { expect(projected.failures).toEqual([]); expect(projected.views[0]?.visible).toHaveLength(4); }
      const prepared = await resolver.prepareDrawingSource(source);
      const requestView = { id: 'a', origin: [0, 0, 0] as const, normal: [0, 0, 1] as const,
        xDir: [1, 0, 0] as const, includeHidden: true, mode: 'precise' as const };
      const completed: number[] = [];
      const cancelled = await bridge.hiddenLineViews({ bodyIds: prepared.bodyIds,
        views: [requestView, { ...requestView, id: 'b' }] }, {
        onProgress: (value) => { completed.push(value.completed); }, shouldCancel: () => completed.length > 0,
      });
      expect(cancelled.cancelled).toBe(true); expect(cancelled.views).toHaveLength(1); expect(completed).toEqual([1]);
      const stoppedSection = await bridge.sectionViews({ bodyIds: prepared.bodyIds, view: requestView, kind: 'full',
        keepSide: 'positive', plane: { origin: [0, 0, 0], axisU: [1, 0, 0], normal: [0, 0, 1] } }, { shouldCancel: () => true });
      expect(stoppedSection.cancelled).toBe(true); expect(stoppedSection.visible).toEqual([]);
      const cut = await resolveDrawing({ ...drawing, views: [{ ...drawing.views[0], kind: 'section' }] }, resolver, {
        sections: { front: { kind: 'full', keepSide: 'positive', plane: { kind: 'workPlane', planeId: 'xy', offset: expressionValueFromNumber(0) } } },
        planeContext: { point: () => null, axis: () => null, workPlane: (id) => Object.values(WORK_PLANES).find((plane) => plane.id === id) ?? null },
      });
      expect(cut.ok).toBe(true);
      if (cut.ok) { expect(cut.failures).toEqual([]); expect(cut.views[0]?.visible).toHaveLength(4); expect(cut.views[0]?.cuttingCurves).toHaveLength(4); }
    } finally { await api.releasePart('drawing-source'); bridge.dispose(); }
  });
  function bridgeOnlyInput(): AssemblyInterferenceInput {
    return { requestId: 'old-generation', components: [component('a'), component('b')],
      resolved: { parts: new Map(), partKeys: new Map(), placements: new Map(), errors: [] }, bodies: new Map(), placements: new Map() };
  }
  it('B01 実recomputePartのliveBodyIds全体からbody keyを取り実APIでunionする', async () => {
    const context = await fixture(true); const calls = vi.spyOn(context.api, 'checkInterference');
    const result = await context.direct.checkInterference(context.input); check(result);
    const sent = calls.mock.calls[0][0].components[0]; if (sent.kind !== 'ready') throw new Error('ready');
    expect(sent.bodyKeys).toEqual(context.resolved.steps.filter((step) => context.resolved.liveBodyIds.includes(step.featureId)).map((step) => step.key).sort());
    expect(result.pairs[0].volume).toBeCloseTo(2000, 6);
  }, 180_000);
  it('B02 保存位置に依存せず提供世界配置xyz/xyzwを一回だけ使う', async () => {
    const context = await fixture(); const calls = vi.spyOn(context.api, 'checkInterference');
    context.placements.set('a', { position: [100, 20, 30], rotation: [0, 0, Math.SQRT1_2, Math.SQRT1_2] });
    context.placements.set('b', { position: [100, 35, 30], rotation: [0, 0, Math.SQRT1_2, Math.SQRT1_2] });
    const result = await context.direct.checkInterference(context.input); check(result); expect(result.pairs[0].volume).toBeCloseTo(2000, 6);
    expect(calls.mock.calls[0][0].components[0]).toMatchObject({ placement: { position: [100, 20, 30], rotation: [0, 0, Math.SQRT1_2, Math.SQRT1_2] } });
    const mesh = result.pairs[0].mesh.positions; expect(Math.min(...Array.from(mesh).filter((_, index) => index % 3 === 0))).toBeGreaterThan(80);
  });
  it('B03 別partの同名featureIdを各partのkeyへ分離する', async () => {
    const context = await fixture(); const empty = createEmptyPartDocument();
    const primitive = createPrimitiveFeature(empty, 'box');
    const small = appendSolid(empty, { ...primitive, shape: { kind: 'box', sizeX: expressionValueFromNumber(10), sizeY: expressionValueFromNumber(10), sizeZ: expressionValueFromNumber(10) } });
    let part = resolvePart(small);
    const output = await recomputePart(small, context.direct, { partId: 'part-b', onResolved: (value) => { part = value; } });
    context.parts.set('part-b', part); context.partKeys.set('b', 'part-b'); context.bodies.set('part-b', output.bodies); context.placements.set('b', IDENTITY_PLACEMENT);
    expect(part.steps[0].featureId).toBe(context.resolved.steps[0].featureId); expect(part.steps[0].key).not.toBe(context.resolved.steps[0].key);
    const result = await context.direct.checkInterference(context.input); check(result); expect(result.pairs[0].volume).toBeCloseTo(1000, 6);
  });
  it('B04 未解決/未計算/欠落snapshotを黙って省かない', async () => {
    const context = await fixture();
    for (const input of [
      { ...context.input, resolved: { ...context.input.resolved, parts: new Map() } },
      { ...context.input, bodies: new Map() },
      { ...context.input, placements: new Map() },
      { ...context.input, bodies: new Map([['part-a', []]]) },
    ]) {
      const result = await context.direct.checkInterference(input);
      expect(result.totalPairCount).toBe(1); expect(result.failures).toHaveLength(1); expect(result.checkedPairCount).toBe(0); expect(result.pendingPairCount).toBe(0);
    }
  });
  it('B05 0部品は固定noComponents文言、1部品は正常total0', async () => {
    const context = await fixture();
    const none = await context.direct.checkInterference({ ...context.input, components: [] });
    expect(none).toMatchObject({ kind: 'failed', failure: { code: 'noComponents', message: '調べる部品がありません。' }, totalPairCount: 0 });
    const one = await context.direct.checkInterference({ ...context.input, components: [component('a')] }); check(one, 0); expect(one.totalPairCount).toBe(0);
  });
  it('B06 unknown/self/重複componentはinvalidRequest、reverse pairは1回', async () => {
    const context = await fixture();
    for (const pair of [['a', 'missing'], ['a', 'a']]) {
      expect(await context.direct.checkInterference(context.input, { pairs: [[pair[0], pair[1]]] })).toMatchObject({ kind: 'failed', failure: { code: 'invalidRequest' } });
    }
    expect(await context.direct.checkInterference({ ...context.input, components: [component('a'), component('a')] })).toMatchObject({ kind: 'failed', failure: { code: 'invalidRequest' } });
    check(await context.direct.checkInterference(context.input, { pairs: [['b', 'a'], ['a', 'b']] }));
  });
  it('B07 await中のcaller Map変更でもsnapshotとrequestIdを保持する', async () => {
    const context = await fixture();
    const pending = context.direct.checkInterference(context.input);
    context.placements.clear(); context.parts.clear(); context.partKeys.clear(); context.bodies.clear();
    const result = await pending; check(result); expect(result.requestId).toBe('document-25:version-4'); expect(result.pairs[0].volume).toBeCloseTo(2000, 6);
  });
  it('B08 実MessageChannel/ComlinkがFloat32/Uint32を保持しnativeやdeleteを輸送しない', async () => {
    const context = await fixture(); const channel = new MessageChannel();
    Comlink.expose(context.api, channel.port1); const remote = Comlink.wrap<ReturnType<typeof createKernelApi>>(channel.port2);
    const calls = vi.spyOn(context.api, 'checkInterference');
    await context.direct.checkInterference(context.input); const dto = calls.mock.calls[0][0];
    const before = structuredClone(context.computed.bodies[0].mesh.positions);
    try {
      const result = await remote.checkInterference(dto);
      expect(result.pairs[0].mesh.positions).toBeInstanceOf(Float32Array); expect(result.pairs[0].mesh.normals).toBeInstanceOf(Float32Array); expect(result.pairs[0].mesh.indices).toBeInstanceOf(Uint32Array);
      expect(Object.keys(result.pairs[0].mesh).sort()).toEqual(['indices', 'normals', 'positions', 'triangleCount']);
      expect('shape' in result.pairs[0]).toBe(false); expect('delete' in result.pairs[0]).toBe(false);
      expect(context.computed.bodies[0].mesh.positions).toEqual(before);
    } finally { remote[Comlink.releaseProxy](); channel.port1.close(); channel.port2.close(); }
  });
  it('B09 lease中のreleasePart/容量圧迫でも借用shapeが生き終了保護数が戻る', async () => {
    const context = await fixture(false, 1); const key = context.resolved.steps[0].key;
    const source = context.cache.get(key); if (source === undefined) throw new Error('cache entry');
    let releaseGate: () => void = () => undefined; let announce: () => void = () => undefined;
    const entered = new Promise<void>((resolve) => { announce = resolve; }); const gate = new Promise<void>((resolve) => { releaseGate = resolve; });
    const original = context.api.checkInterference.bind(context.api);
    // callbackのawaitだけを制御し、実factory/acquire/native計算を全て通す。
    vi.spyOn(context.api, 'checkInterference').mockImplementation((request, progress, cancel) => original(request, async (value) => { announce(); await gate; await progress?.(value); }, cancel));
    const pending = context.direct.checkInterference(context.input); await entered;
    await context.api.releasePart('part-a'); expect(context.cache.has(key)).toBe(true);
    const pressure = { ...fakeStep('pressure', 'pressure-key'), plan: { kind: 'primitive', origin: [0, 0, 0], axis: [0, 0, 1], shape: { kind: 'sphere', radius: 3 }, originQuery: null, targetKey: null } } satisfies ResolvedSolidStep;
    await context.direct.recomputeSolids([pressure], { partId: 'part-b' }); await context.api.releasePart('part-b');
    expect(source.shape.IsNull()).toBe(false); expect(context.cache.stats().protectedKeyCount).toBe(1);
    releaseGate(); check(await pending); expect(context.cache.stats().protectedKeyCount).toBe(0);
  });
  it('B10 同key上書き中は旧entryを使い最後にretiredを解放、次回は新entry', async () => {
    const context = await fixture(); const key = context.resolved.steps[0].key;
    const old = context.cache.get(key); if (old === undefined) throw new Error('cache'); const oldDelete = vi.spyOn(old, 'delete');
    const otherStep = fakeStep('other', 'sphere-for-replacement'); await context.direct.recomputeSolids([otherStep], { partId: 'part-b' });
    const replacement = context.cache.get(otherStep.key); if (replacement === undefined) throw new Error('replacement');
    let changed = false;
    const pending = context.direct.checkInterference(context.input, { onProgress() {
      if (!changed) { changed = true; context.cache.set(key, { shape: replacement.shape, mesh: replacement.mesh, delete: () => undefined }); }
    } });
    const result = await pending; check(result); expect(result.pairs[0].volume).toBeCloseTo(2000, 6);
    expect(oldDelete).not.toHaveBeenCalled(); await context.api.releasePart('part-a'); expect(oldDelete).toHaveBeenCalledTimes(1);
    const next = await context.direct.checkInterference(context.input); check(next); expect(next.pairs[0].volume).not.toBeCloseTo(2000, 3);
  });
  it('B11 実Comlink進捗はrequestId一致・completed単調・終了後callback0', async () => {
    const context = await fixture(); const bridge = connected(context.api); const progress: AssemblyInterferenceProgress[] = [];
    check(await bridge.checkInterference(context.input, { onProgress: (value) => { progress.push(value); } }));
    expect(progress.length).toBeGreaterThan(0); expect(progress.every((value) => value.requestId === context.input.requestId)).toBe(true);
    expect(progress.map((value) => value.completedPairs)).toEqual(progress.map((value) => value.completedPairs).sort((a, b) => a - b));
    expect(bridge.pendingCallbacks()).toBe(0); expect(bridge.pendingWaiters()).toBe(0);
  });
  it('B12 native後mesh前にmacrotask取消が届きmeshと次Commonを始めない', async () => {
    const context = await fixture(); const bridge = connected(context.api); let cancel = false;
    const original = interferenceCommon.intersectionVolume;
    const common = vi.spyOn(interferenceCommon, 'intersectionVolume').mockImplementation((...args) => { const value = original(...args); setTimeout(() => { cancel = true; }, 0); return value; });
    const mesh = vi.spyOn(interferenceMesh, 'buildExportMesh');
    const result = await bridge.checkInterference(context.input, { shouldCancel: () => cancel });
    expect(result).toMatchObject({ cancelled: true, pendingPairCount: 1, checkedPairCount: 0, pairs: [] });
    expect(common).toHaveBeenCalledTimes(1); expect(mesh).not.toHaveBeenCalled(); expect(bridge.pendingCallbacks()).toBe(0);
  });
  it('B13 Worker errorはPromiseをworkerBrokenで決着しwaiter/callbackを残さない', async () => {
    const bridge = createKernelBridge(); const pending = bridge.checkInterference(bridgeOnlyInput(), { onProgress: () => undefined });
    silentWorkers.breakCurrent(); const result = await pending;
    expect(result).toMatchObject({ kind: 'failed', failure: { code: 'workerBroken' }, pendingPairCount: 1 });
    expect(bridge.operationStatus(result)).toBe('workerBroken'); expect(bridge.pendingWaiters()).toBe(0); expect(bridge.pendingCallbacks()).toBe(0); bridge.dispose();
  });
  it('B14 messageerrorも同じ破損経路で全通知を解放する', async () => {
    const created = vi.spyOn(silentWorkers, 'create'); const bridge = createKernelBridge();
    const pending = bridge.checkInterference(bridgeOnlyInput(), { onProgress: () => undefined });
    const worker = created.mock.results[0]; if (worker.type !== 'return') throw new Error('worker'); worker.value.dispatchEvent(new Event('messageerror'));
    const result = await pending; expect(bridge.operationStatus(result)).toBe('workerBroken'); expect(result).toMatchObject({ kind: 'failed', failure: { code: 'workerBroken' } });
    expect(bridge.pendingWaiters()).toBe(0); expect(bridge.pendingCallbacks()).toBe(0); bridge.dispose();
  });
  it('B15 postMessage同期throwでもscopeのcallback/port/waiterが残らない', async () => {
    const bridge = createKernelBridge(); silentWorkers.failPost();
    const result = await bridge.checkInterference(bridgeOnlyInput(), { onProgress: () => undefined });
    expect(result).toMatchObject({ kind: 'failed', failure: { code: 'rpcFailed' } }); expect(bridge.operationStatus(result)).toBe('failed');
    expect(bridge.pendingWaiters()).toBe(0); expect(bridge.pendingCallbacks()).toBe(0); bridge.dispose();
  });
  it('B16 RPC rejectと実部分失敗を構造化してsuccessと分類しない', async () => {
    const bridge = createKernelBridge(); silentWorkers.rejectWith('transport rejection');
    const rejected = await bridge.checkInterference(bridgeOnlyInput()); expect(rejected).toMatchObject({ kind: 'failed', failure: { code: 'rpcFailed' } }); expect(bridge.operationStatus(rejected)).toBe('failed'); bridge.dispose();
    silentWorkers.clear(); const context = await fixture(); const real = connected(context.api);
    const partial = await real.checkInterference({ ...context.input, bodies: new Map() });
    expect(partial.kind).toBe('checked'); expect(partial.failures).toHaveLength(1); expect(real.operationStatus(partial)).toBe('failed');
  });
  it('B17 disposeは旧requestIdを保ち遅い結果/進捗を無効にする', async () => {
    const context = await fixture(); const bridge = connected(context.api); let callbacks = 0;
    let announce: () => void = () => undefined; let finish: () => void = () => undefined;
    const completed = new Promise<void>((resolve) => { announce = resolve; });
    const gate = new Promise<void>((resolve) => { finish = resolve; });
    const original = context.api.checkInterference.bind(context.api);
    vi.spyOn(context.api, 'checkInterference').mockImplementation(async (...args) => {
      const result = await original(...args); announce(); await gate; return result;
    });
    const pending = bridge.checkInterference(context.input, { onProgress() { callbacks += 1; } });
    await completed; const callbackCount = callbacks; bridge.dispose(); finish();
    const result = await pending;
    expect(result.requestId).toBe(context.input.requestId); expect(result.cancelled).toBe(true); expect(bridge.operationStatus(result)).toBe('cancelled');
    await new Promise<void>((resolve) => setTimeout(resolve, 10)); expect(callbacks).toBe(callbackCount); expect(bridge.pendingCallbacks()).toBe(0); expect(bridge.pendingWaiters()).toBe(0);
  });
  it('B18 direct/Workerの結果が一致し旧基底overloadの計算口が使える', async () => {
    const context = await fixture(); const bridge = connected(context.api);
    const direct = await context.direct.checkInterference(context.input); expect(await bridge.checkInterference(context.input)).toEqual(direct);
    const legacy = createDirectKernelBridge(context.api); const measured = await legacy.measure(context.resolved.steps, [{ bodyFeatureId: context.resolved.steps[0].featureId, subShape: null }], 'massProperties');
    expect(measured.kind).not.toBe('failed'); legacy.dispose();
  });
  it('B19 callbackとlease解放が同時に失敗しても元理由と解放理由を保持する', async () => {
    const context = await fixture(); const before = context.cache.stats();
    const native = context.cache.release.bind(context.cache);
    vi.spyOn(context.cache, 'release').mockImplementationOnce((token) => { native(token); throw new Error('lease cleanup'); });
    const result = await context.direct.checkInterference(context.input, { onProgress() { throw new Error('progress failed'); } });
    expect(result).toMatchObject({ kind: 'failed', failure: { code: 'callbackFailed', message: 'progress failed', cleanupMessages: ['lease cleanup'] }, pendingPairCount: 1 });
    expect(context.cache.stats().protectedKeyCount).toBe(before.protectedKeyCount);
  });
  it('B20 2回目Common後の取消も再利用queueで直接mesh登録前に配送する', async () => {
    const context = await fixture(); const bridge = connected(context.api);
    const partKey = context.input.resolved.partKeys.get('b'); if (partKey === undefined) throw new Error('part key');
    const input: AssemblyInterferenceInput = { ...context.input, components: [...context.input.components, { ...context.input.components[1], id: 'c' }],
      resolved: { ...context.input.resolved, partKeys: new Map([...context.input.resolved.partKeys, ['c', partKey]]) },
      placements: new Map([...context.input.placements, ['c', { position: [10, 0, 0], rotation: [0, 0, 0, 1] }]]) };
    let cancel = false; let calls = 0; const native = interferenceCommon.intersectionVolume;
    const common = vi.spyOn(interferenceCommon, 'intersectionVolume').mockImplementation((...args) => {
      const result = native(...args); calls += 1; if (calls === 2) setTimeout(() => { cancel = true; }, 0); return result;
    });
    const mesh = vi.spyOn(interferenceMesh, 'buildExportMesh');
    const result = await bridge.checkInterference(input, { shouldCancel: () => cancel });
    expect(result).toMatchObject({ cancelled: true, checkedPairCount: 1, pendingPairCount: 2 });
    expect(common).toHaveBeenCalledTimes(2); expect(mesh).not.toHaveBeenCalled(); expect(bridge.pendingCallbacks()).toBe(0);
  });
  it('B21 開始前取消とqueue/lease解放故障をdirect結果へ全て残す', async () => {
    const context = await fixture(); const before = context.cache.stats(); const Channel = MessageChannel;
    const release = context.cache.release.bind(context.cache);
    vi.spyOn(context.cache, 'release').mockImplementationOnce((token) => { release(token); throw new Error('lease cleanup'); });
    vi.spyOn(globalThis, 'MessageChannel').mockImplementation(function () {
      const channel = new Channel(); const close = channel.port1.close.bind(channel.port1);
      channel.port1.close = () => { close(); throw new Error('queue cleanup'); }; return channel;
    });
    const result = await context.direct.checkInterference(context.input, { shouldCancel: () => true });
    expect(result).toMatchObject({ kind: 'failed', failure: { code: 'cleanupFailed', cleanupMessages: ['queue cleanup', 'lease cleanup'] },
      cancelled: true, totalPairCount: 1, checkedPairCount: 0, skippedPairCount: 0, failures: [], pendingPairCount: 1 });
    expect(context.cache.stats().protectedKeyCount).toBe(before.protectedKeyCount);
  });
  it('B22 実Comlinkは非同期relay故障を構造化して決着しcallback/leaseを返す', async () => {
    const context = await fixture(); const bridge = connected(context.api); const before = context.cache.stats();
    const Channel = MessageChannel; let commonStarted = false; const native = interferenceCommon.intersectionVolume;
    const common = vi.spyOn(interferenceCommon, 'intersectionVolume').mockImplementationOnce((...args) => {
      const result = native(...args); commonStarted = true; return result;
    });
    const channels = vi.spyOn(globalThis, 'MessageChannel').mockImplementation(function () {
      const channel = new Channel();
      // callback輸送は既に始まっている。Common後に作るkernelのqueueだけを故障させる。
      if (commonStarted) vi.spyOn(channel.port1, 'postMessage').mockImplementation(() => { throw new Error('worker relay'); });
      return channel;
    });
    const mesh = vi.spyOn(interferenceMesh, 'buildExportMesh');
    const result = await bridge.checkInterference(context.input);
    expect(result).toMatchObject({ kind: 'failed', failure: { code: 'unexpectedFailure', message: 'worker relay' }, cancelled: false,
      totalPairCount: 1, checkedPairCount: 0, skippedPairCount: 0, failures: [], pendingPairCount: 1 });
    expect(common).toHaveBeenCalledTimes(1); expect(mesh).not.toHaveBeenCalled();
    expect(bridge.pendingCallbacks()).toBe(0); expect(bridge.pendingWaiters()).toBe(0);
    expect(context.cache.stats().protectedKeyCount).toBe(before.protectedKeyCount);
    channels.mockRestore(); common.mockRestore();
    expect((await bridge.checkInterference(context.input)).kind).toBe('checked');
  });
});

// Candidate append to the fully read kernelBridge.test.ts; not executed.
describe('current global solid backing ledger through actual Comlink clones', () => {
  const cleanup: (() => void | Promise<void>)[] = [];
  beforeEach(() => silentWorkers.clear());
  afterEach(async () => { vi.restoreAllMocks(); for (const run of cleanup.splice(0).reverse()) await run(); });
  async function localBox(generation = 1, cache?: AcquiringShapeCache<CachedSolid>) {
    const api = createKernelApi(loadOcctForNode, cache), bridge = createKernelBridge();
    Comlink.expose(api, silentWorkers.serverEndpoint());
    cleanup.push(async () => { bridge.dispose(); await api.releasePart('ledger-part'); });
    const empty = createEmptyPartDocument(), document = appendSolid(empty, createPrimitiveFeature(empty, 'box'));
    const options = { partId: 'ledger-part', generation,
      localMesh: { maximumFloat32ErrorMm: 1e-4, maximumLiveMeshBytes: 64 * 1024 * 1024 } };
    if (bridge.captureCurrentMeshLedger === undefined) throw new Error('Current ledger capability required');
    const baseline = await bridge.captureCurrentMeshLedger({ observationId: 'before-own-allocation', owners: [] });
    if (baseline.status !== 'known') throw new Error('Known registered backing baseline required');
    const result = await recomputePart(document, bridge, options);
    if (bridge.meshLedgerOwner === undefined || bridge.captureCurrentMeshLedger === undefined
      || bridge.currentMeshLedgerReceipt === undefined || bridge.releaseReferenceMeshLease === undefined)
      throw new Error('Current ledger capability required');
    const owner = bridge.meshLedgerOwner(result.bodies);
    if (owner === null) throw new Error('Actual dispatch owner required');
    return { api, bridge, document, options, result, owner, baseline };
  }
  const bodyBytes = (bodies: readonly SolidBody[]) => [...new Set(bodies.flatMap(body => [body.mesh.positions.buffer,
    body.mesh.normals.buffer, body.mesh.indices.buffer, body.mesh.edgePositions.buffer]))]
    .reduce((sum, buffer) => sum + buffer.byteLength, 0);
  it.each(['workerBroken', 'dispose'] as const)('actual unreceived display closes before Comlink resolver release after %s without forgetting a held clone', async ending => {
    const first = await localBox();
    const held = first.result.bodies;
    const heldBytes = bodyBytes(held);
    expect(heldBytes).toBeGreaterThan(0);
    const blocked = vi.spyOn(first.api, 'recomputeSolids').mockImplementation(() => new Promise(() => undefined));
    let sent: () => void = () => { throw new Error('Actual dispatch handshake missing'); };
    const dispatched = new Promise<void>(resolve => { sent = resolve; });
    silentWorkers.observePostedRequests(message => {
      if (typeof message === 'object' && message !== null && 'type' in message && message.type === 'APPLY'
        && 'path' in message && Array.isArray(message.path) && message.path[0] === 'recomputeSolids') sent();
    });
    const running = first.bridge.recomputeSolids(resolvePart(first.document).steps, { ...first.options, generation: 2 });
    await dispatched;
    await vi.waitFor(() => expect(blocked).toHaveBeenCalledTimes(1));
    expect(first.bridge.pendingWaiters()).toBe(1);
    const pending = await first.bridge.captureCurrentMeshLedger?.({ observationId: 'actual-unreceived-before-close', owners: [first.owner] });
    expect(pending).toMatchObject({ status: 'unknown', reason: 'pending-reply' });
    if (ending === 'workerBroken') silentWorkers.breakCurrent(); else first.bridge.dispose();
    const outcome = await running;
    expect(first.bridge.operationStatus(outcome)).toBe(ending === 'workerBroken' ? 'workerBroken' : 'cancelled');
    expect(outcome.bodies).toEqual([]);
    first.bridge.dispose();
    expect(first.bridge.pendingWaiters()).toBe(0); expect(first.bridge.pendingCallbacks()).toBe(0);
    silentWorkers.observePostedRequests(() => undefined);
    const api = createKernelApi(loadOcctForNode), probe = createKernelBridge();
    cleanup.push(() => probe.dispose());
    Comlink.expose(api, silentWorkers.serverEndpoint());
    await vi.waitFor(async () => {
      const current = await probe.captureCurrentMeshLedger?.({ observationId: 'actual-unreceived-after-close', owners: [] });
      expect(current?.status).toBe('known');
      if (current?.status !== 'known') throw new Error('Exact pending request not settled');
      expect(current.pendingCloneReservedBytes).toBe(0);
      expect(current.hostRetainedBackingBytes).toBeGreaterThanOrEqual(heldBytes);
      expect(bodyBytes(held)).toBe(heldBytes);
      expect(current.unobserved).toContain('native'); expect(current.unobserved).toContain('gpu');
    });
    blocked.mockRestore();
  });
  it.each(['workerBroken', 'dispose'] as const)('an actual reserved but unsent display slot settles after %s and a fresh real census recovers', async ending => {
    const bridge = createKernelBridge();
    cleanup.push(() => bridge.dispose());
    let sent = 0;
    silentWorkers.observePostedRequests(message => {
      if (typeof message === 'object' && message !== null && 'type' in message && message.type === 'APPLY'
        && 'path' in message && Array.isArray(message.path) && message.path[0] === 'recomputeSolids') sent += 1;
    });
    const pending = bridge.recomputeSolids([fakeStep('unsent', 'unsent-key')], {
      localMesh: { maximumFloat32ErrorMm: 1e-4, maximumLiveMeshBytes: 64 * 1024 * 1024 } });
    // Reservation grant is synchronous; the bridge continuation resumes after this real async interruption window.
    if (ending === 'workerBroken') silentWorkers.breakCurrent(); else bridge.dispose();
    const result = await pending;
    expect(sent).toBe(0); expect(bridge.pendingCallbacks()).toBe(0); expect(bridge.pendingWaiters()).toBe(0);
    expect(bridge.operationStatus(result)).toBe(ending === 'workerBroken' ? 'workerBroken' : 'cancelled');
    expect(result.cancelled).toBe(ending === 'dispose');
    expect(result.failures).toEqual(ending === 'workerBroken' ? [{ featureId: 'unsent', message: KERNEL_BROKEN_MESSAGE }] : []);
    bridge.dispose();
    silentWorkers.observePostedRequests(() => undefined);
    const next = await localBox(); // Actual Comlink/current Worker baseline, then actual native recomputation.
    expect(next.baseline.pendingCloneReservedBytes).toBe(0); expect(next.result.errors).toEqual([]);
    const current = await next.bridge.captureCurrentMeshLedger?.({ observationId: 'after-unsent-display', owners: [next.owner] });
    expect(current?.status).toBe('known');
    if (current?.status !== 'known') throw new Error('Actual recovered current census');
    expect(current.pendingCloneReservedBytes).toBe(0);
  });
  it.each(['workerBroken', 'dispose'] as const)('an actual reserved but unsent hidden slot settles after %s without dropping a held main borrower', async ending => {
    const first = await localBox();
    const held = first.result.bodies;
    if (first.bridge.readCachedBodies === undefined) throw new Error('Actual hidden reader');
    let sent = 0;
    silentWorkers.observePostedRequests(message => {
      if (typeof message === 'object' && message !== null && 'type' in message && message.type === 'APPLY'
        && 'path' in message && Array.isArray(message.path) && message.path[0] === 'readCachedBodies') sent += 1;
    });
    const steps = resolvePart(first.document).steps;
    const pending = first.bridge.readCachedBodies(steps, [steps[0].featureId], {
      partId: 'ledger-part', generation: 1, maximumLiveMeshBytes: 64 * 1024 * 1024 });
    if (ending === 'workerBroken') silentWorkers.breakCurrent(); else first.bridge.dispose();
    const result = await pending;
    expect(sent).toBe(0); expect(first.bridge.pendingCallbacks()).toBe(0); expect(first.bridge.pendingWaiters()).toBe(0);
    expect(first.bridge.operationStatus(result)).toBe(ending === 'workerBroken' ? 'workerBroken' : 'cancelled');
    first.bridge.dispose(); await first.api.releasePart('ledger-part');
    silentWorkers.observePostedRequests(() => undefined);
    const next = await localBox();
    const current = await next.bridge.captureCurrentMeshLedger?.({ observationId: 'after-unsent-hidden', owners: [next.owner] });
    if (current?.status !== 'known') throw new Error('Actual recovered hidden census');
    expect(current.pendingCloneReservedBytes).toBe(0);
    expect(current.hostRetainedBackingBytes).toBeGreaterThanOrEqual(bodyBytes(held));
    expect(held[0].mesh.positions.buffer.byteLength).toBeGreaterThan(0);
  });
  it('diagnoses actual receipt invalidation without an extra query, pruning or resource ownership', async () => {
    const { api, bridge, document, owner, result } = await localBox();
    if (bridge.captureCurrentMeshLedger === undefined || bridge.currentMeshLedgerReceipt === undefined) throw new Error('Capability');
    const receipt = await bridge.captureCurrentMeshLedger({ observationId: 'diagnostic-current', owners: [owner] });
    if (receipt.status !== 'known') throw new Error('Actual current receipt');
    const query = vi.spyOn(api, 'readCurrentMeshAccounting');
    expect(bridge.currentMeshLedgerReceipt(receipt)).toBe(true);
    const before = readMeshLedgerDiagnostics();
    expect(before.validations.at(-1)).toMatchObject({ reason: null, issuedHostEpoch: receipt.hostEpoch,
      observedHostEpoch: receipt.hostEpoch, pendingCloneBytes: 0 });
    expect(readMeshLedgerDiagnostics()).toEqual(before); expect(query).not.toHaveBeenCalled();
    await bridge.checkShapeAvailability('ledger-part', resolvePart(document).steps.map(step => step.key));
    expect(bridge.currentMeshLedgerReceipt(receipt)).toBe(false);
    const after = readMeshLedgerDiagnostics();
    expect(after.validations.at(-1)).toMatchObject({ reason: 'host-epoch-changed', issuedHostEpoch: receipt.hostEpoch });
    expect(after.host.changes.some(change => change.epoch > receipt.hostEpoch
      && change.reason === 'owned-worker-dispatch-or-connection')).toBe(true);
    expect(readMeshLedgerDiagnostics()).toEqual(after); expect(query).not.toHaveBeenCalled();
    expect(result.bodies[0].mesh.positions.buffer.byteLength).toBeGreaterThan(0);
    expect(after.acceptanceComplete).toBe(false);
    bridge.dispose();
    expect(bridge.currentMeshLedgerReceipt(receipt)).toBe(false);
    expect(readMeshLedgerDiagnostics().validations.at(-1)).toMatchObject({ reason: 'bridge-disposed',
      issuedHostEpoch: null, observedHostEpoch: null, pendingCloneBytes: null });
    expect(query).not.toHaveBeenCalled();
    expect(result.bodies[0].mesh.positions.buffer.byteLength).toBeGreaterThan(0);
  });
  function holdActualLedgerQueries(api: ReturnType<typeof createKernelApi>, firstQueries: number) {
    const method = api.readCurrentMeshAccounting?.bind(api);
    if (method === undefined) throw new Error('Actual readonly mesh accounting capability required');
    const read = method;
    let release: () => void = () => undefined;
    let announce: () => void = () => undefined;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const entered = new Promise<void>(resolve => { announce = resolve; });
    let calls = 0;
    const query = vi.spyOn(api, 'readCurrentMeshAccounting').mockImplementation(async input => {
      calls += 1;
      if (calls === firstQueries) announce();
      await gate;
      return read(input);
    });
    return { entered, release, query };
  }
  it('overlapping readonly ledger captures do not invalidate each other across held real Comlink queries', async () => {
    const { api, bridge, owner, result } = await localBox();
    if (bridge.captureCurrentMeshLedger === undefined || bridge.currentMeshLedgerReceipt === undefined) throw new Error('Capability');
    const held = holdActualLedgerQueries(api, 2);
    const positions = result.bodies[0].mesh.positions.slice();
    const first = bridge.captureCurrentMeshLedger({ observationId: 'overlap-A', owners: [owner] });
    const second = bridge.captureCurrentMeshLedger({ observationId: 'overlap-B', owners: [owner] });
    try {
      await held.entered;
      expect(held.query).toHaveBeenCalledTimes(2);
      held.release();
      const [a, b] = await Promise.all([first, second]);
      expect(a.status).toBe('known'); expect(b.status).toBe('known');
      if (a.status !== 'known' || b.status !== 'known') throw new Error('Both readonly captures must be known');
      expect(a.pendingCloneReservedBytes).toBe(0); expect(b.pendingCloneReservedBytes).toBe(0);
      expect(bridge.currentMeshLedgerReceipt(a)).toBe(true); expect(bridge.currentMeshLedgerReceipt(b)).toBe(true);
      expect(held.query).toHaveBeenCalledTimes(4);
      expect(result.bodies[0].mesh.positions).toEqual(positions);
    } finally { held.release(); }
  });
  it('a real mutating dispatch invalidates an overlapping held ledger capture even after pending replies settle', async () => {
    const { api, bridge, owner, document, result } = await localBox();
    if (bridge.captureCurrentMeshLedger === undefined) throw new Error('Capability');
    const held = holdActualLedgerQueries(api, 1);
    const positions = result.bodies[0].mesh.positions.slice();
    const capture = bridge.captureCurrentMeshLedger({ observationId: 'overlap-mutation', owners: [owner] });
    try {
      await held.entered;
      await bridge.checkShapeAvailability('ledger-part', resolvePart(document).steps.map(step => step.key));
      expect(readMeshLedgerDiagnostics().host.pendingRequests).toBe(0);
      held.release();
      expect(await capture).toMatchObject({ status: 'unknown', reason: 'host-epoch-changed' });
      expect(held.query).toHaveBeenCalledTimes(2);
      expect(result.bodies[0].mesh.positions).toEqual(positions);
    } finally { held.release(); }
  });
  it('connection interruption prevents a held readonly capture from issuing a known old response', async () => {
    const { api, bridge, owner, result } = await localBox();
    if (bridge.captureCurrentMeshLedger === undefined) throw new Error('Capability');
    const held = holdActualLedgerQueries(api, 1);
    const positions = result.bodies[0].mesh.positions.slice();
    const capture = bridge.captureCurrentMeshLedger({ observationId: 'overlap-interrupted', owners: [owner] });
    try {
      await held.entered;
      silentWorkers.breakCurrent();
      held.release();
      expect(await capture).toMatchObject({ status: 'unknown', reason: 'transport-unavailable' });
      expect(bridge.pendingWaiters()).toBe(0); expect(bridge.pendingCallbacks()).toBe(0);
      expect(result.bodies[0].mesh.positions).toEqual(positions);
    } finally { held.release(); }
  });
  it('counts the actual main clone separately from Worker backing and performs two fresh observations on cache hit', async () => {
    const { api, bridge, result, owner, baseline } = await localBox();
    if (bridge.captureCurrentMeshLedger === undefined || bridge.currentMeshLedgerReceipt === undefined) throw new Error('Capability');
    const query = vi.spyOn(api, 'readCurrentMeshAccounting');
    const receipt = await bridge.captureCurrentMeshLedger({ observationId: 'actual-box', owners: [owner] });
    expect(query).toHaveBeenCalledTimes(2);
    expect(receipt.status).toBe('known');
    if (receipt.status !== 'known') throw new Error('Known registered solid scope required');
    expect(receipt.hostRetainedBackingBytes).toBeGreaterThanOrEqual(bodyBytes(result.bodies));
    expect(receipt.hostRetainedBackingBytes).toBeLessThanOrEqual(baseline.hostRetainedBackingBytes + bodyBytes(result.bodies));
    expect(receipt.workerRetainedBackingBytes).toBeGreaterThanOrEqual(bodyBytes(result.bodies));
    expect(receipt.admittedBoundBytes).toBe(receipt.workerRetainedBackingBytes + receipt.hostRetainedBackingBytes);
    expect(receipt.pendingCloneReservedBytes).toBe(0);
    expect(receipt.unobserved).toContain('native'); expect(receipt.unobserved).toContain('gpu');
    expect(bridge.currentMeshLedgerReceipt(receipt)).toBe(true);
    // An all-cache-hit batch must query again even when exact cached result/body objects are reused.
    const second = await bridge.captureCurrentMeshLedger({ observationId: 'cache-hit', owners: [owner] });
    expect(query).toHaveBeenCalledTimes(4);
    expect(second.status).toBe('known');
  });
  it('does not forget a strongly held old main clone after replacing the Worker display owner', async () => {
    const first = await localBox(), { bridge } = first;
    if (bridge.captureCurrentMeshLedger === undefined || bridge.meshLedgerOwner === undefined) throw new Error('Capability');
    const second = await recomputePart(first.document, bridge, { ...first.options, generation: 2 });
    const owner = bridge.meshLedgerOwner(second.bodies); if (owner === null) throw new Error('New owner');
    const receipt = await bridge.captureCurrentMeshLedger({ observationId: 'replace', owners: [owner] });
    if (receipt.status !== 'known') throw new Error('Current receipt');
    const heldOldSession = { slot: { bodies: first.result.bodies }, cancelled: true };
    expect(receipt.hostRetainedBackingBytes).toBeGreaterThanOrEqual(bodyBytes(heldOldSession.slot.bodies) + bodyBytes(second.bodies));
    expect(receipt.hostRetainedBackingBytes).toBeLessThanOrEqual(first.baseline.hostRetainedBackingBytes + bodyBytes(heldOldSession.slot.bodies) + bodyBytes(second.bodies));
    expect(await bridge.captureCurrentMeshLedger({ observationId: 'old-owner', owners: [first.owner] }))
      .toMatchObject({ status: 'unknown', reason: 'owner-mismatch' });
    expect(await bridge.captureCurrentMeshLedger({ observationId: 'forged', owners: [{ ...owner }] }))
      .toMatchObject({ status: 'unknown', reason: 'unissued-owner' });
  });
  it('cancelled local hidden request sends no native read and keeps the issued display owner', async () => {
    const { api, bridge, document, owner, options } = await localBox();
    if (bridge.readCachedBodies === undefined || bridge.captureCurrentMeshLedger === undefined) throw new Error('Actual hidden reader');
    const reader = vi.spyOn(api, 'readCachedBodies');
    const steps = resolvePart(document).steps;
    const result = await bridge.readCachedBodies(steps, [steps[0].featureId], {
      partId: options.partId, generation: options.generation,
      maximumLiveMeshBytes: options.localMesh.maximumLiveMeshBytes, localMesh: options.localMesh, shouldCancel: () => true });
    expect(result).toMatchObject({ cancelled: true, bodies: [], failures: [] });
    expect(reader).not.toHaveBeenCalled();
    expect(await bridge.captureCurrentMeshLedger({ observationId: 'after-local-hidden-cancel', owners: [owner] })).toMatchObject({ status: 'known' });
    expect(bridge.pendingCallbacks()).toBe(0); expect(bridge.pendingWaiters()).toBe(0);
  });

  it('actual Comlink hidden local request preserves issued receipt, receiver ACK and borrowed buffers after close', async () => {
    const { bridge, document, owner, options } = await localBox();
    if (bridge.readCachedBodies === undefined || bridge.meshLedgerOwner === undefined
      || bridge.captureCurrentMeshLedger === undefined || bridge.releaseReferenceMeshLease === undefined) throw new Error('Actual lease capabilities');
    const steps = resolvePart(document).steps;
    const hidden = await bridge.readCachedBodies(steps, [steps[0].featureId], {
      partId: options.partId, generation: options.generation,
      maximumLiveMeshBytes: options.localMesh.maximumLiveMeshBytes, localMesh: options.localMesh });
    expect(hidden.failures).toEqual([]);
    expect(hidden.bodies[0].coordinateFrame?.space).toBe('local');
    expect(hidden.bodies[0].mesh.positions.byteLength).toBeGreaterThan(0);
    expect(hidden.bodies[0].mesh.edgePositions.byteLength).toBeGreaterThan(0);
    const issued = bridge.meshLedgerOwner(hidden.bodies);
    if (issued === null) throw new Error('Actual hidden owner');
    expect(await bridge.captureCurrentMeshLedger({ observationId: 'local-hidden-issued', owners: [owner, issued] })).toMatchObject({ status: 'known' });
    const borrowed = hidden.bodies[0].mesh.positions;
    expect(await bridge.releaseReferenceMeshLease(issued)).toEqual({ released: true });
    expect(borrowed.byteLength).toBeGreaterThan(0);
    expect(await bridge.captureCurrentMeshLedger({ observationId: 'local-hidden-retired', owners: [issued] })).toMatchObject({ status: 'unknown', reason: 'owner-mismatch' });
    expect(bridge.pendingCallbacks()).toBe(0); expect(bridge.pendingWaiters()).toBe(0);
  });

  it('hidden token release has a real Worker acknowledgement while an old strong host borrower remains counted', async () => {
    const { bridge, document, result, owner, baseline } = await localBox();
    if (bridge.readCachedBodies === undefined || bridge.meshLedgerOwner === undefined
      || bridge.releaseReferenceMeshLease === undefined || bridge.captureCurrentMeshLedger === undefined) throw new Error('Capability');
    const steps = resolvePart(document).steps;
    const hidden = await bridge.readCachedBodies(steps, [steps[0].featureId], {
      partId: 'ledger-part', generation: 1, maximumLiveMeshBytes: 64 * 1024 * 1024 });
    const hiddenOwner = bridge.meshLedgerOwner(hidden.bodies); if (hiddenOwner === null) throw new Error('Hidden owner');
    const before = await bridge.captureCurrentMeshLedger({ observationId: 'hidden', owners: [owner, hiddenOwner] });
    if (before.status !== 'known') throw new Error('Certified current hidden registration');
    const oldSession = { candidates: [{ body: hidden.bodies[0] }], cancelled: true };
    expect(await bridge.releaseReferenceMeshLease(hiddenOwner)).toEqual({ released: true });
    const after = await bridge.captureCurrentMeshLedger({ observationId: 'released-token', owners: [owner] });
    if (after.status !== 'known') throw new Error('Current display scope');
    expect(after.hostRetainedBackingBytes).toBeGreaterThanOrEqual(bodyBytes(result.bodies) + bodyBytes(hidden.bodies));
    expect(after.hostRetainedBackingBytes).toBeLessThanOrEqual(baseline.hostRetainedBackingBytes + bodyBytes(result.bodies) + bodyBytes(hidden.bodies));
    expect(oldSession.candidates[0].body.mesh.positions.buffer.byteLength).toBeGreaterThan(0);
    expect(await bridge.captureCurrentMeshLedger({ observationId: 'released-owner', owners: [hiddenOwner] }))
      .toMatchObject({ status: 'unknown', reason: 'owner-mismatch' });
    expect(await bridge.releaseReferenceMeshLease(hiddenOwner)).toEqual({ released: false, absent: true });
  });
  it('invalidates issued receipts on a real owned RPC and never certifies an unregistered historical hidden read', async () => {
    const { bridge, document, owner } = await localBox();
    if (bridge.captureCurrentMeshLedger === undefined || bridge.currentMeshLedgerReceipt === undefined
      || bridge.readCachedBodies === undefined) throw new Error('Capability');
    const receipt = await bridge.captureCurrentMeshLedger({ observationId: 'before-rpc', owners: [owner] });
    expect(bridge.currentMeshLedgerReceipt(receipt)).toBe(true);
    await bridge.checkShapeAvailability('ledger-part', resolvePart(document).steps.map(step => step.key));
    expect(bridge.currentMeshLedgerReceipt(receipt)).toBe(false);
    const steps = resolvePart(document).steps;
    await bridge.readCachedBodies(steps, [steps[0].featureId]);
    expect(await bridge.captureCurrentMeshLedger({ observationId: 'legacy-hidden', owners: [owner] }))
      .toMatchObject({ status: 'unknown', reason: 'uncertified-hidden-read' });
  });
  it('a second real bridge is included in the global current union and closing it retains its held main clone', async () => {
    const first = await localBox(), second = await localBox();
    if (first.bridge.captureCurrentMeshLedger === undefined || first.bridge.currentMeshLedgerReceipt === undefined) throw new Error('Capability');
    const receipt = await first.bridge.captureCurrentMeshLedger({ observationId: 'two-bridges', owners: [first.owner, second.owner] });
    if (receipt.status !== 'known') throw new Error('Global union');
    expect(receipt.workerEpochs).toHaveLength(2);
    expect(new Set(receipt.workerEpochs.map(epoch => epoch.providerId)).size).toBe(2);
    expect(receipt.hostRetainedBackingBytes).toBeGreaterThanOrEqual(bodyBytes(first.result.bodies) + bodyBytes(second.result.bodies));
    expect(receipt.hostRetainedBackingBytes).toBeLessThanOrEqual(first.baseline.hostRetainedBackingBytes + bodyBytes(first.result.bodies) + bodyBytes(second.result.bodies));
    const secondSnapshot = await second.api.readCurrentMeshAccounting?.({ observationId: 'second-independent', limitBytes: 512 * 1024 * 1024, expectedOwners: [second.owner] });
    expect(secondSnapshot?.status).toBe('known');
    if (secondSnapshot?.status !== 'known') throw new Error('Independent second Worker');
    expect(receipt.workerRetainedBackingBytes).toBeGreaterThanOrEqual(secondSnapshot.reading.retainedBackingBytes + bodyBytes(first.result.bodies));
    const held = { bodies: second.result.bodies };
    second.bridge.dispose();
    expect(first.bridge.currentMeshLedgerReceipt(receipt)).toBe(false);
    const after = await first.bridge.captureCurrentMeshLedger({ observationId: 'second-closed', owners: [first.owner] });
    if (after.status !== 'known') throw new Error('Remaining managed Worker');
    expect(after.workerEpochs).toHaveLength(1);
    expect(after.hostRetainedBackingBytes).toBeGreaterThanOrEqual(bodyBytes(first.result.bodies) + bodyBytes(held.bodies));
    expect(after.hostRetainedBackingBytes).toBeLessThanOrEqual(receipt.hostRetainedBackingBytes);
    expect(held.bodies[0].mesh.positions.byteLength).toBeGreaterThan(0);
  });
  it('real world Part computation can be followed by local Assembly admission without a permanent world unknown', async () => {
    const first = await localBox();
    const world = await recomputePart(first.document, first.bridge, { partId: 'world-part', generation: 2 });
    expect(world.bodies[0].mesh.positions.byteLength).toBeGreaterThan(0);
    const local = await recomputePart(first.document, first.bridge, { ...first.options, generation: 3 });
    if (first.bridge.meshLedgerOwner === undefined || first.bridge.captureCurrentMeshLedger === undefined) throw new Error('Capability');
    const worldOwner = first.bridge.meshLedgerOwner(world.bodies), localOwner = first.bridge.meshLedgerOwner(local.bodies);
    if (worldOwner === null || localOwner === null) throw new Error('Actual world/local owners');
    const receipt = await first.bridge.captureCurrentMeshLedger({ observationId: 'world-then-local', owners: [worldOwner, localOwner] });
    if (receipt.status !== 'known') throw new Error('World clone must be registered, not sticky unknown');
    expect(receipt.hostRetainedBackingBytes).toBeGreaterThanOrEqual(bodyBytes(first.result.bodies) + bodyBytes(world.bodies) + bodyBytes(local.bodies));
    expect(receipt.hostRetainedBackingBytes).toBeLessThanOrEqual(first.baseline.hostRetainedBackingBytes + bodyBytes(first.result.bodies) + bodyBytes(world.bodies) + bodyBytes(local.bodies));
    expect(receipt.unobserved).toContain('gpu');
    cleanup.push(async () => { await first.api.releasePart('world-part'); });
  });

  it('conversion aliases the actual received Comlink clone rather than allocating another unregistered mesh backing', async () => {
    const received: { positions: Float32Array; normals: Float32Array; indices: Uint32Array; edgePositions: Float32Array }[] = [];
    silentWorkers.observeClonedReplies(message => {
      if (typeof message !== 'object' || message === null || !('type' in message) || message.type !== 'RAW'
        || !('value' in message) || typeof message.value !== 'object' || message.value === null
        || !('bodies' in message.value) || !Array.isArray(message.value.bodies)) return;
      message.value.bodies.forEach((body: unknown) => {
        if (typeof body !== 'object' || body === null || !('positions' in body) || !(body.positions instanceof Float32Array)
          || !('normals' in body) || !(body.normals instanceof Float32Array) || !('indices' in body) || !(body.indices instanceof Uint32Array)
          || !('edgePositions' in body) || !(body.edgePositions instanceof Float32Array)) return;
        received.push({ positions: body.positions, normals: body.normals, indices: body.indices, edgePositions: body.edgePositions });
      });
    });
    const { bridge, result, owner } = await localBox();
    expect(received.length).toBe(result.bodies.length);
    result.bodies.forEach((body, index) => {
      expect(body.mesh.positions).toBe(received[index]?.positions);
      expect(body.mesh.normals).toBe(received[index]?.normals);
      expect(body.mesh.indices).toBe(received[index]?.indices);
      expect(body.mesh.edgePositions).toBe(received[index]?.edgePositions);
    });
    if (bridge.captureCurrentMeshLedger === undefined) throw new Error('Capability');
    const receipt = await bridge.captureCurrentMeshLedger({ observationId: 'actual-clone-alias', owners: [owner] });
    if (receipt.status !== 'known') throw new Error('Registered actual received backing');
    expect(receipt.hostRetainedBackingBytes).toBeGreaterThanOrEqual(bodyBytes(result.bodies));
  });

  async function hiddenCurrent(cache?: AcquiringShapeCache<CachedSolid>) {
    const first = await localBox(1, cache);
    const tool = createPrimitiveFeature(first.document, 'box');
    const pair = appendSolid(first.document, tool);
    const document = appendSolid(pair, { kind: 'boolean', id: 'ledger-joined', name: 'Joined', suppressed: false,
      operation: 'union', targetFeatureId: first.document.solids[0].id, toolFeatureId: tool.id });
    const current = await recomputePart(document, first.bridge, { ...first.options, generation: 2 });
    expect(current.errors).toEqual([]);
    const scope = current.referenceMeshScope;
    if (scope === undefined || !scope.current) throw new Error('Actual current recomputation scope required');
    cleanup.push(async () => { await scope.close(); });
    const source = first.document.solids[0].id;
    const request = { steps: resolvePart(document).steps, bodies: current.bodies, featureIds: [source],
      failedIds: new Set<string>(), bridge: first.bridge, shouldCancel: () => false, features: document.solids, scope };
    return { ...first, document, current, scope, source, request };
  }
  it('the actual consumed-source reader passes its owner context and closes only its Worker lease while a borrower stays live', async () => {
    const fixture = await hiddenCurrent();
    const read = vi.spyOn(fixture.bridge, 'readCachedBodies');
    const hidden = await readReferenceBodies(fixture.request);
    expect(hidden.cancelled).toBe(false); expect(hidden.missing.size).toBe(0);
    const body = hidden.bodies.find(body => body.featureId === fixture.source);
    if (body === undefined) throw new Error('Actual consumed current source');
    expect(read.mock.calls[0]?.[2]).toMatchObject({ partId: 'ledger-part', generation: 2 });
    expect(fixture.scope.owners).toHaveLength(1);
    const receipt = await fixture.scope.capture('actual-reader-owned', fixture.current.bodies);
    if (receipt.status !== 'known') throw new Error('Actual hidden and display current owners');
    const heldOldSession = { candidates: [{ body }] };
    expect(await fixture.scope.close()).toBe(true);
    expect(fixture.scope.current).toBe(false); expect(fixture.scope.owners).toEqual([]);
    expect(await fixture.scope.capture('closed-reader', fixture.current.bodies)).toMatchObject({ status: 'unknown' });
    if (fixture.bridge.meshLedgerOwner === undefined || fixture.bridge.captureCurrentMeshLedger === undefined) throw new Error('Capability');
    const owner = fixture.bridge.meshLedgerOwner(fixture.current.bodies);
    if (owner === null) throw new Error('Display owner');
    const after = await fixture.bridge.captureCurrentMeshLedger({ observationId: 'closed-strong-borrower', owners: [owner] });
    if (after.status !== 'known') throw new Error('Registered current display plus actual retained host borrow');
    expect(heldOldSession.candidates[0].body.mesh.positions.buffer.byteLength).toBeGreaterThan(0);
    expect(after.hostRetainedBackingBytes).toBeGreaterThanOrEqual(bodyBytes(fixture.current.bodies) + bodyBytes([body]));
  });
  it('actual reader cancellation after a Worker reply closes the acquired owner instead of losing its token', async () => {
    const fixture = await hiddenCurrent();
    let cancelled = false;
    const actualRead = fixture.api.readCachedBodies.bind(fixture.api);
    vi.spyOn(fixture.api, 'readCachedBodies').mockImplementation(async (...args) => {
      const reply = await actualRead(...args); cancelled = true; return reply;
    });
    const release = vi.spyOn(fixture.api, 'releaseReferenceMeshLease');
    const result = await readReferenceBodies({ ...fixture.request, shouldCancel: () => cancelled });
    expect(result).toMatchObject({ cancelled: true, bodies: [] });
    expect(release).toHaveBeenCalledTimes(1);
    expect(fixture.scope.current).toBe(false); expect(fixture.scope.owners).toEqual([]);
    expect(await fixture.scope.capture('cancelled-scope', fixture.current.bodies)).toMatchObject({ status: 'unknown' });
  });
  it('cleanup failure remains unproved and retry plus a new current generation can recover normal operations', async () => {
    const fixture = await hiddenCurrent();
    const hidden = await readReferenceBodies(fixture.request);
    const borrower = hidden.bodies.find(body => body.featureId === fixture.source);
    if (borrower === undefined) throw new Error('Borrower');
    const release = vi.spyOn(fixture.api, 'releaseReferenceMeshLease').mockRejectedValueOnce(new Error('injected actual RPC cleanup failure'));
    expect(await fixture.scope.close()).toBe(false);
    expect(fixture.scope.current).toBe(false); expect(fixture.scope.owners).toHaveLength(1);
    expect(await fixture.scope.capture('cleanup-unproved', fixture.current.bodies)).toMatchObject({ status: 'unknown' });
    expect(borrower.mesh.positions.buffer.byteLength).toBeGreaterThan(0);
    release.mockRestore();
    expect(await fixture.scope.close()).toBe(true); expect(fixture.scope.owners).toEqual([]);
    const recovered = await recomputePart(fixture.document, fixture.bridge, { ...fixture.options, generation: 3 });
    expect(recovered.errors).toEqual([]);
    const scope = recovered.referenceMeshScope;
    if (scope === undefined) throw new Error('New scope');
    cleanup.push(async () => { await scope.close(); });
    expect(scope.current).toBe(true);
    expect((await scope.capture('new-current-after-cleanup', recovered.bodies)).status).toBe('known');
    expect(fixture.scope.current).toBe(false);
  });
  it('a cancelled actual reader leaves failed cleanup reachable through bridge lifetime without a returned recomputation scope', async () => {
    const fixture = await hiddenCurrent();
    let cancelled = false;
    const actualRead = fixture.api.readCachedBodies.bind(fixture.api);
    vi.spyOn(fixture.api, 'readCachedBodies').mockImplementation(async (...args) => {
      const result = await actualRead(...args); cancelled = true; return result;
    });
    const release = vi.spyOn(fixture.api, 'releaseReferenceMeshLease').mockRejectedValueOnce(new Error('release transport before actual cache release'));
    const cancelledResult = await readReferenceBodies({ ...fixture.request, shouldCancel: () => cancelled });
    expect(cancelledResult).toMatchObject({ cancelled: true, bodies: [] });
    expect(fixture.scope.owners).toHaveLength(1);
    if (fixture.bridge.pendingReferenceMeshCleanup === undefined || fixture.bridge.retryReferenceMeshCleanup === undefined) throw new Error('Bridge lifetime queue');
    const before = fixture.bridge.pendingReferenceMeshCleanup();
    expect(before).toBeGreaterThan(0); release.mockRestore();
    const retried = await fixture.bridge.retryReferenceMeshCleanup();
    expect(retried.released).toBeGreaterThan(0); expect(retried.retained).toBeLessThan(before);
    // The scope's independent retry observes authoritative absence, not a duplicate native delete.
    expect(await fixture.scope.close()).toBe(true);
    expect(fixture.scope.owners).toEqual([]);
  });
  it('a real receiver ACK failure retains only its owner and can resume after trusted retry without forgetting its real host clone', async () => {
    const api = createKernelApi(loadOcctForNode), bridge = createKernelBridge();
    Comlink.expose(api, silentWorkers.serverEndpoint());
    cleanup.push(async () => { bridge.dispose(); await api.releasePart('ack-part'); });
    const acknowledge = vi.spyOn(api, 'acknowledgeMeshReply').mockRejectedValueOnce(new Error('ACK transport before actual owner release'));
    const empty = createEmptyPartDocument(), document = appendSolid(empty, createPrimitiveFeature(empty, 'box'));
    const result = await recomputePart(document, bridge, { partId: 'ack-part', generation: 1,
      localMesh: { maximumFloat32ErrorMm: 1e-4, maximumLiveMeshBytes: 64 * 1024 * 1024 } });
    expect(result.errors).toEqual([]); expect(result.bodies.length).toBeGreaterThan(0);
    if (bridge.meshLedgerOwner === undefined || bridge.captureCurrentMeshLedger === undefined || bridge.retryReferenceMeshCleanup === undefined
      || bridge.pendingReferenceMeshCleanup === undefined) throw new Error('Managed queue capability');
    const owner = bridge.meshLedgerOwner(result.bodies); if (owner === null) throw new Error('Actual adopted owner');
    expect(bridge.pendingReferenceMeshCleanup()).toBe(1);
    expect((await bridge.captureCurrentMeshLedger({ observationId: 'ACK-failure', owners: [owner] })).status).toBe('unknown');
    acknowledge.mockRestore();
    expect(await bridge.retryReferenceMeshCleanup()).toEqual({ released: 1, retained: 0 });
    const current = await bridge.captureCurrentMeshLedger({ observationId: 'ACK-recovered', owners: [owner] });
    expect(current.status).toBe('known');
    if (current.status !== 'known') throw new Error('Recovered actual receiver ACK');
    expect(current.pendingCloneReservedBytes).toBe(0);
    expect(current.hostRetainedBackingBytes).toBeGreaterThanOrEqual(bodyBytes(result.bodies));
    expect(current.unobserved).toContain('native'); expect(current.unobserved).toContain('gpu');
  });
  function measuredCache() {
    return createShapeCache<CachedSolid>(16,
      entry => entry.mesh.positions.byteLength + entry.mesh.normals.byteLength + entry.mesh.indices.byteLength + entry.mesh.edgePositions.byteLength,
      entry => [entry.mesh.positions.buffer, entry.mesh.normals.buffer, entry.mesh.indices.buffer, entry.mesh.edgePositions.buffer]);
  }
  it('actual cache release failure retains the real Worker hidden owner until the same token is successfully returned', async () => {
    const cache = measuredCache(), fixture = await hiddenCurrent(cache);
    const read = await readReferenceBodies(fixture.request);
    expect(read.bodies.some(body => body.featureId === fixture.source)).toBe(true);
    const owner = fixture.scope.owners[0]; if (owner === undefined) throw new Error('Actual hidden owner');
    const before = cache.stats().protectedKeyCount;
    const release = vi.spyOn(cache, 'release').mockImplementationOnce(() => { throw new Error('actual cache release before token mutation'); });
    expect(await fixture.scope.close()).toBe(false);
    expect(fixture.scope.owners).toEqual([owner]); expect(cache.stats().protectedKeyCount).toBe(before);
    if (fixture.api.readCurrentMeshAccounting === undefined) throw new Error('Worker current query');
    const retained = await fixture.api.readCurrentMeshAccounting({ observationId: 'retained-failed-token', limitBytes: 64 * 1024 * 1024, expectedOwners: [owner] });
    expect(retained.status).toBe('known');
    if (retained.status !== 'known') throw new Error('Failed-before-mutation still owns real registered JS backing');
    expect(retained.hiddenBackingBytes).toBeGreaterThan(0);
    release.mockRestore();
    expect(await fixture.scope.close()).toBe(true);
    expect((await fixture.api.readCurrentMeshAccounting({ observationId: 'actually-released-owner', limitBytes: 64 * 1024 * 1024, expectedOwners: [owner] })).status).toBe('unknown');
  });
  it('readCachedBodies catch retains a failed actual cleanup owner in the bridge even before a scope can register a reply', async () => {
    const cache = measuredCache(), fixture = await hiddenCurrent(cache);
    const actualRead = fixture.api.readCachedBodies.bind(fixture.api);
    vi.spyOn(fixture.api, 'readCachedBodies').mockImplementation((items, lease) => actualRead(items, lease, () => Promise.resolve(false)));
    const release = vi.spyOn(cache, 'release').mockImplementation(() => { throw new Error('actual cache cleanup cannot start'); });
    const result = await readReferenceBodies(fixture.request);
    expect(result.missing.get(fixture.source)).toBe('read-failed'); expect(fixture.scope.owners).toEqual([]);
    if (fixture.bridge.pendingReferenceMeshCleanup === undefined || fixture.bridge.retryReferenceMeshCleanup === undefined) throw new Error('Bridge failed-owner queue');
    expect(fixture.bridge.pendingReferenceMeshCleanup()).toBeGreaterThan(0);
    const protectedBeforeRetry = cache.stats().protectedKeyCount;
    expect(protectedBeforeRetry).toBeGreaterThan(0);
    release.mockRestore();
    const actualRelease = vi.spyOn(cache, 'release');
    const retried = await fixture.bridge.retryReferenceMeshCleanup();
    expect(retried.released).toBeGreaterThan(0); expect(retried.retained).toBe(0);
    expect(actualRelease).toHaveBeenCalledTimes(1); // No successful token return is repeated.
  });
  it('late actual registration in an already completed close iterator window still returns its real token', async () => {
    const fixture = await hiddenCurrent();
    if (fixture.bridge.readCachedBodies === undefined || fixture.bridge.meshLedgerOwner === undefined) throw new Error('Actual hidden reader');
    const read = await fixture.bridge.readCachedBodies(fixture.request.steps, [fixture.source], fixture.scope.context);
    const owner = fixture.bridge.meshLedgerOwner(read.bodies); if (owner === null) throw new Error('Actual hidden dispatch');
    expect(fixture.scope.owners).toEqual([]);
    const release = vi.spyOn(fixture.api, 'releaseReferenceMeshLease');
    const closing = fixture.scope.close(); // Its empty iterator is already finished, finally is still pending.
    const lateRegister = fixture.scope.register(read.bodies);
    expect(await closing).toBe(true); await lateRegister;
    expect(fixture.scope.owners).toEqual([]); expect(release).toHaveBeenCalledTimes(1);
    expect(fixture.bridge.pendingReferenceMeshCleanup?.()).toBe(0);
    if (fixture.api.readCurrentMeshAccounting === undefined) throw new Error('Actual Worker query');
    expect((await fixture.api.readCurrentMeshAccounting({ observationId: 'late-register-actually-returned',
      limitBytes: 64 * 1024 * 1024, expectedOwners: [owner] })).status).toBe('unknown');
  });
  it('ordinary reservation cancellation is a cancelled outcome without dispatch or broken failure', async () => {
    const api = createKernelApi(loadOcctForNode), bridge = createKernelBridge();
    Comlink.expose(api, silentWorkers.serverEndpoint());
    cleanup.push(async () => { bridge.dispose(); await api.releasePart('ordinary-cancel'); });
    const dispatch = vi.spyOn(api, 'recomputeSolids');
    const empty = createEmptyPartDocument(), document = appendSolid(empty, createPrimitiveFeature(empty, 'box'));
    const result = await bridge.recomputeSolids(resolvePart(document).steps, { partId: 'ordinary-cancel', generation: 1,
      shouldCancel: () => true, localMesh: { maximumFloat32ErrorMm: 1e-4, maximumLiveMeshBytes: 64 * 1024 * 1024 } });
    expect(result).toMatchObject({ cancelled: true, bodies: [], failures: [] }); expect(dispatch).not.toHaveBeenCalled();
    expect(bridge.pendingWaiters()).toBe(0); expect(bridge.pendingCallbacks()).toBe(0);
    const normal = await recomputePart(document, bridge, { partId: 'ordinary-cancel', generation: 2,
      localMesh: { maximumFloat32ErrorMm: 1e-4, maximumLiveMeshBytes: 64 * 1024 * 1024 } });
    expect(normal.errors).toEqual([]); expect(normal.bodies.length).toBeGreaterThan(0); expect(dispatch).toHaveBeenCalledTimes(1);
  });
  it.each(['false', 'throw'] as const)('actual uncertified reply cleanup %s keeps only failed owner reachable for trusted retry', async mode => {
    const fixture = await hiddenCurrent();
    const release = vi.spyOn(fixture.api, 'releaseReferenceMeshLease');
    if (mode === 'false') release.mockResolvedValueOnce({ released: false });
    else release.mockRejectedValueOnce(new Error('uncertified release before actual token mutation'));
    if (fixture.bridge.readCachedBodies === undefined || fixture.bridge.retryReferenceMeshCleanup === undefined
      || fixture.bridge.pendingReferenceMeshCleanup === undefined || fixture.bridge.captureCurrentMeshLedger === undefined
      || fixture.bridge.meshLedgerOwner === undefined) throw new Error('Managed legacy capability');
    const result = await fixture.bridge.readCachedBodies(fixture.request.steps, [fixture.source]); // Actual legacy call, no Scope context.
    const borrower = result.bodies.find(body => body.featureId === fixture.source);
    if (borrower === undefined) throw new Error('Actual adopted legacy raw clone');
    expect(borrower.mesh.positions.buffer.byteLength).toBeGreaterThan(0);
    expect(fixture.bridge.meshLedgerOwner(result.bodies)).toBeNull(); // Legacy result remains uncertified.
    expect(fixture.bridge.pendingReferenceMeshCleanup()).toBe(1);
    expect(release).toHaveBeenCalledTimes(1);
    expect(await fixture.bridge.retryReferenceMeshCleanup()).toEqual({ released: 1, retained: 0 });
    expect(release).toHaveBeenCalledTimes(2); // First call did not return a token; only the actual retry frees it.
    const reading = await fixture.bridge.captureCurrentMeshLedger({ observationId: 'legacy-cleanup-still-uncertified', owners: [] });
    expect(reading).toMatchObject({ status: 'unknown', reason: 'uncertified-hidden-read' });
    expect(borrower.mesh.positions.buffer.byteLength).toBeGreaterThan(0); // No physical/host-zero claim.
  });
  it('ordinary current hidden-read cancellation stops before Worker dispatch with a cancelled outcome', async () => {
    const fixture = await hiddenCurrent();
    const dispatch = vi.spyOn(fixture.api, 'readCachedBodies');
    if (fixture.bridge.readCachedBodies === undefined) throw new Error('Current hidden reader');
    const result = await fixture.bridge.readCachedBodies(fixture.request.steps, [fixture.source], {
      ...fixture.scope.context, shouldCancel: () => Promise.resolve(true) });
    expect(result).toMatchObject({ cancelled: true, bodies: [], failures: [] });
    expect(dispatch).not.toHaveBeenCalled(); expect(fixture.bridge.pendingReferenceMeshCleanup?.()).toBe(0);
  });
  it('actual overlapping bridge reservations time out as ordinary budget refusal and preserve the first request until stop', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const bridge = createKernelBridge(); // Real bridge/ledger and unreceived fake Worker transport.
    let first: Promise<Awaited<ReturnType<typeof bridge.recomputeSolids>>> | undefined;
    try {
      const empty = createEmptyPartDocument(), document = appendSolid(empty, createPrimitiveFeature(empty, 'box'));
      const steps = resolvePart(document).steps;
      first = bridge.recomputeSolids(steps, { partId: 'budget-main', generation: 1,
        localMesh: { maximumFloat32ErrorMm: 1e-4, maximumLiveMeshBytes: 512 * 1024 * 1024 } });
      for (let i = 0; i < 8; i++) await Promise.resolve();
      expect(bridge.pendingWaiters()).toBe(1);
      const waiting = bridge.recomputeSolids(steps, { partId: 'budget-preview', generation: 1,
        localMesh: { maximumFloat32ErrorMm: 1e-4, maximumLiveMeshBytes: 512 * 1024 * 1024 } });
      await vi.advanceTimersByTimeAsync(10_000);
      const result = await waiting;
      expect(result.cancelled).toBe(false); expect(result.failures).toHaveLength(1);
      expect(result.failures[0].message).toContain('表示メッシュの空きを待つ時間');
      expect(result.failures[0].message).not.toBe(KERNEL_BROKEN_MESSAGE);
      expect(bridge.pendingWaiters()).toBe(1); // Other reservation/request has not been cleared.
      bridge.dispose(); await first; first = undefined;
      expect(bridge.pendingWaiters()).toBe(0); expect(bridge.pendingCallbacks()).toBe(0);
    } finally {
      bridge.dispose(); if (first !== undefined) await first; vi.useRealTimers();
    }
  });
  it('void close failure and a late actual owner retain only the failed lease in the bridge queue', async () => {
    const fixture = await hiddenCurrent(); await readReferenceBodies(fixture.request);
    const failedOwner = fixture.scope.owners[0]; if (failedOwner === undefined) throw new Error('Actual first hidden owner');
    if (fixture.bridge.readCachedBodies === undefined || fixture.bridge.meshLedgerOwner === undefined
      || fixture.bridge.retryReferenceMeshCleanup === undefined || fixture.bridge.pendingReferenceMeshCleanup === undefined)
      throw new Error('Actual bridge cleanup capability');
    const late = await fixture.bridge.readCachedBodies(fixture.request.steps, [fixture.source], fixture.scope.context);
    const lateOwner = fixture.bridge.meshLedgerOwner(late.bodies); if (lateOwner === null) throw new Error('Second actual hidden owner');
    const actualRelease = fixture.api.releaseReferenceMeshLease?.bind(fixture.api);
    if (actualRelease === undefined) throw new Error('Actual Worker release');
    const release = vi.spyOn(fixture.api, 'releaseReferenceMeshLease').mockImplementation(owner => owner.dispatchId === failedOwner.dispatchId
      ? Promise.reject(new Error('first real owner cleanup cannot start')) : actualRelease(owner));
    void fixture.scope.close(); // Same nonawaiting boundary used by store lifecycle cleanup.
    const registration = fixture.scope.register(late.bodies);
    expect(await fixture.scope.close()).toBe(false); await registration;
    expect(fixture.scope.owners).toEqual([failedOwner]);
    expect(fixture.bridge.pendingReferenceMeshCleanup()).toBe(1);
    expect(release.mock.calls.filter(([owner]) => owner.dispatchId === lateOwner.dispatchId)).toHaveLength(1);
    expect(late.bodies[0].mesh.positions.buffer.byteLength).toBeGreaterThan(0);
    release.mockRestore();
    expect(await fixture.bridge.retryReferenceMeshCleanup()).toEqual({ released: 1, retained: 0 });
    expect(await fixture.scope.close()).toBe(true); expect(fixture.scope.owners).toEqual([]);
  });
  it.each(['released', 'false', 'throw'] as const)('128 actual hidden owners distinguish duplicate, same-Worker refusal and new-connection overflow %s', async mode => {
    const empty = createEmptyPartDocument(), document = appendSolid(empty, createPrimitiveFeature(empty, 'box'));
    const steps = resolvePart(document).steps, featureId = document.solids[0].id;
    async function seed(partId: string) {
      const cache = measuredCache(), api = createKernelApi(loadOcctForNode, cache), direct = createDirectKernelBridge(api);
      const result = await recomputePart(document, direct, { partId, generation: 1 });
      expect(result.errors).toEqual([]); expect(result.bodies[0].mesh.positions.buffer.byteLength).toBeGreaterThan(0);
      await api.releasePart(partId); direct.dispose(); // Cache retains the real OCCT shape/backings, no adopted display owner.
      expect(cache.stats().size).toBeGreaterThan(0);
      return { cache, api, result };
    }
    const first = await seed('capacity-seed-first'), bridge = createKernelBridge();
    Comlink.expose(first.api, silentWorkers.serverEndpoint());
    const context = { partId: 'actual-capacity-scope', generation: 1, maximumLiveMeshBytes: 64 * 1024 * 1024 };
    const scope = new ReferenceMeshScope(document, context, bridge);
    const oldOwners: MeshLedgerOwner[] = [], newOwners: MeshLedgerOwner[] = [];
    const borrowers: SolidBody[] = [];
    const nextForCleanup: { value?: Awaited<ReturnType<typeof seed>> } = {};
    cleanup.push(async () => {
      bridge.dispose();
      // Fake Worker.terminate is only a transport/lifetime unit boundary. Explicitly
      // return real Node-hosted API native/cache tokens for teardown; never claim physical zero from the fake.
      for (const owner of oldOwners) await first.api.releaseReferenceMeshLease?.(owner);
      first.cache.clear();
      const next = nextForCleanup.value;
      if (next !== undefined) {
        for (const owner of newOwners) await next.api.releaseReferenceMeshLease?.(owner);
        next.cache.clear();
      }
    });
    if (bridge.readCachedBodies === undefined || bridge.meshLedgerOwner === undefined
      || bridge.pendingReferenceMeshCleanup === undefined || bridge.retryReferenceMeshCleanup === undefined)
      throw new Error('Actual managed owner capability');
    const acquire = vi.spyOn(first.cache, 'acquire');
    let duplicateBodies: readonly SolidBody[] | undefined;
    for (let index = 0; index < 128; index++) {
      const reply = await bridge.readCachedBodies(steps, [featureId], context);
      expect(reply.failures).toEqual([]); expect(reply.bodies).toHaveLength(1);
      expect(reply.bodies[0].mesh.positions.buffer.byteLength).toBeGreaterThan(0);
      const owner = bridge.meshLedgerOwner(reply.bodies); if (owner === null) throw new Error('Actual Comlink hidden owner');
      oldOwners.push(owner); borrowers.push(reply.bodies[0]);
      if (index === 0) duplicateBodies = reply.bodies;
      await scope.register(reply.bodies);
    }
    expect(scope.owners).toHaveLength(128); expect(scope.current).toBe(true); expect(acquire).toHaveBeenCalledTimes(128);
    if (duplicateBodies === undefined) throw new Error('First actual owner');
    await scope.register(duplicateBodies);
    expect(scope.owners).toHaveLength(128); expect(scope.current).toBe(true); // Same identity is idempotent at full capacity.
    expect(bridge.pendingReferenceMeshCleanup()).toBe(0);
    if (first.api.readCurrentMeshAccounting === undefined) throw new Error('Actual Worker owner query');
    const actual128 = await first.api.readCurrentMeshAccounting({ observationId: 'actual-128-leases',
      limitBytes: context.maximumLiveMeshBytes, expectedOwners: oldOwners });
    expect(actual128.status).toBe('known');
    if (actual128.status !== 'known') throw new Error('Actual current owner set');
    expect(actual128.owners).toHaveLength(128); expect(actual128.hiddenBackingBytes).toBeGreaterThan(0);
    const registered = await scope.capture('actual-scope-128', []);
    expect(registered.status).toBe('known');
    if (registered.status !== 'known') throw new Error('Registered JS owner union');
    expect(registered.hostRetainedBackingBytes).toBeGreaterThanOrEqual(bodyBytes(borrowers));
    expect(registered.unobserved).toContain('native'); expect(registered.unobserved).toContain('gpu');
    await expect(bridge.readCachedBodies(steps, [featureId], context)).rejects.toThrow('Invalid reference mesh lease');
    expect(acquire).toHaveBeenCalledTimes(128); // The same Worker refuses before acquiring or returning a129th reply.
    expect(scope.owners).toHaveLength(128); expect(bridge.pendingReferenceMeshCleanup()).toBe(0);

    const next = await seed('capacity-seed-next');
    nextForCleanup.value = next;
    const nextApi = next.api;
    silentWorkers.connectNextCreated(() => { Comlink.expose(nextApi, silentWorkers.serverEndpoint()); });
    silentWorkers.breakCurrent();
    const overflow = await bridge.readCachedBodies(steps, [featureId], context);
    const owner = bridge.meshLedgerOwner(overflow.bodies); if (owner === null) throw new Error('Actual new-connection reply');
    newOwners.push(owner);
    expect(overflow.bodies[0].mesh.positions.buffer.byteLength).toBeGreaterThan(0);
    const release = vi.spyOn(nextApi, 'releaseReferenceMeshLease');
    if (mode === 'false') release.mockResolvedValueOnce({ released: false });
    if (mode === 'throw') release.mockRejectedValueOnce(new Error('actual overflow cleanup before token mutation'));
    await scope.register(overflow.bodies);
    expect(scope.owners).toHaveLength(128); expect(scope.current).toBe(false);
    expect(release).toHaveBeenCalledTimes(1);
    if (mode !== 'released') {
      expect(bridge.pendingReferenceMeshCleanup()).toBe(1);
      if (nextApi.readCurrentMeshAccounting === undefined) throw new Error('Actual new Worker owner query');
      const retained = await nextApi.readCurrentMeshAccounting({ observationId: 'actual-overflow-failed-owner',
        limitBytes: context.maximumLiveMeshBytes, expectedOwners: [owner] });
      expect(retained.status).toBe('known');
      if (retained.status !== 'known') throw new Error('Real failed overflow owner retained');
      expect(retained.hiddenBackingBytes).toBeGreaterThan(0);
      expect(await bridge.retryReferenceMeshCleanup()).toEqual({ released: 1, retained: 0 });
      expect(release).toHaveBeenCalledTimes(2);
    } else expect(bridge.pendingReferenceMeshCleanup()).toBe(0);
    if (nextApi.readCurrentMeshAccounting === undefined) throw new Error('Actual new Worker owner query');
    expect((await nextApi.readCurrentMeshAccounting({ observationId: 'overflow-actually-returned',
      limitBytes: context.maximumLiveMeshBytes, expectedOwners: [owner] })).status).toBe('unknown');
    expect(await scope.close()).toBe(true); expect(scope.owners).toEqual([]);
    expect(borrowers[0].mesh.positions.buffer.byteLength).toBeGreaterThan(0);
    expect(overflow.bodies[0].mesh.positions.buffer.byteLength).toBeGreaterThan(0);
    // The unit's fake transport closure has not freed this independently retained real API.
    const stillHostedOldApi = await first.api.readCurrentMeshAccounting({ observationId: 'fake-closure-not-physical-zero',
      limitBytes: context.maximumLiveMeshBytes, expectedOwners: oldOwners });
    expect(stillHostedOldApi.status).toBe('known');
  });
  it('a Worker restart invalidates the old epoch vector and preserves an actually held old main clone', async () => {
    const first = await localBox();
    if (first.bridge.captureCurrentMeshLedger === undefined || first.bridge.currentMeshLedgerReceipt === undefined) throw new Error('Capability');
    const old = await first.bridge.captureCurrentMeshLedger({ observationId: 'before-real-restart', owners: [first.owner] });
    if (old.status !== 'known') throw new Error('Old current receipt');
    const held = first.result.bodies;
    silentWorkers.breakCurrent();
    expect(first.bridge.currentMeshLedgerReceipt(old)).toBe(false);
    const nextApi = createKernelApi(loadOcctForNode);
    silentWorkers.connectNextCreated(() => Comlink.expose(nextApi, silentWorkers.serverEndpoint()));
    cleanup.push(async () => { await nextApi.releasePart('ledger-part'); });
    const next = await recomputePart(first.document, first.bridge, { ...first.options, generation: 2 });
    expect(next.errors).toEqual([]);
    const scope = next.referenceMeshScope;
    if (scope === undefined) throw new Error('Restarted current scope');
    cleanup.push(async () => { await scope.close(); });
    const receipt = await scope.capture('after-real-restart', next.bodies);
    if (receipt.status !== 'known') throw new Error('New connection current union');
    expect(receipt.workerEpochs).toHaveLength(old.workerEpochs.length);
    expect(receipt.workerEpochs[0]?.connectionEpoch).not.toBe(old.workerEpochs[0]?.connectionEpoch);
    expect(first.bridge.currentMeshLedgerReceipt(old)).toBe(false);
    expect(receipt.hostRetainedBackingBytes).toBeGreaterThanOrEqual(bodyBytes(held) + bodyBytes(next.bodies));
  });

  function actualRawBackingBuffers(message: unknown): ArrayBuffer[] {
    if (typeof message !== 'object' || message === null || !('type' in message) || message.type !== 'RAW'
      || !('value' in message) || typeof message.value !== 'object' || message.value === null
      || !('bodies' in message.value) || !Array.isArray(message.value.bodies)) return [];
    return message.value.bodies.flatMap((body: unknown) => {
      if (typeof body !== 'object' || body === null || !('positions' in body) || !(body.positions instanceof Float32Array)
        || !('normals' in body) || !(body.normals instanceof Float32Array) || !('indices' in body) || !(body.indices instanceof Uint32Array)
        || !('edgePositions' in body) || !(body.edgePositions instanceof Float32Array)) return [];
      const buffers: ArrayBuffer[] = [];
      for (const buffer of [body.positions.buffer, body.normals.buffer, body.indices.buffer, body.edgePositions.buffer]) {
        if (!(buffer instanceof ArrayBuffer)) throw new Error('Actual raw mesh uses unsupported shared backing');
        buffers.push(buffer);
      }
      return buffers;
    });
  }
  it('received raw mesh continues actual backing adoption after transport close and its callback ports retire', async () => {
    const api = createKernelApi(loadOcctForNode), bridge = createKernelBridge();
    Comlink.expose(api, silentWorkers.serverEndpoint());
    const empty = createEmptyPartDocument(), document = appendSolid(empty, createPrimitiveFeature(empty, 'box'));
    const dispatched = vi.spyOn(api, 'recomputeSolids');
    const received: ArrayBuffer[] = [];
    silentWorkers.observeReceivedReplies(message => {
      const buffers = actualRawBackingBuffers(message);
      if (buffers.length === 0) return;
      // This hook runs after Worker message listeners, including Comlink, have consumed the real cloned response.
      received.push(...buffers); bridge.dispose();
    });
    cleanup.push(async () => {
      bridge.dispose();
      const owner = dispatched.mock.calls[0]?.[4];
      if (owner !== undefined) await api.acknowledgeMeshReply?.(owner); // fake-Worker server teardown, not a physical process claim
      await api.releasePart('received-close');
    });
    const reply = await bridge.recomputeSolids(resolvePart(document).steps, { partId: 'received-close', generation: 1,
      localMesh: { maximumFloat32ErrorMm: 1e-4, maximumLiveMeshBytes: 64 * 1024 * 1024 } });
    expect(reply.bodies).toEqual([]);
    expect(received.reduce((sum, buffer) => sum + buffer.byteLength, 0)).toBeGreaterThan(0);
    await vi.waitFor(() => { expect(bridge.pendingCallbacks()).toBe(0); expect(bridge.pendingWaiters()).toBe(0); });
    silentWorkers.observeReceivedReplies(() => undefined);
    const nextApi = createKernelApi(loadOcctForNode), next = createKernelBridge();
    Comlink.expose(nextApi, silentWorkers.serverEndpoint());
    cleanup.push(() => { next.dispose(); });
    if (next.captureCurrentMeshLedger === undefined) throw new Error('Current global capability');
    const current = await next.captureCurrentMeshLedger({ observationId: 'received-then-closed', owners: [] });
    if (current.status !== 'known') throw new Error('Actual received backing must finish adoption');
    expect(current.pendingCloneReservedBytes).toBe(0);
    expect(current.hostRetainedBackingBytes).toBeGreaterThanOrEqual([...new Set(received)].reduce((sum, buffer) => sum + buffer.byteLength, 0));
    expect(current.unobserved).toContain('native'); expect(current.unobserved).toContain('gpu');
  });
  it('closing an actually unreceived call settles only that transport request and a new managed computation recovers', async () => {
    const bridge = createKernelBridge();
    const empty = createEmptyPartDocument(), document = appendSolid(empty, createPrimitiveFeature(empty, 'box'));
    const pending = bridge.recomputeSolids(resolvePart(document).steps, { partId: 'unreceived-close', generation: 1,
      localMesh: { maximumFloat32ErrorMm: 1e-4, maximumLiveMeshBytes: 512 * 1024 * 1024 } });
    await vi.waitFor(() => expect(bridge.pendingWaiters()).toBe(1));
    bridge.dispose();
    expect((await pending).bodies).toEqual([]);
    await vi.waitFor(() => { expect(bridge.pendingCallbacks()).toBe(0); expect(bridge.pendingWaiters()).toBe(0); });
    const recovered = await localBox();
    expect(recovered.result.errors).toEqual([]);
    const scope = recovered.result.referenceMeshScope;
    if (scope === undefined) throw new Error('Recovered current scope');
    cleanup.push(async () => { await scope.close(); });
    expect((await scope.capture('after-unreceived-close', recovered.result.bodies)).status).toBe('known');
  });




  function partClaim(fixture: Awaited<ReturnType<typeof localBox>>) {
    const claim = fixture.bridge.capturePartReleaseClaim?.(fixture.result.bodies);
    if (claim === undefined || claim === null || fixture.bridge.releasePartClaim === undefined
      || fixture.api.readPartOwnership === undefined || fixture.api.releaseOwnedPart === undefined) throw new Error('Actual Part owner contract');
    return claim;
  }
  it('actual Part claim returns its cache token before removing the exact display owner, independently of legacy void', async () => {
    const cache = measuredCache(), fixture = await localBox(1, cache), claim = partClaim(fixture);
    const release = vi.spyOn(cache, 'release');
    const observed = await fixture.api.readPartOwnership?.(claim.owner);
    expect(observed?.status).toBe('current');
    expect(await fixture.bridge.releasePartClaim?.({ ...claim })).toMatchObject({ status: 'unavailable', reason: 'unissued-claim' });
    expect(release).not.toHaveBeenCalled();
    expect(await fixture.bridge.releasePartClaim?.(claim)).toEqual({ status: 'released' });
    expect(release).toHaveBeenCalledTimes(1);
    expect(await fixture.api.readPartOwnership?.(claim.owner)).toEqual({ status: 'absent' });
    expect(await fixture.bridge.releasePartClaim?.(claim)).toEqual({ status: 'absent' });
    expect(release).toHaveBeenCalledTimes(1);
    expect(bodyBytes(fixture.result.bodies)).toBeGreaterThan(0); // Strong main clone remains; no physical zero.
    expect(cache.stats().size).toBeGreaterThan(0); // Native cache lifetime is separate from the display token.
    cleanup.push(() => cache.clear());
  });
  it('an actual pre-mutation cache throw retains the display owner and succeeds on a safe single retry', async () => {
    const cache = measuredCache(), fixture = await localBox(1, cache), claim = partClaim(fixture);
    const before = cache.meshBufferSnapshot?.();
    const release = vi.spyOn(cache, 'release').mockImplementationOnce(() => { throw new Error('Before any actual token mutation'); });
    expect(await fixture.bridge.releasePartClaim?.(claim)).toMatchObject({ status: 'cleanup-failed' });
    expect(await fixture.api.readPartOwnership?.(claim.owner)).toMatchObject({ status: 'current', owner: claim.owner });
    expect(cache.meshBufferSnapshot?.()).toEqual(before);
    expect(await fixture.bridge.releasePartClaim?.(claim)).toEqual({ status: 'released' });
    expect(release).toHaveBeenCalledTimes(2);
    expect(await fixture.api.readPartOwnership?.(claim.owner)).toEqual({ status: 'absent' });
    cleanup.push(() => cache.clear());
  });
  it('fresh epoch and old-owner checks prevent an old Part claim from releasing a newly adopted same-ref owner', async () => {
    const cache = measuredCache(), fixture = await localBox(1, cache), old = partClaim(fixture);
    const observation = await fixture.api.readPartOwnership?.(old.owner);
    if (observation?.status !== 'current') throw new Error('Actual old epoch');
    const next = await recomputePart(fixture.document, fixture.bridge, { ...fixture.options, generation: 2 });
    const current = fixture.bridge.capturePartReleaseClaim?.(next.bodies);
    if (current === undefined || current === null) throw new Error('Actual current display owner');
    const release = vi.spyOn(cache, 'release');
    expect(await fixture.api.releaseOwnedPart?.(old.owner, observation.epoch)).toEqual({ status: 'stale-owner' });
    expect(await fixture.bridge.releasePartClaim?.(old)).toEqual({ status: 'stale-owner' });
    expect(release).not.toHaveBeenCalled();
    expect(await fixture.api.readPartOwnership?.(current.owner)).toMatchObject({ status: 'current', owner: current.owner });
    expect(await fixture.bridge.releasePartClaim?.(current)).toEqual({ status: 'released' });
    expect(release).toHaveBeenCalledTimes(1);
    expect(bodyBytes(fixture.result.bodies)).toBeGreaterThan(0);
    expect(bodyBytes(next.bodies)).toBeGreaterThan(0);
    cleanup.push(() => cache.clear());
  });
  it('actual cache epoch change refuses release without deleting an unchanged display owner', async () => {
    const cache = measuredCache(), fixture = await localBox(1, cache), claim = partClaim(fixture);
    const observed = await fixture.api.readPartOwnership?.(claim.owner);
    if (observed?.status !== 'current') throw new Error('Actual current epoch');
    const key = claim.owner.steps[0]?.key;
    if (key === undefined) throw new Error('Actual protected key');
    const extra = cache.acquire([key]);
    expect(await fixture.api.releaseOwnedPart?.(claim.owner, observed.epoch)).toEqual({ status: 'unavailable', reason: 'epoch-changed' });
    expect(await fixture.api.readPartOwnership?.(claim.owner)).toMatchObject({ status: 'current' });
    cache.release(extra);
    expect(await fixture.bridge.releasePartClaim?.(claim)).toEqual({ status: 'released' });
    cleanup.push(() => cache.clear());
  });
  it('legacy broken void completion cannot become an actual Part disposition', async () => {
    const fixture = await localBox(), claim = partClaim(fixture);
    silentWorkers.breakCurrent();
    expect(await fixture.bridge.releasePart('ledger-part')).toBeUndefined();
    expect(await fixture.bridge.releasePartClaim?.(claim)).toMatchObject({ status: 'unavailable' });
    expect(await fixture.api.readPartOwnership?.(claim.owner)).toMatchObject({ status: 'current' });
    expect(bodyBytes(fixture.result.bodies)).toBeGreaterThan(0);
  });
  it('only successful terminate-return supplies logical Part closure, while a terminate throw remains unavailable', async () => {
    const created = vi.spyOn(silentWorkers, 'create');
    const fixture = await localBox(), claim = partClaim(fixture);
    const actualWorker = created.mock.results[0];
    if (actualWorker?.type !== 'return') throw new Error('Actual worker missing');
    const terminate = vi.spyOn(actualWorker.value, 'terminate').mockImplementationOnce(() => { throw new Error('Worker termination did not return'); });
    expect(() => fixture.bridge.dispose()).toThrow('Worker termination did not return');
    expect(await fixture.bridge.releasePartClaim?.(claim)).toMatchObject({ status: 'unavailable' });
    expect(await fixture.api.readPartOwnership?.(claim.owner)).toMatchObject({ status: 'current' });
    fixture.bridge.dispose();
    expect(terminate).toHaveBeenCalledTimes(2);
    expect(await fixture.bridge.releasePartClaim?.(claim)).toEqual({ status: 'closed' });
    // The unit uses a separately retained real API, so its native/cache owner is still live.
    expect(await fixture.api.readPartOwnership?.(claim.owner)).toMatchObject({ status: 'current' });
    expect(bodyBytes(fixture.result.bodies)).toBeGreaterThan(0);
  });
  it('actual Part partial native cleanup retains the failed token/backing and never repeats successful frees', async () => {
    const cache = measuredCache(), fixture = await localBox(1, cache), claim = partClaim(fixture);
    const key = claim.owner.steps[0]?.key;
    if (key === undefined) throw new Error('Actual box key');
    const original = cache.get(key);
    if (original === undefined) throw new Error('Actual box cached solid');
    const originalDelete = vi.spyOn(original, 'delete');
    const oc = await loadOcctForNode();
    const failedMaker = new oc.BRepPrimAPI_MakeBox_2(1, 2, 3), failedShape = failedMaker.Shape();
    let failedShapeDeletes = 0, failedMakerDeletes = 0;
    const failedBacking = new ArrayBuffer(24), currentBacking = new ArrayBuffer(48);
    const withBacking = (backing: ArrayBuffer) => ({ ...original.mesh, positions: new Float32Array(backing),
      normals: new Float32Array(backing, 0, 0), indices: new Uint32Array(backing, 0, 0), edgePositions: new Float32Array(backing, 0, 0) });
    const failed: CachedSolid = { shape: failedShape, mesh: withBacking(failedBacking), delete() {
      failedShape.delete(); failedShapeDeletes += 1;
      throw new Error('Actual native shape deleted before maker cleanup failed');
    } };
    const currentMaker = new oc.BRepPrimAPI_MakeBox_2(2, 3, 4), currentShape = currentMaker.Shape();
    let currentDeletes = 0;
    const current: CachedSolid = { shape: currentShape, mesh: withBacking(currentBacking), delete() {
      currentShape.delete(); currentMaker.delete(); currentDeletes += 1;
    } };
    cache.set(key, failed); cache.set(key, current);
    expect(await fixture.bridge.releasePartClaim?.(claim)).toMatchObject({ status: 'cleanup-failed' });
    expect(originalDelete).toHaveBeenCalledTimes(1); expect(failedShapeDeletes).toBe(1); expect(failedMakerDeletes).toBe(0);
    expect(failedMaker.IsDone()).toBe(true); expect(currentDeletes).toBe(0);
    expect(await fixture.api.readPartOwnership?.(claim.owner)).toMatchObject({ status: 'current' });
    expect(cache.meshBufferSnapshot?.()).toMatchObject({ status: 'known', active: [currentBacking], retired: [failedBacking], protected: [failedBacking] });
    expect(await fixture.bridge.releasePartClaim?.(claim)).toMatchObject({ status: 'cleanup-failed' });
    expect(originalDelete).toHaveBeenCalledTimes(1); expect(failedShapeDeletes).toBe(1); expect(currentDeletes).toBe(0);
    expect((await fixture.api.readCurrentMeshAccounting?.({ observationId: 'opaque-part-cleanup',
      limitBytes: 64 * 1024 * 1024, expectedOwners: [claim.owner] }))?.status).toBe('unknown');
    cache.delete(key); expect(currentDeletes).toBe(1);
    // Independent test proof: this maker was never freed. Production keeps opaque failure unknown.
    failedMaker.delete(); failedMakerDeletes += 1;
    expect(failedMakerDeletes).toBe(1);
    // Failed token is deliberately not presented as released; direct cleanup callback must not retry it.
    cleanup.pop();
    cleanup.push(() => fixture.bridge.dispose());
  });

  it('actual cache missing, throwing and unsafe cleanup metadata never becomes authoritative Part absence', async () => {
    const cache = measuredCache(), fixture = await localBox(1, cache), claim = partClaim(fixture);
    await fixture.api.releasePart('ledger-part');
    const descriptor = Object.getOwnPropertyDescriptor(cache, 'cleanupFailureCount');
    if (descriptor === undefined) throw new Error('Actual cache metadata callback');
    try {
      expect(Reflect.deleteProperty(cache, 'cleanupFailureCount')).toBe(true);
      expect(await fixture.api.readPartOwnership?.(claim.owner)).toEqual({ status: 'unavailable', reason: 'cleanup-metadata-unavailable' });
      expect(await fixture.bridge.releasePartClaim?.(claim)).toEqual({ status: 'unavailable', reason: 'cleanup-metadata-unavailable' });
      expect((await fixture.api.readCurrentMeshAccounting?.({ observationId: 'actual-callback-missing',
        limitBytes: 64 * 1024 * 1024, expectedOwners: [] }))?.status).toBe('unknown');
      Object.defineProperty(cache, 'cleanupFailureCount', descriptor);
      const count = vi.spyOn(cache, 'cleanupFailureCount');
      for (const invalid of [NaN, -1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
        count.mockReturnValueOnce(invalid);
        expect(await fixture.api.readPartOwnership?.(claim.owner)).toEqual({ status: 'unavailable', reason: 'cleanup-metadata-unavailable' });
      }
      count.mockImplementationOnce(() => { throw new Error('Actual cleanup observation unavailable'); });
      expect(await fixture.bridge.releasePartClaim?.(claim)).toEqual({ status: 'unavailable', reason: 'cleanup-metadata-unavailable' });
      expect(await fixture.bridge.releasePartClaim?.(claim)).toEqual({ status: 'absent' });
      expect(bodyBytes(fixture.result.bodies)).toBeGreaterThan(0);
    } finally { Object.defineProperty(cache, 'cleanupFailureCount', descriptor); }
    cleanup.push(() => cache.clear());
  });
  it('256 actual Part absences retire exact owner slots while every external main borrower stays positive', async () => {
    const cache = measuredCache(), fixture = await localBox(1, cache);
    const firstClaim = partClaim(fixture), borrowers = [fixture.result.bodies];
    await fixture.api.releasePart('ledger-part');
    expect(await fixture.bridge.releasePartClaim?.(firstClaim)).toEqual({ status: 'absent' });
    const before = await fixture.bridge.captureCurrentMeshLedger?.({ observationId: 'after-first-actual-absence', owners: [] });
    if (before?.status !== 'known') throw new Error('Actual current registered backing baseline');
    const finishedClaims = [firstClaim];
    for (let index = 1; index <= 256; index++) {
      const partId = `actual-absence-part-${index}`;
      const result = await recomputePart(fixture.document, fixture.bridge, { ...fixture.options, partId, generation: index });
      expect(result.errors).toEqual([]);
      const claim = fixture.bridge.capturePartReleaseClaim?.(result.bodies);
      if (claim === undefined || claim === null) throw new Error('Actual current display reply');
      borrowers.push(result.bodies); finishedClaims.push(claim);
      expect(bodyBytes(result.bodies)).toBeGreaterThan(0);
      await fixture.api.releasePart(partId); // Real cache token return, independently of the claim path.
      expect(await fixture.bridge.releasePartClaim?.(claim)).toEqual({ status: 'absent' });
    }
    const current = await fixture.bridge.captureCurrentMeshLedger?.({ observationId: 'after-256-authoritative-absences', owners: [] });
    if (current?.status !== 'known') throw new Error('No false logical-owner capacity exhaustion');
    const actualBorrowedBytes = borrowers.reduce((sum, bodies) => sum + bodyBytes(bodies), 0);
    expect(actualBorrowedBytes).toBeGreaterThan(0);
    expect(current.hostRetainedBackingBytes).toBeGreaterThanOrEqual(actualBorrowedBytes);
    expect(current.pendingCloneReservedBytes).toBe(0);
    expect(current.unobserved).toContain('native'); expect(current.unobserved).toContain('gpu');
    fixture.bridge.dispose();
    for (const claim of finishedClaims) expect(await fixture.bridge.releasePartClaim?.(claim)).toEqual({ status: 'closed' });
    // Closure does not detach/free externally borrowed actual main arrays.
    expect(borrowers.reduce((sum, bodies) => sum + bodyBytes(bodies), 0)).toBe(actualBorrowedBytes);
    const observerApi = createKernelApi(loadOcctForNode), observer = createKernelBridge();
    Comlink.expose(observerApi, silentWorkers.serverEndpoint());
    cleanup.push(() => observer.dispose());
    const afterClosed = await observer.captureCurrentMeshLedger?.({ observationId: 'logical-closure-strong-borrowers', owners: [] });
    if (afterClosed?.status !== 'known') throw new Error('Fresh other provider sees retained main realm backings');
    expect(afterClosed.hostRetainedBackingBytes).toBeGreaterThanOrEqual(actualBorrowedBytes);
    expect(afterClosed.unobserved).toContain('native'); expect(afterClosed.unobserved).toContain('gpu');
    cleanup.push(() => cache.clear());
  });

  it('actual missing Comlink current provider replies unknown instead of being a callable capability proof', async () => {
    const api = createKernelApi(loadOcctForNode), bridge = createKernelBridge();
    Comlink.expose(api, silentWorkers.serverEndpoint());
    cleanup.push(() => bridge.dispose());
    expect(Reflect.deleteProperty(api, 'readCurrentMeshAccounting')).toBe(true);
    if (bridge.captureCurrentMeshLedger === undefined || bridge.currentMeshLedgerReceipt === undefined) throw new Error('Bridge current capability');
    const receipt = await bridge.captureCurrentMeshLedger({ observationId: 'actual-missing-remote-provider', owners: [] });
    expect(receipt).toMatchObject({ status: 'unknown', reason: 'provider-reply-unavailable' });
    expect(bridge.currentMeshLedgerReceipt(receipt)).toBe(false);
    expect(bridge.pendingWaiters()).toBe(0);
  });

  it('issued global membership classifies actual main Source identities and distinct buffers without using copied receipts or inspections', async () => {
    const fixture = await localBox();
    const receipt = await fixture.bridge.captureCurrentMeshLedger?.({ observationId: 'actual-membership', owners: [fixture.owner] });
    if (receipt?.status !== 'known') throw new Error('Actual issued global receipt');
    const source = fixture.result.bodies[0]?.mesh.positions.buffer;
    if (!(source instanceof ArrayBuffer)) throw new Error('Actual main Source backing');
    const distinct = new ArrayBuffer(24);
    const actualQueries = vi.spyOn(fixture.api, 'readCurrentMeshAccounting');
    const inspection = await fixture.bridge.inspectSourceMeshBackings?.(receipt, [source, distinct, source, distinct]);
    if (inspection?.status !== 'known') throw new Error('Actual global identity inspection');
    expect(actualQueries).toHaveBeenCalledTimes(2);
    expect(fixture.bridge.currentMeshLedgerReceipt?.(receipt)).toBe(true);
    expect(inspection.hostEpoch).toBe(receipt.hostEpoch);
    expect(inspection.coverage).toBe('registered-main-solid-backings-only');
    expect(inspection.sameSourceBackings).toHaveLength(1); expect(inspection.sameSourceBackings[0]?.deref()).toBe(source);
    expect(inspection.inputBackingBytes).toBe(source.byteLength + 24); expect(inspection.additionalBackingBytes).toBe(24);
    expect(fixture.bridge.currentSourceMeshBackingInspection?.(inspection, receipt)).toBe(true);
    expect(fixture.bridge.currentSourceMeshBackingInspection?.({ ...inspection }, receipt)).toBe(false);
    expect(fixture.bridge.currentSourceMeshBackingInspection?.(inspection, { ...receipt })).toBe(false);
    expect((await fixture.bridge.inspectSourceMeshBackings?.({ ...receipt }, [source]))?.status).toBe('unknown');
    expect(source.byteLength).toBeGreaterThan(0); expect(inspection.unobserved).toContain('native'); expect(inspection.unobserved).toContain('gpu');
    await fixture.bridge.releasePartClaim?.(partClaim(fixture));
    expect(fixture.bridge.currentSourceMeshBackingInspection?.(inspection, receipt)).toBe(false);
    expect((await fixture.bridge.inspectSourceMeshBackings?.(receipt, [source]))?.status).toBe('unknown');
    const fresh = await fixture.bridge.captureCurrentMeshLedger?.({ observationId: 'borrower-after-owner-retire', owners: [] });
    if (fresh?.status !== 'known') throw new Error('Actual retained main borrower receipt');
    const retired = await fixture.bridge.inspectSourceMeshBackings?.(fresh, [source]);
    if (retired?.status !== 'known') throw new Error('Retired-but-live actual Source backing');
    expect(retired.additionalBackingBytes).toBe(0); expect(retired.sameSourceBackings[0]?.deref()).toBe(source);
    expect(fresh.hostRetainedBackingBytes).toBeGreaterThanOrEqual(source.byteLength);
  });
  it('readonly membership still settles a genuinely dispatched query on transport break', async () => {
    const fixture = await localBox();
    const receipt = await fixture.bridge.captureCurrentMeshLedger?.({ observationId: 'readonly-break', owners: [fixture.owner] });
    if (receipt?.status !== 'known') throw new Error('Actual issued global receipt');
    const source = fixture.result.bodies[0]?.mesh.positions.buffer;
    if (!(source instanceof ArrayBuffer)) throw new Error('Actual main Source backing');
    let acknowledgeDispatch: () => void = () => { throw new Error('Dispatch handshake not installed'); };
    const dispatched = new Promise<void>(resolve => { acknowledgeDispatch = resolve; });
    const query = vi.spyOn(fixture.api, 'readCurrentMeshAccounting').mockImplementationOnce(() => {
      acknowledgeDispatch(); return new Promise(() => undefined);
    });
    const pending = fixture.bridge.inspectSourceMeshBackings?.(receipt, [source]);
    await dispatched;
    expect(query).toHaveBeenCalledTimes(1);
    expect(fixture.bridge.pendingWaiters()).toBe(1);
    silentWorkers.breakCurrent();
    expect(await pending).toEqual({ status: 'unknown', reason: 'transport-unavailable' });
    expect(fixture.bridge.pendingWaiters()).toBe(0);
    expect(fixture.bridge.currentMeshLedgerReceipt?.(receipt)).toBe(false);
    expect(source.byteLength).toBeGreaterThan(0);
    query.mockRestore();
  });
  it('global membership requires own issued receipt and actual freshness across other managed providers', async () => {
    const first = await localBox(), second = await localBox();
    const secondReceipt = await second.bridge.captureCurrentMeshLedger?.({ observationId: 'other-factory', owners: [second.owner] });
    if (secondReceipt?.status !== 'known') throw new Error('Other issued global receipt');
    const source = second.result.bodies[0]?.mesh.positions.buffer;
    if (!(source instanceof ArrayBuffer)) throw new Error('Other managed main backing');
    expect((await first.bridge.inspectSourceMeshBackings?.(secondReceipt, [source]))?.status).toBe('unknown');
    const own = await first.bridge.captureCurrentMeshLedger?.({ observationId: 'both-providers-own-receipt', owners: [first.owner, second.owner] });
    if (own?.status !== 'known') throw new Error('Actual two-provider global receipt');
    const inspected = await first.bridge.inspectSourceMeshBackings?.(own, [source]);
    if (inspected?.status !== 'known') throw new Error('Actual registered other-provider main Source');
    expect(inspected.sameSourceBackings[0]?.deref()).toBe(source); expect(inspected.additionalBackingBytes).toBe(0);
    await second.api.releasePart('ledger-part'); // Bypass managed host notification, so async Worker epoch refresh must catch it.
    expect((await first.bridge.inspectSourceMeshBackings?.(own, [source]))?.status).toBe('unknown');
    // A synchronous host-current check is not substituted for the mandatory async global observation.
    const fresh = await first.bridge.captureCurrentMeshLedger?.({ observationId: 'after-real-other-worker-change', owners: [first.owner] });
    if (fresh?.status !== 'known') throw new Error('Actual current global receipt after return');
    const query = vi.spyOn(second.api, 'readCurrentMeshAccounting').mockImplementationOnce(query => Promise.resolve({
      status: 'unknown', observationId: query.observationId, reason: 'actual-provider-unavailable' }));
    expect((await first.bridge.inspectSourceMeshBackings?.(fresh, [source]))?.status).toBe('unknown');
    expect(query).toHaveBeenCalled(); expect(source.byteLength).toBeGreaterThan(0);
  });
  it('EX12: more than 4,096 UI backings are inspected under the capacity bound (512 MiB / 4 KiB) and refused only above it', async () => {
    const fixture = await localBox();
    const receipt = await fixture.bridge.captureCurrentMeshLedger?.({ observationId: 'ex12-many-ui-backings', owners: [fixture.owner] });
    if (receipt?.status !== 'known') throw new Error('Actual issued global receipt');
    const source = fixture.result.bodies[0]?.mesh.positions.buffer;
    if (!(source instanceof ArrayBuffer)) throw new Error('Actual main Source backing');
    // About 1,000 parts' worth of UI copies: above the former fixed 4,096 input backings.
    const copies = Array.from({ length: 5_000 }, () => new ArrayBuffer(8));
    const inspection = await fixture.bridge.inspectSourceMeshBackings?.(receipt, [source, ...copies]);
    if (inspection?.status !== 'known') throw new Error(`Capacity-bounded inspection: ${inspection?.status === 'unknown' ? inspection.reason : 'missing'}`);
    expect(inspection.inputBackingBytes).toBe(source.byteLength + 5_000 * 8);
    expect(inspection.additionalBackingBytes).toBe(5_000 * 8);
    expect(inspection.sameSourceBackings).toHaveLength(1); expect(inspection.sameSourceBackings[0]?.deref()).toBe(source);
    expect(fixture.bridge.currentSourceMeshBackingInspection?.(inspection, receipt)).toBe(true);
    // One backing more than the capacity bound (131,072) is refused with its reason, and the receipt stays current.
    const beyond = Array.from({ length: 512 * 1024 * 1024 / 4096 + 1 }, () => new ArrayBuffer(0));
    expect(await fixture.bridge.inspectSourceMeshBackings?.(receipt, beyond)).toEqual({ status: 'unknown', reason: 'input-capacity' });
    expect(fixture.bridge.currentMeshLedgerReceipt?.(receipt)).toBe(true);
  });
  it('EX12: the publication gate issues a known receipt and inspection for 1,000 current display owners (one per distinct part)', async () => {
    const api = createKernelApi(() => Promise.reject(new Error('Empty managed work must not load OCCT'))), bridge = createKernelBridge();
    Comlink.expose(api, silentWorkers.serverEndpoint());
    const parts = Array.from({ length: 1_000 }, (_, index) => `ex12-gate-part-${String(index)}`);
    cleanup.push(async () => { bridge.dispose(); for (const partId of parts) await api.releasePart(partId); });
    const localMesh = { maximumFloat32ErrorMm: 1e-4, maximumLiveMeshBytes: 64 * 1024 * 1024 };
    const owners: NonNullable<ReturnType<NonNullable<ReturnType<typeof createKernelBridge>['meshLedgerOwner']>>>[] = [];
    for (const partId of parts) {
      // Empty steps with a local budget still take the managed display path: dispatch, admission, adoption, receipt.
      const outcome = await bridge.recomputeSolids([], { partId, generation: 1, localMesh });
      expect(outcome.failures).toEqual([]);
      const owner = bridge.meshLedgerOwner?.(outcome.bodies);
      if (owner === undefined || owner === null) throw new Error('Actual display owner per part');
      owners.push(owner);
    }
    const receipt = await bridge.captureCurrentMeshLedger?.({ observationId: 'ex12-gate-1000', owners });
    if (receipt?.status !== 'known') throw new Error(`Known 1,000-owner receipt: ${receipt?.status === 'unknown' ? receipt.reason : 'missing'}`);
    expect(receipt.owners).toHaveLength(1_000);
    expect(bridge.currentMeshLedgerReceipt?.(receipt)).toBe(true);
    const inspection = await bridge.inspectSourceMeshBackings?.(receipt, []);
    if (inspection?.status !== 'known') throw new Error(`Known 1,000-owner inspection: ${inspection?.status === 'unknown' ? inspection.reason : 'missing'}`);
    expect(bridge.currentSourceMeshBackingInspection?.(inspection, receipt)).toBe(true);
  });
});

describe('actual acquisition and partial native/cache cleanup disposition', () => {
  afterEach(() => vi.restoreAllMocks());
  it('a real KernelApi acquisition throw restores the active counter before the next operation', async () => {
    const cache = createShapeCache<CachedSolid>(16,
      entry => entry.mesh.positions.byteLength + entry.mesh.normals.byteLength + entry.mesh.indices.byteLength + entry.mesh.edgePositions.byteLength,
      entry => [entry.mesh.positions.buffer, entry.mesh.normals.buffer, entry.mesh.indices.buffer, entry.mesh.edgePositions.buffer]);
    const api = createKernelApi(loadOcctForNode, cache);
    const acquire = vi.spyOn(cache, 'acquire').mockImplementationOnce(() => { throw new Error('actual acquisition failure'); });
    await expect(api.recomputeSolids({ partId: 'acquire-failure', generation: 1, steps: [] })).rejects.toThrow('actual acquisition failure');
    acquire.mockRestore();
    if (api.readCurrentMeshAccounting === undefined) throw new Error('Current query');
    const next = await api.readCurrentMeshAccounting({ observationId: 'after-acquire-throw', limitBytes: 64 * 1024 * 1024, expectedOwners: [] });
    expect(next.status).toBe('known');
    expect(cache.stats().protectedKeyCount).toBe(0);
    await api.recomputeSolids({ partId: 'acquire-failure', generation: 2, steps: [] });
    expect((await api.readCurrentMeshAccounting({ observationId: 'normal-after-acquire-throw', limitBytes: 64 * 1024 * 1024, expectedOwners: [] })).status).toBe('known');
    await api.releasePart('acquire-failure'); cache.clear();
  });
  it('an actual cache token releases every successful native entry once and retains only the partially failed entry/backing', async () => {
    const oc = await loadOcctForNode();
    const state: { shapeDeletes: number; makerDeletes: number }[] = [];
    function entry(bytes: number, failAfterShape = false) {
      const maker = new oc.BRepPrimAPI_MakeBox_2(1, 2, 3), shape = maker.Shape();
      const counts = { shapeDeletes: 0, makerDeletes: 0 }; state.push(counts);
      const backing = new ArrayBuffer(bytes);
      return { backing, maker, delete() {
        shape.delete(); counts.shapeDeletes += 1;
        if (failAfterShape) throw new Error('native shape freed before maker failure');
        maker.delete(); counts.makerDeletes += 1;
      } };
    }
    const a = entry(12), failed = entry(24, true), c = entry(36), current = entry(48);
    const cache = createShapeCache<ReturnType<typeof entry>>(16, value => value.backing.byteLength, value => [value.backing]);
    cache.set('body', a); const token = cache.acquire(['body']);
    cache.set('body', failed); cache.set('body', c); cache.set('body', current);
    expect(() => cache.release(token)).toThrow('Shape cache release partially failed');
    expect(state).toEqual([{ shapeDeletes: 1, makerDeletes: 1 }, { shapeDeletes: 1, makerDeletes: 0 },
      { shapeDeletes: 1, makerDeletes: 1 }, { shapeDeletes: 0, makerDeletes: 0 }]);
    expect(failed.maker.IsDone()).toBe(true); // The native maker is still a real live owner.
    expect(cache.failedReleaseBuffers?.(token)).toEqual([failed.backing]);
    const snapshot = cache.meshBufferSnapshot?.();
    expect(snapshot).toMatchObject({ status: 'known', active: [current.backing], retired: [failed.backing], protected: [failed.backing] });
    expect(cache.stats().meshByteCounts).toMatchObject({ status: 'known', totalBytes: 72 });
    expect(cache.stats().protectedKeyCount).toBe(0); expect(cache.cleanupFailureCount?.()).toBe(1);
    expect(() => cache.release(token)).toThrow('Shape cache release partially failed');
    expect(state[0]).toEqual({ shapeDeletes: 1, makerDeletes: 1 });
    expect(state[1]).toEqual({ shapeDeletes: 1, makerDeletes: 0 });
    expect(state[2]).toEqual({ shapeDeletes: 1, makerDeletes: 1 });
    cache.delete('body');
    expect(cache.meshBufferSnapshot?.()).toMatchObject({ status: 'known', active: [], retired: [failed.backing] });
    // Test teardown has independent proof maker was never freed; production does not infer this disposition.
    failed.maker.delete();
  });

});

describe('actual managed runtime metadata envelope', () => {
  const cleanup: (() => void | Promise<void>)[] = [];
  beforeEach(() => silentWorkers.clear());
  afterEach(async () => {
    vi.restoreAllMocks();
    const failures: unknown[] = [];
    for (const run of cleanup.splice(0).reverse()) { try { await run(); } catch (error) { failures.push(error); } }
    if (failures.length > 0) throw new AggregateError(failures, 'Actual managed phase fixture cleanup failed');
  });
  function nativePhaseFixture() {
    const cache = createShapeCache<CachedSolid>(16,
      entry => entry.mesh.positions.byteLength + entry.mesh.normals.byteLength + entry.mesh.indices.byteLength + entry.mesh.edgePositions.byteLength,
      entry => [entry.mesh.positions.buffer, entry.mesh.normals.buffer, entry.mesh.indices.buffer, entry.mesh.edgePositions.buffer]);
    const api = createKernelApi(loadOcctForNode, cache);
    const owners = new Map<string, NonNullable<Parameters<typeof api.recomputeSolids>[4]>>();
    const recompute = api.recomputeSolids.bind(api);
    api.recomputeSolids = (...args) => {
      const owner = args[4]; if (owner !== undefined) owners.set(owner.dispatchId, owner);
      return recompute(...args);
    };
    cleanup.push(async () => {
      const failures: unknown[] = [];
      for (const owner of owners.values()) { try { await api.acknowledgeMeshReply?.(owner); } catch (error) { failures.push(error); } }
      for (const partId of new Set(['phase-source-part', ...[...owners.values()].map(owner => owner.partId)])) {
        try { await api.releasePart(partId); } catch (error) { failures.push(error); }
      }
      try { cache.clear(); } catch (error) { failures.push(error); }
      if (failures.length > 0) throw new AggregateError(failures, 'Actual native provider cleanup failed');
    });
    expect(cache.meshBufferSnapshot?.().status).toBe('known');
    return { cache, api };
  }
  function phaseFixture(readUi = () => ({ activeDocumentId: 'ui-assembly', documentVersion: 7,
    documentKind: 'assembly' as const })) {
    const { cache, api } = nativePhaseFixture();
    const bridge = createKernelBridge(readUi);
    Comlink.expose(api, silentWorkers.serverEndpoint());
    const empty = createEmptyPartDocument(), document = appendSolid(empty, createPrimitiveFeature(empty, 'box'));
    cleanup.push(() => bridge.dispose());
    const options = { partId: 'phase-source-part', generation: 1,
      localMesh: { maximumFloat32ErrorMm: 1e-4, maximumLiveMeshBytes: 64 * 1024 * 1024 } };
    return { cache, api, bridge, document, options };
  }
  it('joins actual Node-hosted Comlink raw/adopt/ACK to native call/preclone without inferring Assembly Source mapping or physical memory', async () => {
    const fixture = phaseFixture();
    const result = await recomputePart(fixture.document, fixture.bridge, fixture.options);
    expect(result.errors).toEqual([]);
    const body = result.bodies[0]; if (body === undefined) throw new Error('Actual native body');
    const owner = fixture.bridge.meshLedgerOwner?.(result.bodies); if (owner === undefined || owner === null) throw new Error('Actual issued owner');
    const bytes = body.mesh.positions.byteLength, backing = body.mesh.positions.buffer;
    const observation = await fixture.bridge.readRuntimePhases();
    expect(observation.status).toBe('observed');
    const main = observation.main.records.filter(record => record.dispatchId === owner.dispatchId);
    expect(main.map(record => record.phase)).toEqual(['dispatch', 'raw-received', 'adopted', 'receiver-acknowledged']);
    expect(main.every(record => record.partId === 'phase-source-part' && record.generation === 1
      && record.ui?.activeDocumentId === 'ui-assembly' && record.ui.documentVersion === 7 && record.ui.documentKind === 'assembly')).toBe(true);
    const worker = observation.worker; if (worker === null) throw new Error('Received actual Worker-side metadata');
    expect(worker.records.filter(record => record.dispatchId === owner.dispatchId).map(record => record.phase))
      .toEqual(['native-build-start', 'native-build-return', 'reply-preclone']);
    expect(observation.transport).toBe('preclone-to-resolved-main-reply-envelope');
    expect(observation.unobserved).toContain('physical-resident'); expect(observation.unobserved).toContain('assembly-source-library-mapping');
    await fixture.bridge.releasePart('phase-source-part');
    expect(body.mesh.positions.buffer).toBe(backing); expect(body.mesh.positions.byteLength).toBe(bytes);
    expect(bytes).toBeGreaterThan(0); // Node managed transport is not an actual OS Worker or GPU release proof.
  });
  it.each(['duplicate-sequence', 'empty-owner', 'unsafe-generation'] as const)(
    'rejects corrupted %s metadata from an actual managed provider without changing geometry', async corruption => {
      const fixture = phaseFixture();
      const result = await recomputePart(fixture.document, fixture.bridge, fixture.options);
      expect(result.errors).toEqual([]);
      const body = result.bodies[0]; if (body === undefined) throw new Error('Actual native body required');
      const backing = body.mesh.positions.buffer, bytes = body.mesh.positions.byteLength;
      const read = fixture.api.readRuntimePhases?.bind(fixture.api);
      if (read === undefined) throw new Error('Actual provider method required');
      vi.spyOn(fixture.api, 'readRuntimePhases').mockImplementationOnce(() => read().then(snapshot => {
        const first = snapshot.records[0], second = snapshot.records[1];
        if (first === undefined || second === undefined) throw new Error('Actual native phase records required');
        const changed = corruption === 'duplicate-sequence' ? { ...second, seq: first.seq }
          : corruption === 'empty-owner' ? { ...second, dispatchId: '' }
          : { ...second, generation: Number.MAX_SAFE_INTEGER + 1 };
        return { ...snapshot, records: [first, changed, ...snapshot.records.slice(2)] };
      }));
      expect(await fixture.bridge.readRuntimePhases()).toMatchObject({ status: 'unknown',
        reason: corruption === 'duplicate-sequence' ? 'invalid-worker-sequence' : 'unmatched-worker-owner' });
      expect(body.mesh.positions.buffer).toBe(backing); expect(body.mesh.positions.byteLength).toBe(bytes);
      expect(bytes).toBeGreaterThan(0);
    });
  it('missing metadata capability and failing UI context stay unknown without changing actual geometry', async () => {
    const fixture = phaseFixture(() => { throw new Error('diagnostic UI context unavailable'); });
    const result = await recomputePart(fixture.document, fixture.bridge, fixture.options);
    expect(result.errors).toEqual([]); expect(result.bodies[0]?.mesh.positions.byteLength).toBeGreaterThan(0);
    expect(await fixture.bridge.readRuntimePhases()).toMatchObject({ status: 'unknown', reason: 'metadata-incomplete', main: { missingContexts: 1 } });
    expect(Reflect.deleteProperty(fixture.api, 'readRuntimePhases')).toBe(true);
    expect(await fixture.bridge.readRuntimePhases()).toMatchObject({ status: 'unknown', reason: 'provider-reply-unavailable', worker: null });
    expect(fixture.bridge.pendingWaiters()).toBe(0); expect(fixture.bridge.pendingCallbacks()).toBe(0);
  });
  it('keeps an actual unmanaged provider call unmatched instead of inventing a main dispatch owner', async () => {
    const fixture = phaseFixture();
    const result = await recomputePart(fixture.document, fixture.bridge, fixture.options);
    expect(result.errors).toEqual([]);
    try {
      await fixture.api.recomputeSolids({ partId: 'unmanaged-phase', generation: 1, steps: [] });
      const observation = await fixture.bridge.readRuntimePhases();
      expect(observation).toMatchObject({ status: 'unknown', reason: 'unmatched-worker-owner' });
      expect(observation.worker?.missingOwners).toBeGreaterThan(0);
      expect(result.bodies[0]?.mesh.positions.byteLength).toBeGreaterThan(0);
    } finally { await fixture.api.releasePart('unmanaged-phase'); }
  });
  it('records actual receiver ACK failure and its exact retry while the real host borrower stays attached', async () => {
    const fixture = phaseFixture();
    const acknowledge = vi.spyOn(fixture.api, 'acknowledgeMeshReply').mockRejectedValueOnce(new Error('actual ACK transport failure'));
    const result = await recomputePart(fixture.document, fixture.bridge, fixture.options);
    expect(result.errors).toEqual([]); expect(fixture.bridge.pendingReferenceMeshCleanup?.()).toBe(1);
    const before = await fixture.bridge.readRuntimePhases();
    expect(before.status).toBe('unknown'); expect(before.reason).toBe('receiver-ack-unsettled');
    expect(before.main.records.some(record => record.phase === 'receiver-ack-failed')).toBe(true);
    acknowledge.mockRestore();
    expect(await fixture.bridge.retryReferenceMeshCleanup?.()).toEqual({ released: 1, retained: 0 });
    const after = await fixture.bridge.readRuntimePhases(); expect(after.status).toBe('observed');
    expect(after.main.records.filter(record => record.phase === 'receiver-acknowledged')).toHaveLength(1);
    expect(result.bodies[0]?.mesh.positions.byteLength).toBeGreaterThan(0);
  });
  it('rejects stale read completion on actual transport break, then separates the next real connection epoch', async () => {
    const fixture = phaseFixture();
    const result = await recomputePart(fixture.document, fixture.bridge, fixture.options);
    const before = await fixture.bridge.readRuntimePhases(); expect(before.status).toBe('observed');
    let entered: () => void = () => { throw new Error('Actual readonly dispatch not installed'); };
    const dispatched = new Promise<void>(resolve => { entered = resolve; });
    const blocked = vi.spyOn(fixture.api, 'readRuntimePhases').mockImplementationOnce(() => { entered(); return new Promise(() => undefined); });
    const pending = fixture.bridge.readRuntimePhases(); await dispatched;
    silentWorkers.breakCurrent();
    expect(await pending).toMatchObject({ status: 'unknown', reason: 'transport-unavailable' });
    expect(fixture.bridge.pendingWaiters()).toBe(0); blocked.mockRestore();
    const { api: nextApi } = nativePhaseFixture();
    silentWorkers.connectNextCreated(() => Comlink.expose(nextApi, silentWorkers.serverEndpoint()));
    const next = await recomputePart(fixture.document, fixture.bridge, { ...fixture.options, generation: 2 });
    expect(next.errors).toEqual([]);
    const current = await fixture.bridge.readRuntimePhases(); expect(current.status).toBe('observed');
    expect(current.connectionEpoch).toBeGreaterThan(before.connectionEpoch);
    expect(current.main.records.some(record => record.phase === 'connection-interrupted')).toBe(true);
    expect(current.worker?.records.every(record => record.generation === 2)).toBe(true);
    expect(result.bodies[0]?.mesh.positions.byteLength).toBeGreaterThan(0);
  });
  it('late actual native reply after transport closure is not a current raw/adopt event and its Node-owned cache is explicitly cleaned', async () => {
    const fixture = phaseFixture();
    let announce: () => void = () => { throw new Error('Actual native reply handshake not installed'); };
    let finish: () => void = () => { throw new Error('Actual native reply gate not installed'); };
    const entered = new Promise<void>(resolve => { announce = resolve; });
    const gate = new Promise<void>(resolve => { finish = resolve; });
    const original = fixture.api.recomputeSolids.bind(fixture.api);
    let nativeFailed = false, nativeFailure: unknown;
    let nativeCompletion: Promise<SolidRecomputeResult> | undefined;
    const dispatched = vi.spyOn(fixture.api, 'recomputeSolids').mockImplementation((...args) => {
      nativeCompletion = (async () => {
        try { const result = await original(...args); announce(); await gate; return result; }
        catch (error) { nativeFailed = true; nativeFailure = error; announce(); throw error; }
      })();
      return nativeCompletion;
    });
    const pending = fixture.bridge.recomputeSolids(resolvePart(fixture.document).steps, fixture.options);
    const settled = pending.then(result => ({ status: 'returned' as const, result }), (error: unknown) => ({ status: 'rejected' as const, error }));
    try {
      await entered;
      if (nativeFailed) throw nativeFailure;
      fixture.bridge.dispose(); finish();
      const completion = await settled;
      if (completion.status === 'rejected') throw completion.error;
      expect(completion.result.bodies).toEqual([]);
      const observation = await fixture.bridge.readRuntimePhases(); expect(observation.status).toBe('unknown');
      expect(observation.main.records.filter(record => record.phase === 'raw-received' || record.phase === 'adopted')).toEqual([]);
      expect(fixture.bridge.pendingWaiters()).toBe(0); expect(fixture.bridge.pendingCallbacks()).toBe(0);
      const owner = dispatched.mock.calls[0]?.[4]; if (owner === undefined) throw new Error('Actual Worker owner');
      await fixture.api.acknowledgeMeshReply?.(owner); // Fake transport termination did not free the separately retained real API.
    } finally { finish(); await settled; if (nativeCompletion !== undefined) await nativeCompletion; }
  });
  it('a real transport terminate throw records failure and cannot become a completed lifetime receipt', async () => {
    const created = vi.spyOn(silentWorkers, 'create');
    const fixture = phaseFixture();
    const result = await recomputePart(fixture.document, fixture.bridge, fixture.options);
    const worker = created.mock.results[0]; if (worker?.type !== 'return') throw new Error('Actual transport worker');
    const terminate = vi.spyOn(worker.value, 'terminate').mockImplementationOnce(() => { throw new Error('Actual terminate did not return'); });
    try {
      expect(() => fixture.bridge.dispose()).toThrow('Actual terminate did not return');
      const observation = await fixture.bridge.readRuntimePhases();
      expect(observation.status).toBe('unknown');
      expect(observation.main.records.filter(record => record.phase === 'connection-close-failed')).toHaveLength(1);
      expect(observation.main.records.filter(record => record.phase === 'connection-closed')).toEqual([]);
      expect(result.bodies[0]?.mesh.positions.byteLength).toBeGreaterThan(0);
      fixture.bridge.dispose();
      const closed = await fixture.bridge.readRuntimePhases();
      expect(closed.main.records.filter(record => record.phase === 'connection-closed')).toHaveLength(1);
      expect(closed.status).toBe('unknown'); // Logical transport close is not native or physical resident zero.
    } finally { terminate.mockRestore(); fixture.bridge.dispose(); created.mockRestore(); }
  });
  it('bounds main metadata, preserves exact UI snapshot and records a failed diagnostic clock', () => {
    const ui = { activeDocumentId: 'old-ui', documentVersion: 1, documentKind: 'part' as const };
    const observer = createMainPhaseObserver(() => ui);
    const owner = { dispatchId: 'metadata-only', partId: 'source', generation: 1, kind: 'display' as const, steps: [] };
    observer.record('dispatch', 1, owner); ui.activeDocumentId = 'new-ui'; ui.documentVersion = 2;
    observer.record('adopted', 1, owner);
    expect(observer.snapshot().records[1]?.ui).toMatchObject({ activeDocumentId: 'old-ui', documentVersion: 1 });
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => { throw new Error('diagnostic clock unavailable'); });
    try { expect(() => observer.record('raw-received', 1, owner)).not.toThrow(); }
    finally { clock.mockRestore(); }
    expect(observer.snapshot()).toMatchObject({ clockDiscontinuities: 1 });
    for (let index = 0; index < 257; index += 1) observer.record('raw-received', 1, owner);
    const snapshot = observer.snapshot(); expect(snapshot.records).toHaveLength(256); expect(snapshot.dropped).toBe(4);
    expect(snapshot.records.every(record => !('steps' in record) && Object.isFrozen(record))).toBe(true);
  });
});
