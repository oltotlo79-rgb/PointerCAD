import { expressionValueFromNumber } from '@pointercad/expression';
import { readDocumentBundle, writeDocumentBundle } from '@pointercad/io';
import {
  absoluteCoordinate, addComponent, appendFeature, replaceSketch, createAssemblyDocument, createAssemblyDocumentBundle, createComponentFor,
  createEmptyPartDocument, embedPart, EMPTY_PART_LIBRARY, emptyEmbeddedPartAttachments, type PartDocument,
} from '@pointercad/model';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { applyNumericTransition } from '../sketch/commitToStore.js';
import { createNumericInput } from '../sketch/numericInput.js';
import { newSketchCanvas } from '../file/canvasFile.js';
import { activeDocument, activePartDocument } from './documentKind.js';
import { prepareDocumentEdit } from './documentDerived.js';
import { assemblyBackgroundLibrary, assemblyCalculation, assemblyCalculationPatch } from './partEditActions.js';
import { resetTestStore } from './testing/createTestStore.js';
import { useAppStore } from './useAppStore.js';

beforeEach(resetTestStore);

async function fixture(part = createEmptyPartDocument(), attachments = emptyEmbeddedPartAttachments()) {
  const importedAt = '2026-11-21T00:00:00.000Z';
  const embedded = await embedPart(EMPTY_PART_LIBRARY, part, 'part.pcad', './part.pcad', { importedAt, attachments });
  const base = createAssemblyDocument('assembly');
  const component = createComponentFor(base, { kind: 'part', partRef: embedded.partRef });
  const assembly = addComponent(base, component);
  useAppStore.getState().openAssembly(assembly, embedded.library);
  return { part, assembly, component, embedded, importedAt };
}

function importedPart() {
  const canvas = { ...newSketchCanvas([], 'xy', 'image.png', { width: 2, height: 1 }, 'canvas-1'), visible: false };
  const part: PartDocument = { ...createEmptyPartDocument(), solids: [
    { kind: 'importedSolid', id: 'importedSolid-1', name: 'shape', shapeRef: 'shape', suppressed: true, bodyKind: 'solid',
      source: { format: 'step', fileName: 'shape.step', unit: 'mm', byteLength: 3 } },
    { kind: 'importedMesh', id: 'importedMesh-1', name: 'mesh', meshRef: 'mesh', suppressed: true, triangleCount: 1,
      source: { format: 'stl', fileName: 'mesh.stl', unit: 'mm', byteLength: 84 } },
  ], canvases: [canvas] };
  const attachments = {
    shapes: new Map([['shape', Uint8Array.of(1, 2, 3)], ['extra', Uint8Array.of(4, 5)]]),
    meshes: new Map([['mesh', { positions: Float32Array.of(0, 0, 0, 1, 0, 0, 0, 1, 0),
      normals: Float32Array.of(0, 0, 1, 0, 0, 1, 0, 0, 1), indices: Uint32Array.of(0, 1, 2) }]]),
    canvases: new Map([[canvas.imageId, Uint8Array.of(6, 7, 8)]]),
  };
  return { part, canvas, attachments };
}

function capture(id: string) {
  const result = useAppStore.getState().captureEditableAssemblyPart(id);
  if (!result.ok) throw new Error(result.reason);
  return result.target;
}

