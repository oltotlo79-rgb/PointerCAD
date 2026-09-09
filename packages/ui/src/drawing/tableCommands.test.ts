import { beforeEach, describe, expect, it } from 'vitest';
import { createDrawingDocument, type BomRow, type DrawingSourceResolution } from '@pointercad/model';
import type { DrawingDocument, DrawingTable, OutlinedText } from '@pointercad/drawing';
import { resetTestStore } from '../store/testing/createTestStore.js';
import { useAppStore } from '../store/useAppStore.js';
import { displayDrawingTables } from './tableDisplay.js';
import { beginDrawingTableDrag, commitDrawingTable, deleteDrawingTables, finishDrawingTableDrag,
  previewDrawingTableDrag, startDrawingBalloon } from './tableCommands.js';

beforeEach(resetTestStore);
function outline(text: string, sizeMm: number): OutlinedText {
  return { status: 'ready', missingCharacters: [], fillRule: 'nonzero', subpaths: [],
    metrics: { fontId: 'table-test', sizeMm, advanceMm: text.length * sizeMm * 0.5,
      inkBounds: { left: 0, right: text.length * sizeMm * 0.5, bottom: 0, top: sizeMm } } };
}
function row(number: number, componentIds: readonly string[]): BomRow {
  return { rowKey: `row-${number}`, number, name: `部品${number}`, configurationName: '標準', quantity: componentIds.length,
    materialId: 'aluminum', materialName: 'aluminum', massEach: 0.25, massTotal: 0.25 * componentIds.length,
    componentIds, occurrencePath: componentIds.slice(0, 1), occurrencePaths: componentIds.map((id) => [id]) };
}
function setup(kind: 'part' | 'assembly' = 'assembly') {
  const document = createDrawingDocument('試験図面', { sourceRef: 'source', sourceKind: kind, path: '',
    fileName: kind === 'part' ? 'part.pcad' : 'assembly.pcaa', contentHash: '', importedAt: '' });
  const source: DrawingSourceResolution = { bodyIds: [], center: [0, 0, 0], bomRows: [row(1, ['a', 'b']), row(2, ['c'])] };
  useAppStore.getState().openDrawing(document);
  useAppStore.setState({ drawingSourceResolution: source });
  return { document, source };
}
const revision = (): Omit<DrawingTable, 'id' | 'layerId'> => ({ kind: 'revision', position: [30, 200],
  columns: ['revision', 'date', 'description', 'approvedBy'], rows: [['A', '2026-09-10', '寸法変更', '確認者']],
  options: { rowHeight: 7, textHeight: 3.5 } });
const bom = (): Omit<DrawingTable, 'id' | 'layerId'> => ({ kind: 'bom', position: [30, 200],
  columns: ['number', 'name', 'quantity', 'material', 'mass', 'configuration'], options: { direction: 'bottomToTop' } });

