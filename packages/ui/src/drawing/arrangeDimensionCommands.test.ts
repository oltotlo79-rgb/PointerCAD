import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDrawingDocument, resolveDrawingDimensions, type DrawingSourceResolution } from '@pointercad/model';
import type { Dimension, DrawingDocument, OutlinedText } from '@pointercad/drawing';
import { resetTestStore } from '../store/testing/createTestStore.js';
import { useAppStore } from '../store/useAppStore.js';
import { arrangeDrawingDimensions, runDrawingDimensionArrangement } from './arrangeDimensionCommands.js';
import { drawingFont } from './drawingFont.js';
import { displayDrawingDimension } from './dimensionDisplay.js';

const source: DrawingSourceResolution = { bodyIds: [], center: [0, 0, 0], dimensionInstances: [] };
const context = { modelCenter: source.center, instances: [] };
const outline = (text: string, sizeMm: number): OutlinedText => ({ status: 'ready', subpaths: [], fillRule: 'nonzero', missingCharacters: [],
  metrics: { fontId: 'test', sizeMm, advanceMm: text.length * sizeMm, inkBounds: { left: 0, right: text.length * sizeMm, bottom: 0, top: sizeMm } } });
function fixture(): DrawingDocument {
  const base = createDrawingDocument('寸法配置', { sourceRef: 's', sourceKind: 'part', fileName: 'a.pcad', path: '', contentHash: '', importedAt: '' });
  const dimension = (id: string, h: number, origin: Dimension['origin'] = 'manual'): Dimension => ({ id, kind: 'length', measurement: 'horizontal',
    targets: [0, 20].map((x) => ({ kind: 'point', viewId: 'front', modelPoint: [x, 0, 0], paperPoint: [100 + x, 100] })),
    placement: { commonNormalCoordinate: h, textPosition: [110, h + 1] }, reference: false, layerId: 'layer-4', origin });
  return { ...base, views: [{ id: 'front', name: '正面', kind: 'front', position: [100, 100], scale: 1, direction: [0, 1, 0], xDir: [1, 0, 0],
    showHidden: true, showCenterLines: true, layerId: 'layer-1' }], dimensions: [dimension('first', 110), dimension('second', 111), dimension('fixed', 118)] };
}
beforeEach(() => { resetTestStore(); vi.spyOn(drawingFont, 'load').mockResolvedValue('ready'); vi.spyOn(drawingFont, 'outline').mockImplementation(outline); });
afterEach(() => vi.restoreAllMocks());
describe('選択寸法を用紙上でまとめて整列する', () => {
  it('固定寸法との重なりを避け、手動文字も動かすが実寸・参照・固定配置は保つ', () => {
    const document = fixture(), result = arrangeDrawingDimensions(document, source, ['first', 'second'], outline);
    if (result === null) throw new Error('整列なし');
    expect(result.unresolvedOverlapIds).toEqual([]);
    expect(result.document.dimensions[2]).toBe(document.dimensions[2]);
    expect(result.document.dimensions[1].placement).toEqual({ commonNormalCoordinate: 126, textPosition: [110, 127] });
    expect(result.document.dimensions[1].targets).toBe(document.dimensions[1].targets);
    const resolved = resolveDrawingDimensions(result.document, context);
    expect(resolved.map((value) => value.value)).toEqual([20, 20, 20]);
    const bounds = resolved.map((value) => displayDrawingDimension(result.document, value, outline).bounds);
    expect(bounds[1]?.bottom).toBeGreaterThan(bounds[2]?.top ?? Infinity);
  });
  it('一括更新はUndo一回、同じ配置への再実行は履歴を増やさない', async () => {
    const document = fixture(), state = useAppStore.getState(); state.openDrawing(document);
    useAppStore.setState({ drawingSourceResolution: source }); state.selectDrawingIds(['first', 'second']);
    expect(await runDrawingDimensionArrangement()).toBe(true);
    const version = useAppStore.getState().documentVersion;
    expect(await runDrawingDimensionArrangement()).toBe(true); expect(useAppStore.getState().documentVersion).toBe(version);
    state.undoDrawing(); expect(useAppStore.getState().drawing).toBe(document);
  });
  it('未解決の参照を含めた整列は一部だけ変更しない', () => {
    const document = fixture(), missing = { ...document.dimensions[1], targets: [] };
    expect(arrangeDrawingDimensions({ ...document, dimensions: [document.dimensions[0], missing] }, source, ['first', 'second'], outline)).toBeNull();
  });
  it('字体待ちの間に選択が変わると前の選択へ適用しない', async () => {
    const document = fixture(), state = useAppStore.getState(); state.openDrawing(document);
    useAppStore.setState({ drawingSourceResolution: source }); state.selectDrawingIds(['first', 'second']);
    vi.spyOn(drawingFont, 'load').mockImplementation(() => { state.selectDrawingIds(['fixed']); return Promise.resolve('ready'); });
    expect(await runDrawingDimensionArrangement()).toBe(false); expect(useAppStore.getState().drawing).toBe(document);
  });
});