describe('組立内の部品編集が親の所有権を守る', () => {
  it('入退場は履歴0で、編集中の確定とUndo・Redoの保存先は親のまま', async () => {
    const { part, component, embedded, assembly } = await fixture();
    const parent = useAppStore.getState();
    expect(parent.beginAssemblyPartEdit(component.id)).toBe(true);
    const editing = useAppStore.getState();
    expect(activePartDocument(editing)).toBe(part);
    expect(editing.assemblyUndoStack).toBe(parent.assemblyUndoStack);
    const updated = { ...part, name: 'work in assembly' };
    const placement = prepareDocumentEdit(editing, updated, false);
    const pending = editing.commitAssemblyPartPlacement(placement);
    expect(editing.commitAssemblyPartPlacement(placement)).toBe(pending);
    expect(activeDocument(useAppStore.getState())).toMatchObject({ kind: 'assembly', document: assembly, library: embedded.library });
    expect(await pending).toBe('applied');
    const committed = useAppStore.getState();
    expect(committed.document).toBe(updated);
    expect(assemblyBackgroundLibrary(committed)).toBe(embedded.library);
    expect(committed.assemblyUndoStack?.past).toHaveLength(1);
    committed.undo();
    expect(useAppStore.getState().document).toBe(part);
    committed.redo();
    expect(useAppStore.getState().document).toBe(updated);
    committed.endAssemblyPartEdit();
    const exited = useAppStore.getState();
    expect(exited.document).toBe(parent.document);
    expect(exited.undoStack).toBe(parent.undoStack);
    expect(exited.selection).toEqual([component.id]);
    expect(exited.assemblyUndoStack?.past).toHaveLength(1);
    expect(activeDocument(exited)).toMatchObject({ kind: 'assembly', document: assembly, library: committed.assemblyLibrary });
  });

  it('親子の応答を別の欄に置き、退出後に同じ部品を開き直しても以前の確定を積まない', async () => {
    const { part, component, embedded } = await fixture();
    const parent = useAppStore.getState();
    expect(parent.beginAssemblyPartEdit(component.id)).toBe(true);
    useAppStore.setState({ requestedGeneration: 12 });
    useAppStore.setState(state => assemblyCalculationPatch(state, { requestedGeneration: 7, completedGeneration: 7, lastOutcome: 'success' }));
    const working = useAppStore.getState();
    expect(working.requestedGeneration).toBe(12);
    expect(assemblyCalculation(working).requestedGeneration).toBe(7);
    const pending = working.commitAssemblyPartPlacement(prepareDocumentEdit(working, { ...part, name: 'late' }, false));
    working.endAssemblyPartEdit();
    expect(useAppStore.getState().requestedGeneration).toBe(7);
    expect(parent.beginAssemblyPartEdit(component.id)).toBe(true);
    expect(await pending).toBe('stale');
    expect(useAppStore.getState().assemblyLibrary).toBe(embedded.library);
    expect(useAppStore.getState().assemblyUndoStack?.past).toHaveLength(0);
  });

  it.each(['reference', 'input'] as const)('取り消した確定がハッシュ待ちでも、新しい確定だけを親が採る (%s)', async (cancel) => {
    const { part, component } = await fixture();
    expect(useAppStore.getState().beginAssemblyPartEdit(component.id)).toBe(true);
    const editing = useAppStore.getState();
    let current = true;
    const old = editing.commitAssemblyPartPlacement(
      prepareDocumentEdit(editing, { ...part, name: 'old' }, false),
      cancel === 'reference' ? { isCurrent: () => current } : undefined,
    );
    if (cancel === 'reference') current = false;
    else editing.cancelRecompute();
    const active = useAppStore.getState();
    const next = active.commitAssemblyPartPlacement(prepareDocumentEdit(active, { ...part, name: 'new' }, false));
    expect(await next).toBe('applied');
    expect(await old).toBe('stale');
    expect(useAppStore.getState().document.name).toBe('new');
    expect(useAppStore.getState().assemblyUndoStack?.past).toHaveLength(1);
  });

  it.each([false, true])('作図の角丸めを親が採用するまで入力と選択を保つ (取消=%s)', async (cancel) => {
    const empty = createEmptyPartDocument();
    const sketch = appendFeature(empty.sketches[0], {
      id: 'rect', name: '矩形', planeId: 'xy', kind: 'rectangle', construction: false,
      corner1: absoluteCoordinate(0, 0, 0), corner2: absoluteCoordinate(40, 30, 0),
    });
    const { component, embedded } = await fixture(replaceSketch(empty, sketch));
    const parent = useAppStore.getState();
    expect(parent.beginAssemblyPartEdit(component.id)).toBe(true);
    const editing = useAppStore.getState();
    editing.setActiveTool('sketchFillet');
    editing.setSelection(['rect#0', 'rect#1']);
    const input = createNumericInput('sketchFillet', 'sketchFilletRadius');
    editing.openNumericInput(input, [0, 0]);
    const completion = vi.spyOn(useAppStore.getState(), 'commitAssemblyPartPlacement');
    applyNumericTransition({ kind: 'editCommitted', state: input, commit: {
      kind: 'edit', tool: 'sketchFillet', step: 'sketchFilletRadius',
      values: { cornerRadius: expressionValueFromNumber(5) }, flags: {}, choices: {},
    } });
    const outcome = completion.mock.results[0];
    if (outcome?.type !== 'return') {
      throw new Error(`Expected commitAssemblyPartPlacement to return, got ${outcome?.type ?? 'no call'}`);
    }
    const pending = outcome.value;
    expect(pending).toBeDefined();
    expect(useAppStore.getState().numericInput).toBe(input);
    expect(useAppStore.getState().selection).toEqual(['rect#0', 'rect#1']);
    expect(useAppStore.getState().assemblyLibrary).toBe(embedded.library);
    if (cancel) applyNumericTransition({ kind: 'cancelled' });
    expect(await pending).toBe(cancel ? 'stale' : 'applied');
    expect(useAppStore.getState().assemblyUndoStack?.past).toHaveLength(cancel ? 0 : 1);
    expect(useAppStore.getState().numericInput).toBeNull();
    completion.mockRestore();
  });

  it('部品単位では収まる原本も、親の ZIP 項目数を超えると確定しない', async () => {
    const { part, assembly, component, embedded } = await fixture();
    const source = await embedPart(embedded.library, { ...part, id: `${part.id}-source` }, 'source.pcad', './source.pcad');
    const first = createComponentFor(assembly, { kind: 'part', partRef: source.partRef });
    const pair = addComponent(assembly, first);
    const second = createComponentFor(pair, { kind: 'part', partRef: source.partRef });
    useAppStore.getState().openAssembly(addComponent(pair, second), source.library);
    const before = useAppStore.getState();
    const bytes = Uint8Array.of(1);
    // Root + two embedded documents + two digests. The two source occurrences share one document entry.
    const shapes = new Map(Array.from({ length: 4092 }, (_, i) => [`shape-${i}`, bytes] as const));
    expect(await before.commitEditedAssemblyPart(capture(component.id), part, { ...emptyEmbeddedPartAttachments(), shapes }))
      .toBe('failed');
    expect(useAppStore.getState().assemblyUndoStack).toBe(before.assemblyUndoStack);
    shapes.delete('shape-4091');
    expect(await before.commitEditedAssemblyPart(capture(component.id), part, { ...emptyEmbeddedPartAttachments(), shapes }))
      .toBe('applied');
    expect(useAppStore.getState().assemblyUndoStack?.past).toHaveLength(1);
  });

  it('原本が欠けるか保存後に読めない添付は、親と履歴を変えずに断る', async () => {
    const { part, canvas, attachments } = importedPart();
    const { component, embedded } = await fixture(part, attachments);
    const before = useAppStore.getState();
    const target = capture(component.id);
    const validMesh = attachments.meshes.get('mesh');
    if (validMesh === undefined) throw new Error('Missing mesh fixture');
    const missingTables = [
      { ...attachments, shapes: new Map([['extra', Uint8Array.of(4, 5)]]) },
      { ...attachments, meshes: new Map<string, never>() },
      { ...attachments, canvases: new Map<string, never>() },
      { ...attachments, shapes: new Map([...attachments.shapes, ['nested/extra', Uint8Array.of(1)]]) },
      { ...attachments, meshes: new Map([['mesh', { ...validMesh, indices: Uint32Array.of(0, 1, 3) }]]) },
    ];
    for (const incomplete of missingTables) {
      expect(await before.commitEditedAssemblyPart(target, part, incomplete)).toBe('failed');
    }
    const newReference = { ...part, canvases: [{ ...canvas, imageId: 'missing' }] };
    expect(await before.commitEditedAssemblyPart(target, newReference)).toBe('failed');
    const after = useAppStore.getState();
    expect(after.assemblyLibrary).toBe(embedded.library);
    expect(after.assemblyUndoStack).toBe(before.assemblyUndoStack);
    expect(after.assemblyUndoStack?.past).toHaveLength(0);
  });

  it('既定で原本を引き継ぎ、更新した非空添付を親のUndo・Redoと保存再読込で保つ', async () => {
    const { part, canvas, attachments } = importedPart();
    const { assembly, component, embedded, importedAt } = await fixture(part, attachments);
    const store = useAppStore.getState();
    const renamed = { ...part, name: 'edited imported part' };
    expect(await store.commitEditedAssemblyPart(capture(component.id), renamed)).toBe('applied');
    const inherited = useAppStore.getState().assemblyLibrary;
    expect(inherited.attachments.get(embedded.partRef)).toBe(attachments);
    const nextAttachments = { ...attachments, canvases: new Map([[canvas.imageId, Uint8Array.of(9, 10)]]) };
    expect(await store.commitEditedAssemblyPart(capture(component.id), renamed, nextAttachments)).toBe('applied');
    const updated = useAppStore.getState();
    expect(updated.assemblyUndoStack?.past).toHaveLength(2);
    updated.undo();
    expect(useAppStore.getState().assemblyLibrary).toBe(inherited);
    updated.undo();
    expect(useAppStore.getState().assemblyLibrary).toBe(embedded.library);
    updated.redo();
    expect(useAppStore.getState().assemblyLibrary).toBe(inherited);
    updated.redo();
    expect(useAppStore.getState().assemblyLibrary).toBe(updated.assemblyLibrary);
    const saved = activeDocument(useAppStore.getState());
    if (saved.kind !== 'assembly') throw new Error('Missing parent');
    const bytes = await writeDocumentBundle(createAssemblyDocumentBundle(saved.document, saved.library));
    const loaded = await readDocumentBundle(bytes, 'assembly');
    if (!loaded.ok || loaded.bundle.kind !== 'assembly') throw new Error('Missing assembly bundle');
    expect(loaded.bundle.document.components).toEqual(assembly.components);
    expect(loaded.bundle.partFiles[0]).toMatchObject({ ref: embedded.partRef, path: './part.pcad', importedAt });
    const reloaded = loaded.bundle.embeddedDocuments.get(embedded.partRef);
    expect(reloaded?.document).toMatchObject({ id: renamed.id, name: renamed.name, solids: renamed.solids, canvases: renamed.canvases });
    expect(reloaded?.attachments).toMatchObject(nextAttachments);
  });

  it('同じ配置と取込時刻を保って部品を1段で置き換え、Undo・Redo・.pcadaの読戻しが同じ一式を使う', async () => {
    const { part, assembly, component, embedded, importedAt } = await fixture();
    const store = useAppStore.getState();
    const target = capture(component.id);
    const renamed = { ...part, name: 'edited' };
    expect(await store.commitEditedAssemblyPart(target, renamed)).toBe('applied');
    const after = useAppStore.getState();
    expect(after.assembly).toBe(assembly);
    expect(after.assemblyUndoStack?.past).toHaveLength(1);
    expect(after.assemblyLibrary.parts.get(embedded.partRef)).toBe(renamed);
    expect(after.assemblyLibrary.attachments.get(embedded.partRef)).toBe(target.attachments);
    expect(after.assemblyLibrary.partFiles[0]?.importedAt).toBe(importedAt);
    expect(after.activeDocumentId).toBe(store.activeDocumentId);
    expect(after.assemblyFileName).toBe(store.assemblyFileName);
    after.undo();
    expect(useAppStore.getState().assemblyLibrary).toBe(embedded.library);
    useAppStore.getState().redo();
    const saved = activeDocument(useAppStore.getState());
    if (saved.kind !== 'assembly') throw new Error('Missing parent');
    const bytes = await writeDocumentBundle(createAssemblyDocumentBundle(saved.document, saved.library));
    const loaded = await readDocumentBundle(bytes, 'assembly');
    if (!loaded.ok || loaded.bundle.kind !== 'assembly') throw new Error('Missing assembly bundle');
    expect(loaded.bundle.document.components).toEqual(assembly.components);
    expect(loaded.bundle.embeddedDocuments.get(embedded.partRef)?.document).toMatchObject({ id: part.id, name: 'edited' });
  });

  it('同じバイトの書込みと、古い入力・競合した書込みで履歴を増やさない', async () => {
    const { part, component } = await fixture();
    const store = useAppStore.getState();
    const target = capture(component.id);
    expect(await store.commitEditedAssemblyPart(target, { ...part })).toBe('unchanged');
    expect(useAppStore.getState().assemblyUndoStack?.past).toHaveLength(0);
    const pending = store.commitEditedAssemblyPart(target, { ...part, name: 'cancelled' });
    store.cancelRecompute();
    expect(await pending).toBe('stale');
    const current = capture(component.id);
    const outcomes = await Promise.all([
      store.commitEditedAssemblyPart(current, { ...part, name: 'first' }),
      store.commitEditedAssemblyPart(current, { ...part, name: 'second' }),
    ]);
    expect(outcomes.sort()).toEqual(['applied', 'stale']);
    expect(useAppStore.getState().assemblyUndoStack?.past).toHaveLength(1);
  });

  it('入力が届く途中の文書切替とハッシュの失敗を親へ積まない', async () => {
    const { part, assembly, component, embedded } = await fixture();
    const before = useAppStore.getState();
    const pending = before.commitEditedAssemblyPart(capture(component.id), { ...part, name: 'late' });
    before.openAssembly(assembly, embedded.library);
    expect(await pending).toBe('stale');
    const target = capture(component.id);
    vi.stubGlobal('crypto', {});
    try {
      expect(await useAppStore.getState().commitEditedAssemblyPart(target, { ...part, name: 'failed' })).toBe('failed');
    } finally {
      vi.unstubAllGlobals();
    }
    expect(useAppStore.getState().assemblyLibrary).toBe(embedded.library);
    expect(useAppStore.getState().assemblyUndoStack?.past).toHaveLength(0);
  });

  it('見えない共有部品と、子組立の欠落で共有数が分からない対象を開かない', async () => {
    const { assembly, component, embedded } = await fixture();
    const store = useAppStore.getState();
    const other = createComponentFor(assembly, component.source);
    store.openAssembly(addComponent(assembly, { ...other, visible: false, suppressed: true }), embedded.library);
    expect(useAppStore.getState().captureEditableAssemblyPart(component.id)).toEqual({ ok: false, reason: 'targetPartShared' });
    const missing = createComponentFor(assembly, { kind: 'subAssembly', assemblyRef: 'missing' });
    store.openAssembly(addComponent(assembly, missing), embedded.library);
    expect(useAppStore.getState().captureEditableAssemblyPart(component.id)).toEqual({ ok: false, reason: 'targetCountUnknown' });
  });
});
