import { expressionValueFromNumber } from '@pointercad/expression';
import { beforeEach, describe, expect, it } from 'vitest';
import { encodeSaveDocument, readDocumentBundle, writeDocumentBundle } from '@pointercad/io';
import { buildSteelStockList, buildStandardPartFromSource, createStandardPartSource, steelProducts, steelProductOptions,
  DEFAULT_COMPONENT_PLACEMENT, createAssemblyDocument, createAssemblyDocumentBundle, createDrawingDocument,
  contentHashOf, embedPart, EMPTY_PART_LIBRARY, replacePartDocument, type BomRow, type DrawingSourceResolution } from '@pointercad/model';
import type { DrawingDocument, DrawingTable, OutlinedText } from '@pointercad/drawing';
import { captureSaveSnapshot } from '../file/pcadSaveSnapshot.js';
import { t } from '../i18n/t.js';
import { serializeSteelStockCsv } from '../assembly/steelStockCsvExport.js';
import { resetTestStore } from '../store/testing/createTestStore.js';
import { useAppStore } from '../store/useAppStore.js';
import { displayDrawingTables } from './tableDisplay.js';
import { drawingTableRowOwner } from './drawingSelection.js';
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

describe('steel stock drawing data binding', () => {
  it('refuses missing stock resolution instead of silently drawing a BOM', () => {
    setup();
    expect(commitDrawingTable({ ...bom(), options: { stockList: true } }, undefined, outline)).toBe(false);
    expect(useAppStore.getState().drawing?.tables).toHaveLength(0);
  });
  it('renders steel-specific headings through the shared export geometry', () => {
    const { document, source } = setup();
    const tables = [{ id: 'stock-1', kind: 'bom' as const, position: [20, 250] as const,
      columns: ['number', 'name'], options: { stockList: true, textHeight: 2 }, layerId: document.layers[0].id }];
    const stock = buildSteelStockList(createAssemblyDocument('empty'));
    const empty = displayDrawingTables({ ...document, tables }, { ...source, steelStockList: stock }, outline);
    expect(empty.unresolved).toEqual([]);
    expect(empty.elements.flatMap((element) => element.texts ?? []).map((text) => text.text)).toContain(`${t('assembly.steel.finishedLength')} (mm)`);
  });
});

