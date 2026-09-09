import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDrawingDocument, createEmptyPartDocument, embedDrawingSource, emptyDrawingSourceLibrary,
  createAssemblyDocument, DEFAULT_COMPONENT_PLACEMENT, embedPart, EMPTY_PART_LIBRARY, emptyEmbeddedPartAttachments,
  type AssemblyDocument, type PartLibrary,
  type AssemblyKernelBridge, type DrawingKernelBridge, type DrawingProjectionResult, type PartDocument, type SolidBody } from '@pointercad/model';
import type { DrawingView } from '@pointercad/drawing';
import { expressionValueFromNumber } from '@pointercad/expression';
import { readDrawingBundle, writeDrawingBundle } from '@pointercad/io';
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

async function assemblyFixture() {
  const embedded = await embedPart(EMPTY_PART_LIBRARY, part, 'part.pcad', '', {
    attachments: { ...emptyEmbeddedPartAttachments(), shapes: new Map([['shape-1', Uint8Array.of(1)]]) },
  });
  const document: AssemblyDocument = { ...createAssemblyDocument('組図の元'), components: [0, 30].map((x, index) => ({
    id: `component-${index + 1}`, name: `共通部品:${index + 1}`, source: { kind: 'part', partRef: embedded.partRef },
    placement: { ...DEFAULT_COMPONENT_PLACEMENT, position: [expressionValueFromNumber(x), expressionValueFromNumber(0), expressionValueFromNumber(0)] },
    fixed: index === 0, visible: true, suppressed: false,
  })) };
  return { document, library: embedded.library };
}
async function openAssemblySource(document: AssemblyDocument, library: PartLibrary) {
  const source = { sourceKind: 'assembly' as const, document, library };
  const embedded = await embedDrawingSource(emptyDrawingSourceLibrary(), source, 'assembly.pcada', '');
  const drawing = { ...createDrawingDocument('組図', embedded.source), views: [view] };
  state().openDrawing(drawing, { sources: embedded.library });
  return { source, drawing, embedded };
}

