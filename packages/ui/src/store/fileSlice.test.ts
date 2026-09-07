/** ファイル・自動保存。useAppStore.test.ts から責務単位で移した回帰テスト。 */

import {
  absoluteCoordinate,
  createEmptyPartDocument,
} from '@pointercad/model';
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

beforeEach(resetTestStore);

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
