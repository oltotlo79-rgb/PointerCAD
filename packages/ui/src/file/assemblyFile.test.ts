import { writeAssemblyDocument } from '@pointercad/io';
import { startRefreshPartSource } from '../assembly/replaceActions.js';
import { createPartDocumentBundle } from '@pointercad/model';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { encodeSaveDocument, createAutoSaver, createMemoryAutoSaveStorage, readDocumentBundle, writeDocumentBundle } from '@pointercad/io';
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
import { currentPcadAttachments } from '../store/attachKernel.js';
import { newSketchCanvas } from './canvasFile.js';
import { startAutoSave } from './attachAutoSave.js';

beforeEach(() => { resetTestStore(); useAppStore.setState({ saveDocumentEncoder: encodeSaveDocument, documentSaveOperation: null }); });

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
  it('削除した下絵を組立へ同梱せず、部品のUndo後には元画像を同梱する', async () => {
    for (const restore of [false, true]) {
      resetTestStore();
      const g = gateway();
      const canvas = newSketchCanvas([], 'xy', 'A.png', { width: 2, height: 1 }, 'canvas-1');
      const bytes = Uint8Array.of(1, 2, 3);
      useAppStore.getState().addCanvas(canvas, bytes);
      useAppStore.getState().removeCanvas(canvas.id);
      if (restore) useAppStore.getState().undo();
      const embedded = await embedPart(EMPTY_PART_LIBRARY, useAppStore.getState().document, 'a.pcad', '', {
        attachments: currentPcadAttachments(),
      });
      const otherBytes = Uint8Array.of(8, 9);
      const other = await embedPart(embedded.library,
        { ...createEmptyPartDocument(), name: 'Other', canvases: [canvas] }, 'other.pcad', '', {
          attachments: { ...emptyEmbeddedPartAttachments(), canvases: new Map([[canvas.imageId, otherBytes]]) },
        });
      const empty = createAssemblyDocument('assembly');
      const first = addComponent(empty, createComponentFor(empty, { kind: 'part', partRef: embedded.partRef }));
      const document = addComponent(first, createComponentFor(first, { kind: 'part', partRef: other.partRef }));
      useAppStore.getState().openAssembly(document, other.library);
      const storage = createMemoryAutoSaveStorage();
      let timer: (() => void) | undefined;
      const stop = startAutoSave({ storage, createSaver: (options) => createAutoSaver({ ...options,
        setTimeout: (callback) => { timer = callback; return 1; }, clearTimeout: () => { timer = undefined; } }) });
      try {
        timer?.();
        await vi.waitFor(async () => { expect(await storage.listRecords()).toHaveLength(1); });
        const recovery = await readDocumentBundle((await storage.listRecords())[0].bytes, 'assembly');
        expect(recovery.ok).toBe(true);
        if (!recovery.ok || recovery.bundle.kind !== 'assembly') throw new Error('Missing assembly recovery');
        expect(recovery.bundle.embeddedDocuments.get(embedded.partRef)?.attachments.canvases.size).toBe(restore ? 1 : 0);
        expect(recovery.bundle.embeddedDocuments.get(other.partRef)?.attachments.canvases.get(canvas.imageId)).toEqual(otherBytes);
      } finally { stop(); }
      await savePart(deps, false);
      const saved = g.saved(); if (saved === null) throw new Error('Missing assembly');
      const read = await readDocumentBundle(saved.bytes, 'assembly');
      expect(read.ok).toBe(true);
      if (!read.ok || read.bundle.kind !== 'assembly') throw new Error('Missing assembly bundle');
      const attachments = read.bundle.embeddedDocuments.get(embedded.partRef)?.attachments;
      expect(attachments?.canvases.size).toBe(restore ? 1 : 0);
      expect(read.bundle.embeddedDocuments.get(other.partRef)?.attachments.canvases.get(canvas.imageId)).toEqual(otherBytes);
      if (restore) expect(attachments?.canvases.get(canvas.imageId)).toEqual(bytes);
      else expect(Buffer.from(saved.bytes).includes(Buffer.from(`parts/${embedded.partRef}/canvases/canvas-1.png`))).toBe(false);
    }
  });

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

