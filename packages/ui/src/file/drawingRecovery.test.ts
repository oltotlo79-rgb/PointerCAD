import { createAutoSaver, createMemoryAutoSaveStorage, readDrawingBundle, type AutoSaveRecord, type AutoSaveStorage } from '@pointercad/io';
import { createDrawingDocument, createEmptyPartDocument, embedDrawingSource, emptyDrawingSourceLibrary,
  type DrawingDocument, type GdtFeature, type ToleranceCharacteristic } from '@pointercad/model';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetTestStore } from '../store/testing/createTestStore.js';
import { useAppStore } from '../store/useAppStore.js';
import { activeHasUnsavedChanges } from './assemblyFile.js';
import { attachAutoSave, exportAutoSave, loadAutoSavePrompt, restoreAutoSave, startAutoSave } from './attachAutoSave.js';
import { savePart, type PartFileDeps } from './partFile.js';

const cleanup: (() => void)[] = [];
beforeEach(resetTestStore);
afterEach(() => { for (const stop of cleanup.splice(0)) stop(); });
const deps: PartFileDeps = { captureThumbnail: () => null, confirmDiscard: () => Promise.resolve(true), recentFilesStorage: null };
const kinds: readonly ToleranceCharacteristic[] = ['straightness', 'flatness', 'roundness', 'cylindricity', 'lineProfile', 'surfaceProfile',
  'parallelism', 'perpendicularity', 'angularity', 'position', 'coaxiality', 'symmetry', 'circularRunout', 'totalRunout'];

async function fixture() {
  const source = { sourceKind: 'part' as const, document: createEmptyPartDocument() };
  const embedded = await embedDrawingSource(emptyDrawingSourceLibrary(), source, '原本.pcad', '');
  // 元面が消失した状態も保存対象。解決不能の参照を救済時に消してはいけない。
  const feature: GdtFeature = { kind: 'surface', target: { kind: 'subShape', viewId: 'view-1', sourceRef: embedded.source.sourceRef,
    ref: { bodyFeatureId: 'missing-face', index: 0, fingerprint: { kind: 'face', surfaceKind: 'plane', area: 10,
      position: [0, 0, 0], axis: [0, 0, 1], radius: null } } } };
  const document: DrawingDocument = { ...createDrawingDocument('復元する製作図', embedded.source),
    datums: [{ id: 'datum-a', label: 'A', feature, position: [20, 30], height: 3.5, layerId: 'layer-5' }],
    gdtFrames: kinds.map((characteristic, index) => ({ id: `gdt-${index + 1}`, feature, position: [40, index * 10], height: 3.5, layerId: 'layer-5',
      segments: [{ characteristic, zone: 'betweenPlanes', material: 'none', datums: [{ kind: 'single', member: { datumId: 'datum-a', material: 'none' } }],
        basicDimensionIds: [], tolerance: { expression: { source: '0.1/2', value: 0.05, display: '0.05' }, unit: 'mm' } }] })),
    weldSymbols: [{ id: 'weld-1', system: 'B', target: feature.target, sides: [{ kind: 'fillet', side: 'arrow',
      size: { kind: 'leg', value: { expression: { source: '4+2', value: 6, display: '6' }, unit: 'mm' } }, contour: 'none', finish: 'none' }],
      allAround: true, fieldWeld: true, tail: 'WPS-01', position: [90, 30], height: 3.5, layerId: 'layer-5' }],
  };
  useAppStore.getState().openDrawing(document, { sources: embedded.library });
  return { document, source, library: embedded.library };
}

function start(storage: AutoSaveStorage, sessionId = 'new-window') {
  const stop = startAutoSave({ storage, sessionId }); cleanup.push(stop);
  const saver = useAppStore.getState().autoSaver; if (saver === null) throw new Error('図面の自動保存が接続されていない');
  return saver;
}

