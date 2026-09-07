import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  addComponent, createAssemblyDocument, createComponentFor, createEmptyPartDocument,
  embedPart, emptyEmbeddedPartAttachments, EMPTY_PART_LIBRARY, KERNEL_BROKEN_MESSAGE,
  moveComponent, removeComponent, resolvePart,
  type AssemblyKernelBridge, type PartDocument, type SolidBody,
} from '@pointercad/model';
import { expressionValueFromNumber } from '@pointercad/expression';
import { useAppStore } from '../store/useAppStore.js';
import { resetTestStore, resultFor } from '../store/testing/createTestStore.js';
import { createFakeRecompute } from '../store/testing/createTestStore.js';
import { attachAssembly } from './attachAssembly.js';

beforeEach(resetTestStore);

function importedPart(): PartDocument {
  return { ...createEmptyPartDocument(), solids: [{ id: 'imported-1', name: 'STEP',
    kind: 'importedSolid', suppressed: false, shapeRef: 'shape-1', bodyKind: 'solid',
    source: { format: 'step', fileName: 'source.step', unit: 'mm', byteLength: 1 } }] };
}

async function fixture() {
  const a = await embedPart(EMPTY_PART_LIBRARY, importedPart(), 'a.pcad', 'a.pcad', {
    attachments: { ...emptyEmbeddedPartAttachments(), shapes: new Map([['shape-1', Uint8Array.of(10)]]) },
  });
  const b = await embedPart(a.library, importedPart(), 'b.pcad', 'b.pcad', {
    attachments: { ...emptyEmbeddedPartAttachments(), shapes: new Map([['shape-1', Uint8Array.of(20)]]) },
  });
  let document = createAssemblyDocument('assembly');
  for (const partRef of [a.partRef, b.partRef, a.partRef]) {
    document = addComponent(document, createComponentFor(document, { kind: 'part', partRef }));
  }
  return { document, library: b.library, a: a.partRef, b: b.partRef };
}

function body(featureId: string, size: number): SolidBody {
  return { featureId, volume: size ** 3, isValid: true, faces: [], edges: [], vertices: [], threadMarks: [],
    mesh: { positions: Float32Array.of(0, 0, 0, size, 0, 0, 0, size, 0),
      normals: Float32Array.of(0, 0, 1, 0, 0, 1, 0, 0, 1), indices: Uint32Array.of(0, 1, 2),
      edgePositions: Float32Array.of(0, 0, 0, size, 0, 0), triangleCount: 1 } };
}

function fakeBridge() {
  const keys = new Set<string>();
  const releasePart = vi.fn<AssemblyKernelBridge['releasePart']>(() => Promise.resolve());
  const checkShapeAvailability = vi.fn<AssemblyKernelBridge['checkShapeAvailability']>((partId, requested) =>
    Promise.resolve({ partId, missingKeys: requested.filter((key) => !keys.has(key)) }));
  const recomputeSolids = vi.fn<AssemblyKernelBridge['recomputeSolids']>((steps) => {
    for (const step of steps) keys.add(step.key);
    return Promise.resolve({ bodies: steps.filter((step) => step.visible).map((step) =>
      body(step.featureId, step.plan.kind === 'importedSolid' ? step.plan.bytes[0] : 1)),
    failures: [], cacheHits: 0, cancelled: false });
  });
  const bridge: AssemblyKernelBridge = {
    releasePart, checkShapeAvailability, recomputeSolids,
    tessellateSketchFaces: () => Promise.resolve({ mesh: { faces: [] }, failures: [] }),
    offsetSketchCurves: () => Promise.resolve({ results: [], failures: [] }),
    projectSketchCurves: () => Promise.resolve({ results: [], failures: [] }),
    sectionSketchCurves: () => Promise.resolve({ results: [], failures: [] }),
    measure: () => Promise.resolve({ kind: 'failed', message: 'unused' }),
    exportShapes: () => Promise.resolve({ kind: 'failed', message: 'unused' }),
    importShape: () => Promise.resolve({ kind: 'failed', message: 'unused' }),
    inspectPrintability: () => Promise.resolve({ kind: 'failed', message: 'unused' }),
    dispose: () => undefined,
  };
  return { bridge, keys, recomputeSolids, releasePart, checkShapeAvailability };
}

async function settle(): Promise<void> {
  await vi.waitFor(() => expect(useAppStore.getState().isComputing).toBe(false));
}

