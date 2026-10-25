import { expressionValueFromNumber } from '@pointercad/expression';
import { readDocumentBundle } from '@pointercad/io';
import { buildStandardPartFromSource, buildSteelStockList, createAssemblyDocument, DEFAULT_COMPONENT_PLACEMENT,
  contentHashOf, replacePartDocument, STEEL_PRODUCTS, steelProducts, type SteelMaterialGrade, type SteelSectionCatalog } from '@pointercad/model';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resetTestStore } from '../store/testing/createTestStore.js';
import { useAppStore } from '../store/useAppStore.js';
import { cancelPlaceComponent, commitPlaceComponent } from './placeComponentActions.js';
import { buildEditableSteelPart, placeEditableSteelPart } from './steelEditablePart.js';
import { commitStandardPartChoice, standardPartChoices } from './standardPartPicker.js';

const LINEAGE = 'part-uuid:3f2b8c1e-6a4d-4e2f-9b1c-0d5e7a9c2b41';
const lineage = (): string => LINEAGE;

function key(grade: SteelMaterialGrade, catalog: SteelSectionCatalog, size: string): string {
  const row = steelProducts(grade, catalog).find(candidate => candidate.size === size);
  if (row === undefined) throw new Error(`Missing catalog row ${grade} ${size}`);
  return `steel:${row.key}`;
}
function stockRows(assembly = useAppStore.getState().assembly) {
  if (assembly === null) throw new Error('No assembly');
  const library = useAppStore.getState().assemblyLibrary;
  return buildSteelStockList(assembly, library.assemblies, library.parts).rows
    .map(row => [row.product.materialGrade, row.product.size, row.lengthMm, row.finishedLengthMm, row.quantity]);
}

describe('editable straight steel stock from the picker source', () => {
  it.each(STEEL_PRODUCTS.map(row => [row.materialGrade, row.catalog, row.size, row.key] as const))(
    '%s %s %s keeps the placed source, the generator solids and an exact unmachined finished length',
    (_grade, _catalog, _size, productKey) => {
      const committed = commitStandardPartChoice('structuralSection', `steel:${productKey}`, '1000');
      if (!committed.ok) throw new Error('Picker refused a catalog row');
      const built = buildEditableSteelPart(`steel:${productKey}`, '1000', lineage);
      if (!built.ok) throw new Error(`Refused ${productKey}: ${built.reason}`);
      const generated = buildStandardPartFromSource(committed.value.source);
      // Same provenance as an ordinary placement; only the lineage id is new, so refresh can match the file.
      expect(built.document).toEqual({ ...generated, id: LINEAGE });
      expect(built.document.steelStockSource).toEqual(committed.value.source);
      expect(built.document.solids.length).toBeGreaterThan(0);
      expect(built.fileName).toBe(`${built.document.name}.pcad`);
      const assembly = { ...createAssemblyDocument('Root'), components: [{ id: 'bar', name: 'bar',
        source: { kind: 'part' as const, partRef: 'bar' }, placement: DEFAULT_COMPONENT_PLACEMENT,
        fixed: false, visible: true, suppressed: false }] };
      const rows = buildSteelStockList(assembly, new Map(), new Map([['bar', built.document]])).rows;
      expect(rows.map(row => [row.product.key, row.lengthMm, row.finishedLengthMm, row.quantity]))
        .toEqual([[productKey, 1000, 1000, 1]]);
    });

  it('covers SS400 and S45C flat and round bars, a hollow pipe and a profile section', () => {
    const grades = new Set(STEEL_PRODUCTS.map(row => `${row.materialGrade}:${row.catalog}`));
    for (const required of ['SS400:flatBar', 'SS400:roundBar', 'S45C:flatBar', 'S45C:roundBar', 'SGP:steelPipe']) {
      expect(grades.has(required), required).toBe(true);
    }
    expect(STEEL_PRODUCTS.some(row => row.geometry === 'profileSection')).toBe(true);
  });

  it('refuses unknown rows, rows without a steel grade and lengths outside the stock limits', () => {
    const flat = key('SS400', 'flatBar', 'FB 50×6');
    expect(buildEditableSteelPart('steel:not-a-product', '1000', lineage)).toEqual({ ok: false, reason: 'unknownChoice' });
    const legacy = standardPartChoices('structuralSection')[0];
    expect(buildEditableSteelPart(legacy.key, '1000', lineage)).toEqual({ ok: false, reason: 'notSteelStock' });
    for (const length of ['0', '-5', '12001', 'abc', '']) {
      expect(buildEditableSteelPart(flat, length, lineage), length).toEqual({ ok: false, reason: 'invalidLength' });
    }
    // An expression length is kept in the name but never becomes a path separator in the file name.
    const half = buildEditableSteelPart(flat, '2000/2', lineage);
    if (!half.ok) throw new Error('Expression length refused');
    expect(half.document.name).toBe('SS400 FB 50×6 長さ2000/2');
    expect(half.fileName).toBe('SS400 FB 50×6 長さ2000_2.pcad');
    expect(half.document.steelStockSource?.options.length).toBe('2000/2');
  });
});

