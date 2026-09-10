import type { Dimension, DrawingDocument, OutlinedText, Vector3 } from '@pointercad/drawing';
import { createDrawingDocument, IDENTITY_PLACEMENT, resolveDrawingDimensions, type DrawingSourceResolution, type ResolvedDrawingView, type SolidBody } from '@pointercad/model';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInitialDocumentState } from '../store/initialDocumentState.js';
import { useAppStore } from '../store/useAppStore.js';
import { generateDrawingAutoDimensions, runDrawingAutoDimensions } from './autoDimensionCommands.js';
import { deleteSelectedDrawingElements } from './dimensionCommands.js';
import { drawingFont } from './drawingFont.js';
import { displayDrawingDimension } from './dimensionDisplay.js';

const sourceMeta = { sourceRef: 's', sourceKind: 'part' as const, fileName: 'plate.pcad', path: '', contentHash: 'hash', importedAt: '' };
const vertices: readonly Vector3[] = [[0, 0, 0], [100, 0, 0], [100, 0, 60], [0, 0, 60]];
const body: SolidBody = { featureId: 'plate', isValid: true, volume: 600, threadMarks: [], faces: [],
  mesh: { positions: new Float32Array(vertices.flat()), normals: new Float32Array(), indices: new Uint32Array(), edgePositions: new Float32Array(), triangleCount: 0 },
  vertices: vertices.map((position, index) => ({ position, index })),
  edges: [{ index: 0, curveKind: 'circle', radius: 4, length: 8 * Math.PI, axis: [0, 1, 0], axisOrigin: [30, 0, 20],
    midpoint: [26, 0, 20], start: [34, 0, 20], end: [34, 0, 20], segmentOffset: 0, segmentCount: 8 }],
};
const source: DrawingSourceResolution = { bodyIds: ['worker-key'], center: [0, 0, 0],
  dimensionInstances: [{ sourceRef: 's', bodyId: 'worker-key', placement: IDENTITY_PLACEMENT, body }] };
const initial: DrawingDocument = { ...createDrawingDocument('図面', sourceMeta), views: [{ id: 'front', name: '正面', kind: 'front',
  position: [120, 120], scale: 1, direction: [0, 1, 0], xDir: [1, 0, 0], showHidden: true, showCenterLines: true, layerId: 'layer-1' }] };
const view: ResolvedDrawingView = { viewId: 'front', name: '正面', position: [120, 120], scale: 1, visible: [], hidden: [], cuttingCurves: [] };
const circle = { curve: { kind: 'arc' as const, center: [150, 140] as const, radius: 4, startAngle: 0, endAngle: 2 * Math.PI },
  provenance: { kind: 'edge', dimensionTarget: true, bodyId: 'worker-key', edgeIndex: 0, occurrenceId: null, parameterRange: [0, 2 * Math.PI] } };
function outline(text: string, sizeMm: number): OutlinedText {
  return { status: 'ready', subpaths: [], fillRule: 'nonzero', missingCharacters: [], metrics: { fontId: 'test', sizeMm,
    advanceMm: text.length * sizeMm / 2, inkBounds: { left: 0, right: text.length * sizeMm / 2, bottom: 0, top: sizeMm } } };
}
function generate(document = initial, projections: readonly ResolvedDrawingView[] = [view]): DrawingDocument {
  const result = generateDrawingAutoDimensions(document, source, projections, outline);
  if (result === null) throw new Error('自動寸法の生成失敗');
  return result;
}
function open(document = initial): void {
  useAppStore.getState().openDrawing(document);
  useAppStore.setState({ drawingSourceResolution: source, drawingResolution: { ok: true, document,
    projection: { ok: true, views: [view], failures: [], cancelled: false },
    dimensions: resolveDrawingDimensions(document, { instances: source.dimensionInstances ?? [], modelCenter: source.center }),
    unresolvedCount: 0, sourceChangedExternally: false } });
}