describe('アセンブリの実経路', () => {
  it('別 STEP 2 種・同一部品 2 個を1つの橋で解決し、鍵と寸法が混ざらない', async () => {
    const f = await fixture();
    const fake = fakeBridge();
    useAppStore.getState().openAssembly(f.document, f.library);
    const detach = attachAssembly(fake.bridge);
    await settle();
    expect(fake.recomputeSolids).toHaveBeenCalledTimes(2);
    expect(fake.recomputeSolids.mock.calls.map((call) => call[1]?.partId)).toEqual([f.a, f.b]);
    expect(fake.recomputeSolids.mock.calls[0][0][0].key).not.toBe(fake.recomputeSolids.mock.calls[1][0][0].key);
    const view = useAppStore.getState().assemblyView;
    expect(view?.bodies.get(f.a)?.[0].volume).toBe(1000);
    expect(view?.bodies.get(f.b)?.[0].volume).toBe(8000);
    expect(view?.resolved.partKeys.size).toBe(3);
    detach();
  });

  it('配置変更は形の参照を保ち、部品を再計算しない', async () => {
    const f = await fixture();
    const fake = fakeBridge();
    useAppStore.getState().openAssembly(f.document, f.library);
    const detach = attachAssembly(fake.bridge);
    await settle();
    const previous = useAppStore.getState().assemblyView?.bodies.get(f.a);
    const previousAppearance = useAppStore.getState().assemblyView?.appearances.get(f.a);
    useAppStore.getState().applyAssembly(moveComponent(f.document, f.document.components[0].id, {
      position: [expressionValueFromNumber(30), expressionValueFromNumber(0), expressionValueFromNumber(0)], rotation: [0, 0, 0, 1],
    }));
    await settle();
    expect(fake.recomputeSolids).toHaveBeenCalledTimes(2);
    expect(useAppStore.getState().assemblyView?.bodies.get(f.a)).toBe(previous);
    expect(useAppStore.getState().assemblyView?.appearances.get(f.a)).toBe(previousAppearance);
    expect(useAppStore.getState().assemblyView?.resolved.placements.get(f.document.components[0].id)?.position).toEqual([30, 0, 0]);
    detach();
  });

  it('構造化された欠落があれば、その部品だけ再取得する', async () => {
    const f = await fixture();
    const fake = fakeBridge();
    useAppStore.getState().openAssembly(f.document, f.library);
    const detach = attachAssembly(fake.bridge);
    await settle();
    fake.keys.delete(fake.recomputeSolids.mock.calls[0][0][0].key);
    useAppStore.getState().applyAssembly({ ...f.document, name: 'changed' });
    await settle();
    expect(fake.recomputeSolids).toHaveBeenCalledTimes(3);
    expect(fake.recomputeSolids.mock.calls[2][1]?.partId).toBe(f.a);
    expect(useAppStore.getState().lastOutcome).toBe('success');
    detach();
  });

  it('取り直しても欠ける形は無限に再試行しない', async () => {
    const f = await fixture();
    const fake = fakeBridge();
    fake.checkShapeAvailability.mockImplementation((partId, keys) => Promise.resolve({ partId, missingKeys: keys }));
    useAppStore.getState().openAssembly(f.document, f.library);
    const detach = attachAssembly(fake.bridge);
    await settle();
    expect(fake.recomputeSolids).toHaveBeenCalledTimes(2);
    expect(useAppStore.getState().lastOutcome).toBe('failed');
    expect(useAppStore.getState().assemblyView?.bodies.size).toBe(0);
    detach();
  });

  it('最後のインスタンスが消えた部品だけ releasePart する', async () => {
    const f = await fixture();
    const fake = fakeBridge();
    useAppStore.getState().openAssembly(f.document, f.library);
    const detach = attachAssembly(fake.bridge);
    await settle();
    useAppStore.getState().applyAssembly(removeComponent(f.document, f.document.components[1].id));
    await settle();
    expect(fake.releasePart).toHaveBeenCalledExactlyOnceWith(f.b);
    detach();
    await vi.waitFor(() => expect(fake.releasePart).toHaveBeenCalledWith(f.a));
  });

  it('遅れて届いた古い世代を適用せず、最新だけを適用する', async () => {
    const library = (await embedPart(EMPTY_PART_LIBRARY, createEmptyPartDocument(), 'a.pcad', '')).library;
    let document = createAssemblyDocument('assembly');
    document = addComponent(document, createComponentFor(document, { kind: 'part', partRef: 'part-1' }));
    useAppStore.getState().openAssembly(document, library);
    const fake = createFakeRecompute();
    const detach = attachAssembly(fakeBridge().bridge, fake.recompute);
    await vi.waitFor(() => expect(fake.calls).toHaveLength(1));
    useAppStore.getState().applyAssembly({ ...document, name: 'latest' });
    expect(fake.calls[0].options.shouldCancel?.()).toBe(true);
    fake.calls[0].options.onResolved?.(resolvePart(fake.calls[0].document));
    fake.calls[0].settle(resultFor(fake.calls[0].document));
    await vi.waitFor(() => expect(fake.calls).toHaveLength(2));
    expect(useAppStore.getState().assemblyView).toBeNull();
    fake.calls[1].options.onResolved?.(resolvePart(fake.calls[1].document));
    fake.calls[1].settle(resultFor(fake.calls[1].document));
    await settle();
    expect(useAppStore.getState().completedGeneration).toBe(useAppStore.getState().requestedGeneration);
    detach();
  });

  it('Worker の失敗は完了として知らせ、待ち続けない', async () => {
    const f = await fixture();
    useAppStore.getState().openAssembly(f.document, f.library);
    const fake = fakeBridge();
    fake.recomputeSolids.mockRejectedValue(new Error(KERNEL_BROKEN_MESSAGE));
    const detach = attachAssembly(fake.bridge);
    await settle();
    expect(useAppStore.getState().lastOutcome).toBe('workerBroken');
    expect(useAppStore.getState().completedGeneration).toBe(useAppStore.getState().requestedGeneration);
    detach();
  });

  it('部品画面では assembly の再計算を呼ばない', () => {
    const fake = fakeBridge();
    const detach = attachAssembly(fake.bridge);
    expect(fake.recomputeSolids).not.toHaveBeenCalled();
    detach();
  });
});
