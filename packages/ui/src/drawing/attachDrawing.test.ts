import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDrawingDocument, createEmptyPartDocument, embedDrawingSource, emptyDrawingSourceLibrary,
  type AssemblyKernelBridge, type DrawingKernelBridge, type DrawingProjectionResult, type PartDocument, type SolidBody } from '@pointercad/model';
import type { DrawingView } from '@pointercad/drawing';
import { useAppStore } from '../store/useAppStore.js';
import { createInitialDocumentState } from '../store/initialDocumentState.js';
import { attachDrawing } from './attachDrawing.js';

const view: DrawingView = { id: 'front', name: '正面', kind: 'front', position: [100, 100], scale: null,
  direction: [0, 1, 0], xDir: [1, 0, 0], showHidden: true, showCenterLines: true, layerId: 'layer-1' };
const part: PartDocument = { ...createEmptyPartDocument(), solids: [{ id: 'imported-1', name: 'STEP',
  kind: 'importedSolid', suppressed: false, shapeRef: 'shape-1', bodyKind: 'solid',
  source: { format: 'step', fileName: 'source.step', unit: 'mm', byteLength: 1 } }] };
const body: SolidBody = { featureId: 'imported-1', mesh: { positions: new Float32Array([0, 0, 0, 20, 10, 30]),
  normals: new Float32Array(), indices: new Uint32Array(), edgePositions: new Float32Array(), triangleCount: 0 },
  volume: 6000, isValid: true, bodyKind: 'solid', faces: [], edges: [], vertices: [], threadMarks: [] };
function engine() {
  const keys = new Set<string>();
  const releasePart = vi.fn<AssemblyKernelBridge['releasePart']>(() => Promise.resolve());
  const recomputeSolids = vi.fn<AssemblyKernelBridge['recomputeSolids']>((steps) => {
    for (const step of steps) keys.add(step.key);
    return Promise.resolve({ bodies: [body], failures: [], cacheHits: 0, cancelled: false });
  });
  const hiddenLineViews = vi.fn<DrawingKernelBridge['hiddenLineViews']>((request) => Promise.resolve({
    views: request.views.map((item) => ({ viewId: item.id, visible: [], hidden: [] })), failures: [], cancelled: false,
  }));
  const bridge: AssemblyKernelBridge & DrawingKernelBridge = { releasePart, recomputeSolids, hiddenLineViews,
    checkShapeAvailability: (partId, requested) => Promise.resolve({ partId, missingKeys: requested.filter((key) => !keys.has(key)) }),
    sectionViews: (request) => Promise.resolve({ viewId: request.view.id, visible: [], hidden: [], cuttingCurves: [], failures: [], cancelled: false }),
    tessellateSketchFaces: () => Promise.resolve({ mesh: { faces: [] }, failures: [] }),
    offsetSketchCurves: () => Promise.resolve({ results: [], failures: [] }),
    projectSketchCurves: () => Promise.resolve({ results: [], failures: [] }),
    sectionSketchCurves: () => Promise.resolve({ results: [], failures: [] }),
    measure: () => Promise.resolve({ kind: 'failed', message: 'unused' }), exportShapes: () => Promise.resolve({ kind: 'failed', message: 'unused' }),
    importShape: () => Promise.resolve({ kind: 'failed', message: 'unused' }), inspectPrintability: () => Promise.resolve({ kind: 'failed', message: 'unused' }),
    dispose: () => undefined,
  };
  return { bridge, keys, recomputeSolids, hiddenLineViews, releasePart };
}
const state = () => useAppStore.getState();
let detach: (() => void) | undefined;
async function open() {
  const embedded = await embedDrawingSource(emptyDrawingSourceLibrary(), { sourceKind: 'part', document: part }, 'part.pcad', '');
  state().openDrawing({ ...createDrawingDocument('図面', embedded.source), views: [view] }, {
    sources: embedded.library, importedShapes: new Map([['shape-1', Uint8Array.of(1)]]) });
}
async function settle() { await vi.waitFor(() => { expect(state().drawingBusy).toBe(false); expect(state().drawingResolution?.ok).toBe(true); }); }
function editTitle(name = '変更') { const drawing = state().drawing; if (drawing === null) throw new Error('図面なし'); state().applyDrawing({ ...drawing, name }); }