describe('same-source action through actual PCAD/PCADA codecs', () => {
  it('saves updated shared source with exact component/mate/joint references and restores library Undo/Redo', async () => {
    const g = gateway();
    const f = await fixture();
    const source = f.library.parts.get(f.partRef);
    if (source === undefined) throw new Error('Source part required');
    let document = addComponent(f.document, createComponentFor(f.document, { kind: 'part', partRef: f.partRef }));
    const a = { kind: 'origin', componentId: document.components[0].id, element: 'origin' } as const;
    const b = { kind: 'origin', componentId: document.components[1].id, element: 'origin' } as const;
    document = { ...document, mates: [{ id: 'saved-mate', name: 'Saved', kind: 'coincident', a, b,
      suppressed: false, flipped: false }], joints: [{ id: 'saved-joint', name: 'Joint', kind: 'ball',
      a, b, minValue: null, maxValue: null, suppressed: false }] };
    useAppStore.getState().openAssembly(document, f.library);
    await saveAssembly(deps, false);
    const beforeReferences = JSON.stringify(document);
    const canonicalOptions = { savedAt: '2026-01-01T00:00:00.000Z' };
    const canonicalBefore = writeAssemblyDocument(document, canonicalOptions);
    const updated = { ...source, name: 'Edited original part' };
    const bytes = await writeDocumentBundle(createPartDocumentBundle(updated, f.attachments));
    useAppStore.setState({ isComputing: false });
    let approvals = 0;
    const unsubscribe = useAppStore.subscribe((state) => {
      const request = state.partSourceConfirm;
      if (request === null) return;
      expect(request.sourceName).toBe(source.name);
      expect(request.fileName).toBe('source-renamed.pcad');
      expect(request.occurrenceCount).toBe(2);
      expect(request.countComplete).toBe(true);
      approvals += 1;
      state.answerPartSourceConfirm(request.requestId, true);
    });
    try { await startRefreshPartSource(document.components[0].id, {
      choose: () => Promise.resolve({ kind: 'pcad', fileName: 'source-renamed.pcad', bytes }),
      read: value => readDocumentBundle(value, 'part'),
      replace: (library, ref, part, attachments) => replacePartDocument(library, ref, part, { attachments }),
    }); }
    finally { unsubscribe(); }
    expect(approvals).toBe(1);
    expect(JSON.stringify(useAppStore.getState().assembly)).toBe(beforeReferences);
    expect(activeHasUnsavedChanges(useAppStore.getState())).toBe(true);
    const refreshed = useAppStore.getState().assemblyLibrary;
    useAppStore.getState().undo();
    expect(useAppStore.getState().assemblyLibrary).toBe(f.library);
    expect(activeHasUnsavedChanges(useAppStore.getState())).toBe(false);
    useAppStore.getState().redo();
    expect(useAppStore.getState().assemblyLibrary).toBe(refreshed);
    await saveAssembly(deps, false);
    const saved = g.saved();
    if (saved === null) throw new Error('Actual saved PCADA required');
    const parsed = await readDocumentBundle(saved.bytes, 'assembly');
    if (!parsed.ok || parsed.bundle.kind !== 'assembly') throw new Error('Actual PCADA decode required');
    expect(parsed.bundle.document).toEqual(document);
    expect(writeAssemblyDocument(parsed.bundle.document, canonicalOptions)).toBe(canonicalBefore);
    const embedded = parsed.bundle.embeddedDocuments.get(f.partRef);
    expect(embedded?.document).toEqual(updated);
    expect(embedded?.attachments.shapes).toEqual(f.attachments.shapes);
    expect(embedded?.attachments.meshes).toEqual(f.attachments.meshes);
    expect(embedded?.attachments.canvases).toEqual(f.attachments.canvases);
    await openAssembly(deps);
    const reopened = useAppStore.getState().assembly;
    if (reopened === null) throw new Error('Reopened assembly required');
    expect(reopened).toEqual(document);
    expect(writeAssemblyDocument(reopened, canonicalOptions)).toBe(canonicalBefore);
    expect(useAppStore.getState().assemblyLibrary.parts.get(f.partRef)).toEqual(updated);
    expect(activeHasUnsavedChanges(useAppStore.getState())).toBe(false);
    // Codec reopen only. Actual process cold restart belongs to the held E2E packet.
  });
});

describe('actual assembly file callers reject missing session entropy atomically', () => {
  it('New keeps the whole old authored/runtime state and actual saved target except typed notice', async () => {
    const g = gateway();
    await fixture();
    await saveAssembly(deps, false);
    const before = useAppStore.getState();
    const stored = g.saved();
    g.clearSaveTarget.mockClear();
    // Retain real attachment hashing while removing only ID entropy.
    vi.stubGlobal('crypto', { subtle: globalThis.crypto.subtle });
    try {
      await newAssembly(deps);
      expect(g.clearSaveTarget).not.toHaveBeenCalled();
      expect(useAppStore.getState().fileGateway.hasSaveTarget()).toBe(true);
      expect(g.saved()).toBe(stored);
      expect(useAppStore.getState()).toEqual({ ...before,
        fileMessage: { key: 'command.unavailable.action', failed: true } });
    } finally { vi.unstubAllGlobals(); }
  });
  it('Open parses a real saved assembly but cannot replace the old owner or confirm its target', async () => {
    const g = gateway();
    await fixture();
    await saveAssembly(deps, false);
    const before = useAppStore.getState();
    const stored = g.saved();
    if (stored === null) throw new Error('Actual saved assembly required');
    g.clearSaveTarget.mockClear();
    g.confirmSaveTarget.mockClear();
    // Retain real attachment hashing while removing only ID entropy.
    vi.stubGlobal('crypto', { subtle: globalThis.crypto.subtle });
    try {
      await openAssembly(deps);
      expect(g.openPcad).toHaveBeenCalledTimes(1);
      expect(g.confirmSaveTarget).not.toHaveBeenCalled();
      expect(g.clearSaveTarget).not.toHaveBeenCalled();
      expect(useAppStore.getState().fileGateway.hasSaveTarget()).toBe(true);
      expect(g.saved()).toBe(stored);
      expect(useAppStore.getState()).toEqual({ ...before,
        fileMessage: { key: 'file.openFailed', failed: true } });
      const parsed = await readDocumentBundle(stored.bytes, 'assembly');
      expect(parsed.ok).toBe(true);
    } finally { vi.unstubAllGlobals(); }
  });
});