describe('machined steel source to drawing table equality', () => {
  it('keeps saved generator groups, cut lengths and quantities identical in drawing and CSV after a real bundle reopen', async () => {
    const { document, source } = setup();
    const product = steelProducts('SS400', 'roundBar').find(item => item.size === 'φ25');
    if (product === undefined) throw new Error('Missing independent stock fixture');
    const current = createStandardPartSource(product.catalog, product.size, { ...steelProductOptions(product), length: '1000' });
    const original = buildStandardPartFromSource(current);
    if (original === null) throw new Error('Missing generated stock');
    const cut: import('@pointercad/model').CutFeature = { id: 'cut', name: 'cut', kind: 'cut', suppressed: false,
      targetFeatureId: original.solids.at(-1)?.id ?? '', pairedWith: null, keep: 'negative',
      plane: { kind: 'workPlane', planeId: 'xy', offset: expressionValueFromNumber(600) } };
    const edited = { ...original, solids: [...original.solids, cut] };
    const embedded = await embedPart(EMPTY_PART_LIBRARY, original, 'stock.pcad', 'stock.pcad');
    const library = await replacePartDocument(embedded.library, embedded.partRef, edited);
    const assembly = { ...createAssemblyDocument('Two generators and two edited occurrences'), components: [
      ...['one', 'two'].map(id => ({ id, name: id, source: { kind: 'part' as const, partRef: embedded.partRef },
        placement: DEFAULT_COMPONENT_PLACEMENT, fixed: false, visible: true, suppressed: false })),
      { id: 'legacy', name: 'legacy', source: { ...current, generatorRevision: '2-steel-1' },
        placement: DEFAULT_COMPONENT_PLACEMENT, fixed: false, visible: true, suppressed: false },
    ] };
    const reopened = await readDocumentBundle(await writeDocumentBundle(createAssemblyDocumentBundle(assembly, library)), 'assembly');
    if (!reopened.ok || reopened.bundle.kind !== 'assembly') throw new Error('Actual assembly bundle reopen failed');
    const parts = new Map([...reopened.bundle.embeddedDocuments].map(([ref, entry]) => [ref, entry.document]));
    const stock = buildSteelStockList(reopened.bundle.document, new Map(), parts);
    const expected = [
      ['SS400', 'φ25', 'jp-steel-2026-10-10-r1', '3-steel-profile-1', 1000, 600, 2, 2000],
      ['SS400', 'φ25', 'jp-steel-2026-10-10-r1', '2-steel-1', 1000, 1000, 1, 1000],
    ];
    expect(stock.rows.map(row => [row.product.materialGrade, row.product.size, row.catalogRevision, row.generatorRevision,
      row.lengthMm, row.finishedLengthMm, row.quantity, row.totalLengthMm])).toEqual(expected);
    expect([stock.totalQuantity, stock.totalLengthMm]).toEqual([3, 3000]);
    const definition = { ...document, tables: [{ id: 'stock', kind: 'bom' as const, position: [20, 250] as const,
      columns: ['number', 'name'], options: { stockList: true, textHeight: 2 }, layerId: document.layers[0].id }] };
    const drawing = displayDrawingTables(definition, { ...source, steelStockList: stock }, outline);
    expect(drawing.unresolved).toEqual([]);
    const text = drawing.elements.flatMap(element => element.texts ?? []).map(item => item.text).join('');
    expect(text).toContain('jp-steel-2026-10-10-r1');
    expect(text).toContain('3-steel-profile-1');
    expect(text).toContain('2-steel-1');
    expect(text).toContain(t('assembly.steel.csv.catalogRevision'));
    expect(text).toContain(t('assembly.steel.csv.generatorRevision'));
    const renderedRow = (index: number) => drawing.elements.filter(element => element.ownerId === drawingTableRowOwner('stock', index))
      .flatMap(element => element.texts ?? []).map(item => item.text);
    expect(renderedRow(1)).toEqual(expect.arrayContaining(['SS400', '1000', '600', '2']));
    expect(renderedRow(2)).toEqual(expect.arrayContaining(['SS400', '1000', '1']));
    expect(renderedRow(1).join('')).toContain('3-steel-profile-1');
    expect(renderedRow(1).join('')).not.toContain('2-steel-1');
    expect(renderedRow(2).join('')).toContain('2-steel-1');
    expect(renderedRow(2).join('')).not.toContain('3-steel-profile-1');
    // The profile cell is the first 30mm column of this existing 170mm table.
    // Read its actual rendered text, not the model row or the CSV field.
    const profileCell = (index: number) => drawing.elements
      .filter(element => element.ownerId === drawingTableRowOwner('stock', index))
      .flatMap(element => element.texts ?? [])
      .filter(item => item.position[0] >= 20 && item.position[0] < 50)
      .map(item => item.text).join('');
    expect(profileCell(1)).toBe(`${t('assembly.steel.roundBar')} φ25`);
    expect(profileCell(2)).toBe(`${t('assembly.steel.roundBar')} φ25`);

    // Both rows remain on the existing 170mm table; actual text wrapping/row-height checks remain enabled.
    expect(drawing.items[0].bounds.right - drawing.items[0].bounds.left).toBe(170);
    // Independent CSV reader retains quoted occurrence paths, commas and multiline fields.
    const rows: string[][] = []; let row: string[] = [], cell = '', quoted = false;
    const csv = new TextDecoder().decode(serializeSteelStockCsv(stock));
    for (let index = 0; index < csv.length; index++) {
      const ch = csv[index];
      if (ch === '"') { if (quoted && csv[index + 1] === '"') { cell += '"'; index++; } else quoted = !quoted; }
      else if (!quoted && ch === ',') { row.push(cell); cell = ''; }
      else if (!quoted && ch === '\r' && csv[index + 1] === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; index++; }
      else cell += ch;
    }
    expect(rows.slice(2, 4).map(value => [value[1], value[5], value[14], value[15],
      Number(value[7]), Number(value[13]), Number(value[8]), Number(value[9])])).toEqual(expected);
    const undone = buildSteelStockList(assembly, new Map(), embedded.library.parts);
    expect(undone.rows.map(row => [row.generatorRevision, row.finishedLengthMm, row.quantity]))
      .toEqual([['3-steel-profile-1', 1000, 2], ['2-steel-1', 1000, 1]]);
    expect(definition.tables[0]).not.toHaveProperty('rows');
  });

  it('keeps purchased length/quantity while current edited length and undo reach the shared rendering', () => {
    const { document, source } = setup();
    const product = steelProducts('SS400', 'roundBar').find((item) => item.size === 'φ25');
    if (product === undefined) throw new Error('Missing catalogue fixture');
    const purchased = createStandardPartSource(product.catalog, product.size, { ...steelProductOptions(product), length: '1000' });
    const part = buildStandardPartFromSource(purchased);
    if (part === null) throw new Error('Missing generated stock');
    const cut: import('@pointercad/model').CutFeature = { id: 'cut', name: 'cut', kind: 'cut', suppressed: false,
      targetFeatureId: part.solids.at(-1)?.id ?? '', pairedWith: null, keep: 'negative',
      plane: { kind: 'workPlane', planeId: 'xy', offset: expressionValueFromNumber(600) } };
    const edited = { ...part, solids: [...part.solids, cut] };
    const assembly = { ...createAssemblyDocument('steel'), components: ['a', 'b'].map((id) => ({ id, name: id,
      source: { kind: 'part' as const, partRef: 'stock' }, placement: DEFAULT_COMPONENT_PLACEMENT,
      fixed: false, visible: true, suppressed: false })) };
    const definition = { ...document, tables: [{ id: 'stock', kind: 'bom' as const, position: [20, 250] as const,
      columns: ['number', 'name'], options: { stockList: true, textHeight: 2 }, layerId: document.layers[0].id }] };
    const render = (current: import('@pointercad/model').PartDocument) => {
      const stock = buildSteelStockList(assembly, new Map(), new Map([['stock', current]]));
      const display = displayDrawingTables(definition, { ...source, steelStockList: stock }, outline);
      expect(display.unresolved).toEqual([]);
      return { stock, text: display.elements.flatMap((element) => element.texts ?? []).map((text) => text.text) };
    };
    const changed = render(edited);
    expect(changed.stock.rows[0]).toMatchObject({ lengthMm: 1000, finishedLengthMm: 600, quantity: 2 });
    expect(changed.text).toEqual(expect.arrayContaining(['1000', '600', '2', 'SS400']));
    expect(changed.text.join('')).toContain(t('assembly.steel.roundBar'));
    const unknown = render({ ...edited, solids: [] });
    expect(unknown.stock.rows[0].finishedLengthMm).toBeNull();
    expect(unknown.text.join('')).toContain(t('assembly.steel.finishedUnknown'));
    const undo = render(part);
    expect(undo.stock.rows[0]).toMatchObject({ lengthMm: 1000, finishedLengthMm: 1000, quantity: 2 });
    expect(definition.tables[0]).not.toHaveProperty('rows');
  });
});