describe('組図の再計算・配置・部品表・寿命(P8-59/64)', () => {
  beforeEach(() => useAppStore.setState(createInitialDocumentState()));
  afterEach(async () => { detach?.(); detach = undefined; await Promise.resolve(); });
  it('同じ部品を一度だけ再計算し、二つの配置と部品表数量を導く', async () => {
    const f = await assemblyFixture(); await openAssemblySource(f.document, f.library);
    const fake = engine(); detach = attachDrawing(fake.bridge); await settle();
    expect(fake.recomputeSolids).toHaveBeenCalledOnce();
    expect(state().drawingSourceResolution?.center).toEqual([25, 5, 15]);
    expect(state().drawingSourceResolution?.bomRows).toMatchObject([{ quantity: 2, number: 1 }]);
    expect(fake.hiddenLineViews.mock.calls[0]?.[0].instances).toMatchObject([
      { occurrenceId: 'component-1', placement: { position: [0, 0, 0] } },
      { occurrenceId: 'component-2', placement: { position: [30, 0, 0] } },
    ]);
  });
  it('合致を解いた配置を投影し、保存されていた移動前の座標を使わない', async () => {
    const f = await assemblyFixture();
    const document: AssemblyDocument = { ...f.document, mates: [{ id: 'mate-1', name: '原点を重ねる', kind: 'coincident',
      a: { kind: 'origin', componentId: 'component-1', element: 'origin' },
      b: { kind: 'origin', componentId: 'component-2', element: 'origin' },
      value: expressionValueFromNumber(0), flipped: false, suppressed: false }] };
    await openAssemblySource(document, f.library);
    const fake = engine(); detach = attachDrawing(fake.bridge); await settle();
    const x = state().drawingSourceResolution?.instances?.[1].placement.position[0];
    expect(x).toBeCloseTo(0, 6);
    expect(document.components[1].placement.position[0].value).toBe(30);
  });
  it('サブアセンブリの親の配置を投影座標へ反映する', async () => {
    const f = await assemblyFixture();
    const root: AssemblyDocument = { ...createAssemblyDocument('外側'), components: [{ id: 'outer', name: '内部',
      source: { kind: 'subAssembly', assemblyRef: 'assembly-1' }, fixed: true, visible: true, suppressed: false,
      placement: { ...DEFAULT_COMPONENT_PLACEMENT, position: [expressionValueFromNumber(100), expressionValueFromNumber(0), expressionValueFromNumber(0)] } }] };
    await openAssemblySource(root, { ...f.library, assemblies: new Map([['assembly-1', f.document]]) });
    const fake = engine(); detach = attachDrawing(fake.bridge); await settle();
    expect(state().drawingSourceResolution?.center).toEqual([125, 5, 15]);
    expect(state().drawingSourceResolution?.instances?.map((item) => item.occurrenceId)).toEqual(['outer/component-1', 'outer/component-2']);
  });
  it('非表示の部品を投影と図面全体の中心から除く', async () => {
    const f = await assemblyFixture();
    await openAssemblySource({ ...f.document, components: f.document.components.map((component, index) => ({ ...component, visible: index === 0 })) }, f.library);
    const fake = engine(); detach = attachDrawing(fake.bridge); await settle();
    expect(state().drawingSourceResolution?.instances).toHaveLength(1);
    expect(state().drawingSourceResolution?.center).toEqual([10, 5, 15]);
  });
  it('保存してストアを初期化してから開いても配置と表を再作成する', async () => {
    const f = await assemblyFixture(); const opened = await openAssemblySource(f.document, f.library);
    const bytes = await writeDrawingBundle(opened.drawing, { source: opened.source });
    useAppStore.setState(createInitialDocumentState());
    const read = await readDrawingBundle(bytes);
    if (!read.ok) throw new Error(read.error.message);
    state().openDrawing(read.document, { sources: { sources: [{ metadata: read.document.source, ...read.source }] } });
    const fake = engine(); detach = attachDrawing(fake.bridge); await settle();
    expect(state().drawingSourceResolution?.bomRows).toMatchObject([{ quantity: 2 }]);
    expect(state().drawingSourceResolution?.center).toEqual([25, 5, 15]);
  });
  it('図面の表題編集で元の組立を再計算しない', async () => {
    const f = await assemblyFixture(); await openAssemblySource(f.document, f.library);
    const fake = engine(); detach = attachDrawing(fake.bridge); await settle(); editTitle('組図の改名'); await settle();
    expect(fake.recomputeSolids).toHaveBeenCalledOnce();
  });
  it('Workerの形が消えたら再取得してから投影する', async () => {
    const f = await assemblyFixture(); await openAssemblySource(f.document, f.library);
    const fake = engine(); detach = attachDrawing(fake.bridge); await settle();
    fake.keys.clear(); editTitle(); await settle();
    expect(fake.recomputeSolids).toHaveBeenCalledTimes(2);
  });
  it('閉じた組図が所有する部品を解放する', async () => {
    const f = await assemblyFixture(); await openAssemblySource(f.document, f.library);
    const fake = engine(); detach = attachDrawing(fake.bridge); await settle(); state().closeDrawing();
    await vi.waitFor(() => expect(fake.releasePart).toHaveBeenCalledOnce());
    expect(fake.releasePart.mock.calls[0]?.[0]).toContain('drawing:');
  });
  it('参照部品が欠けた組図は不完全な部品表を成功結果として出さない', async () => {
    const f = await assemblyFixture(); await openAssemblySource(f.document, { ...f.library, parts: new Map() });
    const fake = engine(); detach = attachDrawing(fake.bridge);
    await vi.waitFor(() => expect(state().drawingBusy).toBe(false));
    expect(state().drawingResolution?.ok).toBe(false);
    expect(state().drawingSourceResolution).toBeNull();
    expect(fake.hiddenLineViews).not.toHaveBeenCalled();
  });
});
