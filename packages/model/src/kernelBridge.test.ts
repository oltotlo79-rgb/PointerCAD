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
import { expressionValueFromNumber } from '@pointercad/expression';
import * as Comlink from 'comlink';
import { loadOcctForNode } from '../../kernel/src/occt/loadOcct.node.js';
import { createShapeCache } from '../../kernel/src/worker/shapeCache.js';
import type { CachedSolid } from '../../kernel/src/worker/recomputeSolids.js';
import * as interferenceCommon from '../../kernel/src/occt/intersectionVolume.js';
import * as interferenceMesh from '../../kernel/src/occt/exportMesh.js';

import {
  createKernelBridge,
  createDirectKernelBridge,
  createDirectInterferenceKernelBridge,
  type AssemblyInterferenceInput,
  type AssemblyInterferenceResult,
  type AssemblyInterferenceProgress,
  KERNEL_BROKEN_MESSAGE,
  toPrintabilityOutcome,
  selectMateTargetGeometry,
  type SolidBody,
  type SketchOffsetRequestItem,
  type SketchProjectionRequestItem,
} from './kernelBridge.js';
import { resolvePart, type ResolvedSolidStep } from './part/resolvePart.js';
import { appendSolid, createEmptyPartDocument, createPrimitiveFeature } from './part/createPartDocument.js';
import { recomputePart } from './part/recomputePart.js';
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

describe('createKernelBridge: Worker が黙ったまま壊れたとき(§2.9)', () => {
  beforeEach(() => {
    silentWorkers.clear();
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