describe('save, place, sibling and one Undo step through the real store', () => {
  const save = vi.fn<(name: string, kind: string, bytes: Uint8Array) => Promise<boolean>>();
  beforeEach(() => {
    resetTestStore();
    save.mockReset();
    useAppStore.getState().openAssembly(createAssemblyDocument('Steel'));
    useAppStore.setState({ fileGateway: { ...useAppStore.getState().fileGateway, saveFileAs: save } });
    expect(useAppStore.getState().openStandardPartPicker()).toBe(true);
  });
  afterEach(() => { resetTestStore(); });

  it('saves the editable file, places it once, keeps an identical standard sibling and undoes each step separately', async () => {
    save.mockResolvedValue(true);
    const flat = key('SS400', 'flatBar', 'FB 50×6');
    const before = useAppStore.getState().assembly;
    expect(await placeEditableSteelPart(flat, '1000', lineage)).toBe('placing');
    expect(save).toHaveBeenCalledOnce();
    const [fileName, kind, bytes] = save.mock.calls[0];
    expect([fileName, kind]).toEqual(['SS400 FB 50×6 長さ1000.pcad', 'pcad']);
    const placement = useAppStore.getState().assemblyPlacement;
    if (placement?.kind !== 'ready') throw new Error('No ready placement after the save');
    const read = await readDocumentBundle(bytes, 'part');
    if (!read.ok || read.bundle.kind !== 'part') throw new Error('Saved file does not decode');
    // The file on disk is exactly the document being placed.
    expect(read.bundle.document).toEqual(placement.document);
    expect(placement.document.id).toBe(LINEAGE);
    expect(placement.fileName).toBe(fileName);
    expect(useAppStore.getState().standardPartPickerOpen).toBe(false);
    expect(useAppStore.getState().assembly).toBe(before);

    await commitPlaceComponent();
    const placed = useAppStore.getState();
    expect(placed.assembly?.components.map(component => component.source.kind)).toEqual(['part']);
    const partRef = placed.assembly?.components[0]?.source;
    if (partRef?.kind !== 'part') throw new Error('Not a part occurrence');
    expect(placed.assemblyLibrary.partFiles.map(file => [file.ref, file.fileName])).toEqual([[partRef.partRef, fileName]]);
    expect(placed.assemblyLibrary.parts.get(partRef.partRef)?.steelStockSource).toEqual(placement.document.steelStockSource);
    const partId = placed.assembly?.components[0]?.id;
    const partLibrary = placed.assemblyLibrary;

    // An ordinary placement of the same stock stays a standard part and shares the purchased-length row.
    expect(placed.openStandardPartPicker()).toBe(true);
    expect(useAppStore.getState().placeStandardPart('structuralSection', flat, '1000')).toBe(true);
    expect(useAppStore.getState().assembly?.components.map(component => component.source.kind)).toEqual(['part', 'standardPart']);
    expect(stockRows()).toEqual([['SS400', 'FB 50×6', 1000, 1000, 2]]);

    useAppStore.getState().undo();
    expect(useAppStore.getState().assembly?.components.map(component => component.id)).toEqual([partId]);
    expect(useAppStore.getState().assemblyLibrary).toBe(partLibrary);
    useAppStore.getState().undo();
    expect(useAppStore.getState().assembly?.components).toEqual([]);
    expect(useAppStore.getState().assemblyLibrary.partFiles).toEqual([]);
    useAppStore.getState().redo();
    expect(useAppStore.getState().assembly?.components.map(component => component.id)).toEqual([partId]);
    expect(useAppStore.getState().assemblyLibrary).toBe(partLibrary);
    expect(stockRows()).toEqual([['SS400', 'FB 50×6', 1000, 1000, 1]]);
  });

  it('places nothing when the save is cancelled, fails or the request is superseded, and refuses re-entry', async () => {
    const flat = key('S45C', 'roundBar', steelProducts('S45C', 'roundBar')[0].size);
    const initial = useAppStore.getState().assembly;
    save.mockResolvedValueOnce(false);
    expect(await placeEditableSteelPart(flat, '1000', lineage)).toBe('cancelled');
    expect(useAppStore.getState().assemblyPlacement).toBeNull();
    expect(useAppStore.getState().standardPartPickerOpen).toBe(true);

    save.mockRejectedValueOnce(new Error('disk full'));
    expect(await placeEditableSteelPart(flat, '1000', lineage)).toBe('failed');
    expect(useAppStore.getState().assemblyPlacement).toBeNull();

    let finish: (saved: boolean) => void = () => undefined;
    save.mockImplementationOnce(() => new Promise<boolean>(resolve => { finish = resolve; }));
    const pending = placeEditableSteelPart(flat, '1000', lineage);
    await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(3));
    expect(useAppStore.getState().assemblyPlacement?.kind).toBe('choosing');
    expect(await placeEditableSteelPart(flat, '1000', lineage)).toBe('busy');
    useAppStore.setState({ assemblyPlacement: null }); // the user cancelled the pending placement
    finish(true);
    expect(await pending).toBe('cancelled');
    expect(useAppStore.getState().assemblyPlacement).toBeNull();

    expect(await placeEditableSteelPart(flat, '0', lineage)).toBe('invalidLength');
    expect(save).toHaveBeenCalledTimes(3);
    expect(useAppStore.getState().assembly).toBe(initial);
    expect(useAppStore.getState().canUndo).toBe(false);
  });
});

