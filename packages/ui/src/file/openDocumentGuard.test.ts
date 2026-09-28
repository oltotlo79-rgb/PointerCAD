/**
 * 開く(組立・図面)の読込の待ちの間に文書が変わったときの採用判定の回帰検査
 * (docs/review-2026-09-28-codex.md R02・§6.1 の1、付録C の再現を公開入口から移したもの)。
 *
 * 読込(`readDocumentBundle`・`readDrawingBundle`)は実物を使い、その前で待たせる口だけを
 * 足す。待たせない限り実物と同じに動く。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  addComponent, createAssemblyDocument, createComponentFor, createDrawingDocument, createEmptyPartDocument,
  embedDrawingSource, embedPart, EMPTY_PART_LIBRARY, emptyDrawingSourceLibrary,
} from '@pointercad/model';

import { resetTestStore } from '../store/testing/createTestStore.js';
import { useAppStore } from '../store/useAppStore.js';
import { activeHasUnsavedChanges, openAssembly } from './assemblyFile.js';
import type { FileGateway, PickedFile } from './fileGateway.js';
import { openPart, savePart, type PartFileDeps } from './partFile.js';

const readGate = vi.hoisted(() => ({
  hold: null as Promise<void> | null,
  entered: 0,
}));

vi.mock('@pointercad/io', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@pointercad/io')>();
  async function gate(): Promise<void> {
    readGate.entered += 1;
    if (readGate.hold !== null) await readGate.hold;
  }
  return {
    ...actual,
    readDocumentBundle: async (...args: Parameters<typeof actual.readDocumentBundle>) => {
      await gate();
      return actual.readDocumentBundle(...args);
    },
    readDrawingBundle: async (...args: Parameters<typeof actual.readDrawingBundle>) => {
      await gate();
      return actual.readDrawingBundle(...args);
    },
  };
});

function deferred<T>() {
  let resolve: (value: T) => void = () => { throw new Error('Not initialized'); };
  const promise = new Promise<T>((callback) => { resolve = callback; });
  return { promise, resolve };
}

beforeEach(() => {
  resetTestStore();
  readGate.hold = null;
  readGate.entered = 0;
});

/** 読込の前で待たせる。返す関数を呼ぶと続きが走る。 */
function holdReads(): () => void {
  const release = deferred<undefined>();
  readGate.hold = release.promise;
  return () => { readGate.hold = null; release.resolve(undefined); };
}

function gateway() {
  let saved: PickedFile | null = null;
  let target = false;
  const savePcad = vi.fn<FileGateway['savePcad']>((name, bytes) => {
    saved = { name, bytes, saveTargetToken: 'saved-target' };
    target = true;
    return Promise.resolve(name);
  });
  const openPcad = vi.fn<FileGateway['openPcad']>(() => Promise.resolve(saved));
  const confirmSaveTarget = vi.fn<NonNullable<FileGateway['confirmSaveTarget']>>(() => {
    target = true;
    return Promise.resolve();
  });
  const clearSaveTarget = vi.fn(() => { target = false; });
  const value: FileGateway = { savePcad, openPcad, confirmSaveTarget, clearSaveTarget, hasSaveTarget: () => target };
  useAppStore.setState({ fileGateway: value });
  return { savePcad, openPcad, confirmSaveTarget, clearSaveTarget };
}

function depsWith(confirmDiscard: PartFileDeps['confirmDiscard']): PartFileDeps {
  return { captureThumbnail: () => null, confirmDiscard, recentFilesStorage: null };
}

/** 部品を 1 つ置いた組立を保存し、その組立を開いたままにする。 */
async function savedAssembly() {
  const g = gateway();
  const embedded = await embedPart(EMPTY_PART_LIBRARY, createEmptyPartDocument(), 'a.pcad', './a.pcad');
  const empty = createAssemblyDocument('保存した組立');
  const document = addComponent(empty, createComponentFor(empty, { kind: 'part', partRef: embedded.partRef }));
  useAppStore.getState().openAssembly(empty);
  useAppStore.getState().applyAssembly(document, embedded.library);
  await savePart(depsWith(() => Promise.resolve(true)), false);
  expect(activeHasUnsavedChanges(useAppStore.getState())).toBe(false);
  g.confirmSaveTarget.mockClear();
  g.clearSaveTarget.mockClear();
  return { g, document };
}

