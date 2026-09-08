import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readDocumentBundle, writeDocumentBundle } from '@pointercad/io';
import {
  addComponent, createAssemblyDocument, createAssemblyDocumentBundle, createComponentFor,
  createEmptyPartDocument, embedPart, EMPTY_PART_LIBRARY, emptyEmbeddedPartAttachments,
  moveComponent, replacePartDocument, resolveAssembly, resolvePart, WORK_PLANES,
} from '@pointercad/model';
import { expressionValueFromNumber } from '@pointercad/expression';
import { resetTestStore } from '../store/testing/createTestStore.js';
import { activeDocument, activeFileName } from '../store/documentKind.js';
import { useAppStore } from '../store/useAppStore.js';
import { activeHasUnsavedChanges, newAssembly, openAssembly, saveAssembly } from './assemblyFile.js';
import { newPart, openPart, savePart, windowTitle, type PartFileDeps } from './partFile.js';
import { type FileGateway, type PickedFile } from './fileGateway.js';
import { beginComponentDrag, finishComponentDrag, moveComponentDrag } from '../assembly/dragComponentActions.js';

beforeEach(resetTestStore);

const deps: PartFileDeps = { captureThumbnail: () => null, confirmDiscard: () => Promise.resolve(true), recentFilesStorage: null };

function gateway() {
  let saved: PickedFile | null = null;
  let target = false;
  const confirmSaveTarget = vi.fn<NonNullable<FileGateway['confirmSaveTarget']>>(() => {
    expect(useAppStore.getState().assembly).not.toBeNull();
    target = true;
    return Promise.resolve();
  });
  const clearSaveTarget = vi.fn(() => { target = false; });
  const savePcad = vi.fn<FileGateway['savePcad']>((name, bytes) => {
    saved = { name, bytes, saveTargetToken: 'candidate' };
    target = true;
    return Promise.resolve(name);
  });
  const openPcad = vi.fn<FileGateway['openPcad']>(() => Promise.resolve(saved));
  const value: FileGateway = { savePcad, openPcad, hasSaveTarget: () => target, confirmSaveTarget, clearSaveTarget };
  useAppStore.setState({ fileGateway: value });
  return { saved: () => saved, savePcad, openPcad, confirmSaveTarget, clearSaveTarget };
}

async function fixture() {
  const attachments = { ...emptyEmbeddedPartAttachments(),
    shapes: new Map([['shape', Uint8Array.of(1, 2, 3)]]),
    meshes: new Map([['mesh', { positions: Float32Array.of(0, 0, 0, 1, 0, 0, 0, 1, 0),
      normals: Float32Array.of(0, 0, 1, 0, 0, 1, 0, 0, 1), indices: Uint32Array.of(0, 1, 2) }]]),
    canvases: new Map([['image', Uint8Array.of(4, 5, 6)]]),
  };
  const embedded = await embedPart(EMPTY_PART_LIBRARY, createEmptyPartDocument(), 'a.pcad', './a.pcad', { attachments });
  const empty = createAssemblyDocument('assembly');
  const document = addComponent(empty, createComponentFor(empty, { kind: 'part', partRef: embedded.partRef }));
  useAppStore.getState().openAssembly(empty);
  useAppStore.getState().applyAssembly(document, embedded.library);
  return { ...embedded, document, attachments };
}

