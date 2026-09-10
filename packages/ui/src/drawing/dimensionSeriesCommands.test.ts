import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DimensionTarget, DrawingDocument, OutlinedText } from '@pointercad/drawing';
import { createDrawingDocument, resolveDrawingDimensions, type DrawingSourceResolution } from '@pointercad/model';
import { resetTestStore } from '../store/testing/createTestStore.js';
import { useAppStore } from '../store/useAppStore.js';
import { createDrawingDimensionSeries, startDrawingDimensionSeries, commitDrawingDimensionSeries } from './dimensionSeriesCommands.js';
import { pickDrawingTarget } from './dimensionCommands.js';
import { drawingFont } from './drawingFont.js';
import { displayDrawingDimension } from './dimensionDisplay.js';

const source: DrawingSourceResolution = { bodyIds: [], center: [0, 0, 0], dimensionInstances: [] };
const context = { modelCenter: source.center, instances: [] };
const initial: DrawingDocument = { ...createDrawingDocument('寸法列', { sourceRef: 's', sourceKind: 'part', fileName: 'a.pcad', path: '', contentHash: '', importedAt: '' }),
  views: [{ id: 'front', name: '正面', kind: 'front', position: [100, 100], scale: 0.5, direction: [0, 1, 0], xDir: [1, 0, 0],
    showHidden: true, showCenterLines: true, layerId: 'layer-1' }] };
const targets: readonly DimensionTarget[] = [0, 20, 50, 90].map((x) => ({ kind: 'point', viewId: 'front', modelPoint: [x, 0, 0], paperPoint: [100 + x / 2, 100] }));
const outline = (text: string, sizeMm: number): OutlinedText => ({ status: 'ready', subpaths: [], fillRule: 'nonzero', missingCharacters: [],
  metrics: { fontId: 'test', sizeMm, advanceMm: text.length * sizeMm / 2, inkBounds: { left: 0, right: text.length * sizeMm / 2, bottom: 0, top: sizeMm } } });
beforeEach(() => { resetTestStore(); useAppStore.getState().openDrawing(initial); useAppStore.setState({ drawingSourceResolution: source });
  vi.spyOn(drawingFont, 'load').mockResolvedValue('ready'); vi.spyOn(drawingFont, 'outline').mockImplementation(outline); });
afterEach(() => vi.restoreAllMocks());

