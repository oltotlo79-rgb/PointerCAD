import type { DrawingDocument } from '@pointercad/drawing';
import { createDrawingDocument, resolveDrawingDimensions } from '@pointercad/model';
import { beforeEach, describe, expect, it } from 'vitest';
import { createInitialDocumentState } from '../store/initialDocumentState.js';
import { useAppStore } from '../store/useAppStore.js';
import { applyDrawingTolerance } from './toleranceCommands.js';

const initial: DrawingDocument = { ...createDrawingDocument('図面', { sourceRef: 's', sourceKind: 'part', fileName: '', path: '', contentHash: '', importedAt: '' }),
  views: [{ id: 'v', name: '正面', kind: 'front', position: [0, 0], scale: null, direction: [0, 1, 0], xDir: [1, 0, 0],
    showHidden: true, showCenterLines: true, layerId: 'layer-1' }],
  dimensions: [{ id: 'd', kind: 'length', measurement: 'trueDistance', targets: [
    { kind: 'point', viewId: 'v', paperPoint: [0, 0], modelPoint: [0, 0, 0] },
    { kind: 'point', viewId: 'v', paperPoint: [20, 0], modelPoint: [20, 0, 0] }],
  placement: { commonNormalCoordinate: 10, textPosition: null }, reference: false, origin: 'manual', layerId: 'layer-4' }] };
function drawing(): DrawingDocument { const value = useAppStore.getState().drawing; if (value === null) throw new Error('図面'); return value; }
const resolved = () => resolveDrawingDimensions(drawing(), { instances: [], modelCenter: [0, 0, 0] })[0];

describe('寸法の公差とはめあい(P8-36)', () => {
  beforeEach(() => {
    useAppStore.setState(createInitialDocumentState()); useAppStore.getState().openDrawing(initial);
    useAppStore.setState({ drawingSourceResolution: { bodyIds: [], center: [0, 0, 0] } });
  });
  it('±0.1の式を保存し数値は形から得る', () => {
    expect(applyDrawingTolerance('d', { kind: 'symmetric', value: '1/10' })).toBe(true);
    expect(drawing().dimensions[0].tolerance).toEqual({ kind: 'symmetric', value: { source: '1/10', value: 0.1, display: '0.1' } });
    expect(resolved().text).toBe('20±0.1');
  });
  it('上下偏差を付けて1回のUndoで戻す', () => {
    applyDrawingTolerance('d', { kind: 'deviation', upper: '0.2', lower: '-0.1' });
    expect(resolved().displayTolerance).toEqual({ kind: 'deviation', upper: 0.2, lower: -0.1 });
    useAppStore.getState().undo(); expect(drawing()).toBe(initial);
    useAppStore.getState().redo(); expect(resolved().displayTolerance?.kind).toBe('deviation');
  });
  it('上が下より小さい入力は文書を変更せず断る', () => {
    expect(applyDrawingTolerance('d', { kind: 'deviation', upper: '-0.2', lower: '0.1' })).toBe(false);
    expect(drawing()).toBe(initial); expect(useAppStore.getState().drawingMessage).toContain('上の許容差');
  });
  it('負の対称公差は断る', () => {
    expect(applyDrawingTolerance('d', { kind: 'symmetric', value: '-0.1' })).toBe(false);
    expect(drawing()).toBe(initial);
  });
  it('間違った式は履歴を作らず断る', () => {
    expect(applyDrawingTolerance('d', { kind: 'symmetric', value: '1/0' })).toBe(false);
    expect(useAppStore.getState().canUndo).toBe(false);
  });
  it('H7の記号だけ保存し上下偏差は呼び20の表から解決する', () => {
    expect(applyDrawingTolerance('d', { kind: 'fit', symbol: 'H7', showDeviation: true })).toBe(true);
    expect(drawing().dimensions[0].fit).toEqual({ symbol: 'H7', showDeviation: true });
    expect(drawing().dimensions[0].tolerance).toBeUndefined();
    expect(resolved().displayTolerance).toEqual({ kind: 'deviation', upper: 0.021, lower: 0 });
    expect(resolved().text).toContain('H7');
  });
  it('呼びが40へ変わると同じH7でも上偏差が0.025へ追従する', () => {
    applyDrawingTolerance('d', { kind: 'fit', symbol: 'H7', showDeviation: true });
    const original = drawing(), dimension = original.dimensions[0];
    useAppStore.getState().applyDrawing({ ...original, dimensions: [{ ...dimension,
      targets: [dimension.targets[0], { kind: 'point', viewId: 'v', paperPoint: [40, 0], modelPoint: [40, 0, 0] }] }] });
    expect(resolved().displayTolerance).toEqual({ kind: 'deviation', upper: 0.025, lower: 0 });
  });
  it('許容差の併記を切ってもはめあい記号は残る', () => {
    applyDrawingTolerance('d', { kind: 'fit', symbol: 'H7', showDeviation: false });
    expect(resolved().text).toBe('20H7'); expect(resolved().displayTolerance).toBeUndefined();
  });
  it('知らないはめあい記号を断り履歴を作らない', () => {
    expect(applyDrawingTolerance('d', { kind: 'fit', symbol: 'Z99', showDeviation: true })).toBe(false);
    expect(drawing()).toBe(initial);
  });
  it('はめあいを手動公差へ変更すると古い記号を残さない', () => {
    applyDrawingTolerance('d', { kind: 'fit', symbol: 'H7', showDeviation: true });
    applyDrawingTolerance('d', { kind: 'symmetric', value: '0.1' });
    expect(drawing().dimensions[0].fit).toBeUndefined(); expect(resolved().text).toBe('20±0.1');
  });
  it('公差なしへ戻しても寸法と選択を保つ', () => {
    applyDrawingTolerance('d', { kind: 'symmetric', value: '0.1' });
    applyDrawingTolerance('d', { kind: 'none' });
    expect(resolved().text).toBe('20'); expect(useAppStore.getState().drawingSelectedIds).toEqual(['d']);
  });
  it('日本語パラメータの古い評価値を使わず式の依存を解く', () => {
    useAppStore.getState().applyDrawing({ ...initial, parameters: [
      { name: '基準', value: { source: '0.1', value: 9, display: '9' }, unit: 'mm', description: '' },
      { name: '公差', value: { source: '基準*2', value: 18, display: '18' }, unit: 'mm', description: '' }] });
    applyDrawingTolerance('d', { kind: 'symmetric', value: '公差' });
    expect(resolved().text).toBe('20±0.2');
  });
  it('図面の再計算中は公差を確定しない', () => {
    useAppStore.setState({ drawingBusy: true });
    expect(applyDrawingTolerance('d', { kind: 'symmetric', value: '0.1' })).toBe(false);
    expect(drawing()).toBe(initial);
  });
  it('同じ公差の再確定で空のUndoを増やさない', () => {
    applyDrawingTolerance('d', { kind: 'symmetric', value: '0.1' });
    const version = useAppStore.getState().documentVersion;
    applyDrawingTolerance('d', { kind: 'symmetric', value: '0.1' });
    expect(useAppStore.getState().documentVersion).toBe(version);
  });
});
