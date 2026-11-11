import { createHash } from 'node:crypto';
import { emptyPcadAttachments, encodeSaveDocument, readPcadFile, writePcadFile, type PcadAttachments } from '@pointercad/io';
import {
  addComponent, createAssemblyDocument, createComponentFor, createDrawingDocument, createEmptyPartDocument, embedDrawingSource,
  embedPart, emptyDrawingSourceLibrary, EMPTY_PART_LIBRARY, emptyEmbeddedPartAttachments, type PartDocument,
} from '@pointercad/model';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { newSketchCanvas } from '../file/canvasFile.js';
import { hasUnsavedChanges } from '../file/partFile.js';
import { currentPcadAttachments } from '../store/attachKernel.js';
import { resetTestStore } from '../store/testing/createTestStore.js';
import { useAppStore } from '../store/useAppStore.js';
import { executeDefinitionDiffWork } from '../diff/definitionDiffWork.js';
import { createNamedSavePointActions } from './namedSavePointActions.js';
import type { PcadSavePointReply, PcadWorkerRequest } from '../file/pcadSaveProtocol.js';
import { createNamedSavePoints, SavePointError,
  type NamedSavePoint, type SavePointBlob, type SavePointChange, type SavePointState, type SavePointStorage,
} from './namedSavePoints.js';

beforeEach(resetTestStore);
const digest = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

function storage(): SavePointStorage & { readonly points: () => readonly NamedSavePoint[];
  readonly corrupt: (hash: string) => void; readonly failNext: (reason: 'quota') => void } {
  const points = new Map<string, NamedSavePoint>(), blobs = new Map<string, Uint8Array>();
  let revision = 0, failure: 'quota' | null = null;
  const metadata = (): SavePointBlob[] => [...blobs].map(([sha256, bytes]) => ({
    version: 1, sha256, byteLength: bytes.length, chunkCount: Math.max(1, Math.ceil(bytes.length / 1048576)),
  }));
  return {
    points: () => [...points.values()],
    corrupt(hash) { const bytes = blobs.get(hash); if (bytes) bytes[0] ^= 1; },
    failNext(reason) { failure = reason; },
    load(): Promise<SavePointState> { const values = metadata(); return Promise.resolve({ revision,
      points: [...points.values()].map(point => structuredClone(point)), blobs: values,
      chunkKeys: values.flatMap(blob => Array.from({ length: blob.chunkCount }, (_, index) => `${blob.sha256}:${index}`)) }); },
    readBlob(blob) { return new Promise<Uint8Array>(resolve => {
      const bytes = blobs.get(blob.sha256); if (!bytes) throw new Error('missing blob'); resolve(new Uint8Array(bytes));
    }); },
    commit(expected, change: SavePointChange, signal) { return new Promise<void>(resolve => {
      if (signal?.aborted) throw new SavePointError('cancelled', 'cancelled');
      if (expected !== revision) throw new SavePointError('conflict', 'revision changed');
      if (failure) { failure = null; throw new SavePointError('quota', 'quota'); }
      if (change.pointPut) points.set(change.pointPut.id, structuredClone(change.pointPut));
      if (change.pointDelete) points.delete(change.pointDelete);
      for (const [hash, bytes] of change.blobPut ?? []) blobs.set(hash, new Uint8Array(bytes));
      for (const blob of change.blobDelete ?? []) blobs.delete(blob.sha256);
      revision += 1;
      resolve();
    }); },
  };
}

