import { expressionValueFromNumber } from '@pointercad/expression';
import { buildSteelStockList, createAssemblyDocument, createAssemblyDocumentBundle, createPartDocumentBundle,
  emptyEmbeddedPartAttachments, replacePartDocument, STEEL_PRODUCTS, type CutFeature, type PartDocument } from '@pointercad/model';
import { readDocumentBundle, writeDocumentBundle } from '@pointercad/io';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createBrowserFileGateway } from '../file/fileGateway.js';
import { t } from '../i18n/t.js';
import { resetTestStore } from '../store/testing/createTestStore.js';
import { useAppStore } from '../store/useAppStore.js';
import { commitPlaceComponent } from './placeComponentActions.js';
import { refreshPartReadiness, startRefreshPartSource, type RefreshPartDeps } from './replaceActions.js';
import { beginSteelBendPlacement, buildSteelBendChoice, DEFAULT_STEEL_BEND_SOURCES } from './steelBendPicker.js';
import { exportSteelStockCsv, serializeSteelStockCsv } from './steelStockCsvExport.js';

/** Public EX08 path: picker bend -> actual library placement -> the actual cut-list CSV command -> saved bundle reopen.
 * The developed length is the already proved centroid-path closed form 100 + 200 + (30 + 50/2) * pi/2 of FB 50x6 bent
 * towards +X with inside radius 30 (steelBend.test.ts, steelBendPicker.test.ts); no density or standard is used. */
const DEVELOPED = 300 + 55 * Math.PI / 2;
const STOCK = 7, QUANTITY = 8, TOTAL = 9, FINISHED = 13;

function csvRows(bytes: Uint8Array): string[][] {
  const text = new TextDecoder().decode(bytes);
  const rows: string[][] = [];
  let row: string[] = [], value = '', quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const ch = text[index];
    if (ch === '"') {
      if (quoted && text[index + 1] === '"') { value += '"'; index += 1; }
      else quoted = !quoted;
    } else if (!quoted && ch === ',') { row.push(value); value = ''; }
    else if (!quoted && ch === '\r' && text[index + 1] === '\n') {
      row.push(value); rows.push(row); row = []; value = ''; index += 1;
    } else value += ch;
  }
  return rows;
}

/** Places the bend through the picker's own commands and returns the placed library part. */
async function placeBend(): Promise<PartDocument> {
  const row = STEEL_PRODUCTS.find(candidate => candidate.key === 'SS400:flatBar:FB 50×6');
  if (row === undefined) throw new Error('Missing sourced product');
  const choice = buildSteelBendChoice(row, { ...DEFAULT_STEEL_BEND_SOURCES, radius: '30', firstLeg: '100', secondLeg: '200' });
  if (!choice.ok) throw new Error(choice.reason);
  expect(beginSteelBendPlacement(choice)).toBe(true);
  await commitPlaceComponent();
  const component = useAppStore.getState().assembly?.components[0];
  if (component?.source.kind !== 'part') throw new Error('Bend was not placed as a library part');
  const placed = useAppStore.getState().assemblyLibrary.parts.get(component.source.partRef);
  if (placed === undefined) throw new Error('Missing placed bend');
  return placed;
}

/** Runs the actual CSV export command through the existing save gateway and returns the written CSV rows. */
async function exportedRows(): Promise<string[][]> {
  const writes: Uint8Array[] = [];
  const writable = { write: (bytes: Uint8Array) => { writes.push(bytes); return Promise.resolve(); },
    close: () => Promise.resolve(), abort: () => Promise.resolve() };
  const handle = { name: 'steel-stock-list.csv', createWritable: () => Promise.resolve(writable) };
  useAppStore.setState({ fileGateway: { ...createBrowserFileGateway({ showSaveFilePicker: vi.fn(() => Promise.resolve(handle)) }),
    clearSaveTarget: vi.fn() } });
  useAppStore.getState().openStandardPartPicker();
  const state = useAppStore.getState();
  if (state.assembly === null) throw new Error('Missing assembly');
  const status = vi.fn(), error = vi.fn();
  await exportSteelStockCsv({ pending: { current: null as AbortController | null }, assembly: state.assembly,
    library: state.assemblyLibrary, busy: vi.fn(), error, status });
  expect(error).toHaveBeenLastCalledWith('');
  expect(status).toHaveBeenLastCalledWith(t('assembly.steel.csv.saved'));
  expect(writes).toHaveLength(1);
  return csvRows(writes[0]);
}

beforeEach(() => {
  resetTestStore();
  useAppStore.getState().openAssembly(createAssemblyDocument('Bend cut list'));
  useAppStore.getState().openStandardPartPicker();
});