describe('図面の表の確定・保存定義・Undo(P8-54〜57)', () => {
  it('先に選んだ組図の辺を風船の取付先として保つ', () => {
    setup();
    const target = { kind: 'subShape' as const, viewId: 'view-1', sourceRef: 'source', componentId: 'a',
      ref: { bodyFeatureId: 'box', index: 0, fingerprint: { kind: 'edge' as const, curveKind: 'line' as const,
        length: 20, position: [0, 0, 0] as const, axis: null, radius: null } } };
    useAppStore.getState().setDrawingTargets([target]);
    expect(startDrawingBalloon()).toBe(true);
    expect(useAppStore.getState().drawingTool).toBe('balloon');
    expect(useAppStore.getState().drawingTargets).toEqual([target]);
    expect(useAppStore.getState().canUndo).toBe(false);
  });
  it('改訂欄を確定してUndo/Redoすると全行が戻る', () => {
    const { document } = setup();
    expect(commitDrawingTable(revision(), undefined, outline)).toBe(true);
    expect(useAppStore.getState().drawing?.tables[0].rows).toEqual(revision().rows);
    useAppStore.getState().undoDrawing();
    expect(useAppStore.getState().drawing).toBe(document);
    useAppStore.getState().redoDrawing();
    expect(useAppStore.getState().drawing?.tables[0].rows).toEqual(revision().rows);
  });
  it('同じ値の再確定では文書と履歴を増やさない', () => {
    setup(); commitDrawingTable(revision(), undefined, outline);
    const before = useAppStore.getState();
    expect(commitDrawingTable(revision(), before.drawing?.tables[0].id, outline)).toBe(true);
    expect(useAppStore.getState().drawing).toBe(before.drawing);
    expect(useAppStore.getState().drawingUndoStack).toBe(before.drawingUndoStack);
  });
  it('表の改訂内容を変えてUndoすると古い行へ戻る', () => {
    setup(); commitDrawingTable(revision(), undefined, outline);
    const before = useAppStore.getState().drawing;
    expect(commitDrawingTable({ ...revision(), rows: [['B', '2026-09-11', '厚さ変更', '承認']] }, before?.tables[0].id, outline)).toBe(true);
    useAppStore.getState().undoDrawing(); expect(useAppStore.getState().drawing).toBe(before);
  });
  it.each([[NaN, 200], [20, Infinity], [-10, 200], [500, 200]] as const)('不正な位置%sを確定しない', (x, y) => {
    const { document } = setup();
    expect(commitDrawingTable({ ...revision(), position: [x, y] }, undefined, outline)).toBe(false);
    expect(useAppStore.getState().drawing).toBe(document);
  });
  it('小さすぎる列と不正な行・字体欠落を黙って保存しない', () => {
    const { document } = setup();
    expect(commitDrawingTable({ ...bom(), options: { 'width.name': -1 } }, undefined, outline)).toBe(false);
    expect(commitDrawingTable({ ...revision(), rows: [['A']] }, undefined, outline)).toBe(false);
    expect(commitDrawingTable(revision(), undefined, () => ({ ...outline('', 3.5), metrics: null, status: 'missingGlyph' }))).toBe(false);
    expect(useAppStore.getState().drawing).toBe(document);
  });
  it('部品図へ部品表や風船を作らず、組図では入口が働く', () => {
    setup('part'); expect(commitDrawingTable(bom(), undefined, outline)).toBe(false); expect(startDrawingBalloon()).toBe(false);
    setup(); expect(commitDrawingTable(bom(), undefined, outline)).toBe(true); expect(startDrawingBalloon()).toBe(true);
    expect(useAppStore.getState().drawingTool).toBe('balloon');
  });
  it('BOMの並びと選択先を揃え、生成した行を文書に保存しない', () => {
    const { source } = setup(); commitDrawingTable(bom(), undefined, outline);
    const document = useAppStore.getState().drawing;
    if (document === null) throw new Error('図面なし');
    const shown = displayDrawingTables(document, source, outline);
    expect(shown.unresolved).toEqual([]);
    expect(shown.items[0].rowComponentIds).toEqual([['c'], ['a', 'b']]);
    expect(document.tables[0].rows).toBeUndefined();
    expect(shown.elements.flatMap((element) => element.texts ?? []).some((text) => text.text === '標準')).toBe(true);
  });
  it('関連する風船は部品表を削除しても消えない', () => {
    const { document } = setup(); commitDrawingTable(bom(), undefined, outline);
    const withTable = useAppStore.getState().drawing;
    if (withTable === null) throw new Error('図面なし');
    const withBalloon: DrawingDocument = { ...withTable, balloons: [{ id: 'balloon', itemNumber: 1,
      componentIds: ['a'], position: [180, 150], leader: [[100, 100]], layerId: document.layers[0].id }] };
    useAppStore.getState().applyDrawing(withBalloon);
    useAppStore.getState().selectDrawingIds([withTable.tables[0].id, 'component:a']);
    expect(deleteDrawingTables()).toBe(true);
    expect(useAppStore.getState().drawing?.tables).toEqual([]);
    expect(useAppStore.getState().drawing?.balloons).toEqual(withBalloon.balloons);
    useAppStore.getState().undoDrawing(); expect(useAppStore.getState().drawing).toBe(withBalloon);
  });
  it('ドラッグは確定まで文書を変えず、全移動をUndo1回で戻す', () => {
    setup(); commitDrawingTable(revision(), undefined, outline);
    const before = useAppStore.getState().drawing;
    const drag = beginDrawingTableDrag(before?.tables[0].id ?? '', [30, 200]);
    if (drag === null) throw new Error('ドラッグなし');
    expect(previewDrawingTableDrag(drag, [50, 190]).tables[0].position).toEqual([50, 190]);
    expect(useAppStore.getState().drawing).toBe(before);
    expect(finishDrawingTableDrag(drag, [50, 190], outline)).toBe(true);
    useAppStore.getState().undoDrawing(); expect(useAppStore.getState().drawing).toBe(before);
  });
  it('紙外/無移動/文書切替後のドラッグ結果を適用しない', () => {
    setup(); commitDrawingTable(revision(), undefined, outline);
    const document = useAppStore.getState().drawing;
    const drag = beginDrawingTableDrag(document?.tables[0].id ?? '', [30, 200]);
    if (drag === null) throw new Error('ドラッグなし');
    expect(finishDrawingTableDrag(drag, [30, 200], outline)).toBe(false);
    expect(finishDrawingTableDrag(drag, [-300, 200], outline)).toBe(false);
    setup(); expect(finishDrawingTableDrag(drag, [50, 190], outline)).toBe(false);
  });
  it('風船番号は保存値でなく現在の部品表へ追従する', () => {
    const { document, source } = setup();
    const drawing: DrawingDocument = { ...document, balloons: [{ id: 'balloon', itemNumber: 99, componentIds: ['a'],
      position: [180, 150], leader: [[100, 100]], layerId: document.layers[0].id }] };
    const result = displayDrawingTables(drawing, source, outline);
    expect(result.unresolved).toEqual([]);
    expect(result.elements.flatMap((element) => element.texts ?? []).map((text) => text.text)).toEqual(['1']);
    expect(drawing.balloons[0].itemNumber).toBe(99);
    expect(displayDrawingTables(drawing, { ...source, bomRows: [] }, outline).unresolved).toEqual(['balloon']);
  });
  it.each([
    { direction: [0, 0, -1] as const, rowY: 20, paperY: 107.5 },
    { direction: [0, 0, 1] as const, rowY: -20, paperY: 92.5 },
  ])('穴表の記号を図の実寸の穴中心へ引く（視線$direction）', ({ direction, rowY, paperY }) => {
    const { document, source } = setup('part');
    const drawing: DrawingDocument = { ...document, views: [{ id: 'top', name: '平面', kind: 'top', position: [100, 100],
      direction, xDir: [1, 0, 0], scale: 0.5, showHidden: false, showCenterLines: true, layerId: document.layers[0].id }],
      tables: [{ id: 'holes', kind: 'hole', position: [30, 200], columns: ['symbol', 'x', 'y', 'diameter', 'depth'],
        options: { viewId: 'top' }, layerId: document.layers[0].id }] };
    const holeSource: DrawingSourceResolution = { ...source, center: [5, 5, 0], holeTables: new Map([['holes', { ok: true, rows: [
      { id: 'hole:0', symbol: 'A1', x: 10, y: rowY, diameter: 6, depth: null, center: [10, 20, 3], featureIds: ['hole'] },
    ] }]]) };
    const result = displayDrawingTables(drawing, holeSource, outline);
    expect(result.unresolved).toEqual([]);
    expect(result.elements.flatMap((element) => element.texts ?? []).filter((text) => text.text === 'A1')).toHaveLength(2);
    expect(result.elements.flatMap((element) => element.curves ?? []).some((item) =>
      item.kind === 'segment' && item.from[0] === 102.5 && item.from[1] === paperY)).toBe(true);
    expect(result.elements.flatMap((element) => element.texts ?? []).map((text) => text.text)).toContain('貫通');
    expect(displayDrawingTables({ ...drawing, views: [] }, holeSource, outline).unresolved).toEqual(['holes']);
  });
});