function part(name: string, byte: number): { document: PartDocument; attachments: PcadAttachments; zip: Uint8Array } {
  const canvas = newSketchCanvas([], 'xy', `${name}.png`, { width: 2, height: 1 }, 'shared-canvas');
  const document: PartDocument = { ...createEmptyPartDocument(), name, canvases: [canvas], solids: [
    { id: 'importedSolid-1', kind: 'importedSolid', name: 'shape', suppressed: false,
      shapeRef: 'shared-shape', source: { format: 'step', fileName: 'shape.step', unit: 'mm', byteLength: 3 }, bodyKind: 'solid' },
    { id: 'importedMesh-1', kind: 'importedMesh', name: 'mesh', suppressed: false,
      meshRef: 'shared-mesh', source: { format: 'stl', fileName: 'mesh.stl', unit: 'mm', byteLength: 84 }, triangleCount: 1 },
  ] };
  const attachments = { ...emptyPcadAttachments(), shapes: new Map([['shared-shape', Uint8Array.of(byte, 2, 3)]]),
    meshes: new Map([['shared-mesh', { positions: Float32Array.of(byte, 0, 0, 1, 0, 0, 0, 1, 0),
      normals: Float32Array.of(0, 0, 1, 0, 0, 1, 0, 0, 1), indices: Uint32Array.of(0, 1, 2) }]]),
    canvases: new Map([[canvas.imageId, Uint8Array.of(byte, 5, 6)]]) };
  return { document, attachments, zip: writePcadFile(document, { savedAt: '2026-10-04T00:00:00.000Z', attachments }) };
}

function shownBytes(): { shape: Uint8Array | undefined; mesh: Float32Array | undefined; canvas: Uint8Array | undefined } {
  const state = useAppStore.getState(), current = currentPcadAttachments(state.document);
  const shape = state.document.solids.find(feature => feature.kind === 'importedSolid');
  const mesh = state.document.solids.find(feature => feature.kind === 'importedMesh');
  return { shape: shape?.kind === 'importedSolid' ? current.shapes.get(shape.shapeRef) : undefined,
    mesh: mesh?.kind === 'importedMesh' ? current.meshes.get(mesh.meshRef)?.positions : undefined,
    canvas: current.canvases.get(state.document.canvases[0]?.imageId ?? '') };
}