describe('placed steel bend in the actual cut-list consumers', () => {
  it('exports the developed length, not "finished unknown", and keeps it after a saved bundle reopen', async () => {
    const placed = await placeBend();
    const cut = (await exportedRows())[2];
    expect(cut[FINISHED]).not.toBe(t('assembly.steel.finishedUnknown'));
    expect(cut[FINISHED]).toBe(cut[STOCK]);
    expect(Math.abs(Number(cut[FINISHED]) - DEVELOPED) / DEVELOPED).toBeLessThan(1e-12);
    expect([cut[QUANTITY], Number(cut[TOTAL])]).toEqual(['1', Number(cut[STOCK])]);

    // Saved .pcad bundle -> reopen: the same cut-list row comes from the reopened assembly and its embedded part.
    const state = useAppStore.getState();
    if (state.assembly === null) throw new Error('Missing assembly');
    const reopened = await readDocumentBundle(await writeDocumentBundle(createAssemblyDocumentBundle(state.assembly, state.assemblyLibrary)), 'assembly');
    if (!reopened.ok || reopened.bundle.kind !== 'assembly') throw new Error('Assembly roundtrip failed');
    const parts = new Map([...reopened.bundle.embeddedDocuments].map(([ref, entry]) => [ref, entry.document]));
    expect([...parts.values()]).toEqual([placed]);
    expect(csvRows(serializeSteelStockCsv(buildSteelStockList(reopened.bundle.document, new Map(), parts)))[2]).toEqual(cut);
  });

  it('drops to "finished unknown" after the part file is edited (cut) and refreshed, and Undo restores the length', async () => {
    const placed = await placeBend();
    const before = (await exportedRows())[2];
    const component = useAppStore.getState().assembly?.components[0];
    if (component === undefined) throw new Error('Missing placed component');
    // A real part edit saved to the part file: a transverse cut on the bend's sweep, as the part editor appends it.
    const cutFeature: CutFeature = { id: 'cut-1', name: 'cut-1', kind: 'cut', suppressed: false, targetFeatureId: 'steel-bend-sweep-0',
      pairedWith: null, plane: { kind: 'workPlane', planeId: 'xy', offset: expressionValueFromNumber(50) }, keep: 'positive' };
    const edited: PartDocument = { ...placed, solids: [...placed.solids, cutFeature] };
    const bytes = await writeDocumentBundle(createPartDocumentBundle(edited, emptyEmbeddedPartAttachments()));
    const deps: RefreshPartDeps = {
      choose: () => Promise.resolve({ kind: 'pcad', fileName: 'edited-bend.pcad', bytes }),
      read: input => readDocumentBundle(input, 'part'),
      replace: (library, ref, document, attachments) => replacePartDocument(library, ref, document, { attachments }),
    };
    useAppStore.setState({ isComputing: false });
    expect(refreshPartReadiness(useAppStore.getState(), component.id).ready).toBe(true);
    const unsubscribe = useAppStore.subscribe(state => {
      if (state.partSourceConfirm !== null) state.answerPartSourceConfirm(state.partSourceConfirm.requestId, true);
    });
    try { await startRefreshPartSource(component.id, deps); }
    finally { unsubscribe(); }
    if (component.source.kind !== 'part') throw new Error('Bend was not placed as a library part');
    expect(useAppStore.getState().assemblyLibrary.parts.get(component.source.partRef)).toEqual(edited);
    const after = (await exportedRows())[2];
    expect(after[FINISHED]).toBe(t('assembly.steel.finishedUnknown'));
    expect([after[STOCK], after[QUANTITY], after[TOTAL]]).toEqual([before[STOCK], before[QUANTITY], before[TOTAL]]);

    useAppStore.getState().undoAssembly();
    expect(useAppStore.getState().assemblyLibrary.parts.get(component.source.partRef)).toEqual(placed);
    expect((await exportedRows())[2]).toEqual(before);
  });
});

describe('cut-list compatibility with optional authored bend inputs', () => {
  it('keeps the entire stock list and exported CSV identical when the recipe is absent', async () => {
    const placed = await placeBend();
    const before = await exportedRows();
    const state = useAppStore.getState();
    const component = state.assembly?.components[0];
    if (state.assembly === null || component?.source.kind !== 'part') throw new Error('Missing placed bend');
    expect(placed.solids.some(feature => feature.kind === 'sweep' && feature.steelBend !== undefined)).toBe(true);
    const legacy: PartDocument = { ...placed, solids: placed.solids.map(feature => {
      if (feature.kind !== 'sweep') return feature;
      const sweep = { ...feature };
      delete sweep.steelBend;
      return sweep;
    }) };
    const parts = new Map(state.assemblyLibrary.parts);
    parts.set(component.source.partRef, legacy);
    const current = buildSteelStockList(state.assembly, state.assemblyLibrary.assemblies, state.assemblyLibrary.parts);
    const old = buildSteelStockList(state.assembly, state.assemblyLibrary.assemblies, parts);
    expect(current.rows).toHaveLength(1);
    expect(current.rows[0].finishedLengthMm).toBe(386.3937979737193);
    expect(old).toEqual(current);
    expect(csvRows(serializeSteelStockCsv(old))).toEqual(before);
    expect(state.assemblyLibrary.parts.get(component.source.partRef)).toEqual(placed);
  });
});