describe('自動寸法の操作と更新(P8-40)', () => {
  beforeEach(() => {
    useAppStore.setState(createInitialDocumentState());
    vi.spyOn(drawingFont, 'load').mockResolvedValue('ready');
    vi.spyOn(drawingFont, 'outline').mockImplementation(outline);
  });
  afterEach(() => { vi.restoreAllMocks(); });

  it('100×60の板から2本の実寸法を生成する', () => {
    const next = generate();
    expect(next.dimensions).toHaveLength(2);
    expect(resolveDrawingDimensions(next, { instances: source.dimensionInstances ?? [], modelCenter: source.center }).map((item) => item.value)).toEqual([100, 60]);
  });
  it('再実行でも同じIDと順序になり自動寸法が増殖しない', () => {
    const once = generate(); expect(generate(once)).toEqual(once);
  });
  it('補助図の解決済み基底で外形を測り、表示と同じ文字高さを使う', () => {
    const document = { ...initial, sheet: { ...initial.sheet, textHeight: 5 } };
    const rotated = { ...initial.views[0], xDir: [0, 0, 1] as const };
    const resolvedSource = { ...source, viewFrames: new Map([['front', { view: rotated, modelCenter: source.center }]]) };
    const measure = vi.fn(outline);
    const next = generateDrawingAutoDimensions(document, resolvedSource, [view], measure);
    if (next === null) throw new Error('回転図の自動寸法なし');
    expect(resolveDrawingDimensions(next, { instances: source.dimensionInstances ?? [], modelCenter: source.center,
      viewFrames: resolvedSource.viewFrames }).map((dimension) => dimension.value)).toEqual([60, 100]);
    expect(measure.mock.calls.every((call) => call[1] === 5)).toBe(true);
  });
  it('切り抜きの外の頂点から外形寸法を作らない', () => {
    const clipped = { ...source, viewFrames: new Map([['front', { view: initial.views[0], modelCenter: source.center,
      clips: [{ kind: 'polygon' as const, points: [[20, 10], [80, 10], [80, 50], [20, 50]] as const }] }]]) };
    expect(generateDrawingAutoDimensions(initial, clipped, [view], outline)).toBeNull();
    expect(initial.dimensions).toHaveLength(0);
  });
  it('非表示の図を自動記入の対象に戻さない', () => {
    const document = { ...initial, layers: initial.layers.map((layer) => layer.id === 'layer-1' ? { ...layer, visible: false } : layer) };
    expect(generate(document).dimensions).toHaveLength(0);
  });
  it('手動寸法の対象と配置と参照を保持する', () => {
    const base = generate();
    const manual: Dimension = { ...base.dimensions[0], id: 'dim-1', origin: 'manual', placement: { commonNormalCoordinate: 300, textPosition: [10, 300] } };
    const next = generate({ ...base, dimensions: [...base.dimensions, manual] });
    expect(next.dimensions.find((dimension) => dimension.id === manual.id)).toBe(manual);
  });
  it('同じ位置の手動寸法を動かさず、字体の実測囲みが重ならない位置へ自動寸法を置く', () => {
    const base = generate();
    const manual: Dimension = { ...base.dimensions[0], id: 'manual', origin: 'manual' };
    const next = generate({ ...base, dimensions: [manual] });
    const context = { instances: source.dimensionInstances ?? [], modelCenter: source.center };
    const displays = resolveDrawingDimensions(next, context).map((dimension) => displayDrawingDimension(next, dimension, outline));
    const fixed = displays[0].bounds;
    if (fixed === null) throw new Error('手動寸法の字体がない');
    for (const { bounds } of displays.slice(1)) {
      if (bounds === null) throw new Error('自動寸法の字体がない');
      expect(bounds.left < fixed.right + 2 && fixed.left < bounds.right + 2
        && bounds.bottom < fixed.top + 2 && fixed.bottom < bounds.top + 2).toBe(false);
    }
    expect(next.dimensions[0]).toBe(manual);
    expect(generate(next)).toEqual(next);
  });
  it('見えている円は径1本と穴位置2本を追加する', () => {
    const next = generate(initial, [{ ...view, visible: [circle] }]);
    expect(next.dimensions).toHaveLength(5);
    expect(next.dimensions.filter((item) => item.kind === 'diameter')).toHaveLength(1);
  });
  it('同じ辺の投影線が分割されても穴の数を重複させない', () => {
    const next = generate(initial, [{ ...view, visible: [circle, circle] }]);
    expect(next.dimensions).toHaveLength(5);
  });
  it('隠れた円を見えている穴として記入しない', () => {
    expect(generate(initial, [{ ...view, hidden: [circle] }]).dimensions).toHaveLength(2);
  });
  it('由来の分からない輪郭を穴の寸法へ変えない', () => {
    expect(generate(initial, [{ ...view, visible: [{ ...circle, provenance: { kind: 'silhouette', dimensionTarget: false } }] }]).dimensions).toHaveLength(2);
  });
  it('自動寸法ボタンは1回の更新で追加しUndo/Redoできる', async () => {
    open(); const version = useAppStore.getState().documentVersion;
    expect(await runDrawingAutoDimensions()).toBe(true);
    expect(useAppStore.getState().documentVersion).toBe(version + 1);
    expect(useAppStore.getState().drawing?.dimensions).toHaveLength(2);
    useAppStore.getState().undo(); expect(useAppStore.getState().drawing).toBe(initial);
    useAppStore.getState().redo(); expect(useAppStore.getState().drawing?.dimensions).toHaveLength(2);
  });
  it('自動寸法を1本だけ削除してUndo1回で復元する', () => {
    const next = generate(); open(next);
    useAppStore.getState().selectDrawingIds([next.dimensions[0].id]);
    expect(deleteSelectedDrawingElements()).toBe(true);
    expect(useAppStore.getState().drawing?.dimensions).toHaveLength(1);
    useAppStore.getState().undo(); expect(useAppStore.getState().drawing).toBe(next);
  });
  it('字体が読めなければ推測幅で配置せず理由を出す', async () => {
    open(); vi.spyOn(drawingFont, 'load').mockResolvedValue('failed');
    expect(await runDrawingAutoDimensions()).toBe(false);
    expect(useAppStore.getState().drawing).toBe(initial);
    expect(useAppStore.getState().drawingMessage).toContain('字体');
  });
  it('字体の読込中に文書を閉じたら古い結果を追加しない', async () => {
    open();
    vi.spyOn(drawingFont, 'load').mockImplementation(() => {
      useAppStore.getState().closeDrawing(); return Promise.resolve('ready');
    });
    expect(await runDrawingAutoDimensions()).toBe(false);
    expect(useAppStore.getState().drawing).toBeNull();
  });
  it('形の再計算中は古い形へ自動寸法を付けない', async () => {
    open(); useAppStore.setState({ drawingBusy: true });
    expect(await runDrawingAutoDimensions()).toBe(false);
    expect(useAppStore.getState().drawing?.dimensions).toHaveLength(0);
  });
  it('字体待ちの間に再計算が始まった場合も古い投影へ寸法を追加しない', async () => {
    open(); vi.spyOn(drawingFont, 'load').mockImplementation(() => {
      useAppStore.setState({ drawingBusy: true }); return Promise.resolve('ready');
    });
    expect(await runDrawingAutoDimensions()).toBe(false);
    expect(useAppStore.getState().drawing).toBe(initial);
  });
  it('密集した文字を規定回数で避けられなかったときは件数を隠さない', async () => {
    const base = generate(), manual: Dimension = { ...base.dimensions[0], id: 'manual', origin: 'manual' };
    open({ ...initial, dimensions: [manual] });
    vi.spyOn(drawingFont, 'outline').mockImplementation((text, size) => ({ ...outline(text, size), metrics: {
      fontId: 'large-test', sizeMm: size, advanceMm: 1000, inkBounds: { left: 0, right: 1000, bottom: 0, top: 1000 },
    } }));
    expect(await runDrawingAutoDimensions()).toBe(true);
    expect(useAppStore.getState().drawingMessage).toContain('重な');
    expect(useAppStore.getState().drawing?.dimensions.find((item) => item.id === manual.id)).toBe(manual);
  });
});