describe('名前付き保存点のUI手続き', () => {
  it.each(['success', 'listFailure', 'cloneFailure', 'cancelAfterCommit'] as const)(
    '実Worker分岐の%sは独立再読と保存成否を保つ', async mode => {
      const { SavePointError: WorkerSavePointError } = await import('./namedSavePoints.js');
      const data = storage(), source = part('original', 4), repository = createNamedSavePoints(data);
      const original = await repository.create('original', source.zip, 'part');
      let committed = false, loads = 0;
      let receive: (reply: PcadSavePointReply) => void = () => undefined;
      const response = new Promise<PcadSavePointReply>(resolve => { receive = resolve; });
      const scope: { onmessage: ((event: MessageEvent<PcadWorkerRequest>) => void) | null;
        postMessage: (reply: PcadSavePointReply) => void } = { onmessage: null, postMessage: receive };
      const request: PcadWorkerRequest = { id: 'batch', kind: 'savePoint', operation: 'cloneAndList',
        pointId: original.id, name: 'alias' };
      const observed: SavePointStorage = { ...data, async load() {
        loads += 1;
        if (committed && mode === 'listFailure') throw new WorkerSavePointError('corrupt', 'refresh failed');
        return data.load();
      }, async commit(revision, change, signal) {
        if (mode === 'cloneFailure') throw new WorkerSavePointError('quota', 'full');
        await data.commit(revision, change, signal); committed = true;
        if (mode === 'cancelAfterCommit') scope.onmessage?.(new MessageEvent<PcadWorkerRequest>('message', {
          data: { id: request.id, kind: 'savePointCancel' },
        }));
      } };
      vi.doMock('./namedSavePointStorage.js', () => ({ createIndexedDbSavePointStorage: () => observed }));
      vi.stubGlobal('self', scope);
      try {
        await import('../file/pcadSave.worker.js');
        scope.onmessage?.(new MessageEvent<PcadWorkerRequest>('message', { data: request }));
        const reply = await response;
        if (mode === 'cloneFailure') {
          expect(reply).toMatchObject({ kind: 'savePointFailure', reason: 'quota' });
          expect(loads).toBe(1); expect(data.points()).toEqual([original]);
        } else {
          expect(data.points()).toHaveLength(2);
          const alias = data.points().find(point => point.id !== original.id);
          if (alias === undefined) throw new Error('Committed alias missing');
          expect((await repository.read(alias.id)).bytes).toEqual(source.zip);
          expect((await repository.read(original.id)).bytes).toEqual(source.zip);
          if (mode === 'cancelAfterCommit') expect(reply.kind).toBe('savePointCancelled');
          else {
            expect(loads).toBe(2);
            expect(reply).toMatchObject({ kind: 'savePointResult', operation: 'cloneAndList', point: alias,
              listing: mode === 'success' ? { ok: true, points: [original, alias] }
                : { ok: false, reason: 'corrupt', message: 'refresh failed' } });
          }
        }
      } finally { vi.doUnmock('./namedSavePointStorage.js'); vi.unstubAllGlobals(); vi.resetModules(); }
    });

  it('組の複製と再読一覧でも全添付ZIP・旧点・文書・Undoを保つ', async () => {
    const data = storage(), repository = createNamedSavePoints(data), source = part('original', 7);
    const original = await repository.create('original', source.zip, 'part');
    const before = useAppStore.getState(), actions = createNamedSavePointActions(repository);
    const result = await actions.cloneAndList(original.id, 'alias');
    expect(result.listing.ok).toBe(true);
    if (!result.listing.ok) throw new Error('List failed');
    expect(result.listing.points).toEqual([original, result.point]);
    expect(result.point.originId).toBe(original.id);
    expect((await repository.read(original.id)).bytes).toEqual(source.zip);
    expect((await repository.read(result.point.id)).bytes).toEqual(source.zip);
    expect(useAppStore.getState()).toBe(before);
  });

  it('複製失敗は一覧を呼ばず、保存後の一覧失敗は保存済み点を区別して残す', async () => {
    const data = storage(), repository = createNamedSavePoints(data), source = part('original', 8);
    const original = await repository.create('original', source.zip, 'part');
    const list = vi.fn(repository.list.bind(repository)), actions = createNamedSavePointActions({ ...repository, list });
    data.failNext('quota');
    await expect(actions.cloneAndList(original.id, 'failed')).rejects.toMatchObject({ reason: 'quota' });
    expect(list).not.toHaveBeenCalled(); expect(data.points()).toEqual([original]);
    list.mockRejectedValueOnce(new SavePointError('corrupt', 'changed after commit'));
    const result = await actions.cloneAndList(original.id, 'saved');
    expect(result.listing).toEqual({ ok: false, reason: 'corrupt', message: 'changed after commit' });
    expect(data.points()).toEqual([original, result.point]);
    expect((await repository.read(result.point.id)).bytes).toEqual(source.zip);
  });

  it('複製commit後の取消は一覧成功扱いもrollbackも行わない', async () => {
    const data = storage(), repository = createNamedSavePoints(data), source = part('original', 9);
    const original = await repository.create('original', source.zip, 'part');
    const controller = new AbortController(), list = vi.fn(repository.list.bind(repository));
    const actions = createNamedSavePointActions({ ...repository, list, async clone(id, name, signal) {
      const point = await repository.clone(id, name, signal); controller.abort(); return point;
    } });
    await expect(actions.cloneAndList(original.id, 'committed', controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(list).not.toHaveBeenCalled(); expect(data.points()).toHaveLength(2);
    expect((await repository.read(original.id)).bytes).toEqual(source.zip);
  });

  it('Worker対応repositoryには組を1回だけ委譲し、別のclone/listを追加しない', async () => {
    const repository = createNamedSavePoints(storage()), source = part('original', 2);
    const point = await repository.create('original', source.zip, 'part');
    const result = { point, listing: { ok: true as const, points: [point] } };
    const clone = vi.fn(repository.clone.bind(repository)), list = vi.fn(repository.list.bind(repository));
    const cloneAndList = vi.fn(() => Promise.resolve(result)), controller = new AbortController();
    const actions = createNamedSavePointActions({ ...repository, clone, list, cloneAndList });
    await expect(actions.cloneAndList(point.id, 'alias', controller.signal)).resolves.toBe(result);
    expect(cloneAndList).toHaveBeenCalledExactlyOnceWith(point.id, 'alias', controller.signal);
    expect(clone).not.toHaveBeenCalled(); expect(list).not.toHaveBeenCalled();
  });

  it('試作A/発注前の一覧・複製・実比較・復元で元点SHAを変えず、復元だけUndoを1段進める', async () => {
    const data = storage(), repository = createNamedSavePoints(data), actions = createNamedSavePointActions(repository);
    const a = part('試作A', 1), b = part('発注前', 9);
    const first = await repository.create('試作A', a.zip, 'part');
    const second = await repository.create('発注前', b.zip, 'part');
    const state = useAppStore.getState();
    state.setImportedAttachments(a.attachments.shapes, a.attachments.meshes);
    state.setCanvasImages(a.attachments.canvases);
    state.applyDocument(a.document, { replacesDocument: true });
    state.setFileState('試作A.pcad', a.document);
    const before = useAppStore.getState();
    expect((await actions.list()).map(point => point.name)).toEqual(['試作A', '発注前']);
    for (const point of [first, second]) {
      const cloned = await actions.clone(point.id, `${point.name}の複製`);
      expect(cloned.sourceSha256).toBe(point.sourceSha256);
      expect(cloned.originId).toBe(point.id);
    }
    const comparison = await actions.comparison(first.id, second.id);
    const result = await executeDefinitionDiffWork({ kind: 'compare', before: comparison.before.bytes,
      after: comparison.after.bytes, relationship: comparison.relationship });
    expect(result.kind).toBe('compared');
    if (result.kind !== 'compared') throw new Error('Comparison did not complete');
    expect(result.result.changes.some(change => change.group === 'attachments')).toBe(true);
    expect(useAppStore.getState().document).toBe(before.document);
    expect(useAppStore.getState().undoStack).toBe(before.undoStack);
    expect(useAppStore.getState().canvases).toBe(before.canvases);
    const originalPoints = await actions.list();
    for (const [point, source] of [[first, a], [second, b]] as const) {
      await actions.restore(point.id);
      expect(useAppStore.getState().document.name).toBe(source.document.name);
      expect(useAppStore.getState().undoStack.past).toHaveLength(before.undoStack.past.length + 1);
      expect(shownBytes()).toEqual({ shape: source.attachments.shapes.get('shared-shape'),
        mesh: source.attachments.meshes.get('shared-mesh')?.positions, canvas: source.attachments.canvases.get('shared-canvas') });
      useAppStore.getState().undo();
      expect(useAppStore.getState().document).toBe(before.document);
      expect(shownBytes()).toEqual({ shape: a.attachments.shapes.get('shared-shape'),
        mesh: a.attachments.meshes.get('shared-mesh')?.positions, canvas: a.attachments.canvases.get('shared-canvas') });
      expect((await repository.read(point.id)).bytes).toEqual(source.zip);
      expect((await repository.read(point.id)).point.sourceSha256).toBe(digest(source.zip));
    }
    expect(await actions.list()).toEqual(originalPoints);
    expect(useAppStore.getState().fileName).toBe('試作A.pcad');
    expect(useAppStore.getState().savedDocument).toBe(a.document);
  });

  it('読取開始後の復元取消は文書・Undo・添付と保存点を保持する', async () => {
    const data = storage(), repository = createNamedSavePoints(data), b = part('発注前', 9);
    const point = await repository.create('発注前', b.zip, 'part');
    let entered = (): void => undefined, release = (): void => undefined;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const blocked: SavePointStorage = { ...data, async readBlob(blob, signal) {
      entered(); await gate; return data.readBlob(blob, signal);
    } };
    const actions = createNamedSavePointActions(createNamedSavePoints(blocked)), controller = new AbortController();
    const before = useAppStore.getState(), points = await repository.list();
    const pending = actions.restore(point.id, controller.signal);
    await started; controller.abort(); release();
    await expect(pending).rejects.toMatchObject({ reason: 'cancelled' });
    const after = useAppStore.getState();
    expect(after.document).toBe(before.document); expect(after.undoStack).toBe(before.undoStack);
    expect(after.importedShapes).toBe(before.importedShapes); expect(after.importedMeshes).toBe(before.importedMeshes);
    expect(after.canvases).toBe(before.canvases);
    expect(await repository.list()).toEqual(points);
    expect((await repository.read(point.id)).bytes).toEqual(b.zip);
  });

  it('Workerの通常ZIPで作成し、複製の原点SHAと別名の比較関係を保持する', async () => {
    const data = storage(), repository = createNamedSavePoints(data), actions = createNamedSavePointActions(repository);
    const a = part('A', 1);
    const store = useAppStore.getState();
    store.setImportedAttachments(a.attachments.shapes, a.attachments.meshes);
    store.setCanvasImages(a.attachments.canvases);
    store.applyDocument(a.document, { replacesDocument: true });
    const encodings: Uint8Array[] = [];
    useAppStore.setState({ saveDocumentEncoder: async input => {
      expect(input.kind).toBe('part');
      const bytes = await encodeSaveDocument(input);
      encodings.push(bytes);
      return bytes;
    } });
    const before = useAppStore.getState(), point = await actions.create('試作A');
    expect(encodings).toHaveLength(1);
    const encoded = encodings[0];
    if (encoded === undefined) throw new Error('Encoder did not return');
    expect(point.sourceSha256).toBe(digest(encoded));
    const reopened = readPcadFile(encoded);
    expect(reopened.ok && reopened.document.name).toBe('A');
    expect(useAppStore.getState().document).toBe(before.document);
    expect(useAppStore.getState().undoStack).toBe(before.undoStack);
    const alias = await actions.clone(point.id, '控え');
    expect(alias.originId).toBe(point.id); expect(alias.sourceSha256).toBe(digest(encoded));
    const pair = await actions.comparison(point.id, alias.id);
    expect(pair.relationship).toBe('versions');
    expect(pair.before.bytes).toEqual(encoded); expect(pair.after.bytes).toEqual(encoded);
    expect(data.points()).toHaveLength(2);
  });

  it('同ref異bytesのA→B復元はUndo1段で旧文書/形/網/画像を戻しRedoでBを戻す', async () => {
    const data = storage(), repository = createNamedSavePoints(data), actions = createNamedSavePointActions(repository);
    const a = part('A', 1), b = part('B', 9);
    const point = await repository.create('B', b.zip, 'part');
    const initial = useAppStore.getState();
    initial.setImportedAttachments(a.attachments.shapes, a.attachments.meshes);
    initial.setCanvasImages(a.attachments.canvases);
    initial.applyDocument(a.document, { replacesDocument: true });
    initial.setFileState('A.pcad', a.document);
    const before = useAppStore.getState(), depth = before.undoStack.past.length;
    const restored = await actions.restore(point.id);
    const after = useAppStore.getState();
    expect(restored.sourceSha256).toBe(digest(b.zip));
    expect(after.document.name).toBe('B'); expect(after.undoStack.past).toHaveLength(depth + 1);
    expect(after.fileName).toBe('A.pcad'); expect(after.savedDocument).toBe(a.document);
    expect(hasUnsavedChanges(after.document, after.savedDocument)).toBe(true);
    expect(shownBytes()).toEqual({ shape: b.attachments.shapes.get('shared-shape'),
      mesh: b.attachments.meshes.get('shared-mesh')?.positions, canvas: b.attachments.canvases.get('shared-canvas') });
    after.undo();
    expect(useAppStore.getState().document).toBe(a.document);
    expect(shownBytes()).toEqual({ shape: a.attachments.shapes.get('shared-shape'),
      mesh: a.attachments.meshes.get('shared-mesh')?.positions, canvas: a.attachments.canvases.get('shared-canvas') });
    after.redo(); expect(useAppStore.getState().document.name).toBe('B');
    expect(shownBytes()).toEqual({ shape: b.attachments.shapes.get('shared-shape'),
      mesh: b.attachments.meshes.get('shared-mesh')?.positions, canvas: b.attachments.canvases.get('shared-canvas') });
    const reopened = readPcadFile(writePcadFile(useAppStore.getState().document, { attachments: currentPcadAttachments() }));
    expect(reopened.ok).toBe(true);
    if (reopened.ok) expect(reopened.attachments.shapes.size).toBe(1);
  });

  it('取消・破損・quotaは文書/Undo/添付を部分変更せず、保存点も無断削除しない', async () => {
    const data = storage(), repository = createNamedSavePoints(data), actions = createNamedSavePointActions(repository);
    const a = part('A', 1), point = await repository.create('A', a.zip, 'part');
    const before = useAppStore.getState();
    const cancelled = new AbortController(); cancelled.abort();
    await expect(actions.restore(point.id, cancelled.signal)).rejects.toThrow();
    data.failNext('quota');
    useAppStore.setState({ saveDocumentEncoder: () => Promise.resolve(a.zip) });
    await expect(actions.create('失敗')).rejects.toMatchObject({ reason: 'quota' });
    const image = point.entries.find(entry => entry.name.startsWith('canvases/'));
    expect(image).toBeDefined(); if (image) data.corrupt(image.sha256);
    await expect(actions.restore(point.id)).rejects.toMatchObject({ reason: 'corrupt' });
    expect(data.points()).toHaveLength(1);
    expect(useAppStore.getState().document).toBe(before.document);
    expect(useAppStore.getState().undoStack).toBe(before.undoStack);
    expect(useAppStore.getState().importedShapes).toBe(before.importedShapes);
    expect(useAppStore.getState().importedMeshes).toBe(before.importedMeshes);
    expect(useAppStore.getState().canvases).toBe(before.canvases);
  });

  it('通常Worker待機中の再編集で旧createを取り消し、保存点を作らない', async () => {
    const data = storage(), actions = createNamedSavePointActions(createNamedSavePoints(data));
    let started = (): void => undefined, release: (bytes: Uint8Array) => void = () => undefined;
    const entered = new Promise<void>(resolve => { started = resolve; });
    useAppStore.setState({ saveDocumentEncoder: async () => {
      started(); return new Promise<Uint8Array>(resolve => { release = resolve; });
    } });
    const pending = actions.create('旧文書');
    await entered;
    const state = useAppStore.getState();
    state.applyDocument({ ...state.document, name: '編集後' });
    const edited = useAppStore.getState();
    release(part('old', 1).zip);
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(data.points()).toHaveLength(0);
    expect(useAppStore.getState().document).toBe(edited.document);
    expect(useAppStore.getState().undoStack).toBe(edited.undoStack);
  });

  it('保存点commit直後の再編集で旧createを成功通知せず、commit済みの点は削除しない', async () => {
    const data = storage(), a = part('A', 3);
    const editedStorage: SavePointStorage = { ...data, async commit(revision, change, signal) {
      await data.commit(revision, change, signal);
      const state = useAppStore.getState();
      state.applyDocument({ ...state.document, name: 'commit後の編集' });
    } };
    useAppStore.setState({ saveDocumentEncoder: () => Promise.resolve(a.zip) });
    const actions = createNamedSavePointActions(createNamedSavePoints(editedStorage));
    await expect(actions.create('A')).rejects.toMatchObject({ name: 'AbortError' });
    expect(useAppStore.getState().document.name).toBe('commit後の編集');
    expect(data.points()).toHaveLength(1);
    expect(data.points()[0]?.name).toBe('A');
  });

  it('保存点の読取途中に文書を切り替えた旧restoreは新文書/Undo/添付を触らない', async () => {
    const data = storage(), target = part('target', 7);
    const point = await createNamedSavePoints(data).create('target', target.zip, 'part');
    let started = (): void => undefined, release = (): void => undefined;
    const entered = new Promise<void>(resolve => { started = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const blocked: SavePointStorage = { ...data, async readBlob(blob, signal) {
      started(); await gate; return data.readBlob(blob, signal);
    } };
    const actions = createNamedSavePointActions(createNamedSavePoints(blocked));
    const pending = actions.restore(point.id);
    await entered;
    const state = useAppStore.getState();
    state.resetDocument({ ...createEmptyPartDocument(), name: 'new document' });
    const switched = useAppStore.getState();
    release();
    await expect(pending).rejects.toThrow();
    expect(useAppStore.getState().document).toBe(switched.document);
    expect(useAppStore.getState().undoStack).toBe(switched.undoStack);
    expect(useAppStore.getState().importedShapes).toBe(switched.importedShapes);
    expect(useAppStore.getState().canvases).toBe(switched.canvases);
  });
});

async function assemblyFixture() {
  const attachments = { ...emptyEmbeddedPartAttachments(),
    shapes: new Map([['shape', Uint8Array.of(1, 2, 3)]]), canvases: new Map([['image', Uint8Array.of(4, 5, 6)]]) };
  const embedded = await embedPart(EMPTY_PART_LIBRARY, createEmptyPartDocument(), 'a.pcad', './a.pcad', { attachments });
  const empty = createAssemblyDocument('試作A組立');
  const first = addComponent(empty, createComponentFor(empty, { kind: 'part', partRef: embedded.partRef }));
  const second = { ...addComponent(first, createComponentFor(first, { kind: 'part', partRef: embedded.partRef })), name: '発注前組立' };
  return { library: embedded.library, first, second };
}

describe('組立・図面の名前付き保存点', () => {
  it('組立の作成・複製・実比較・復元は、抱き込んだ部品と添付を保ち、復元のUndoは1回', async () => {
    const data = storage(), repository = createNamedSavePoints(data), actions = createNamedSavePointActions(repository);
    const { library, first, second } = await assemblyFixture();
    useAppStore.setState({ saveDocumentEncoder: input => encodeSaveDocument(input) });
    useAppStore.getState().openAssembly(first, library);
    const a = await actions.create('試作A');
    useAppStore.getState().applyAssembly(second, library);
    const b = await actions.create('発注前');
    expect([a.kind, b.kind]).toEqual(['assembly', 'assembly']);
    const cloned = await actions.clone(a.id, '試作Aの複製');
    expect(cloned.sourceSha256).toBe(a.sourceSha256);
    const pair = await actions.comparison(a.id, b.id);
    expect(pair.before.documentKind).toBe('assembly'); expect(pair.relationship).toBe('unrelated');
    const diff = await executeDefinitionDiffWork({ kind: 'compare', before: pair.before.bytes, after: pair.after.bytes,
      relationship: 'versions', documentKind: pair.before.documentKind });
    expect(diff.kind).toBe('compared');
    if (diff.kind !== 'compared') throw new Error('Comparison did not complete');
    expect(diff.result.changes.map(change => `${change.status}:${change.group}`)).toEqual(
      expect.arrayContaining(['added:component', 'changed:assembly-document']));
    const before = useAppStore.getState();
    await actions.restore(a.id);
    const restored = useAppStore.getState();
    expect(restored.assembly?.name).toBe('試作A組立');
    expect(restored.assembly?.components).toHaveLength(1);
    expect(restored.assemblyLibrary.attachments.get('part-1')?.shapes.get('shape')).toEqual(Uint8Array.of(1, 2, 3));
    expect(restored.assemblyUndoStack?.past).toHaveLength((before.assemblyUndoStack?.past.length ?? 0) + 1);
    useAppStore.getState().undo();
    expect(useAppStore.getState().assembly).toBe(before.assembly);
    expect((await repository.read(a.id)).point.sourceSha256).toBe(a.sourceSha256);
  });

  it('図面の作成・比較・復元は参照元一式を保ち、復元のUndoは1回', async () => {
    const data = storage(), repository = createNamedSavePoints(data), actions = createNamedSavePointActions(repository);
    const embedded = await embedDrawingSource(emptyDrawingSourceLibrary(), { sourceKind: 'part', document: createEmptyPartDocument() }, 'part.pcad', '');
    const one = createDrawingDocument('試作A図面', embedded.source), two = { ...one, name: '発注前図面', sheet: { ...one.sheet, scale: 2 } };
    useAppStore.setState({ saveDocumentEncoder: input => encodeSaveDocument(input) });
    useAppStore.getState().openDrawing(one, { sources: embedded.library });
    const a = await actions.create('試作A');
    useAppStore.getState().applyDrawing(two);
    const b = await actions.create('発注前');
    expect([a.kind, b.kind]).toEqual(['drawing', 'drawing']);
    const pair = await actions.comparison(a.id, b.id);
    const diff = await executeDefinitionDiffWork({ kind: 'compare', before: pair.before.bytes, after: pair.after.bytes,
      relationship: 'versions', documentKind: pair.before.documentKind });
    expect(diff.kind).toBe('compared');
    if (diff.kind !== 'compared') throw new Error('Comparison did not complete');
    expect(diff.result.changes.some(change => change.group === 'drawing-document' && change.status === 'changed')).toBe(true);
    const before = useAppStore.getState();
    await actions.restore(a.id);
    expect(useAppStore.getState().drawing?.name).toBe('試作A図面');
    expect(useAppStore.getState().drawingSources.sources).toHaveLength(1);
    expect(useAppStore.getState().drawingUndoStack?.past).toHaveLength((before.drawingUndoStack?.past.length ?? 0) + 1);
    useAppStore.getState().undo();
    expect(useAppStore.getState().drawing).toBe(before.drawing);
  });

  it('開いている文書と違う種類の保存点は復元せず、種類の違う2点は比較しない', async () => {
    const data = storage(), repository = createNamedSavePoints(data), actions = createNamedSavePointActions(repository);
    const a = part('A', 1), { library, first } = await assemblyFixture();
    const partPoint = await repository.create('部品', a.zip, 'part');
    useAppStore.setState({ saveDocumentEncoder: input => encodeSaveDocument(input) });
    useAppStore.getState().openAssembly(first, library);
    const assemblyPoint = await actions.create('組立');
    await expect(actions.restore(partPoint.id)).rejects.toMatchObject({ reason: 'invalid' });
    await expect(actions.comparison(partPoint.id, assemblyPoint.id)).rejects.toMatchObject({ reason: 'invalid' });
    expect(useAppStore.getState().assembly).toBe(first);
  });
});


it('createAndList encodes current attachments once and does not request another list', async () => {
  const data = storage(), repository = createNamedSavePoints(data), source = part('current', 8);
  const state = useAppStore.getState();
  state.setImportedAttachments(source.attachments.shapes, source.attachments.meshes);
  state.setCanvasImages(source.attachments.canvases);
  state.applyDocument(source.document, { replacesDocument: true });
  const encode = vi.fn(encodeSaveDocument);
  useAppStore.setState({ saveDocumentEncoder: encode });
  const before = useAppStore.getState(), list = vi.fn(repository.list.bind(repository));
  const create = vi.fn(repository.create.bind(repository)), createAndList = vi.fn(repository.createAndList.bind(repository));
  const actions = createNamedSavePointActions({ ...repository, list, create, createAndList });
  const result = await actions.createAndList('current');
  expect(encode).toHaveBeenCalledTimes(1); expect(createAndList).toHaveBeenCalledTimes(1);
  expect(create).not.toHaveBeenCalled(); expect(list).not.toHaveBeenCalled();
  expect(result.points).toEqual([result.point]); expect(useAppStore.getState()).toBe(before);
  const encoding = encode.mock.results[0];
  if (encoding.type !== 'return') throw new Error('Encoding did not return');
  const encoded = await encoding.value;
  expect((await repository.read(result.point.id)).bytes).toEqual(encoded);
});


it('real Worker createAndList dispatch verifies once and returns only after commit', async () => {
  const data = storage(), source = part('worker-create', 3);
  let loads = 0, commits = 0;
  let receive: (reply: PcadSavePointReply) => void = () => undefined;
  const response = new Promise<PcadSavePointReply>(resolve => { receive = resolve; });
  const scope: { onmessage: ((event: MessageEvent<PcadWorkerRequest>) => void) | null;
    postMessage: (reply: PcadSavePointReply) => void } = { onmessage: null, postMessage: receive };
  const observed: SavePointStorage = { ...data,
    async load() { loads += 1; return data.load(); },
    async commit(revision, change, signal) { await data.commit(revision, change, signal); commits += 1; },
  };
  vi.doMock('./namedSavePointStorage.js', () => ({ createIndexedDbSavePointStorage: () => observed }));
  vi.stubGlobal('self', scope);
  try {
    await import('../file/pcadSave.worker.js');
    scope.onmessage?.(new MessageEvent<PcadWorkerRequest>('message', { data: {
      id: 'create-list', kind: 'savePoint', operation: 'createAndList', name: 'worker-create', pointKind: 'part', bytes: source.zip,
    } }));
    const reply = await response;
    expect(loads).toBe(1); expect(commits).toBe(1);
    expect(reply).toEqual({ id: 'create-list', kind: 'savePointResult', operation: 'createAndList',
      point: data.points()[0], points: data.points() });
    const repository = createNamedSavePoints(data);
    expect((await repository.read(data.points()[0].id)).bytes).toEqual(source.zip);
  } finally { vi.doUnmock('./namedSavePointStorage.js'); vi.unstubAllGlobals(); vi.resetModules(); }
});
