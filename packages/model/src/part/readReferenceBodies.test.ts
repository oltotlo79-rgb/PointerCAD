import { createAllocations } from '../../../kernel/src/occt/allocations.js';
import { writeBrepBytes } from '../../../kernel/src/occt/brepBytes.js';
import { createSubShapeReference } from '../kernelBridge/createSubShapeReference.js';
import type { HoleFeature, ThreadHoleFeature } from './types.js';
import * as Comlink from 'comlink';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { expressionValueFromNumber } from '@pointercad/expression';
import { createKernelApi, createShapeCache, type CachedSolid } from '@pointercad/kernel';
import { loadOcctForNode } from '../../../kernel/src/occt/loadOcct.node.js';
import { createDirectKernelBridge, createKernelBridge, type KernelBridge, type SolidBody, type CurrentMeshLedgerReceipt } from '../kernelBridge.js';
import type { SubShapeRef } from '../geometry/subShapeRef.js';
import { absoluteCoordinate, appendFeature } from '../sketch/createSketchDocument.js';
import { FREE_WORK_PLANE_ID } from '../sketch/planeMath.js';
import type { CoordinateInput, SketchLineFeature } from '../sketch/types.js';
import { appendSolid, createEmptyPartDocument, createPrimitiveFeature, replaceSketch } from './createPartDocument.js';
import { recomputePart, type PartRecomputeOptions, type PartRecomputeResult } from './recomputePart.js';
import { createSubShapeCache } from './subShapeCache.js';
import { readReferenceBodies, type ReferenceBodyReads } from './readReferenceBodies.js';
import { resolvePart } from './resolvePart.js';
import type { PartDocument } from './types.js';

let oc: Awaited<ReturnType<typeof loadOcctForNode>>;
const bridges: KernelBridge[] = [];
beforeAll(async () => { oc = await loadOcctForNode(); }, 180_000);
afterEach(() => { vi.restoreAllMocks(); for (const bridge of bridges.splice(0)) bridge.dispose(); });

function kernel(): KernelBridge {
  const bridge = createDirectKernelBridge(createKernelApi(() => Promise.resolve(oc)));
  bridges.push(bridge);
  return bridge;
}
function boxPart(): PartDocument {
  const document = createEmptyPartDocument(), feature = createPrimitiveFeature(document, 'box');
  return appendSolid(document, { ...feature, shape: { kind: 'box', sizeX: expressionValueFromNumber(20),
    sizeY: expressionValueFromNumber(30), sizeZ: expressionValueFromNumber(40) } });
}
function consume(document: PartDocument): PartDocument {
  const tool = createPrimitiveFeature(document, 'box');
  const next = appendSolid(document, { ...tool, origin: { kind: 'coordinate', value: absoluteCoordinate(10, 0, 0) },
    shape: { kind: 'box', sizeX: expressionValueFromNumber(20), sizeY: expressionValueFromNumber(30), sizeZ: expressionValueFromNumber(40) } });
  return appendSolid(next, { kind: 'boolean', id: 'joined', name: '結合', suppressed: false,
    operation: 'union', targetFeatureId: document.solids[0].id, toolFeatureId: tool.id });
}
function reference(body: SolidBody, y: number): SubShapeRef {
  const vertex = body.vertices.find(value => value.position[0] === 10 && value.position[1] === y && value.position[2] === 20);
  if (vertex === undefined) throw new Error('Expected real box corner');
  return { bodyFeatureId: body.featureId, index: vertex.index, fingerprint: { kind: 'vertex', position: vertex.position } };
}
function coordinate(ref: SubShapeRef): CoordinateInput {
  const zero = expressionValueFromNumber(0);
  return { mode: 'relative', base: { kind: 'subShape', ref }, dx: zero, dy: zero, dz: zero };
}
function withLine(document: PartDocument, body: SolidBody): PartDocument {
  const line: SketchLineFeature = { id: 'connected', name: '頂点の線', kind: 'line', planeId: FREE_WORK_PLANE_ID,
    construction: false, from: coordinate(reference(body, 15)), to: coordinate(reference(body, -15)) };
  return replaceSketch(document, appendFeature(document.sketches[0], line));
}
function line(result: PartRecomputeResult) {
  return result.sketches[0]?.resolved.segments.find(value => value.featureId === 'connected');
}
function measuredVolume(result: PartRecomputeResult): number {
  const outcome = result.mathGeometry?.[0];
  if (outcome?.status !== 'value' || typeof outcome.value !== 'number') throw new Error('Expected current measured volume');
  return outcome.value;
}
function resize(document: PartDocument): PartDocument {
  return { ...document, solids: document.solids.map((feature, index) => index === 0 && feature.kind === 'primitive'
    ? { ...feature, shape: { kind: 'box', sizeX: expressionValueFromNumber(40),
      sizeY: expressionValueFromNumber(30), sizeZ: expressionValueFromNumber(40) } } : feature) };
}