describe('製作指示を含む図面の自動保存・異常終了からの復元(P9-18)', () => {
  it.each(['datums', 'gdtFrames', 'weldSymbols'] as const)('%sだけが残る図面も未保存として保持する', async (field) => {
    const f = await fixture();
    const document = { ...f.document, datums: [], gdtFrames: [], weldSymbols: [], [field]: f.document[field] };
    useAppStore.getState().openDrawing(document, { sources: f.library });
    expect(activeHasUnsavedChanges(useAppStore.getState())).toBe(true);
  });
  it('実pcaddの控えに全14公差・失われた参照・溶接・元部品を保持し、起動時に別種の文書から復元する', async () => {
    const f = await fixture(), storage = createMemoryAutoSaveStorage();
    const original = createAutoSaver({ storage, kind: 'drawing', documentId: 'drawing-id', sessionId: 'old-window' }); cleanup.push(() => original.stop());
    await original.saveNow({ kind: 'drawing', document: f.document, source: f.source });
    const record = (await storage.listRecords())[0];
    expect(record.kind).toBe('drawing');
    expect(await readDrawingBundle(record.bytes)).toMatchObject({ ok: true, document: f.document, source: f.source });
    useAppStore.getState().closeDrawing();
    const saver = start(storage);
    await vi.waitFor(() => expect(useAppStore.getState().restorePrompt?.documentName).toBe(f.document.name));
    await restoreAutoSave(saver);
    expect(useAppStore.getState().drawing).toEqual(f.document);
    expect(useAppStore.getState().drawingSources.sources[0].document).toEqual(f.source.document);
    expect(activeHasUnsavedChanges(useAppStore.getState())).toBe(true);
    expect(await storage.listRecords()).toHaveLength(1);
    const savePcad = vi.fn().mockRejectedValueOnce(new Error('disk full')).mockResolvedValue('復元図面.pcadd');
    useAppStore.setState({ fileGateway: { ...useAppStore.getState().fileGateway, savePcad, hasSaveTarget: () => false } });
    await savePart(deps, false);
    expect(activeHasUnsavedChanges(useAppStore.getState())).toBe(true);
    expect(useAppStore.getState().drawing).toEqual(f.document);
    expect(await storage.listRecords()).toHaveLength(1);
    await savePart(deps, false);
    expect(activeHasUnsavedChanges(useAppStore.getState())).toBe(false);
    expect(await storage.listRecords()).toHaveLength(0);
  });

  it('画面が隠れると図面の最新変更と参照元を控えへ書き、書込失敗後も再試行できる', async () => {
    const f = await fixture(), storage = createMemoryAutoSaveStorage();
    const write = vi.fn((record: AutoSaveRecord) => storage.write(record)).mockRejectedValueOnce(new Error('quota'));
    const saver = createAutoSaver({ storage: { ...storage, write }, kind: 'drawing', documentId: 'd', sessionId: 's' });
    let onHidden: () => void = () => { throw new Error('visibility handler missing'); };
    cleanup.push(attachAutoSave({ saver, visibility: { visibilityState: 'hidden',
      addEventListener: (_type, callback) => { onHidden = callback; }, removeEventListener: () => {} } }));
    const changed = { ...f.document, name: '変更後' }; useAppStore.getState().applyDrawing(changed);
    onHidden(); await saver.saveNow({ kind: 'drawing', document: changed, source: f.source });
    expect(write).toHaveBeenCalledTimes(1);
    expect(await storage.listRecords()).toHaveLength(0);
    await saver.saveNow({ kind: 'drawing', document: changed, source: f.source });
    const record = (await storage.listRecords())[0];
    expect(await readDrawingBundle(record.bytes)).toMatchObject({ ok: true, document: changed });
  });

  it('壊れた控えは図面拡張子のまま書き出せ、破損の案内が現在の図面を置換しない', async () => {
    const f = await fixture(), storage = createMemoryAutoSaveStorage();
    const record: AutoSaveRecord = { kind: 'drawing', documentId: 'd', sessionId: 's', savedAt: '2026-09-10T00:00:00Z',
      documentName: '壊れた製作図', bytes: Uint8Array.of(0) };
    await storage.write(record);
    const saver = createAutoSaver({ storage, kind: 'drawing', documentId: 'd', sessionId: 's' }); cleanup.push(() => saver.stop());
    await loadAutoSavePrompt(saver); expect(useAppStore.getState().restorePrompt?.unrecoverable).toBe(true);
    await restoreAutoSave(saver); expect(useAppStore.getState().drawing).toBe(f.document);
    const saveFileAs = vi.fn().mockResolvedValue(true); useAppStore.setState({ fileGateway: { ...useAppStore.getState().fileGateway, saveFileAs } });
    await exportAutoSave(saver); expect(saveFileAs).toHaveBeenCalledWith('壊れた製作図.pcadd', 'pcadd', record.bytes);
    expect(await storage.listRecords()).toHaveLength(1);
  });

  it('控えの読込を待つ間に新規図面へ切り替えたら古い復元結果を適用しない', async () => {
    const f = await fixture(), storage = createMemoryAutoSaveStorage();
    const original = createAutoSaver({ storage, kind: 'drawing', documentId: 'old', sessionId: 's' }); cleanup.push(() => original.stop());
    await original.saveNow({ kind: 'drawing', document: f.document, source: f.source });
    const record = (await storage.listRecords())[0];
    let resolve: (value: AutoSaveRecord) => void = () => { throw new Error('not ready'); };
    const saver = { ...original, readLatest: () => new Promise<AutoSaveRecord>((callback) => { resolve = callback; }) };
    const restoring = restoreAutoSave(saver); const next = await fixture(); resolve(record); await restoring;
    expect(useAppStore.getState().drawing).toBe(next.document);
  });
});