describe('寸法列を保存参照からまとめて作る', () => {
  it.each([['chain', [20, 30, 40], [108, 108, 108]], ['parallel', [20, 50, 90], [108, 116, 124]]] as const)('%sは縮尺1/2でも実寸で測り、選択順と間隔を保つ', (kind, values, offsets) => {
    const result = createDrawingDimensionSeries(initial, source, targets, { kind, axis: 'x', offset: 8 }, outline);
    if (result === null) throw new Error('寸法列なし');
    expect(resolveDrawingDimensions(result.document, context).map((value) => value.value)).toEqual(values);
    expect(result.document.dimensions.map((value) => value.placement.commonNormalCoordinate)).toEqual(offsets);
    expect(result.document.dimensions.every((dimension) => !Object.hasOwn(dimension, 'value'))).toBe(true);
  });
  it('座標列は変更した基準と負の側を反映し、各点の文字と引出線を持つ', () => {
    const result = createDrawingDimensionSeries(initial, source, targets, { kind: 'coordinate', baseIndex: 2, offset: 12 }, outline);
    if (result === null) throw new Error('座標列なし');
    const resolved = resolveDrawingDimensions(result.document, context);
    expect(resolved.map((value) => value.coordinates)).toEqual([[-50, 0], [-30, 0], [0, 0], [40, 0]]);
    expect(resolved.map((value) => displayDrawingDimension(result.document, value, outline).textPosition[1])).toEqual([112, 112, 112, 112]);
  });
  it('図の下側の点なら並列寸法を下へ8mmずつ広げ、内部へ戻さない', () => {
    const low: readonly DimensionTarget[] = targets.map((target) => target.kind === 'point' ? { ...target, modelPoint: [target.modelPoint?.[0] ?? 0, 0, -10],
      paperPoint: [target.paperPoint[0], 95] } : target);
    const result = createDrawingDimensionSeries(initial, source, low, { kind: 'parallel', offset: 8 }, outline);
    expect(result?.document.dimensions.map((dimension) => dimension.placement.commonNormalCoordinate)).toEqual([87, 79, 71]);
  });
  it('累進は単一寸法で4目盛りを再計算し、基準の小円と3つの矢印を描く', () => {
    const result = createDrawingDimensionSeries(initial, source, targets, { kind: 'progressive', baseIndex: 1, axis: 'x', offset: 8 }, outline);
    if (result === null) throw new Error('累進なし');
    expect(result.document.dimensions).toHaveLength(1);
    const dimension = resolveDrawingDimensions(result.document, context)[0];
    expect(dimension.progressive?.ticks.map((tick) => tick.value)).toEqual([-20, 0, 30, 70]);
    expect(dimension.value).toBeNull();
    const display = displayDrawingDimension(result.document, dimension, outline);
    expect(display.element.texts?.map((text) => text.text)).toEqual(['-20', '0', '30', '70']);
    expect(display.element.fills).toHaveLength(3);
    expect(display.element.curves?.filter((curve) => curve.kind === 'arc')).toHaveLength(1);
    const preview = { ...dimension, dimension: { ...dimension.dimension, placement: { commonNormalCoordinate: 118, textPosition: null } } };
    const moved = displayDrawingDimension(result.document, preview, outline);
    expect(moved.element.curves?.[0]).toMatchObject({ from: [100, 118], to: [145, 118] });
    expect(moved.element.texts?.[0].position[1]).toBe(120);
    const changed = { ...result.document, dimensions: [{ ...result.document.dimensions[0], tolerance: { kind: 'symmetric' as const, value: 0.1 } }] };
    expect(displayDrawingDimension(changed, resolveDrawingDimensions(changed, context)[0], outline).element.texts?.map((text) => text.text))
      .toEqual(['-20±0.1', '0±0.1', '30±0.1', '70±0.1']);
  });
  it('道具先行で4点を追加しても確定前は履歴なし、一回の確定・Undoで全体が戻る', async () => {
    startDrawingDimensionSeries('chain'); for (const target of targets) pickDrawingTarget(target, true);
    expect(useAppStore.getState().drawing).toBe(initial); expect(useAppStore.getState().canUndo).toBe(false);
    expect(useAppStore.getState().drawingEditor?.kind).toBe('dimension');
    expect(await commitDrawingDimensionSeries()).toBe(true); expect(useAppStore.getState().drawing?.dimensions).toHaveLength(3);
    useAppStore.getState().undoDrawing(); expect(useAppStore.getState().drawing).toBe(initial);
  });
  it('基準より前の選択を外しても同じ実頂点を基準に保つ', () => {
    startDrawingDimensionSeries('parallel'); for (const target of targets) pickDrawingTarget(target, true);
    useAppStore.getState().updateDrawingSeriesEditor({ baseIndex: 2 }); pickDrawingTarget(targets[0], true);
    expect(useAppStore.getState().drawingEditor).toMatchObject({ baseIndex: 1 });
  });
  it('別の図・重複・投影方向でゼロ長になる区間は一部だけ確定しない', () => {
    const options = { kind: 'chain', axis: 'x', offset: 8 } as const;
    expect(createDrawingDimensionSeries(initial, source, [targets[0], { ...targets[1], viewId: 'other' }], options, outline)).toBeNull();
    expect(createDrawingDimensionSeries(initial, source, [targets[0], targets[0]], options, outline)).toBeNull();
    expect(createDrawingDimensionSeries(initial, source, targets, { ...options, axis: 'y' }, outline)).toBeNull();
  });
  it('字体待ちで基準を変えると古い基準の結果を確定しない', async () => {
    startDrawingDimensionSeries('parallel'); for (const target of targets) pickDrawingTarget(target, true);
    vi.spyOn(drawingFont, 'load').mockImplementation(() => { useAppStore.getState().updateDrawingSeriesEditor({ baseIndex: 2 }); return Promise.resolve('ready'); });
    expect(await commitDrawingDimensionSeries()).toBe(false); expect(useAppStore.getState().drawing).toBe(initial);
  });
});