async function startOpeningAssembly(deps: PartFileDeps): Promise<{ opening: Promise<void>; release: () => void }> {
  const release = holdReads();
  const opening = openAssembly(deps);
  await vi.waitFor(() => { expect(readGate.entered).toBe(1); });
  return { opening, release };
}

describe('組立を開く読込の間の変化(R02)', () => {
  it('読込中に同じ組立を編集し、改めての確認で断ったら、文書・取り消し・保存先を保つ', async () => {
    const { g, document } = await savedAssembly();
    const confirmDiscard = vi.fn<PartFileDeps['confirmDiscard']>(() => Promise.resolve(false));
    const { opening, release } = await startOpeningAssembly(depsWith(confirmDiscard));
    const version = useAppStore.getState().documentVersion;
    useAppStore.getState().applyAssembly({ ...document, name: '読込中の編集' });
    const edited = useAppStore.getState();
    expect(edited.documentVersion).toBe(version);
    release();
    await opening;
    const after = useAppStore.getState();
    expect(confirmDiscard).toHaveBeenCalledExactlyOnceWith('file.openChangedWhileReading');
    expect(after.activeDocumentId).toBe(edited.activeDocumentId);
    expect(after.assembly).toBe(edited.assembly);
    expect(after.assembly?.name).toBe('読込中の編集');
    expect(after.assemblyUndoStack).toBe(edited.assemblyUndoStack);
    expect(after.canUndo).toBe(true);
    expect(after.savedAssembly).toBe(edited.savedAssembly);
    expect(g.confirmSaveTarget).not.toHaveBeenCalled();
    expect(g.clearSaveTarget).not.toHaveBeenCalled();
  });

  it('読込中に取り消し(Undo)をしても改めて確認し、断れば履歴を作り直さない', async () => {
    const { g } = await savedAssembly();
    const confirmDiscard = vi.fn<PartFileDeps['confirmDiscard']>(() => Promise.resolve(false));
    const { opening, release } = await startOpeningAssembly(depsWith(confirmDiscard));
    useAppStore.getState().undo();
    const undone = useAppStore.getState();
    expect(undone.canRedo).toBe(true);
    release();
    await opening;
    const after = useAppStore.getState();
    expect(confirmDiscard).toHaveBeenCalledExactlyOnceWith('file.openChangedWhileReading');
    expect(after.assembly).toBe(undone.assembly);
    expect(after.assemblyUndoStack).toBe(undone.assemblyUndoStack);
    expect(after.canRedo).toBe(true);
    expect(g.confirmSaveTarget).not.toHaveBeenCalled();
  });

  it('改めての確認で続けると、選んだ組立を開いて保存先を確定する', async () => {
    const { g, document } = await savedAssembly();
    const confirmDiscard = vi.fn<PartFileDeps['confirmDiscard']>(() => Promise.resolve(true));
    const { opening, release } = await startOpeningAssembly(depsWith(confirmDiscard));
    useAppStore.getState().applyAssembly({ ...document, name: '読込中の編集' });
    release();
    await opening;
    expect(confirmDiscard).toHaveBeenCalledExactlyOnceWith('file.openChangedWhileReading');
    expect(useAppStore.getState().assembly?.name).toBe('保存した組立');
    expect(g.confirmSaveTarget).toHaveBeenCalledExactlyOnceWith('saved-target');
  });

  it('何も変わらなければ確認を出さずに開く', async () => {
    const { g } = await savedAssembly();
    const confirmDiscard = vi.fn<PartFileDeps['confirmDiscard']>(() => Promise.resolve(false));
    const { opening, release } = await startOpeningAssembly(depsWith(confirmDiscard));
    release();
    await opening;
    expect(confirmDiscard).not.toHaveBeenCalled();
    expect(useAppStore.getState().assembly?.name).toBe('保存した組立');
    expect(g.confirmSaveTarget).toHaveBeenCalledExactlyOnceWith('saved-target');
  });

  it('読込中に別の文書へ切り替わったら開くのをやめ、理由を出す', async () => {
    const { g } = await savedAssembly();
    const confirmDiscard = vi.fn<PartFileDeps['confirmDiscard']>(() => Promise.resolve(true));
    const { opening, release } = await startOpeningAssembly(depsWith(confirmDiscard));
    useAppStore.getState().closeAssembly();
    const switched = useAppStore.getState();
    g.clearSaveTarget.mockClear();
    release();
    await opening;
    const after = useAppStore.getState();
    expect(after.assembly).toBeNull();
    expect(after.activeDocumentId).toBe(switched.activeDocumentId);
    expect(after.fileMessage).toEqual({ key: 'file.openStopped', failed: true });
    expect(confirmDiscard).not.toHaveBeenCalled();
    expect(g.confirmSaveTarget).not.toHaveBeenCalled();
    expect(g.clearSaveTarget).not.toHaveBeenCalled();
  });

  it('改めての確認に答えるまでの間にさらに変わったら、開くのをやめる', async () => {
    const { g, document } = await savedAssembly();
    const answer = deferred<boolean>();
    const confirmDiscard = vi.fn<PartFileDeps['confirmDiscard']>(() => answer.promise);
    const { opening, release } = await startOpeningAssembly(depsWith(confirmDiscard));
    useAppStore.getState().applyAssembly({ ...document, name: '一度目の編集' });
    release();
    await vi.waitFor(() => { expect(confirmDiscard).toHaveBeenCalledOnce(); });
    useAppStore.getState().applyAssembly({ ...document, name: '二度目の編集' });
    const edited = useAppStore.getState();
    answer.resolve(true);
    await opening;
    const after = useAppStore.getState();
    expect(after.assembly).toBe(edited.assembly);
    expect(after.assemblyUndoStack).toBe(edited.assemblyUndoStack);
    expect(after.fileMessage).toEqual({ key: 'file.openStopped', failed: true });
    expect(g.confirmSaveTarget).not.toHaveBeenCalled();
  });
});