describe('現在の非表示ボディで頂点参照を検証する実カーネル回帰', () => {
  it('自己参照の位置が保存指紋と一致していても循環形状と下流の線を確定しない', async () => {
    const bridge = kernel(), initial = boxPart(), body = (await recomputePart(initial, bridge)).bodies[0];
    const base = withLine(initial, body), document: PartDocument = { ...base, solids: base.solids.map(feature => feature.kind === 'primitive'
      ? { ...feature, origin: { kind: 'coordinate', value: { mode: 'relative', base: { kind: 'subShape', ref: reference(body, 15) },
        dx: expressionValueFromNumber(-10), dy: expressionValueFromNumber(-15), dz: expressionValueFromNumber(-20) } } } : feature) };
    const result = await recomputePart(document, bridge);
    expect(result.errors.some(error => error.code === 'circularReference')).toBe(true);
    expect(result.bodies).toEqual([]);
    expect(line(result)).toBeUndefined();
  });

  it('実2箱の間接循環を拒否し、独立した正常な箱は残す', async () => {
    const bridge = kernel(), initial = boxPart(), source = initial.solids[0];
    if (source.kind !== 'primitive') throw new Error('Expected primitive');
    const pair = appendSolid(initial, { ...source, id: 'other-box' });
    const body = (await recomputePart(pair, bridge)).bodies[0], withConnection = withLine(pair, body);
    const cyclic: PartDocument = { ...withConnection, solids: withConnection.solids.map(feature => feature.kind === 'primitive'
      ? { ...feature, origin: { kind: 'coordinate', value: { mode: 'relative', base: { kind: 'subShape',
        ref: { ...reference(body, 15), bodyFeatureId: feature.id === source.id ? 'other-box' : source.id } },
        dx: expressionValueFromNumber(-10), dy: expressionValueFromNumber(-15), dz: expressionValueFromNumber(-20) } } } : feature) };
    const document = appendSolid(cyclic, { ...source, id: 'independent',
      origin: { kind: 'coordinate', value: absoluteCoordinate(100, 0, 0) } });
    const result = await recomputePart(document, bridge);
    expect(result.errors.filter(error => error.code === 'circularReference').map(error => error.featureId).sort())
      .toEqual([source.id, 'other-box'].sort());
    expect(result.bodies.map(value => value.featureId)).toEqual(['independent']);
    expect(result.bodies[0].volume).toBeCloseTo(24000, 6);
    expect(line(result)).toBeUndefined();
  });

  it('基本形状の相対原点も消費上流の現在頂点へ追従し、削除後は保存位置を使わない', async () => {
    const bridge = kernel(), initial = boxPart(), source = initial.solids[0];
    if (source.kind !== 'primitive') throw new Error('Expected primitive');
    const body = (await recomputePart(initial, bridge)).bodies[0], ref = reference(body, 15), saved = JSON.stringify(ref);
    const document = appendSolid(consume(initial), { ...source, id: 'relative-box',
      origin: { kind: 'coordinate', value: coordinate(ref) } }), subShapes = createSubShapeCache();
    const first = await recomputePart(document, bridge, { subShapes });
    const maximumX = (result: PartRecomputeResult) => Math.max(...(result.bodies.find(value => value.featureId === 'relative-box')?.vertices
      .map(vertex => vertex.position[0]) ?? []));
    expect(first.errors).toEqual([]);
    expect(maximumX(first)).toBe(20);
    const updated = await recomputePart(resize(document), bridge, { subShapes });
    expect(updated.errors).toEqual([]);
    expect(maximumX(updated)).toBe(30);
    const deleted = await recomputePart({ ...document, solids: document.solids.filter(feature => feature.id !== source.id) }, bridge, { subShapes });
    expect(deleted.bodies.some(value => value.featureId === 'relative-box')).toBe(false);
    expect(deleted.errors.some(error => error.featureId === 'relative-box')).toBe(true);
    expect(JSON.stringify(ref)).toBe(saved);
  });

  it('実cacheから退去した現在キーを再構築せず読取失敗と区別する', async () => {
    const cache = createShapeCache<CachedSolid>(), bridge = createDirectKernelBridge(createKernelApi(() => Promise.resolve(oc), cache));
    bridges.push(bridge);
    try {
      const document = consume(boxPart()), resolved = resolvePart(document), result = await recomputePart(document, bridge);
      const source = resolved.steps[0];
      expect(source.visible).toBe(false);
      expect(cache.delete(source.key)).toBe(true);
      const recompute = vi.spyOn(bridge, 'recomputeSolids');
      const current = await readReferenceBodies({ steps: resolved.steps, bodies: result.bodies, featureIds: [source.featureId],
        failedIds: new Set(), bridge, shouldCancel: () => false, features: document.solids });
      expect(current.missing.get(source.featureId)).toBe('read-failed');
      expect(current.bodies.some(value => value.featureId === source.featureId)).toBe(false);
      expect(cache.has(source.key)).toBe(false);
      expect(recompute).not.toHaveBeenCalled();
    } finally { cache.clear(); }
  });

  it('現在の実2ボディを配列順に依存せず一括で読み、同じキーを同じ再計算内だけ再利用する', async () => {
    const bridge = kernel(), document = consume(boxPart()), resolved = resolvePart(document), result = await recomputePart(document, bridge);
    if (bridge.readCachedBodies === undefined) throw new Error('Real cached-body reader required');
    const originalRead = bridge.readCachedBodies.bind(bridge);
    const read = vi.spyOn(bridge, 'readCachedBodies').mockImplementation(async (steps, ids) => {
      const response = await originalRead(steps, ids); return { ...response, bodies: [...response.bodies].reverse() };
    });
    const ids = document.solids.slice(0, 2).map(feature => feature.id), reads: ReferenceBodyReads = new Map();
    const request = { steps: resolved.steps, bodies: [...result.bodies].reverse(), featureIds: [...ids, ids[0]],
      failedIds: new Set<string>(), bridge, shouldCancel: () => false, features: document.solids, reads };
    const current = await readReferenceBodies(request);
    expect(current.missing.size).toBe(0);
    for (const id of ids) expect(current.bodies.find(body => body.featureId === id)?.volume).toBeCloseTo(24000, 6);
    expect(read).toHaveBeenCalledTimes(1);
    expect(read.mock.calls[0]?.[1]).toEqual(ids);
    expect(await readReferenceBodies(request)).toEqual(current);
    expect(read).toHaveBeenCalledTimes(1);
    await readReferenceBodies({ ...request, reads: new Map() });
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('実bodyが手元にあっても現stepの削除・抑制・未解決・失敗・空キー・重複を混同しない', async () => {
    const bridge = kernel(), document = boxPart(), resolved = resolvePart(document), result = await recomputePart(document, bridge);
    const body = result.bodies[0], source = resolved.steps[0];
    const request = { steps: resolved.steps, bodies: result.bodies, featureIds: [body.featureId],
      failedIds: new Set<string>(), bridge, shouldCancel: () => false, features: document.solids };
    const cases = [
      { reason: 'deleted', request: { ...request, steps: [], features: [] } },
      { reason: 'suppressed', request: { ...request, steps: [], features: [{ id: body.featureId, suppressed: true }] } },
      { reason: 'unresolved-step', request: { ...request, steps: [] } },
      { reason: 'failed', request: { ...request, failedIds: new Set([body.featureId]) } },
      { reason: 'unavailable', request: { ...request, steps: [{ ...source, key: '' }] } },
      { reason: 'ambiguous-body', request: { ...request, bodies: [body, body] } },
      { reason: 'invalid-body', request: { ...request, bodies: [{ ...body, isValid: false }] } },
    ];
    for (const value of cases) {
      const current = await readReferenceBodies(value.request);
      expect(current.missing.get(body.featureId)).toBe(value.reason);
      expect(current.bodies).toEqual([]);
    }
  });

  it('削除した実上面に載る作業面と線を保存平面から公開しない', async () => {
    const bridge = kernel(), initial = boxPart(), body = (await recomputePart(initial, bridge, { measureAreas: true })).bodies[0];
    const face = body.faces.find(value => value.centroid[2] === 20);
    if (face === undefined) throw new Error('Expected real upper box face');
    const faceRef: SubShapeRef = { bodyFeatureId: body.featureId, index: face.index, fingerprint: { kind: 'face',
      position: face.centroid, axis: face.axis, area: face.area, surfaceKind: face.surfaceKind, radius: face.radius } };
    const base: PartDocument = { ...initial, references: [{ id: 'upper-plane', name: '上面', kind: 'referencePlane', visible: true,
      plane: { kind: 'face', face: faceRef, offset: expressionValueFromNumber(0) } }] };
    const document = replaceSketch(base, appendFeature(base.sketches[0], { kind: 'line', id: 'connected', name: '平面の線',
      planeId: 'upper-plane', construction: false, from: absoluteCoordinate(0, 0, 20), to: absoluteCoordinate(10, 0, 20) }));
    const subShapes = createSubShapeCache();
    expect(line(await recomputePart(document, bridge, { subShapes }))?.from[2]).toBe(20);
    const onResolved = vi.fn<NonNullable<PartRecomputeOptions['onResolved']>>();
    const missing = await recomputePart({ ...document, solids: [] }, bridge, { subShapes, onResolved });
    expect(line(missing)).toBeUndefined();
    expect(onResolved.mock.calls[0]?.[0].references.planes).toEqual([]);
    expect(missing.errors.some(error => error.featureId === 'upper-plane')).toBe(true);
  });

  it('結合で消費された上流の最新キーを読み、保存参照を変えず頂点の線を更新する', async () => {
    const bridge = kernel(), initial = boxPart(), body = (await recomputePart(initial, bridge)).bodies[0];
    const document = withLine(consume(initial), body), saved = JSON.stringify(document), subShapes = createSubShapeCache();
    const mathGeometry: NonNullable<PartRecomputeOptions['mathGeometry']> = [{ id: 'upstream-volume', documentId: document.id,
      quantity: { kind: 'volume', body: { kind: 'body', featureId: body.featureId } },
      tolerance: { linearMm: 1e-6, angularRadians: 1e-8 } }];
    if (bridge.readCachedBodies === undefined) throw new Error('Real cached-body reader required');
    const read = vi.spyOn(bridge, 'readCachedBodies');
    const first = await recomputePart(document, bridge, { subShapes, generation: 1, mathGeometry });
    expect(first.errors).toEqual([]);
    expect(first.bodies.map(value => value.featureId)).toEqual(['joined']);
    expect(line(first)?.from).toEqual([10, 15, 20]);
    expect(measuredVolume(first)).toBeCloseTo(24000, 6);
    expect(read).toHaveBeenCalledTimes(1);
    const firstKey = read.mock.calls[0]?.[0].find(step => step.featureId === body.featureId)?.key;
    read.mockClear();
    const updated = await recomputePart(resize(document), bridge, { subShapes, generation: 2, mathGeometry });
    expect(updated.errors).toEqual([]);
    expect(updated.bodies.map(value => value.featureId)).toEqual(['joined']);
    expect(line(updated)?.from).toEqual([20, 15, 20]);
    expect(line(updated)?.to).toEqual([20, -15, 20]);
    expect(measuredVolume(updated)).toBeCloseTo(48000, 6);
    expect(read).toHaveBeenCalledTimes(1);
    const nextKey = read.mock.calls[0]?.[0].find(step => step.featureId === body.featureId)?.key;
    expect(firstKey).toBeTypeOf('string');
    expect(nextKey).not.toBe(firstKey);
    expect(JSON.stringify(document)).toBe(saved);
  });

  it.each(['deleted', 'all-deleted', 'suppressed', 'upstream-failed', 'call-throws', 'read-throws', 'read-failed', 'unsupported', 'cancelled'] as const)(
    '%sでは保存位置や前世代の頂点から線を確定しない', async mode => {
      const bridge = kernel(), initial = boxPart(), body = (await recomputePart(initial, bridge)).bodies[0];
      const document = withLine(consume(initial), body), subShapes = createSubShapeCache();
      await recomputePart(document, bridge, { subShapes });
      const changed = mode === 'all-deleted' ? { ...document, solids: [] }
        : mode === 'deleted' ? { ...document, solids: document.solids.filter(feature => feature.id !== body.featureId) }
        : mode === 'suppressed' ? { ...document, solids: document.solids.map(feature => feature.id === body.featureId
          ? { ...feature, suppressed: true } : feature) }
        : mode === 'upstream-failed' ? { ...document, solids: document.solids.map(feature => feature.id === body.featureId && feature.kind === 'primitive'
          ? { ...feature, shape: { kind: 'box' as const, sizeX: expressionValueFromNumber(-1),
            sizeY: expressionValueFromNumber(30), sizeZ: expressionValueFromNumber(40) } } : feature) } : document;
      if (bridge.readCachedBodies === undefined) throw new Error('Real cached-body reader required');
      if (mode === 'read-failed' || mode === 'cancelled') vi.spyOn(bridge, 'readCachedBodies').mockResolvedValue({
        bodies: [], cacheHits: 0, cancelled: mode === 'cancelled', failures: mode === 'read-failed'
          ? [{ featureId: body.featureId, message: '現在キーの形状が失われました。' }] : [] });
      if (mode === 'call-throws') vi.spyOn(bridge, 'recomputeSolids').mockRejectedValue(new Error('injected kernel communication failure'));
      if (mode === 'read-throws') vi.spyOn(bridge, 'readCachedBodies').mockRejectedValue(new Error('injected read failure'));
      const withoutRead = { ...bridge };
      delete withoutRead.readCachedBodies;
      const result = await recomputePart(changed, mode === 'unsupported' ? withoutRead : bridge, { subShapes });
      expect(line(result)).toBeUndefined();
      if (mode === 'cancelled') expect(result.cancelled).toBe(true);
      else expect(result.errors.some(error => error.featureId === 'connected')).toBe(true);
    });
});

const nativePreviewTransport = vi.hoisted(() => {
  class NativeTransport extends EventTarget {
    readonly requests = new EventTarget();
    readonly listeners = new Set<EventListenerOrEventListenerObject>();
    closed = false;
    postMessage(message: unknown, transfer: Transferable[] = []): void {
      if (this.closed) throw new Error('Own native transport closed');
      const data: unknown = structuredClone(message, { transfer });
      queueMicrotask(() => { if (!this.closed) this.requests.dispatchEvent(new MessageEvent('message', { data })); });
    }
    terminate(): void {
      this.closed = true;
      for (const listener of this.listeners) this.requests.removeEventListener('message', listener);
      this.listeners.clear();
    }
  }
  let latest: NativeTransport | undefined;
  return {
    create() { latest = new NativeTransport(); return latest; },
    endpoint() {
      const worker = latest;
      if (worker === undefined) throw new Error('Own managed transport required');
      return {
        postMessage(message: unknown, transfer: Transferable[] = []) {
          const data: unknown = structuredClone(message, { transfer });
          queueMicrotask(() => { if (!worker.closed) worker.dispatchEvent(new MessageEvent('message', { data })); });
        },
        addEventListener(type: string, listener: EventListenerOrEventListenerObject) {
          worker.listeners.add(listener); worker.requests.addEventListener(type, listener);
        },
        removeEventListener(type: string, listener: EventListenerOrEventListenerObject) {
          worker.listeners.delete(listener); worker.requests.removeEventListener(type, listener);
        },
      };
    },
  };
});
vi.mock('@pointercad/kernel', async importOriginal => {
  const actual = await importOriginal<typeof import('@pointercad/kernel')>();
  return { ...actual, createKernelWorker: () => nativePreviewTransport.create() };
});
const managedPreviewCleanup: (() => void)[] = [];
afterEach(() => { for (const close of managedPreviewCleanup.splice(0).reverse()) close(); });
function managedPreviewKernel(): KernelBridge {
  const cache = createShapeCache<CachedSolid>(
    undefined,
    ({ mesh }) => mesh.positions.byteLength + mesh.normals.byteLength
      + mesh.indices.byteLength + mesh.edgePositions.byteLength,
    ({ mesh }) => [mesh.positions.buffer, mesh.normals.buffer, mesh.indices.buffer, mesh.edgePositions.buffer],
  );
  const api = createKernelApi(() => Promise.resolve(oc), cache);
  const bridge = createKernelBridge();
  try { Comlink.expose(api, nativePreviewTransport.endpoint()); }
  catch (error) { try { bridge.dispose(); } finally { cache.clear(); } throw error; }
  managedPreviewCleanup.push(() => { try { bridge.dispose(); } finally { cache.clear(); } });
  if (bridge.meshLedgerOwner === undefined || bridge.captureCurrentMeshLedger === undefined
    || bridge.currentMeshLedgerReceipt === undefined || bridge.releaseReferenceMeshLease === undefined
    || bridge.inspectSourceMeshBackings === undefined || bridge.currentSourceMeshBackingInspection === undefined)
    throw new Error('Actual managed preview capabilities required');
  return bridge;
}

describe('fresh read-only reference preview backing evidence', () => {
  it('uses the actual consumed Source lease and exact issued weak backing intersection', async () => {
    const bridge = managedPreviewKernel(), initial = boxPart();
    const initialResult = await recomputePart(initial, bridge, { generation: 18, partId: 'preview-evidence',
      localMesh: { maximumFloat32ErrorMm: 0.005, maximumLiveMeshBytes: 512 * 1024 * 1024 } });
    const body = initialResult.bodies[0];
    const document = withLine(consume(initial), body);
    const saved = JSON.stringify(document);
    const result = await recomputePart(document, bridge, { generation: 19, partId: 'preview-evidence',
      localMesh: { maximumFloat32ErrorMm: 0.005, maximumLiveMeshBytes: 512 * 1024 * 1024 } });
    expect(result.errors).toEqual([]);
    const scope = result.referenceMeshScope;
    const hidden = result.referenceBodies?.find(value => value.featureId === body.featureId);
    if (scope === undefined || hidden === undefined) throw new Error('Actual current hidden Source scope required');
    expect(scope.context.localMesh).toEqual({ maximumFloat32ErrorMm: 0.005, maximumLiveMeshBytes: 512 * 1024 * 1024 });
    expect(hidden.coordinateFrame?.space).toBe('local');
    expect(hidden.coordinateFrame?.origin.every(Number.isFinite)).toBe(true);
    expect(hidden.mesh.positions.byteLength).toBeGreaterThan(0);
    expect(hidden.mesh.edgePositions.byteLength).toBeGreaterThan(0);
    expect(scope.referenceBodyCurrent(hidden)).toBe(true);
    expect(scope.referenceBodyCurrent({ ...hidden })).toBe(false);
    expect(result.bodies).not.toContain(hidden);
    const receipt = await scope.capture('preview-native-union', result.bodies);
    expect(receipt.status).toBe('known');
    expect(scope.currentReceipt(receipt)).toBe(true);
    const source = hidden.mesh.positions.buffer;
    if (!(source instanceof ArrayBuffer)) throw new Error('Actual native reply ArrayBuffer required');
    const copy = new ArrayBuffer(37);
    const inspection = await scope.inspectBackings(receipt, [source, source, copy]);
    expect(inspection.status).toBe('known');
    if (inspection.status !== 'known') throw new Error('Actual Source membership evidence required');
    expect(inspection.sameSourceBackings.map(reference => reference.deref())).toEqual([source]);
    expect(inspection.additionalBackingBytes).toBe(37);
    expect(inspection.inputBackingBytes).toBe(source.byteLength + 37);
    expect(scope.currentInspection(inspection, receipt)).toBe(true);
    expect(scope.currentReceipt({ ...receipt })).toBe(false);
    expect(scope.currentInspection({ ...inspection }, receipt)).toBe(false);
    expect(JSON.stringify(document)).toBe(saved);
    expect(await scope.close()).toBe(true);
    expect(scope.currentReceipt(receipt)).toBe(false);
    expect(scope.referenceBodyCurrent(hidden)).toBe(false);
    expect(scope.currentInspection(inspection, receipt)).toBe(false);
    // External strong borrowing is independent of scope retirement and remains actual live backing.
    expect(source.byteLength).toBeGreaterThan(0);
    expect(await scope.inspectBackings(receipt, [source])).toMatchObject({ status: 'unknown' });
    if (bridge.captureCurrentMeshLedger === undefined || bridge.inspectSourceMeshBackings === undefined) throw new Error('Actual global provider required');
    const retained = await bridge.captureCurrentMeshLedger({ observationId: 'actual-strong-borrow-after-close', owners: [] });
    expect(retained.status).toBe('known');
    const retainedInspection = await bridge.inspectSourceMeshBackings(retained, [source]);
    expect(retainedInspection).toMatchObject({ status: 'known', additionalBackingBytes: 0 });
    if (retainedInspection.status !== 'known') throw new Error('Actual strong borrowed backing must remain registered');
    expect(retainedInspection.sameSourceBackings.map(reference => reference.deref())).toEqual([source]);
  });

  it('does not certify Shared/detached inputs or a missing membership capability', async () => {
    const bridge = managedPreviewKernel(), document = boxPart();
    const result = await recomputePart(document, bridge, { generation: 20, partId: 'preview-unsupported',
      localMesh: { maximumFloat32ErrorMm: 0.005, maximumLiveMeshBytes: 512 * 1024 * 1024 } });
    const scope = result.referenceMeshScope;
    if (scope === undefined) throw new Error('Actual Source scope required');
    const receipt = await scope.capture('preview-unsupported-inputs', result.bodies);
    expect(receipt.status).toBe('known');
    expect(await scope.inspectBackings(receipt, [new SharedArrayBuffer(8)])).toMatchObject({ status: 'unknown' });
    const detached = new ArrayBuffer(8);
    structuredClone(detached, { transfer: [detached] });
    expect(await scope.inspectBackings(receipt, [detached])).toMatchObject({ status: 'unknown' });
    expect(await scope.inspectBackings(receipt, [new ArrayBuffer(0)])).toMatchObject({ status: 'known', additionalBackingBytes: 0 });
    const capability = Object.getOwnPropertyDescriptor(bridge, 'inspectSourceMeshBackings');
    if (capability === undefined) throw new Error('Actual membership capability required before removal');
    delete bridge.inspectSourceMeshBackings;
    expect(await scope.inspectBackings(receipt, [])).toMatchObject({ status: 'unknown' });
    Object.defineProperty(bridge, 'inspectSourceMeshBackings', capability);
    expect(await scope.close()).toBe(true);
  });
});

describe('reference capture refusal evidence', () => {
  it('keeps the provider reason without admitting an unknown receipt', async () => {
    const bridge = managedPreviewKernel();
    const result = await recomputePart(boxPart(), bridge, { generation: 31, partId: 'provider-refusal' });
    const scope = result.referenceMeshScope;
    if (scope === undefined || bridge.captureCurrentMeshLedger === undefined || bridge.currentMeshLedgerReceipt === undefined)
      throw new Error('Actual managed scope capabilities required');
    const refused: CurrentMeshLedgerReceipt = { status: 'unknown', observationId: 'provider-refusal', reason: 'pending-reply' };
    const capture = vi.spyOn(bridge, 'captureCurrentMeshLedger').mockResolvedValue(refused);
    const current = vi.spyOn(bridge, 'currentMeshLedgerReceipt').mockReturnValue(false);
    const receipt = await scope.capture('provider-refusal', []);
    expect(receipt).toBe(refused);
    expect(scope.currentReceipt(receipt)).toBe(false);
    expect(capture).toHaveBeenCalledTimes(1);
    expect(current).toHaveBeenCalledExactlyOnceWith(refused);
    expect(await scope.close()).toBe(true);
  });

  it('still rejects a real known receipt when its freshness check fails', async () => {
    const bridge = managedPreviewKernel();
    const result = await recomputePart(boxPart(), bridge, { generation: 32, partId: 'stale-receipt' });
    const scope = result.referenceMeshScope;
    if (scope === undefined || bridge.captureCurrentMeshLedger === undefined || bridge.currentMeshLedgerReceipt === undefined)
      throw new Error('Actual managed scope capabilities required');
    const known = await scope.capture('stale-receipt', result.bodies);
    expect(known.status).toBe('known');
    const capture = vi.spyOn(bridge, 'captureCurrentMeshLedger').mockResolvedValue(known);
    const current = vi.spyOn(bridge, 'currentMeshLedgerReceipt').mockReturnValue(false);
    const receipt = await scope.capture('stale-receipt', result.bodies);
    expect(receipt).toEqual({ status: 'unknown', observationId: 'stale-receipt', reason: 'reference-scope-changed' });
    expect(scope.currentReceipt(receipt)).toBe(false);
    expect(capture).toHaveBeenCalledTimes(1);
    expect(current).toHaveBeenCalledExactlyOnceWith(known);
    expect(await scope.close()).toBe(true);
  });

  it('does not conceal a scope closed while the provider capture is in flight', async () => {
    const bridge = managedPreviewKernel();
    const result = await recomputePart(boxPart(), bridge, { generation: 33, partId: 'scope-closed' });
    const scope = result.referenceMeshScope;
    if (scope === undefined || bridge.captureCurrentMeshLedger === undefined || bridge.currentMeshLedgerReceipt === undefined)
      throw new Error('Actual managed scope capabilities required');
    const capture = vi.spyOn(bridge, 'captureCurrentMeshLedger').mockImplementation(async () => {
      expect(await scope.close()).toBe(true);
      return { status: 'unknown', observationId: 'scope-closed', reason: 'pending-reply' };
    });
    const current = vi.spyOn(bridge, 'currentMeshLedgerReceipt');
    expect(await scope.capture('scope-closed', [])).toEqual({
      status: 'unknown', observationId: 'scope-closed', reason: 'reference-scope-changed',
    });
    expect(capture).toHaveBeenCalledTimes(1);
    expect(current).not.toHaveBeenCalled();
  });
});


/** 面の原点と軸は固定入力で構成し、得られたmetadataを期待値へ転記しない。 */
async function planarLeaseFixture(operation: 'hole' | 'threadHole') {
  const owned = createAllocations(), bridge = managedPreviewKernel();
  let brep: Uint8Array;
  try {
    const axes = owned.keep(new oc.gp_Ax3_3(
      owned.keep(new oc.gp_Pnt_3(0, 0, 10)),
      owned.keep(new oc.gp_Dir_4(0, 0, 1)), owned.keep(new oc.gp_Dir_4(1, 0, 0)),
    ));
    const plane = owned.keep(new oc.gp_Pln_2(axes));
    const maker = owned.keep(new oc.BRepBuilderAPI_MakeFace_9(plane, -20, 20, -15, 15));
    const prism = owned.keep(new oc.BRepPrimAPI_MakePrism_1(
      owned.keep(maker.Face()), owned.keep(new oc.gp_Vec_4(0, 0, -10)), true, true,
    ));
    brep = writeBrepBytes(oc, owned.keep(prism.Shape()));
  } finally { owned.release(); }
  const shapes = new Map([['planar-lease-stock', brep]]);
  const document = appendSolid(createEmptyPartDocument(), {
    id: 'planar-lease-stock', name: '基準素材', kind: 'importedSolid', suppressed: false,
    shapeRef: 'planar-lease-stock', bodyKind: 'solid',
    source: { format: 'step', fileName: 'fixed-stock.step', unit: 'mm', byteLength: brep.byteLength },
  });
  const options = { importedShapes: shapes, partId: 'planar-lease-regression', generation: 41,
    localMesh: { maximumFloat32ErrorMm: .005, maximumLiveMeshBytes: 512 * 1024 * 1024 } };
  const initial = await recomputePart(document, bridge, options);
  expect(initial.errors).toEqual([]);
  const stock = initial.bodies[0];
  const top = stock.faces.find(face => face.surfaceKind === 'plane' && face.axis !== null
    && Math.hypot(face.axis[0], face.axis[1], face.axis[2] - 1) <= 1e-9);
  if (top === undefined) throw new Error('固定素材の上面がありません');
  // imported素材はsemantic originを持たない。元保存と同じ旧参照を固定寸法から構成する。
  expect(createSubShapeReference(stock, 'face', top.index)).toBeNull();
  const face: SubShapeRef = { bodyFeatureId: stock.featureId, index: top.index, fingerprint: {
    kind: 'face', surfaceKind: 'plane', area: 1200, position: [0, 0, 10], axis: [0, 0, 1], radius: null,
  } };
  await initial.referenceMeshScope?.close();
  const n = expressionValueFromNumber;
  const common = { id: 'planar-lease-hole', name: '基準を保持する穴', suppressed: false,
    targetFeatureId: stock.featureId, face, centers: [], tiltAngle: n(0), tiltAzimuth: n(0) };
  const planar: NonNullable<HoleFeature['planar']> = { kind: 'plane-face', locations: [
    { x: { ...n(6), source: '2*3' }, y: { ...n(-4), source: '-2*2' } },
  ] };
  const feature: HoleFeature | ThreadHoleFeature = operation === 'hole'
    ? { ...common, kind: 'hole', planar, diameter: n(6), depth: { kind: 'through' } }
    : { ...common, kind: 'threadHole', planar, designation: 'M6', series: 'coarse', pitch: n(1),
      drillDiameter: n(6 - 1.0825317547305482), threadLength: n(1), representation: 'simplified',
      depth: { kind: 'through' } };
  return { bridge, document, feature, options };
}

describe('平面編集基準の実producerとhidden lease', () => {
  it.each(['hole', 'threadHole'] as const)('作図参照の無い%sでも現在の元素材基準を保持する', async operation => {
    const f = await planarLeaseFixture(operation);
    const document = appendSolid(f.document, f.feature), before = JSON.stringify(document);
    const read = vi.spyOn(f.bridge, 'readCachedBodies');
    for (const y of [-4, -5]) {
      const changed = { ...f.feature, planar: { kind: 'plane-face' as const, locations: [
        { x: { ...expressionValueFromNumber(6), source: '2*3' },
          y: { ...expressionValueFromNumber(y), source: y === -4 ? '-2*2' : '-(1+4)' } },
      ] } };
      const current = y === -4 ? document : appendSolid(f.document, changed);
      const result = await recomputePart(current, f.bridge, { ...f.options, generation: y === -4 ? 42 : 43 });
      try {
        expect(result.errors).toEqual([]);
        expect(result.cancelled).toBe(false);
        expect(result.bodies.map(body => body.featureId)).toEqual([f.feature.id]);
        const hidden = result.referenceBodies?.find(body => body.featureId === f.feature.face.bodyFeatureId);
        if (hidden === undefined || result.referenceMeshScope === undefined) throw new Error('元素材の実所有がありません');
        const scope = result.referenceMeshScope;
        expect(scope.document).toBe(current);
        expect(scope.current).toBe(true);
        expect(scope.referenceBodyCurrent(hidden)).toBe(true);
        expect(scope.referenceBodyCurrent({ ...hidden })).toBe(false);
        const matched = hidden.faces.find(face => face.index === f.feature.face.index)?.planarBasis;
        if (matched === undefined) throw new Error('現在のnative基準がありません');
        expect(Math.hypot(...matched.origin.map((v, i) => v - [0, 0, 10][i]))).toBeLessThanOrEqual(1e-7);
        for (const [actual, expected] of [[matched.xAxis, [1, 0, 0]], [matched.yAxis, [0, 1, 0]],
          [matched.normal, [0, 0, 1]]]) {
          expect(Math.hypot(...actual.map((v, i) => v - expected[i]))).toBeLessThanOrEqual(1e-9);
        }
        const radius = operation === 'hole' ? 3 : (6 - 1.0825317547305482) / 2;
        const expectedVolume = 12000 - Math.PI * radius ** 2 * 10;
        expect(Math.abs(result.bodies[0].volume - expectedVolume) / expectedVolume).toBeLessThanOrEqual(1e-9);
        const bore = result.bodies[0].faces.find(face => face.surfaceKind === 'cylinder');
        if (bore?.axisOrigin === undefined || bore.axisOrigin === null || bore.axis === null || bore.radius === null) {
          throw new Error('実穴の円筒軸がありません');
        }
        expect(Math.hypot(bore.axisOrigin[0] - 6, bore.axisOrigin[1] - y)).toBeLessThanOrEqual(1e-7);
        expect(Math.abs(2 * bore.radius - 2 * radius)).toBeLessThanOrEqual(1e-7);
        expect(Math.hypot(bore.axis[0], bore.axis[1], Math.abs(bore.axis[2]) - 1)).toBeLessThanOrEqual(1e-9);
        expect(JSON.stringify(document)).toBe(before);
        expect(await scope.close()).toBe(true);
        expect(scope.referenceBodyCurrent(hidden)).toBe(false);
      } finally { await result.referenceMeshScope?.close(); }
    }
    expect(read).toHaveBeenCalledTimes(2);
    expect(read.mock.calls.map(call => call[1])).toEqual([['planar-lease-stock'], ['planar-lease-stock']]);
  });

  it('抑制又は未知の元参照を持つ穴からhidden読取りを捏造しない', async () => {
    const f = await planarLeaseFixture('hole'), read = vi.spyOn(f.bridge, 'readCachedBodies');
    for (const feature of [{ ...f.feature, suppressed: true },
      { ...f.feature, face: { ...f.feature.face, bodyFeatureId: 'missing-stock' } }]) {
      const result = await recomputePart(appendSolid(f.document, feature), f.bridge, { ...f.options, generation: 44 });
      try {
        expect(result.bodies.map(body => body.featureId)).toEqual(['planar-lease-stock']);
        expect(result.referenceBodies?.some(body => body.featureId === 'missing-stock')).toBe(false);
        if (!feature.suppressed) expect(result.errors.some(error => error.featureId === feature.id)).toBe(true);
      } finally { await result.referenceMeshScope?.close(); }
    }
    expect(read).not.toHaveBeenCalled();
  });

  it('hidden返信中の取消では現在基準を公開せず所有を解放する', async () => {
    const f = await planarLeaseFixture('hole'), original = f.bridge.readCachedBodies?.bind(f.bridge);
    if (original === undefined) throw new Error('実hidden読取APIがありません');
    let cancelled = false;
    vi.spyOn(f.bridge, 'readCachedBodies').mockImplementation(async (...args) => {
      const reply = await original(...args);
      cancelled = true;
      return reply;
    });
    const release = vi.spyOn(f.bridge, 'releaseReferenceMeshLease');
    const document = appendSolid(f.document, f.feature), before = JSON.stringify(document);
    const result = await recomputePart(document, f.bridge, { ...f.options, generation: 45, shouldCancel: () => cancelled });
    expect(result.cancelled).toBe(true);
    expect(result.bodies).toEqual([]);
    expect(result.referenceBodies).toBeUndefined();
    expect(result.referenceMeshScope).toBeUndefined();
    expect(release).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(document)).toBe(before);
  });
});