describe('stock edit atomic history and cancellation', () => {
  beforeEach(resetTestStore);
  afterEach(resetTestStore);
  it('undoes and redoes one machined-library edit and keeps its document, identities and history on cancelled or failed saves', async () => {
    const save = vi.fn<(name: string, kind: string, bytes: Uint8Array) => Promise<boolean>>();
    useAppStore.getState().openAssembly(createAssemblyDocument('Stock history'));
    useAppStore.setState({ fileGateway: { ...useAppStore.getState().fileGateway, saveFileAs: save } });
    expect(useAppStore.getState().openStandardPartPicker()).toBe(true);
    save.mockResolvedValueOnce(true);
    const round = key('SS400', 'roundBar', 'φ25');
    expect(await placeEditableSteelPart(round, '1000', lineage)).toBe('placing');
    const initialFile = save.mock.calls[0];
    if (initialFile === undefined) throw new Error('Actual part save missing');
    const reopened = await readDocumentBundle(initialFile[2], 'part');
    if (!reopened.ok || reopened.bundle.kind !== 'part') throw new Error('Actual saved part unreadable');
    expect(reopened.bundle.document.id).toBe(LINEAGE);
    await commitPlaceComponent();
    const placed = useAppStore.getState(), assembly = placed.assembly, stack = placed.assemblyUndoStack;
    const original = placed.assemblyLibrary.parts.get('part-1');
    if (assembly === null || stack === null || original === undefined) throw new Error('Actual placed stock missing');
    const componentId = assembly.components[0]?.id;
    expect(assembly.components.map(component => component.source.kind === 'part' ? component.source.partRef : null)).toEqual(['part-1']);
    expect(original.id).toBe(LINEAGE);
    expect(stack.past).toHaveLength(1);
    expect(stockRows()).toEqual([['SS400', 'φ25', 1000, 1000, 1]]);
    const oldHash = await contentHashOf(original);
    expect(await contentHashOf(reopened.bundle.document)).toBe(oldHash);
    const cut: import('@pointercad/model').CutFeature = { id: 'history-cut', name: 'cut', kind: 'cut', suppressed: false,
      targetFeatureId: original.solids.at(-1)?.id ?? '', pairedWith: null, keep: 'negative',
      plane: { kind: 'workPlane', planeId: 'xy', offset: expressionValueFromNumber(600) } };
    const edited = { ...original, solids: [...original.solids, cut] };
    const library = await replacePartDocument(placed.assemblyLibrary, 'part-1', edited);
    const newHash = await contentHashOf(edited);
    expect(newHash).not.toBe(oldHash);
    useAppStore.getState().applyAssembly(assembly, library);
    expect(useAppStore.getState().assemblyUndoStack?.past).toHaveLength(2);
    expect(stockRows()).toEqual([['SS400', 'φ25', 1000, 600, 1]]);
    useAppStore.getState().undo();
    expect(useAppStore.getState().assembly).toBe(assembly);
    expect(useAppStore.getState().assemblyLibrary).toBe(placed.assemblyLibrary);
    expect(useAppStore.getState().assemblyUndoStack?.past).toHaveLength(1);
    expect(useAppStore.getState().assemblyUndoStack?.future).toHaveLength(1);
    expect(useAppStore.getState().assemblyLibrary.partFiles.map(file => [file.ref, file.contentHash])).toEqual([['part-1', oldHash]]);
    expect(stockRows()).toEqual([['SS400', 'φ25', 1000, 1000, 1]]);
    useAppStore.getState().redo();
    const committed = useAppStore.getState();
    expect(committed.assembly).toBe(assembly);
    expect(committed.assembly?.components.map(component => [component.id, component.source.kind === 'part' ? component.source.partRef : null]))
      .toEqual([[componentId, 'part-1']]);
    expect(committed.assemblyLibrary).toBe(library);
    expect(committed.assemblyUndoStack?.past).toHaveLength(2);
    expect(committed.assemblyUndoStack?.future).toEqual([]);
    expect(committed.assemblyLibrary.partFiles.map(file => [file.ref, file.contentHash])).toEqual([['part-1', newHash]]);
    expect(stockRows()).toEqual([['SS400', 'φ25', 1000, 600, 1]]);
    expect(committed.openStandardPartPicker()).toBe(true);
    const unchanged = () => {
      const state = useAppStore.getState();
      expect(state.assembly).toBe(assembly);
      expect(state.assemblyLibrary).toBe(library);
      expect(state.assemblyUndoStack).toBe(committed.assemblyUndoStack);
      expect(state.assemblyPlacement).toBeNull();
      expect(stockRows()).toEqual([['SS400', 'φ25', 1000, 600, 1]]);
    };
    save.mockResolvedValueOnce(false);
    expect(await placeEditableSteelPart(round, '1000', lineage)).toBe('cancelled');
    unchanged();
    save.mockRejectedValueOnce(new Error('disk full'));
    expect(await placeEditableSteelPart(round, '1000', lineage)).toBe('failed');
    unchanged();
    let finish: (saved: boolean) => void = () => { throw new Error('Pending gateway not reached'); };
    save.mockImplementationOnce(() => new Promise<boolean>(resolve => { finish = resolve; }));
    const pending = placeEditableSteelPart(round, '1000', lineage);
    await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(4));
    cancelPlaceComponent();
    finish(true);
    expect(await pending).toBe('cancelled');
    unchanged();
    const retained = useAppStore.getState().assemblyLibrary.parts.get('part-1');
    if (retained === undefined) throw new Error('Cancelled operation lost the committed stock');
    expect(retained.id).toBe(LINEAGE);
    expect(await contentHashOf(retained)).toBe(newHash);
  });
});
