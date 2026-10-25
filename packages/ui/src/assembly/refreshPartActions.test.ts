import { createDrawingDocument } from '@pointercad/model';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readDocumentBundle, writeDocumentBundle } from '@pointercad/io';
import {
  addComponent, createAssemblyDocument, createComponentFor, createEmptyPartDocument,
  createPartDocumentBundle, createAssemblyDocumentBundle, createStandardPartSource,
  embedPart, emptyEmbeddedPartAttachments, EMPTY_PART_LIBRARY,
  replacePartDocument, type PartDocument, type PartLibrary,
} from '@pointercad/model';
import { mountPartSourceConfirmDialog } from '../shell/AppShell.js';
import type { PartSourceConfirmRequest } from '../store/fileSlice.js';
import type { PickedTypedFile } from '../file/fileGateway.js';
import { useAppStore } from '../store/useAppStore.js';
import { resetTestStore } from '../store/testing/createTestStore.js';
import { hasPartLineageId, sharedPartOccurrenceCount, refreshPartReadiness, startRefreshPartSource, type RefreshPartDeps } from './replaceActions.js';

beforeEach(resetTestStore);

function deferred<T>() {
  let resolve: (value: T) => void = () => { throw new Error('not initialized'); };
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

async function fixture(part: PartDocument = createEmptyPartDocument()) {
  const attachments = emptyEmbeddedPartAttachments();
  const embedded = await embedPart(EMPTY_PART_LIBRARY, part, 'source.pcad', './source.pcad', { attachments });
  let assembly = createAssemblyDocument('Shared source');
  for (let i = 0; i < 2; i += 1) {
    assembly = addComponent(assembly, createComponentFor(assembly, { kind: 'part', partRef: embedded.partRef }));
  }
  useAppStore.getState().openAssembly(assembly, embedded.library);
  useAppStore.setState({ isComputing: false });
  const componentId = assembly.components[0].id;
  const next = { ...part, name: 'Changed same source' };
  async function picked(document: PartDocument = next): Promise<PickedTypedFile> {
    return { kind: 'pcad', fileName: 'renamed.pcad', bytes: await writeDocumentBundle(createPartDocumentBundle(document, attachments)) };
  }
  const deps: RefreshPartDeps = {
    choose: () => picked(), read: bytes => readDocumentBundle(bytes, 'part'),
    replace: (library, ref, document, value) => replacePartDocument(library, ref, document, { attachments: value }),
  };
  return { ...embedded, part, assembly, componentId, next, picked, deps };
}

describe('explicit same-source part refresh', () => {
  it('updates both instances through the same ref in one library-only Undo, without mutating the assembly', async () => {
    const f = await fixture();
    const beforeJson = JSON.stringify(f.assembly);
    let approvals = 0;
    const unsubscribe = useAppStore.subscribe((state) => {
      const request = state.partSourceConfirm;
      if (request === null) return;
      expect(request.sourceName).toBe(f.part.name);
      expect(request.fileName).toBe('renamed.pcad');
      expect(request.occurrenceCount).toBe(2);
      expect(request.countComplete).toBe(true);
      approvals += 1;
      state.answerPartSourceConfirm(request.requestId, true);
    });
    try { await startRefreshPartSource(f.componentId, f.deps); }
    finally { unsubscribe(); }
    expect(approvals).toBe(1);
    const state = useAppStore.getState();
    const updated = state.assemblyLibrary;
    expect(state.assembly).toBe(f.assembly);
    expect(JSON.stringify(state.assembly)).toBe(beforeJson);
    expect(updated.parts.get(f.partRef)).toEqual(f.next);
    expect(state.assembly?.components.map(component => component.source)).toEqual([
      { kind: 'part', partRef: f.partRef }, { kind: 'part', partRef: f.partRef },
    ]);
    expect(updated.partFiles[0].fileName).toBe('source.pcad');
    expect(updated.partFiles[0].path).toBe('./source.pcad');
    expect(state.canUndo).toBe(true);
    state.undo();
    expect(useAppStore.getState().assemblyLibrary).toBe(f.library);
    expect(useAppStore.getState().canUndo).toBe(false);
    useAppStore.getState().redo();
    expect(useAppStore.getState().assemblyLibrary).toBe(updated);
    expect(useAppStore.getState().assemblyReplacementBusy).toBe(false);
  });

  it('same content never commits an importedAt-only library or history entry', async () => {
    const f = await fixture();
    await startRefreshPartSource(f.componentId, { ...f.deps, choose: () => f.picked(f.part) });
    expect(useAppStore.getState().assemblyLibrary).toBe(f.library);
    expect(useAppStore.getState().canUndo).toBe(false);
  });

  it('cancellation and a different document ID never replace source or create history', async () => {
    const f = await fixture();
    await startRefreshPartSource(f.componentId, { ...f.deps, choose: () => Promise.resolve(null) });
    expect(useAppStore.getState().assemblyLibrary).toBe(f.library);
    const foreign = { ...createEmptyPartDocument(), id: 'foreign-source-document' };
    expect(foreign.id).not.toBe(f.part.id);
    const picked = await f.picked(foreign);
    const decoded = await readDocumentBundle(picked.bytes, 'part');
    expect(decoded.ok).toBe(true);
    if (!decoded.ok || decoded.bundle.kind !== 'part') throw new Error('Foreign part fixture did not decode');
    expect(decoded.bundle.document.id).toBe(foreign.id);
    const read = vi.fn(f.deps.read);
    const replace = vi.fn(f.deps.replace);
    await startRefreshPartSource(f.componentId, { ...f.deps, choose: () => Promise.resolve(picked), read, replace });
    expect(read).toHaveBeenCalledExactlyOnceWith(picked.bytes);
    expect(replace).not.toHaveBeenCalled();
    expect(useAppStore.getState().assemblyLibrary).toBe(f.library);
    expect(useAppStore.getState().canUndo).toBe(false);
    expect(useAppStore.getState().fileMessage?.key).toBe('assembly.refresh.foreignDocument');
    expect(useAppStore.getState().assemblyReplacementBusy).toBe(false);
  });

  it('a switched document rejects a late picker, and old finally cannot clear a new request', async () => {
    const f = await fixture();
    const choose = deferred<PickedTypedFile | null>();
    const read = vi.fn(f.deps.read);
    const pending = startRefreshPartSource(f.componentId, { ...f.deps, choose: () => choose.promise, read });
    useAppStore.getState().openAssembly(createAssemblyDocument('New owner'));
    useAppStore.setState({ assemblyReplacementBusy: true, assemblyReplacementRequestId: 'new-owner' });
    choose.resolve(await f.picked());
    await pending;
    expect(read).not.toHaveBeenCalled();
    expect(useAppStore.getState().assembly?.name).toBe('New owner');
    expect(useAppStore.getState().assemblyReplacementRequestId).toBe('new-owner');
    expect(useAppStore.getState().assemblyReplacementBusy).toBe(true);
    expect(useAppStore.getState().canUndo).toBe(false);
  });

  it('a changed library rejects a late hash completion without overwriting the new source', async () => {
    const f = await fixture();
    const ready = deferred<void>();
    const result = deferred<PartLibrary>();
    const pending = startRefreshPartSource(f.componentId, { ...f.deps,
      replace: () => { ready.resolve(); return result.promise; },
    });
    await ready.promise;
    const nextLibrary = await replacePartDocument(f.library, f.partRef, { ...f.part, name: 'Intervening update' });
    useAppStore.getState().applyAssembly(f.assembly, nextLibrary);
    result.resolve(await replacePartDocument(f.library, f.partRef, f.next));
    await pending;
    expect(useAppStore.getState().assemblyLibrary).toBe(nextLibrary);
    useAppStore.getState().undo();
    expect(useAppStore.getState().assemblyLibrary).toBe(f.library);
    expect(useAppStore.getState().canUndo).toBe(false);
  });

  it('busy and a missing source block the handler before any picker call', async () => {
    const f = await fixture();
    const choose = vi.fn(f.deps.choose);
    useAppStore.setState({ isComputing: true });
    expect(refreshPartReadiness(useAppStore.getState(), f.componentId).ready).toBe(false);
    await startRefreshPartSource(f.componentId, { ...f.deps, choose });
    useAppStore.setState({ isComputing: false });
    await startRefreshPartSource('missing', { ...f.deps, choose });
    expect(choose).not.toHaveBeenCalled();
    expect(useAppStore.getState().assemblyLibrary).toBe(f.library);
    expect(useAppStore.getState().canUndo).toBe(false);
  });

  it('a rejected decoder releases only its own reservation without a source change', async () => {
    const f = await fixture();
    await startRefreshPartSource(f.componentId, { ...f.deps,
      read: () => Promise.reject(new Error('Decode failed')),
    });
    expect(useAppStore.getState().assemblyLibrary).toBe(f.library);
    expect(useAppStore.getState().assemblyReplacementBusy).toBe(false);
    expect(useAppStore.getState().assemblyReplacementRequestId).toBeNull();
    expect(useAppStore.getState().canUndo).toBe(false);
    expect(useAppStore.getState().fileMessage?.failed).toBe(true);
  });

  it('Undo during actual decode rejects the completed source without adding a history branch', async () => {
    const f = await fixture();
    useAppStore.getState().applyAssembly({ ...f.assembly, name: 'Before decode' });
    const ready = deferred<void>();
    const decoded = deferred<Awaited<ReturnType<RefreshPartDeps['read']>>>();
    const picked = await f.picked();
    const pending = startRefreshPartSource(f.componentId, { ...f.deps,
      choose: () => Promise.resolve(picked),
      read: () => { ready.resolve(); return decoded.promise; },
    });
    await ready.promise;
    useAppStore.getState().undo();
    decoded.resolve(await readDocumentBundle(picked.bytes, 'part'));
    await pending;
    expect(useAppStore.getState().assembly).toBe(f.assembly);
    expect(useAppStore.getState().assemblyLibrary).toBe(f.library);
    expect(useAppStore.getState().canUndo).toBe(false);
    expect(useAppStore.getState().canRedo).toBe(true);
  });

  it('a wrong picker kind is refused before decoding even when its bytes are valid PCAD', async () => {
    const f = await fixture();
    const picked = await f.picked();
    const read = vi.fn(f.deps.read);
    await startRefreshPartSource(f.componentId, { ...f.deps,
      choose: () => Promise.resolve({ ...picked, kind: 'step' }), read,
    });
    expect(read).not.toHaveBeenCalled();
    expect(useAppStore.getState().assemblyLibrary).toBe(f.library);
    expect(useAppStore.getState().canUndo).toBe(false);
    expect(useAppStore.getState().assemblyReplacementBusy).toBe(false);
  });

  it('actual assembly ZIP input is refused as a part without mutating the current assembly', async () => {
    const f = await fixture();
    const bytes = await writeDocumentBundle(createAssemblyDocumentBundle(createAssemblyDocument('Wrong kind')));
    await startRefreshPartSource(f.componentId, { ...f.deps,
      choose: () => Promise.resolve({ kind: 'pcad', fileName: 'wrong.pcada', bytes }),
    });
    expect(useAppStore.getState().assembly).toBe(f.assembly);
    expect(useAppStore.getState().assemblyLibrary).toBe(f.library);
    expect(useAppStore.getState().canUndo).toBe(false);
    expect(useAppStore.getState().assemblyReplacementRequestId).toBeNull();
  });

  it('standard parts are refused by actual source kind before choosing a file', async () => {
    const f = await fixture();
    const empty = createAssemblyDocument('Standard part');
    const standard = createComponentFor(empty, createStandardPartSource('hexBolt', 'M8', { length: '30' }));
    useAppStore.getState().openAssembly(addComponent(empty, standard));
    const choose = vi.fn(f.deps.choose);
    await startRefreshPartSource(standard.id, { ...f.deps, choose });
    expect(choose).not.toHaveBeenCalled();
    expect(refreshPartReadiness(useAppStore.getState(), standard.id).reasonKey).toBe('assembly.refresh.partOnly');
    expect(useAppStore.getState().canUndo).toBe(false);
  });

  it('a rejected hash/attachment update releases its request and preserves original bytes', async () => {
    const f = await fixture();
    await startRefreshPartSource(f.componentId, { ...f.deps,
      replace: () => Promise.reject(new Error('Digest rejected')),
    });
    expect(useAppStore.getState().assembly).toBe(f.assembly);
    expect(useAppStore.getState().assemblyLibrary).toBe(f.library);
    expect(useAppStore.getState().assemblyReplacementBusy).toBe(false);
    expect(useAppStore.getState().assemblyReplacementRequestId).toBeNull();
    expect(useAppStore.getState().canUndo).toBe(false);
  });

  it('a subassembly row is refused without choosing or adding history', async () => {
    const f = await fixture();
    const empty = createAssemblyDocument('Nested source');
    const nested = createComponentFor(empty, { kind: 'subAssembly', assemblyRef: 'nested' });
    useAppStore.getState().openAssembly(addComponent(empty, nested));
    const choose = vi.fn(f.deps.choose);
    await startRefreshPartSource(nested.id, { ...f.deps, choose });
    expect(choose).not.toHaveBeenCalled();
    expect(refreshPartReadiness(useAppStore.getState(), nested.id).reasonKey).toBe('assembly.refresh.partOnly');
    expect(useAppStore.getState().canUndo).toBe(false);
  });
});

describe('canonical active-document boundary for source refresh', () => {
  it('readiness follows the canonical drawing precedence even when a caller retains an assembly field', async () => {
    const f = await fixture();
    const drawing = createDrawingDocument('Drawing', { sourceRef: 'source', sourceKind: 'part',
      fileName: 'source.pcad', path: '', contentHash: 'hash', importedAt: '2026-01-01T00:00:00.000Z' });
    const readonlyInput = { ...useAppStore.getState(), drawing };
    expect(refreshPartReadiness(readonlyInput, f.componentId).ready).toBe(false);
    expect(useAppStore.getState().assembly).toBe(f.assembly);
    // Pure readiness input: no inconsistent state is published into the store.
  });

  it('actual openDrawing during a pending picker rejects the old assembly action', async () => {
    const f = await fixture();
    const pendingPick = deferred<PickedTypedFile | null>();
    const read = vi.fn(f.deps.read);
    const pending = startRefreshPartSource(f.componentId, { ...f.deps, choose: () => pendingPick.promise, read });
    const drawing = createDrawingDocument('New drawing', { sourceRef: 'source', sourceKind: 'part',
      fileName: 'source.pcad', path: '', contentHash: 'hash', importedAt: '2026-01-01T00:00:00.000Z' });
    useAppStore.getState().openDrawing(drawing);
    pendingPick.resolve(await f.picked());
    await pending;
    expect(read).not.toHaveBeenCalled();
    expect(useAppStore.getState().drawing).toBe(drawing);
    expect(useAppStore.getState().assembly).toBeNull();
    expect(useAppStore.getState().assemblyLibrary).toBe(f.library);
    expect(useAppStore.getState().canUndo).toBe(false);
  });
});

describe('legacy confirmation through actual saved part input', () => {
  function observeConfirmation(excludedRequestId?: string) {
    const ready = deferred<PartSourceConfirmRequest>();
    const unsubscribe = useAppStore.subscribe(state => {
      if (state.partSourceConfirm !== null && state.partSourceConfirm.requestId !== excludedRequestId) {
        ready.resolve(state.partSourceConfirm);
      }
    });
    return { ready: ready.promise, unsubscribe };
  }

  it('legacy cancellation preserves exact library and document, history and releases the request', async () => {
    const f = await fixture();
    const before = JSON.stringify(f.assembly);
    const observer = observeConfirmation();
    const pending = startRefreshPartSource(f.componentId, f.deps);
    try {
      const request = await observer.ready;
      expect(request.sourceName).toBe(f.part.name);
      expect(request.fileName).toBe('renamed.pcad');
      expect(request.occurrenceCount).toBe(2);
      expect(request.countComplete).toBe(true);
      expect(useAppStore.getState().assemblyLibrary).toBe(f.library);
      useAppStore.getState().answerPartSourceConfirm(request.requestId, false);
      await pending;
      expect(JSON.stringify(useAppStore.getState().assembly)).toBe(before);
      expect(useAppStore.getState().assemblyLibrary).toBe(f.library);
      expect(useAppStore.getState().canUndo).toBe(false);
      expect(useAppStore.getState().assemblyReplacementBusy).toBe(false);
      expect(useAppStore.getState().partSourceConfirm).toBeNull();
    } finally {
      const request = useAppStore.getState().partSourceConfirm;
      if (request !== null) useAppStore.getState().answerPartSourceConfirm(request.requestId, false);
      observer.unsubscribe();
      await pending;
    }
  });

  it('same content is a no-op before any legacy confirmation, even with a newly computed importedAt', async () => {
    const f = await fixture();
    const observed: PartSourceConfirmRequest[] = [];
    const unsubscribe = useAppStore.subscribe(state => {
      if (state.partSourceConfirm !== null) observed.push(state.partSourceConfirm);
    });
    try {
      await startRefreshPartSource(f.componentId, { ...f.deps, choose: () => f.picked(f.part) });
      expect(observed).toEqual([]);
      expect(useAppStore.getState().assemblyLibrary).toBe(f.library);
      expect(useAppStore.getState().canUndo).toBe(false);
    } finally { unsubscribe(); }
  });

  it('an actual drawing switch during confirmation rejects the old approval', async () => {
    const f = await fixture();
    const observer = observeConfirmation();
    const pending = startRefreshPartSource(f.componentId, f.deps);
    try {
      const request = await observer.ready;
      const drawing = createDrawingDocument('Switched drawing', { sourceRef: 'source', sourceKind: 'part',
        fileName: 'source.pcad', path: '', contentHash: 'hash', importedAt: '2026-01-01T00:00:00.000Z' });
      useAppStore.getState().openDrawing(drawing);
      expect(request.isCurrent()).toBe(false);
      useAppStore.getState().answerPartSourceConfirm(request.requestId, true);
      await pending;
      expect(useAppStore.getState().drawing).toBe(drawing);
      expect(useAppStore.getState().assemblyLibrary).toBe(f.library);
      expect(useAppStore.getState().canUndo).toBe(false);
      expect(useAppStore.getState().assemblyReplacementBusy).toBe(false);
    } finally {
      const request = useAppStore.getState().partSourceConfirm;
      if (request !== null) useAppStore.getState().answerPartSourceConfirm(request.requestId, false);
      observer.unsubscribe();
      await pending;
    }
  });

  it('a new same-ID document request cannot be approved or cancelled by callbacks from the old dialog', async () => {
    const old = await fixture();
    const oldObserver = observeConfirmation();
    const oldRun = startRefreshPartSource(old.componentId, old.deps);
    let newRun: Promise<void> | undefined;
    let newObserver: ReturnType<typeof observeConfirmation> | undefined;
    try {
      const oldRequest = await oldObserver.ready;
      const next = await fixture();
      expect(next.part.id).toBe(old.part.id);
      newObserver = observeConfirmation(oldRequest.requestId);
      newRun = startRefreshPartSource(next.componentId, next.deps);
      const newRequest = await newObserver.ready;
      expect(newRequest.requestId).not.toBe(oldRequest.requestId);
      useAppStore.getState().answerPartSourceConfirm(oldRequest.requestId, true);
      expect(useAppStore.getState().partSourceConfirm).toBe(newRequest);
      useAppStore.getState().answerPartSourceConfirm(oldRequest.requestId, false);
      expect(useAppStore.getState().partSourceConfirm).toBe(newRequest);
      await oldRun;
      expect(useAppStore.getState().assemblyReplacementRequestId).toBe(newRequest.requestId);
      expect(useAppStore.getState().assemblyReplacementBusy).toBe(true);
      expect(useAppStore.getState().assemblyLibrary).toBe(next.library);
      useAppStore.getState().answerPartSourceConfirm(newRequest.requestId, false);
      await newRun;
      expect(useAppStore.getState().assemblyLibrary).toBe(next.library);
      expect(useAppStore.getState().canUndo).toBe(false);
    } finally {
      const request = useAppStore.getState().partSourceConfirm;
      if (request !== null) useAppStore.getState().answerPartSourceConfirm(request.requestId, false);
      oldObserver.unsubscribe();
      newObserver?.unsubscribe();
      await oldRun;
      if (newRun !== undefined) await newRun;
    }
  });

  it('a real source-library change during confirmation rejects late approval and preserves that library', async () => {
    const f = await fixture();
    const observer = observeConfirmation();
    const pending = startRefreshPartSource(f.componentId, f.deps);
    try {
      const request = await observer.ready;
      const intervening = await replacePartDocument(f.library, f.partRef, { ...f.part, name: 'Intervening source' });
      useAppStore.getState().applyAssembly(f.assembly, intervening);
      useAppStore.getState().answerPartSourceConfirm(request.requestId, true);
      await pending;
      expect(useAppStore.getState().assemblyLibrary).toBe(intervening);
      useAppStore.getState().undo();
      expect(useAppStore.getState().assemblyLibrary).toBe(f.library);
      expect(useAppStore.getState().canUndo).toBe(false);
    } finally {
      const request = useAppStore.getState().partSourceConfirm;
      if (request !== null) useAppStore.getState().answerPartSourceConfirm(request.requestId, false);
      observer.unsubscribe();
      await pending;
    }
  });

  it('a same tagged lineage uses actual codec/hash and one Undo without legacy confirmation', async () => {
    const source = { ...createEmptyPartDocument(), id: 'part-uuid:086963bc-1dbd-4a51-a603-ae34317c05c3' };
    const f = await fixture(source);
    const observed: PartSourceConfirmRequest[] = [];
    const unsubscribe = useAppStore.subscribe(state => {
      if (state.partSourceConfirm !== null) observed.push(state.partSourceConfirm);
    });
    try {
      expect(hasPartLineageId(source)).toBe(true);
      await startRefreshPartSource(f.componentId, f.deps);
      expect(observed).toEqual([]);
      expect(useAppStore.getState().assemblyLibrary.parts.get(f.partRef)).toEqual(f.next);
      expect(useAppStore.getState().assembly).toBe(f.assembly);
      useAppStore.getState().undo();
      expect(useAppStore.getState().assemblyLibrary).toBe(f.library);
      expect(useAppStore.getState().canUndo).toBe(false);
    } finally { unsubscribe(); }
  });

  it('counts repeated nested hidden/suppressed occurrences and reports cycles or missing branches as incomplete', async () => {
    const f = await fixture();
    let nested = createAssemblyDocument('Nested');
    const child = createComponentFor(nested, { kind: 'part', partRef: f.partRef });
    nested = addComponent(nested, { ...child, suppressed: true, visible: false });
    let root = createAssemblyDocument('Root');
    for (let i = 0; i < 2; i += 1) {
      const component = createComponentFor(root, { kind: 'subAssembly', assemblyRef: 'nested' });
      root = addComponent(root, i === 1 ? { ...component, visible: false, suppressed: true } : component);
    }
    const library = { ...f.library, assemblies: new Map([['nested', nested]]) };
    expect(sharedPartOccurrenceCount(root, library, f.partRef)).toEqual({ count: 2, complete: true });
    const cyclic = addComponent(nested, createComponentFor(nested, { kind: 'subAssembly', assemblyRef: 'nested' }));
    expect(sharedPartOccurrenceCount(root, { ...library, assemblies: new Map([['nested', cyclic]]) }, f.partRef))
      .toEqual({ count: 2, complete: false });
    expect(sharedPartOccurrenceCount(root, { ...library, assemblies: new Map() }, f.partRef))
      .toEqual({ count: 0, complete: false });
  });
});

describe('lineage format and exact count boundary', () => {
  it('a tag alone or an unrelated UUID format is not lineage evidence', () => {
    const part = createEmptyPartDocument();
    for (const id of ['part-1', 'part-uuid:forged', 'part-uuid:086963bc-1dbd-1a51-a603-ae34317c05c3',
      '086963bc-1dbd-4a51-a603-ae34317c05c3']) {
      expect(hasPartLineageId({ ...part, id }), id).toBe(false);
    }
  });

  it('counts an eight-level saved branch completely and marks a ninth level incomplete', async () => {
    const f = await fixture();
    const countAtDepth = (depth: number) => {
      const assemblies = new Map<string, typeof f.assembly>();
      let child = createAssemblyDocument('Leaf');
      child = addComponent(child, createComponentFor(child, { kind: 'part', partRef: f.partRef }));
      for (let i = depth; i > 0; i -= 1) {
        const ref = `nested-${String(i)}`;
        assemblies.set(ref, child);
        let parent = createAssemblyDocument(`Depth ${String(i)}`);
        parent = addComponent(parent, createComponentFor(parent, { kind: 'subAssembly', assemblyRef: ref }));
        child = parent;
      }
      return sharedPartOccurrenceCount(child, { ...f.library, assemblies }, f.partRef);
    };
    expect(countAtDepth(8)).toEqual({ count: 1, complete: true });
    expect(countAtDepth(9)).toEqual({ count: 0, complete: false });
    expect(useAppStore.getState().assembly).toBe(f.assembly);
    expect(useAppStore.getState().assemblyLibrary).toBe(f.library);
    expect(useAppStore.getState().canUndo).toBe(false);
  });
});

describe('native lifecycle failure during actual legacy source refresh', () => {
  it('setup failure settles the actual decoded request and releases only its real reservation', async () => {
    const f = await fixture();
    const ready = deferred<PartSourceConfirmRequest>();
    const unsubscribe = useAppStore.subscribe(state => {
      if (state.partSourceConfirm !== null) ready.resolve(state.partSourceConfirm);
    });
    const pending = startRefreshPartSource(f.componentId, f.deps);
    try {
      const request = await ready.promise;
      expect(useAppStore.getState().assemblyReplacementBusy).toBe(true);
      mountPartSourceConfirmDialog(request.requestId, {
        open: false, showModal: () => { throw new Error('Native modal setup failed'); }, close: () => undefined,
      }, () => undefined, () => undefined, () => false);
      await pending;
      expect(useAppStore.getState().partSourceConfirm).toBeNull();
      expect(useAppStore.getState().assemblyReplacementBusy).toBe(false);
      expect(useAppStore.getState().assemblyReplacementRequestId).toBeNull();
      expect(useAppStore.getState().assembly).toBe(f.assembly);
      expect(useAppStore.getState().assemblyLibrary).toBe(f.library);
      expect(useAppStore.getState().canUndo).toBe(false);
    } finally {
      unsubscribe();
      const request = useAppStore.getState().partSourceConfirm;
      if (request !== null) useAppStore.getState().answerPartSourceConfirm(request.requestId, false);
      await pending;
    }
  });
});
