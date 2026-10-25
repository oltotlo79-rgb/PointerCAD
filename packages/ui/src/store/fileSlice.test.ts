import { vi } from 'vitest';
import { createSecureUuid, documentSessionId, prepareDocumentSession, PreparedDocumentSession, SecurePartIdentityError } from './fileSlice.js';
/** ファイル・自動保存。useAppStore.test.ts から責務単位で移した回帰テスト。 */

import {
  absoluteCoordinate,
  createEmptyPartDocument,
} from '@pointercad/model';
import { encodeSaveDocument } from '@pointercad/io';
import type {
  AutoSaver,
} from '@pointercad/io';
import {
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';
import {
  useAppStore,
} from './useAppStore.js';
import {
  resetTestStore,
  partWithPoint,
} from './testing/createTestStore.js';
import { activeHasUnsavedChanges } from '../file/assemblyFile.js';
import { createDefaultPartFileDeps } from '../file/partFile.js';
import type { FileGateway } from '../file/fileGateway.js';

beforeEach(() => { resetTestStore(); useAppStore.setState({ saveDocumentEncoder: encodeSaveDocument, documentSaveOperation: null }); });

describe('ファイルまわりの状態(FR-806、計画書 タスク23)', () => {
  it('起動直後は名前も保存済みの文書も無く、口だけが用意されている', () => {
    const state = useAppStore.getState();
    expect(state.fileName).toBeNull();
    expect(state.savedDocument).toBeNull();
    expect(state.captureThumbnail).toBeNull();
    expect(state.fileMessage).toBeNull();
    expect(state.fileGateway.hasSaveTarget()).toBe(false);
  });

  it('読み書きの口を差し替えられる(デスクトップ版が使う)', () => {
    const gateway = {
      openPcad: () => Promise.resolve(null),
      savePcad: () => Promise.resolve(null),
      hasSaveTarget: () => true,
    };
    useAppStore.getState().setFileGateway(gateway);
    expect(useAppStore.getState().fileGateway).toBe(gateway);
  });

  it('ファイル名と保存済みの文書を入れられる', () => {
    const document = createEmptyPartDocument();
    useAppStore.getState().setFileState('部品1.pcad', document);

    const state = useAppStore.getState();
    expect(state.fileName).toBe('部品1.pcad');
    expect(state.savedDocument).toBe(document);
  });

  it('サムネイルの作り手を差し出し、取り下げられる(ビューポートが使う)', () => {
    const png = new Uint8Array([1, 2, 3]);
    useAppStore.getState().setCaptureThumbnail(() => png);
    expect(useAppStore.getState().captureThumbnail?.()).toBe(png);

    useAppStore.getState().setCaptureThumbnail(null);
    expect(useAppStore.getState().captureThumbnail).toBeNull();
  });

  it('文書が変わるとファイル操作の知らせは消える(古い返事を残さない)', () => {
    useAppStore.getState().setFileMessage({ key: 'file.saved', failed: false });
    expect(useAppStore.getState().fileMessage).not.toBeNull();

    useAppStore.getState().applyDocument(partWithPoint());
    expect(useAppStore.getState().fileMessage).toBeNull();
  });

  it('保存・開くなどが成功すると、古い断り(面・立体)は消える(§0.a-0.23 ⑦)', () => {
    useAppStore.getState().setFaceError('face.error.emptySelection');
    useAppStore.getState().setSolidError('solidError.noFace');

    useAppStore.getState().setFileMessage({ key: 'file.saved', failed: false });

    const state = useAppStore.getState();
    expect(state.faceErrorKey).toBeNull();
    expect(state.solidErrorKey).toBeNull();
  });

  it('保存などが失敗したときは古い断りを残す(まだ解消していない、§0.a-0.23 ⑦)', () => {
    useAppStore.getState().setSolidError('solidError.noFace');
    useAppStore.getState().setFileMessage({ key: 'file.saveFailed', failed: true });
    expect(useAppStore.getState().solidErrorKey).toBe('solidError.noFace');
  });

  it('文書が変わったときも古い断りは消える(§0.a-0.23 ⑦)', () => {
    useAppStore.getState().setFaceError('face.error.emptySelection');
    useAppStore.getState().applyDocument(partWithPoint());
    expect(useAppStore.getState().faceErrorKey).toBeNull();
  });

  it('元に戻す・やり直すでも知らせは消える', () => {
    useAppStore.getState().applyDocument(partWithPoint());
    useAppStore.getState().setFileMessage({ key: 'file.saved', failed: false });

    useAppStore.getState().undo();
    expect(useAppStore.getState().fileMessage).toBeNull();

    useAppStore.getState().setFileMessage({ key: 'file.saved', failed: false });
    useAppStore.getState().redo();
    expect(useAppStore.getState().fileMessage).toBeNull();
  });

  it('新しくやり直すと履歴のスタックごと作り直され、取りかけも残らない', () => {
    useAppStore.getState().applyDocument(partWithPoint());
    useAppStore.getState().setSelection(['point-1']);
    useAppStore.getState().setActiveTool('line');
    useAppStore.getState().setPendingStart(absoluteCoordinate(0, 0, 0));
    expect(useAppStore.getState().canUndo).toBe(true);

    const next = createEmptyPartDocument();
    useAppStore.getState().resetDocument(next);

    const state = useAppStore.getState();
    expect(state.document).toBe(next);
    expect(state.undoStack.past).toEqual([]);
    expect(state.undoStack.future).toEqual([]);
    expect(state.canUndo).toBe(false);
    expect(state.canRedo).toBe(false);
    expect(state.selection).toEqual([]);
    expect(state.activeTool).toBe('select');
    expect(state.pendingStart).toBeNull();
    expect(state.errorMessage).toBeNull();
  });
});

describe('自動保存まわりの状態(FR-805、計画書 タスク24)', () => {
  /** 何も書かない偽の控え係。ここで確かめるのは「差し出せて取り下げられる」ことだけ。 */
  function createFakeAutoSaver(): AutoSaver {
    return {
      markDirty: () => undefined,
      saveNow: () => Promise.resolve(),
      stop: () => undefined,
      readLatest: () => Promise.resolve(null),
      discard: () => Promise.resolve(),
    };
  }

  it('起動直後は控え係も復元の案内も無い', () => {
    const state = useAppStore.getState();
    expect(state.autoSaver).toBeNull();
    expect(state.restorePrompt).toBeNull();
  });

  it('控え係を差し出し、取り下げられる', () => {
    const saver = createFakeAutoSaver();
    useAppStore.getState().setAutoSaver(saver);
    expect(useAppStore.getState().autoSaver).toBe(saver);

    useAppStore.getState().setAutoSaver(null);
    expect(useAppStore.getState().autoSaver).toBeNull();
  });

  it('復元の案内を出し、閉じられる', () => {
    const prompt = { savedAt: '2026-09-03T09:30:00.000Z', documentName: '部品1' };
    useAppStore.getState().setRestorePrompt(prompt);
    expect(useAppStore.getState().restorePrompt).toEqual(prompt);

    useAppStore.getState().setRestorePrompt(null);
    expect(useAppStore.getState().restorePrompt).toBeNull();
  });
});

describe('保存していない変更の確認を画面の中の日本語の3択で聞く(w91a)', () => {
  it('答えるまで待ち、答えたら閉じる。新しい確認は前の確認を「戻る」で終える', async () => {
    const first = useAppStore.getState().requestDiscardConfirm('file.discardConfirm');
    expect(useAppStore.getState().discardConfirm?.messageKey).toBe('file.discardConfirm');
    const second = useAppStore.getState().requestDiscardConfirm('file.openChangedWhileReading');
    await expect(first).resolves.toBe('cancel');
    expect(useAppStore.getState().discardConfirm?.messageKey).toBe('file.openChangedWhileReading');

    useAppStore.getState().answerDiscardConfirm('discard');
    await expect(second).resolves.toBe('discard');
    expect(useAppStore.getState().discardConfirm).toBeNull();
    // 確認が無いときの答えは何もしない(二度押しで次の確認へ答えを渡さない)。
    useAppStore.getState().answerDiscardConfirm('save');
    expect(useAppStore.getState().discardConfirm).toBeNull();
  });

  it.each([['discard', true], ['cancel', false]] as const)(
    '画面から呼ぶ既定の口は、答え %s を進めるかどうか(%s)へ直す',
    async (choice, proceed) => {
      useAppStore.getState().applyDocument(partWithPoint());
      const answer = createDefaultPartFileDeps().confirmDiscard('file.discardConfirm');
      expect(useAppStore.getState().discardConfirm?.messageKey).toBe('file.discardConfirm');
      useAppStore.getState().answerDiscardConfirm(choice);
      await expect(answer).resolves.toBe(proceed);
      expect(activeHasUnsavedChanges(useAppStore.getState())).toBe(true);
    },
  );

  it('「保存して続ける」は保存できたときだけ進め、保存を取り消したら変更を残して止まる', async () => {
    const saved: string[] = [];
    let accept = false;
    const gateway: FileGateway = {
      openPcad: () => Promise.resolve(null),
      savePcad: (suggestedName) => {
        if (!accept) return Promise.resolve(null);
        saved.push(suggestedName);
        return Promise.resolve(suggestedName);
      },
      hasSaveTarget: () => false,
    };
    useAppStore.getState().setFileGateway(gateway);
    useAppStore.getState().applyDocument(partWithPoint());
    const deps = createDefaultPartFileDeps();

    const cancelled = deps.confirmDiscard('file.discardConfirm');
    useAppStore.getState().answerDiscardConfirm('save');
    await expect(cancelled).resolves.toBe(false);
    expect(saved).toEqual([]);
    expect(activeHasUnsavedChanges(useAppStore.getState())).toBe(true);

    accept = true;
    const confirmed = deps.confirmDiscard('file.discardConfirm');
    useAppStore.getState().answerDiscardConfirm('save');
    await expect(confirmed).resolves.toBe(true);
    expect(saved).toHaveLength(1);
    expect(activeHasUnsavedChanges(useAppStore.getState())).toBe(false);
  });
});

describe('owner-bound legacy source confirmation', () => {
  const request = (requestId: string, isCurrent: () => boolean = () => true) => ({
    requestId, sourceName: 'Original part', fileName: 'selected.pcad',
    occurrenceCount: 3, countComplete: true, isCurrent,
  });

  it('old approval and cancellation cannot settle a newer same-document request', async () => {
    const old = useAppStore.getState().requestPartSourceConfirm(request('old'));
    const next = useAppStore.getState().requestPartSourceConfirm(request('new'));
    expect(await old).toBe(false);
    const pending = useAppStore.getState().partSourceConfirm;
    useAppStore.getState().answerPartSourceConfirm('old', true);
    expect(useAppStore.getState().partSourceConfirm).toBe(pending);
    useAppStore.getState().answerPartSourceConfirm('old', false);
    expect(useAppStore.getState().partSourceConfirm).toBe(pending);
    useAppStore.getState().answerPartSourceConfirm('new', true);
    expect(await next).toBe(true);
    expect(useAppStore.getState().partSourceConfirm).toBeNull();
  });

  it('a real part-document switch refuses approval from the old owner', async () => {
    const owner = useAppStore.getState().activeDocumentId;
    const pending = useAppStore.getState().requestPartSourceConfirm(request('owner',
      () => useAppStore.getState().activeDocumentId === owner));
    useAppStore.getState().resetDocument({ ...createEmptyPartDocument(), name: 'New owner' });
    expect(useAppStore.getState().activeDocumentId).not.toBe(owner);
    useAppStore.getState().answerPartSourceConfirm('owner', true);
    expect(await pending).toBe(false);
    expect(useAppStore.getState().document.name).toBe('New owner');
    expect(useAppStore.getState().canUndo).toBe(false);
  });

  it('cancellation and an invalid owner never authorize replacement', async () => {
    const cancelled = useAppStore.getState().requestPartSourceConfirm(request('cancel'));
    useAppStore.getState().answerPartSourceConfirm('cancel', false);
    expect(await cancelled).toBe(false);
    const invalid = useAppStore.getState().requestPartSourceConfirm(request('invalid', () => false));
    expect(await invalid).toBe(false);
    expect(useAppStore.getState().partSourceConfirm).toBeNull();
  });
});

describe('invalid incoming confirmation and synchronous newer owner', () => {
  const request = (requestId: string, isCurrent: () => boolean = () => true) => ({
    requestId, sourceName: 'Original', fileName: 'input.pcad', occurrenceCount: 2, countComplete: true, isCurrent,
  });
  it('invalid incoming settles both promises and removes the old visible state', async () => {
    const old = useAppStore.getState().requestPartSourceConfirm(request('old-valid'));
    const invalid = useAppStore.getState().requestPartSourceConfirm(request('invalid', () => false));
    expect(await old).toBe(false);
    expect(await invalid).toBe(false);
    expect(useAppStore.getState().partSourceConfirm).toBeNull();
  });
  it('a newer real store request installed during cancellation survives the outer incoming request', async () => {
    const old = useAppStore.getState().requestPartSourceConfirm(request('outer-old'));
    let newer: Promise<boolean> | undefined;
    let installed = false;
    const unsubscribe = useAppStore.subscribe(state => {
      if (!installed && state.partSourceConfirm === null) {
        installed = true;
        newer = state.requestPartSourceConfirm(request('reentrant-new'));
      }
    });
    try {
      const incoming = useAppStore.getState().requestPartSourceConfirm(request('outer-incoming'));
      expect(await old).toBe(false);
      expect(await incoming).toBe(false);
      expect(useAppStore.getState().partSourceConfirm?.requestId).toBe('reentrant-new');
      useAppStore.getState().answerPartSourceConfirm('outer-old', true);
      useAppStore.getState().answerPartSourceConfirm('outer-incoming', false);
      expect(useAppStore.getState().partSourceConfirm?.requestId).toBe('reentrant-new');
      useAppStore.getState().answerPartSourceConfirm('reentrant-new', false);
      if (newer === undefined) throw new Error('Actual synchronous request required');
      expect(await newer).toBe(false);
    } finally {
      unsubscribe();
      useAppStore.getState().answerPartSourceConfirm('reentrant-new', false);
      if (newer !== undefined) await newer;
    }
  });
});

describe('throwing confirmation owner predicate fails closed', () => {
  const request = (requestId: string, isCurrent: () => boolean = () => true) => ({
    requestId, sourceName: 'Original', fileName: 'input.pcad', occurrenceCount: 1, countComplete: true, isCurrent,
  });
  it('throwing incoming clears the old displayed owner and settles both false', async () => {
    const old = useAppStore.getState().requestPartSourceConfirm(request('old-before-throw'));
    const incoming = useAppStore.getState().requestPartSourceConfirm(request('incoming-throw', () => { throw new Error('predicate'); }));
    expect(await old).toBe(false);
    expect(await incoming).toBe(false);
    expect(useAppStore.getState().partSourceConfirm).toBeNull();
  });
  it('throwing approval cannot leave an unresolved request or remove a synchronous newer owner', async () => {
    let throwNow = false;
    const old = useAppStore.getState().requestPartSourceConfirm(request('answer-throw', () => {
      if (throwNow) throw new Error('predicate');
      return true;
    }));
    let newer: Promise<boolean> | undefined;
    let installed = false;
    const unsubscribe = useAppStore.subscribe(state => {
      if (!installed && state.partSourceConfirm === null) {
        installed = true;
        newer = state.requestPartSourceConfirm(request('new-after-throw'));
      }
    });
    try {
      throwNow = true;
      expect(() => useAppStore.getState().answerPartSourceConfirm('answer-throw', true)).not.toThrow();
      expect(await old).toBe(false);
      expect(useAppStore.getState().partSourceConfirm?.requestId).toBe('new-after-throw');
      useAppStore.getState().answerPartSourceConfirm('answer-throw', false);
      expect(useAppStore.getState().partSourceConfirm?.requestId).toBe('new-after-throw');
    } finally {
      unsubscribe();
      useAppStore.getState().answerPartSourceConfirm('new-after-throw', false);
    }
    if (newer === undefined) throw new Error('Actual newer store request required');
    expect(await newer).toBe(false);
  });
});

describe('nominal secure prepared session runtime contract', () => {
  it('real fallback generates distinct strict v4 IDs and a reusable nominal session', () => {
    const entropy = globalThis.crypto;
    vi.stubGlobal('crypto', { getRandomValues: entropy.getRandomValues.bind(entropy) });
    try {
      const first = createSecureUuid();
      const second = createSecureUuid();
      const format = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
      expect(first).toMatch(format);
      expect(second).toMatch(format);
      expect(second).not.toBe(first);
      const prepared = prepareDocumentSession();
      expect(prepared.id).toMatch(format);
      vi.stubGlobal('crypto', {});
      expect(documentSessionId(prepared)).toBe(prepared.id);
      expect(documentSessionId(prepared)).toBe(prepared.id);
    } finally { vi.unstubAllGlobals(); }
  });
  it('missing entropy and forged nominal prototypes cannot produce a usable session or mutate the store', () => {
    const before = useAppStore.getState();
    vi.stubGlobal('crypto', {});
    try {
      expect(() => prepareDocumentSession()).toThrow(SecurePartIdentityError);
      expect(() => documentSessionId()).toThrow(SecurePartIdentityError);
      expect(() => { Reflect.apply(documentSessionId, undefined, [{ id: 'forged' }]); }).toThrow(SecurePartIdentityError);
      const forgedPrototype = {};
      Object.setPrototypeOf(forgedPrototype, PreparedDocumentSession.prototype);
      expect(() => { Reflect.apply(documentSessionId, undefined, [forgedPrototype]); }).toThrow(SecurePartIdentityError);
      expect(() => { Reflect.apply(documentSessionId, undefined, [null]); }).toThrow(SecurePartIdentityError);
      expect(useAppStore.getState()).toBe(before);
      expect(useAppStore.getState()).toEqual(before);
    } finally { vi.unstubAllGlobals(); }
  });
});