describe('図面再評価の寿命と最新結果の適用', () => {
  beforeEach(async () => { useAppStore.setState(createInitialDocumentState()); await open(); });
  afterEach(async () => { detach?.(); detach = undefined; await Promise.resolve(); });
  it('抱き込んだ部品を実resolvePart経由で評価しWorkerの鍵で投影する', async () => {
    const fake = engine(); detach = attachDrawing(fake.bridge); await settle();
    const request = fake.hiddenLineViews.mock.calls[0][0];
    expect(request.bodyIds).toEqual([...fake.keys]); expect(request.bodyIds).not.toContain('imported-1');
    expect(state().drawingSourceResolution?.center).toEqual([10, 5, 15]);
  });
  it('注記や表題の変更では元部品と投影を作り直さない', async () => {
    const fake = engine(); detach = attachDrawing(fake.bridge); await settle(); editTitle(); await settle();
    expect(fake.recomputeSolids).toHaveBeenCalledTimes(1); expect(fake.hiddenLineViews).toHaveBeenCalledTimes(1);
  });
  it('Workerが鍵を失った後は元形状を作り直す', async () => {
    const fake = engine(); detach = attachDrawing(fake.bridge); await settle(); fake.keys.clear(); editTitle(); await settle();
    expect(fake.recomputeSolids).toHaveBeenCalledTimes(2);
  });
  it('別文書へ切り替えると前の所有形状を解放する', async () => {
    const fake = engine(); detach = attachDrawing(fake.bridge); await settle(); await open(); await settle();
    expect(fake.releasePart).toHaveBeenCalledTimes(1);
  });
  it('図面を閉じると形状を解放する', async () => {
    const fake = engine(); detach = attachDrawing(fake.bridge); await settle(); state().closeDrawing();
    await vi.waitFor(() => expect(fake.releasePart).toHaveBeenCalledTimes(1));
  });
  it('解決中に閉じた図面へ遅い結果を戻さない', async () => {
    const fake = engine(); let finish: (result: DrawingProjectionResult) => void = () => { throw new Error('未開始'); };
    fake.hiddenLineViews.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    detach = attachDrawing(fake.bridge); await vi.waitFor(() => expect(fake.hiddenLineViews).toHaveBeenCalledTimes(1));
    state().closeDrawing(); finish({ views: [{ viewId: view.id, visible: [], hidden: [] }], failures: [], cancelled: false });
    await vi.waitFor(() => expect(fake.releasePart).toHaveBeenCalledTimes(1));
    expect(state().drawing).toBeNull(); expect(state().drawingResolution).toBeNull();
  });
  it('古い解決中に続けて変更しても最新文書を最後に適用する', async () => {
    const fake = engine(); let finish: (result: DrawingProjectionResult) => void = () => { throw new Error('未開始'); };
    fake.hiddenLineViews.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    detach = attachDrawing(fake.bridge); await vi.waitFor(() => expect(fake.hiddenLineViews).toHaveBeenCalledTimes(1));
    editTitle('二番目'); editTitle('三番目');
    finish({ views: [{ viewId: view.id, visible: [], hidden: [] }], failures: [], cancelled: false }); await settle();
    expect(state().drawing?.name).toBe('三番目'); expect(fake.recomputeSolids).toHaveBeenCalledTimes(1);
  });
  it('元データなしは無限再試行せず理由を表示する', async () => {
    useAppStore.setState({ drawingSources: { sources: [] } }); const fake = engine(); detach = attachDrawing(fake.bridge);
    await vi.waitFor(() => expect(state().drawingBusy).toBe(false));
    expect(state().drawingResolution?.ok).toBe(false); expect(state().drawingMessage).not.toBeNull();
    expect(fake.recomputeSolids).not.toHaveBeenCalled();
  });
});
