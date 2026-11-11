import { createAssemblyDocument, createDrawingDocument, createEmptyPartDocument, createUndoStack,
  embedDrawingSource, embedPart, emptyDrawingSourceLibrary, EMPTY_PART_LIBRARY, UNDO_LIMIT, type PartDocument } from '@pointercad/model';
import { emptyPcadAttachments, encodeSaveDocument, readPcadFile } from '@pointercad/io';
import { beforeEach, describe, expect, it } from 'vitest';
import { partAssetRetention } from './partAssetRetention.js';
import { resetTestStore } from './testing/createTestStore.js';
import { useAppStore } from './useAppStore.js';
import { captureSaveSnapshot, copySaveSnapshot } from '../file/pcadSaveSnapshot.js';
import { currentPcadAttachments } from './attachKernel.js';
import { documentPatch } from './documentDerived.js';

beforeEach(resetTestStore);

function documentWith(ref: string): PartDocument {
  return { ...createEmptyPartDocument(), solids: [
    { kind: 'importedSolid', id: 'solid-1', name: ref, shapeRef: ref, suppressed: true, bodyKind: 'solid',
      source: { format: 'step', fileName: 'shape.step', unit: 'mm', byteLength: 2 } },
    { kind: 'importedMesh', id: 'mesh-1', name: ref, meshRef: ref, suppressed: true, triangleCount: 1,
      source: { format: 'stl', fileName: 'mesh.stl', unit: 'mm', byteLength: 84 } },
  ] };
}
function meshFor(value: number) {
  return { positions: Float32Array.of(value, 0, 0, value + 1, 0, 0, value, 1, 0),
    normals: Float32Array.of(0, 0, 1, 0, 0, 1, 0, 0, 1), indices: Uint32Array.of(0, 1, 2) };
}
function addPair(ref: string, value: number): void {
  const state = useAppStore.getState();
  state.addImportedAttachments(new Map([[ref, Uint8Array.of(value, 255 - value)]]), new Map([[ref, meshFor(value)]]));
  state.applyDocument(documentWith(ref));
}
function expectPool(count: number): void {
  const state = useAppStore.getState();
  expect(state.importedShapes.size).toBe(count); expect(state.importedMeshes.size).toBe(count);
  expect([...state.importedShapes.values()].reduce((sum, bytes) => sum + bytes.byteLength, 0)).toBe(count * 2);
  expect([...state.importedMeshes.values()].reduce((sum, mesh) => sum + mesh.positions.byteLength
    + mesh.normals.byteLength + mesh.indices.byteLength, 0)).toBe(count * 84);
  for (const document of [state.document, ...state.undoStack.past, state.undoStack.present, ...state.undoStack.future]) {
    for (const feature of document.solids) {
      if (feature.kind === 'importedSolid') expect(state.importedShapes.has(feature.shapeRef)).toBe(true);
      if (feature.kind === 'importedMesh') expect(state.importedMeshes.has(feature.meshRef)).toBe(true);
    }
  }
}