describe('アセンブリの文書ファイル', () => {
  it('配置→変更→Undo→保存→開き直し→部品更新が成立し、3種類の添付を保持する', async () => {
    const g = gateway();
    const f = await fixture();
    useAppStore.getState().applyAssembly(moveComponent(f.document, f.document.components[0].id, {
      position: [expressionValueFromNumber(30), expressionValueFromNumber(0), expressionValueFromNumber(0)], rotation: [0, 0, 0, 1],
    }));
    useAppStore.getState().undo();
    expect(useAppStore.getState().assembly).toBe(f.document);
    await savePart(deps, false);
    expect(g.savePcad.mock.calls[0][3]).toBe('assembly');
    expect(activeHasUnsavedChanges(useAppStore.getState())).toBe(false);
    await openPart(deps);
    expect(g.confirmSaveTarget).toHaveBeenCalledExactlyOnceWith('candidate');
    expect(useAppStore.getState().assembly).toEqual(f.document);
    expect(useAppStore.getState().assemblyLibrary.attachments.get(f.partRef)).toEqual({ ...f.attachments,
      shapeDigests: new Map([['shape', '039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81']]) });
    const state = useAppStore.getState();
    const updated = await replacePartDocument(state.assemblyLibrary, f.partRef, { ...createEmptyPartDocument(), name: 'updated' });
    state.applyAssembly(f.document, updated);
    expect(activeHasUnsavedChanges(useAppStore.getState())).toBe(true);
    useAppStore.getState().undo();
    expect(activeHasUnsavedChanges(useAppStore.getState())).toBe(false);
  });

  it('実dragの確定配置だけを桁落ちなく保存し、一時状態を開き直さない', async () => {
    const g = gateway();
    const f = await fixture();
    const document = addComponent(f.document,
      createComponentFor(f.document, { kind: 'part', partRef: f.partRef }));
    useAppStore.getState().applyAssembly(document, f.library);
    const part = f.library.parts.get(f.partRef);
    if (part === undefined) throw new Error('embedded part required');
    const resolved = resolveAssembly(document, {
      library: f.library,
      resolvedParts: new Map([[f.partRef, resolvePart(part)]]),
    });
    useAppStore.setState({
      assemblyView: { sourceDocument: document, resolved, bodies: new Map(),
        appearances: new Map(), diagnosis: null, mateTargetErrors: new Map() },
      isComputing: false,
      selectionKind: 'body',
    });
    const id = document.components[1].id;
    const origin = resolved.placements.get(id)?.position;
    if (origin === undefined) throw new Error('component placement required');
    const target = 1.2345678901234567;
    const point: [number, number, number] = [origin[0] + target, origin[1], origin[2]];
    expect(beginComponentDrag(id, { ...WORK_PLANES.xy, origin }, origin)).toBe(true);
    expect(moveComponentDrag(point)?.hardSatisfied).toBe(true);
    expect(useAppStore.getState().assembly).toBe(document);
    expect(finishComponentDrag(point)).toBe(true);
    const committed = useAppStore.getState().assembly;
    const committedValue = committed?.components[1].placement.position[0].value;
    if (committedValue === undefined) throw new Error('committed placement required');
    expect(Math.abs(committedValue - point[0])).toBeLessThan(1e-9);
    expect(committedValue).not.toBe(Number(committedValue.toFixed(12)));
    expect(useAppStore.getState().assemblyDrag).toBeNull();

    await saveAssembly(deps, false);
    const saved = g.saved();
    if (saved === null) throw new Error('saved assembly required');
    const decoded = await readDocumentBundle(saved.bytes, 'assembly');
    if (!decoded.ok || decoded.bundle.kind !== 'assembly') throw new Error('assembly bundle required');
    expect(decoded.bundle.document.components[1].placement.position[0].value).toBe(committedValue);
    expect(Object.hasOwn(decoded.bundle.document, 'assemblyDrag')).toBe(false);

    await openAssembly(deps);
    const reopened = useAppStore.getState();
    expect(reopened.assembly?.components[1].placement.position[0].value).toBe(committedValue);
    expect(reopened.assemblyDrag).toBeNull();
    expect(reopened.assemblyDragOverlay).toBeNull();
  });

  it('Undo/Redo が参照する旧添付を保持する', async () => {
    gateway();
    const f = await fixture();
    const next = await replacePartDocument(f.library, f.partRef, createEmptyPartDocument(), {
      attachments: { ...f.attachments, shapes: new Map([['shape', Uint8Array.of(9)]]) },
    });
    useAppStore.getState().applyAssembly(f.document, next);
    useAppStore.getState().undo();
    expect(useAppStore.getState().assemblyLibrary.attachments.get(f.partRef)).toBe(f.attachments);
    useAppStore.getState().redo();
    expect(useAppStore.getState().assemblyLibrary).toBe(next);
  });

  it('dirty とタイトルは裏の part を参照しない', async () => {
    gateway();
    await fixture();
    useAppStore.setState({ fileName: 'hidden.pcad', savedDocument: useAppStore.getState().document });
    expect(activeHasUnsavedChanges(useAppStore.getState())).toBe(true);
    await saveAssembly(deps, false);
    const state = useAppStore.getState();
    expect(activeFileName(state)).toBe('assembly.pcada');
    expect(windowTitle(activeFileName(state), activeHasUnsavedChanges(state))).toContain('assembly.pcada');
    expect(state.fileName).toBe('hidden.pcad');
  });

  it('壊れた .pcada を開いても今の文書も保存先も変更しない', async () => {
    const g = gateway();
    const f = await fixture();
    await saveAssembly(deps, false);
    const clears = g.clearSaveTarget.mock.calls.length;
    g.openPcad.mockResolvedValue({ name: 'broken.pcada', bytes: Uint8Array.of(0), saveTargetToken: 'bad' });
    await openAssembly(deps);
    expect(useAppStore.getState().assembly).toBe(f.document);
    expect(g.confirmSaveTarget).not.toHaveBeenCalled();
    expect(g.clearSaveTarget).toHaveBeenCalledTimes(clears);
    expect(useAppStore.getState().fileMessage?.failed).toBe(true);
  });

  it('新規は履歴と保存先を消し、documentId も新しくする', async () => {
    const g = gateway();
    await fixture();
    const identity = activeDocument(useAppStore.getState()).documentId;
    await newPart(deps);
    expect(useAppStore.getState().assembly?.components).toEqual([]);
    expect(useAppStore.getState().canUndo).toBe(false);
    expect(activeDocument(useAppStore.getState()).documentId).not.toBe(identity);
    expect(activeHasUnsavedChanges(useAppStore.getState())).toBe(false);
    expect(g.clearSaveTarget).toHaveBeenCalled();
  });

  it('未保存確認を断れば新規にしない', async () => {
    gateway();
    const f = await fixture();
    await newAssembly({ ...deps, confirmDiscard: () => Promise.resolve(false) });
    expect(useAppStore.getState().assembly).toBe(f.document);
  });

  it('保存取消では dirty を消さない', async () => {
    const g = gateway();
    await fixture();
    g.savePcad.mockResolvedValue(null);
    await saveAssembly(deps, true);
    expect(activeHasUnsavedChanges(useAppStore.getState())).toBe(true);
    expect(useAppStore.getState().savedAssembly).toBeNull();
  });

  it('保存後に再度保存しても添付のバイト列を落とさない', async () => {
    const g = gateway();
    const f = await fixture();
    await saveAssembly(deps, false);
    await openAssembly(deps);
    await saveAssembly(deps, false);
    const saved = g.saved();
    expect(saved).not.toBeNull();
    if (saved === null) throw new Error('saved file required');
    const read = await readDocumentBundle(saved.bytes, 'assembly');
    expect(read.ok).toBe(true);
    if (!read.ok || read.bundle.kind !== 'assembly') throw new Error('assembly required');
    expect(read.bundle.embeddedDocuments.get(f.partRef)?.attachments).toEqual({ ...f.attachments,
      shapeDigests: new Map([['shape', '039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81']]) });
  });

  it('part から一般の開くで .pcada を選べる', async () => {
    const g = gateway();
    const document = createAssemblyDocument('opened');
    g.openPcad.mockResolvedValue({ name: 'opened.pcada', saveTargetToken: 'candidate',
      bytes: await writeDocumentBundle(createAssemblyDocumentBundle(document)) });
    await openPart(deps);
    expect(g.openPcad).toHaveBeenCalledExactlyOnceWith('all');
    expect(activeDocument(useAppStore.getState()).kind).toBe('assembly');
    expect(activeFileName(useAppStore.getState())).toBe('opened.pcada');
  });
});