describe('steel authored persistence and input fingerprints', () => {
  it('captures old and machined stock inputs separately and keeps authored identities and content hashes after real saves', async () => {
    const product = steelProducts('SS400', 'roundBar').find(row => row.size === 'φ25');
    if (product === undefined) throw new Error('Missing independent persistence fixture');
    const input = createStandardPartSource('roundBar', 'φ25', { ...steelProductOptions(product), length: '1000' });
    const generated = buildStandardPartFromSource(input);
    if (generated === null) throw new Error('Missing generated persistence fixture');
    const original = { ...generated, id: 'part-uuid:3f2b8c1e-6a4d-4e2f-9b1c-0d5e7a9c2b41' };
    const embedded = await embedPart(EMPTY_PART_LIBRARY, original, 'stock.pcad', 'stock.pcad');
    expect(embedded.partRef).toBe('part-1');
    const assembly = { ...createAssemblyDocument('Persisted steel inputs'), components: [
      ...['one', 'two'].map(id => ({ id, name: id, source: { kind: 'part' as const, partRef: 'part-1' },
        placement: DEFAULT_COMPONENT_PLACEMENT, fixed: false, visible: true, suppressed: false })),
      { id: 'legacy', name: 'legacy', source: { ...input, generatorRevision: '2-steel-1' },
        placement: DEFAULT_COMPONENT_PLACEMENT, fixed: false, visible: true, suppressed: false },
    ] };
    const oldHash = await contentHashOf(original);
    const capturedOld = captureSaveSnapshot({ kind: 'assembly',
      bundle: createAssemblyDocumentBundle(assembly, embedded.library), options: {} });
    const cut: import('@pointercad/model').CutFeature = { id: 'persist-cut', name: 'cut', kind: 'cut', suppressed: false,
      targetFeatureId: original.solids.at(-1)?.id ?? '', pairedWith: null, keep: 'negative',
      plane: { kind: 'workPlane', planeId: 'xy', offset: expressionValueFromNumber(600) } };
    const edited = { ...original, solids: [...original.solids, cut] };
    const library = await replacePartDocument(embedded.library, 'part-1', edited);
    const newHash = await contentHashOf(edited);
    expect(newHash).not.toBe(oldHash);
    expect(embedded.library.partFiles.map(file => [file.ref, file.contentHash])).toEqual([['part-1', oldHash]]);
    expect(library.partFiles.map(file => [file.ref, file.fileName, file.path, file.contentHash]))
      .toEqual([['part-1', 'stock.pcad', 'stock.pcad', newHash]]);
    const capturedNew = captureSaveSnapshot({ kind: 'assembly',
      bundle: createAssemblyDocumentBundle(assembly, library), options: {} });
    // Encode the old capture AFTER the library edit. The production save capture
    // owns its mapping and keeps the immutable authored document it was given.
    for (const [captured, hash, finished] of [[capturedOld, oldHash, 1000], [capturedNew, newHash, 600]] as const) {
      const read = await readDocumentBundle(await encodeSaveDocument(captured), 'assembly');
      if (!read.ok || read.bundle.kind !== 'assembly') throw new Error('Real captured assembly save did not reopen');
      const reopened = read.bundle, part = reopened.embeddedDocuments.get('part-1');
      if (part === undefined) throw new Error('Stable authored part reference missing');
      expect(reopened.document.id).toBe(assembly.id);
      expect(reopened.document.components.map(component => [component.id, component.source.kind,
        component.source.kind === 'part' ? component.source.partRef : null]))
        .toEqual([['one', 'part', 'part-1'], ['two', 'part', 'part-1'], ['legacy', 'standardPart', null]]);
      expect(part.document.id).toBe('part-uuid:3f2b8c1e-6a4d-4e2f-9b1c-0d5e7a9c2b41');
      const authored = part.document.steelStockSource;
      expect([authored?.catalog, authored?.size, authored?.options.materialGrade,
        authored?.catalogRevision, authored?.generatorRevision, authored?.options.length])
        .toEqual(['roundBar', 'φ25', 'SS400', 'jp-steel-2026-10-10-r1', '3-steel-profile-1', '1000']);
      const legacy = reopened.document.components[2]?.source;
      if (legacy?.kind !== 'standardPart') throw new Error('Legacy authored source missing');
      expect([legacy.catalog, legacy.size, legacy.options.materialGrade, legacy.catalogRevision,
        legacy.generatorRevision, legacy.options.length])
        .toEqual(['roundBar', 'φ25', 'SS400', 'jp-steel-2026-10-10-r1', '2-steel-1', '1000']);
      expect(reopened.partFiles.map(file => [file.ref, file.fileName, file.path, file.contentHash]))
        .toEqual([['part-1', 'stock.pcad', 'stock.pcad', hash]]);
      expect(await contentHashOf(part.document)).toBe(hash);
      const parts = new Map([...reopened.embeddedDocuments].map(([ref, value]) => [ref, value.document]));
      const stock = buildSteelStockList(reopened.document, new Map(), parts);
      expect(stock.rows.map(row => [row.product.materialGrade, row.product.catalog, row.product.size,
        row.catalogRevision, row.generatorRevision, row.lengthMm, row.finishedLengthMm, row.quantity, row.totalLengthMm]))
        .toEqual([
          ['SS400', 'roundBar', 'φ25', 'jp-steel-2026-10-10-r1', '3-steel-profile-1', 1000, finished, 2, 2000],
          ['SS400', 'roundBar', 'φ25', 'jp-steel-2026-10-10-r1', '2-steel-1', 1000, 1000, 1, 1000],
        ]);
      expect(stock.rows.map(row => row.occurrencePaths)).toEqual([[['one'], ['two']], [['legacy']]]);
      expect(stock.issues).toEqual([]);
      expect([stock.totalQuantity, stock.totalLengthMm]).toEqual([3, 3000]);
    }
  });
});