describe('図面を開く読込の間の変化(R02 と同じ型)', () => {
  it('読込中に部品を版の番号が増えない形で編集したら、改めて確認し、断れば部品を保つ', async () => {
    const g = gateway();
    const source = { sourceKind: 'part' as const, document: createEmptyPartDocument() };
    const embedded = await embedDrawingSource(emptyDrawingSourceLibrary(), source, 'part.pcad', '');
    useAppStore.getState().openDrawing(createDrawingDocument('試験図面', embedded.source), { sources: embedded.library });
    await savePart(depsWith(() => Promise.resolve(true)), false);
    useAppStore.getState().closeDrawing();
    g.confirmSaveTarget.mockClear();
    const confirmDiscard = vi.fn<PartFileDeps['confirmDiscard']>(() => Promise.resolve(false));
    const release = holdReads();
    const opening = openPart(depsWith(confirmDiscard));
    await vi.waitFor(() => { expect(readGate.entered).toBe(1); });
    const version = useAppStore.getState().documentVersion;
    const state = useAppStore.getState();
    state.applyDocument({ ...state.document, name: '読込中の部品の編集' }, { coalesceKey: 'name' });
    const edited = useAppStore.getState();
    expect(edited.documentVersion).toBe(version);
    release();
    await opening;
    const after = useAppStore.getState();
    expect(confirmDiscard).toHaveBeenCalledExactlyOnceWith('file.openChangedWhileReading');
    expect(after.drawing).toBeNull();
    expect(after.document).toBe(edited.document);
    expect(after.undoStack).toBe(edited.undoStack);
    expect(g.confirmSaveTarget).not.toHaveBeenCalled();
  });
});

describe('保存の完了の知らせ(同じ型: 版の番号だけの照合)', () => {
  it('控えの削除を待つ間に版の番号が増えない編集をしたら「保存しました」を出さない', async () => {
    const g = gateway();
    const started = deferred<undefined>();
    const finished = deferred<undefined>();
    const discard = vi.fn(async () => { started.resolve(undefined); await finished.promise; });
    useAppStore.setState({ autoSaver: { discard, markDirty: () => undefined, saveNow: () => Promise.resolve(undefined),
      stop: () => undefined, readLatest: () => Promise.resolve(null) } });
    const saving = savePart(depsWith(() => Promise.resolve(true)), false);
    await started.promise;
    expect(g.savePcad).toHaveBeenCalledOnce();
    const version = useAppStore.getState().documentVersion;
    const state = useAppStore.getState();
    state.applyDocument({ ...state.document, name: '削除待ちの間の編集' }, { coalesceKey: 'name' });
    expect(useAppStore.getState().documentVersion).toBe(version);
    finished.resolve(undefined);
    await saving;
    expect(useAppStore.getState().fileMessage).toBeNull();
  });
});