describe('BRep/meshの全履歴所有と回収', () => {
  it('進行中保存が捕捉した旧Mapを回収で変更せず、全原本を実ZIPへ保存する', async () => {
    addPair('saved', 1); const before = useAppStore.getState();
    const attachments = currentPcadAttachments(before.document);
    const snapshot = captureSaveSnapshot({ kind: 'part', document: before.document, options: { attachments } });
    const copying = copySaveSnapshot(snapshot);
    before.applyDocument({ ...before.document, solids: [] });
    for (let edit = 0; edit < UNDO_LIMIT; edit++) {
      const state = useAppStore.getState(); state.applyDocument({ ...state.document, name: `later-${edit}` });
    }
    expectPool(0);
    expect(attachments.shapes.get('saved')).toBe(before.importedShapes.get('saved'));
    expect(attachments.meshes.get('saved')).toBe(before.importedMeshes.get('saved'));
    const owned = await copying, saved = readPcadFile(await encodeSaveDocument(owned.input));
    if (!saved.ok) throw new Error('Captured save could not be read');
    expect(saved.document.solids).toEqual(before.document.solids);
    expect(saved.attachments.shapes).toEqual(attachments.shapes); expect(saved.attachments.meshes).toEqual(attachments.meshes);
    expect(before.importedShapes.get('saved')).toEqual(Uint8Array.of(1, 254));
    expect(before.importedMeshes.get('saved')).toEqual(meshFor(1));
  });

  it.each(['assembly', 'drawing'] as const)('%sの複数所有者の同refを仮partで消さず統合しない', async mode => {
    const first = { ...documentWith('shared'), name: 'A' }, second = { ...documentWith('shared'), name: 'B' };
    const assetsA = { ...emptyPcadAttachments(), shapes: new Map([['shared', Uint8Array.of(1, 2)]]), meshes: new Map([['shared', meshFor(1)]]) };
    const assetsB = { ...emptyPcadAttachments(), shapes: new Map([['shared', Uint8Array.of(3, 4)]]), meshes: new Map([['shared', meshFor(2)]]) };
    const partA = await embedPart(EMPTY_PART_LIBRARY, first, 'A.pcad', '', { attachments: assetsA });
    const partB = await embedPart(partA.library, second, 'B.pcad', '', { attachments: assetsB });
    const sourceA = await embedDrawingSource(emptyDrawingSourceLibrary(), { sourceKind: 'part', document: first, attachments: assetsA }, 'A.pcad', '');
    const sourceB = await embedDrawingSource(sourceA.library, { sourceKind: 'part', document: second, attachments: assetsB }, 'B.pcad', '');
    const store = useAppStore.getState();
    if (mode === 'assembly') store.openAssembly(createAssemblyDocument('assembly'), partB.library);
    else store.openDrawing(createDrawingDocument('drawing', sourceA.source), { sources: sourceB.library });
    store.setImportedAttachments(assetsB.shapes, assetsB.meshes);
    const before = useAppStore.getState(), placeholder = createEmptyPartDocument();
    const patch = documentPatch(before, placeholder, before.undoStack);
    expect(patch.importedShapes).toBe(assetsB.shapes); expect(patch.importedMeshes).toBe(assetsB.meshes);
    store.applyDocument(second, { replacesDocument: true });
    expect(useAppStore.getState().importedShapes).toBe(assetsB.shapes);
    expect(useAppStore.getState().importedMeshes).toBe(assetsB.meshes);
    expect(partB.library.attachments.get(partA.partRef)).toBe(assetsA);
    expect(partB.library.attachments.get(partB.partRef)).toBe(assetsB);
    expect(sourceB.library.sources.map(source => source.attachments)).toEqual([assetsA, assetsB]);
    expect(assetsA.shapes.get('shared')).toEqual(Uint8Array.of(1, 2)); expect(assetsA.meshes.get('shared')).toEqual(meshFor(1));
    expect(assetsB.shapes.get('shared')).toEqual(Uint8Array.of(3, 4)); expect(assetsB.meshes.get('shared')).toEqual(meshFor(2));
  });

  it('追加→削除→Undo→Redoを100cycle行い、実UNDO_LIMIT超過で必要なくなった原本だけを回収する', () => {
    for (let cycle = 1; cycle <= 100; cycle++) {
      addPair(`asset-${cycle}`, cycle); expectPool(cycle);
      const added = useAppStore.getState(), shape = added.importedShapes.get(`asset-${cycle}`), mesh = added.importedMeshes.get(`asset-${cycle}`);
      added.applyDocument({ ...added.document, solids: [] }); expectPool(cycle);
      added.undo(); expectPool(cycle);
      expect(useAppStore.getState().importedShapes.get(`asset-${cycle}`)).toBe(shape);
      expect(useAppStore.getState().importedMeshes.get(`asset-${cycle}`)).toBe(mesh);
      added.redo(); expectPool(cycle);
      expect(useAppStore.getState().undoStack.past).toHaveLength(cycle * 2);
    }
    const captured = useAppStore.getState();
    expect(captured.undoStack.past).toHaveLength(UNDO_LIMIT);
    for (let edit = 1; edit <= UNDO_LIMIT; edit++) {
      const state = useAppStore.getState(); state.applyDocument({ ...state.document, name: `later-${edit}` });
      expectPool(100 - Math.floor(edit / 2));
    }
    expectPool(0); expect(captured.importedShapes.size).toBe(100); expect(captured.importedMeshes.size).toBe(100);
    expect(captured.importedShapes.get('asset-1')).toEqual(Uint8Array.of(1, 254));
    expect(captured.importedMeshes.get('asset-100')).toEqual(meshFor(100));
  });

  it('未来だけの原本をRedoまで保ち、新分岐でのみ捨てる', () => {
    addPair('A', 1); const store = useAppStore.getState();
    store.applyDocument({ ...store.document, solids: [] }); addPair('B', 2);
    store.undo(); expectPool(2); store.redo(); expectPool(2); store.undo();
    const captured = useAppStore.getState(); addPair('C', 3); expectPool(2);
    expect([...useAppStore.getState().importedShapes.keys()]).toEqual(['A', 'C']);
    expect([...useAppStore.getState().importedMeshes.keys()]).toEqual(['A', 'C']);
    expect(captured.importedShapes.get('B')).toEqual(Uint8Array.of(2, 253));
    expect(captured.importedMeshes.get('B')).toEqual(meshFor(2));
    store.undo(); store.undo(); expect(useAppStore.getState().document.solids).toEqual(documentWith('A').solids);
    expectPool(2);
  });

  it('空poolでは履歴を読まず、回収が無ければ同じ各Mapを保つ', () => {
    const empty = createEmptyPartDocument(), state = useAppStore.getState();
    const stack = { ...createUndoStack(empty), get past(): readonly PartDocument[] { throw new Error('No assets to inspect'); } };
    const result = partAssetRetention(state, empty, stack, false);
    expect(result.importedShapes).toBe(state.importedShapes); expect(result.importedMeshes).toBe(state.importedMeshes);
    addPair('kept', 1); const current = useAppStore.getState();
    const unchanged = partAssetRetention(current, current.document, current.undoStack, false);
    expect(unchanged.importedShapes).toBe(current.importedShapes); expect(unchanged.importedMeshes).toBe(current.importedMeshes);
  });
});
