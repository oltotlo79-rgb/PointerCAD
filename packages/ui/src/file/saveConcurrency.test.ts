import { createEmptyPartDocument } from '@pointercad/model';
import { readPcadFile, type AutoSaver } from '@pointercad/io';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createInitialDocumentState } from '../store/initialDocumentState.js';
import { useAppStore } from '../store/useAppStore.js';
import { createBrowserFileGateway, type FileGateway } from './fileGateway.js';
import { hasUnsavedChanges, savePart, type PartFileDeps } from './partFile.js';
import { SAVE_RECOVERY_COPY_MARKER } from './saveFailure.js';

function deferred<T>() {
  let resolve: (value: T) => void = () => { throw new Error('未初期化'); };
  let reject: (error: unknown) => void = () => { throw new Error('未初期化'); };
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const deps: PartFileDeps = { captureThumbnail: () => null, confirmDiscard: () => Promise.resolve(true), recentFilesStorage: null };
function saver(discard: AutoSaver['discard'] = vi.fn(() => Promise.resolve(undefined))): AutoSaver {
  return { discard, markDirty: () => undefined, saveNow: () => Promise.resolve(undefined), stop: () => undefined, readLatest: () => Promise.resolve(null) };
}
function delayedGateway() {
  const started = deferred<void>(), completed = deferred<string | null>();
  const gateway: FileGateway = { openPcad: () => Promise.resolve(null), hasSaveTarget: () => false,
    savePcad: async () => { started.resolve(); return completed.promise; } };
  useAppStore.setState({ fileGateway: gateway });
  return { started, completed };
}

beforeEach(() => {
  useAppStore.setState({ ...createInitialDocumentState(), assembly: null, drawing: null,
    activeDocumentId: crypto.randomUUID(), fileName: null, savedDocument: null, fileMessage: null, autoSaver: null });
});

describe('保存の完了を開始した文書へ結び付ける（レビュー R02）', () => {
  it.each(['success', 'failure'])('保存待機中に開いた別文書の名前・保存状態・控えを変えない（%s）', async (outcome) => {
    const delayed = delayedGateway();
    const pending = savePart(deps, false);
    await delayed.started.promise;
    const next = { ...createEmptyPartDocument(), name: '次の部品' };
    const discard = vi.fn(() => Promise.resolve(undefined));
    useAppStore.setState({ activeDocumentId: crypto.randomUUID(), document: next, savedDocument: next,
      fileName: 'B.pcad', fileMessage: null, autoSaver: saver(discard) });
    if (outcome === 'success') delayed.completed.resolve('A.pcad');
    else delayed.completed.reject(new Error('保存不能'));
    await pending;
    const state = useAppStore.getState();
    expect(state.fileName).toBe('B.pcad');
    expect(state.savedDocument).toBe(next);
    expect(state.fileMessage).toBeNull();
    expect(discard).not.toHaveBeenCalled();
  });

  it('同じ文書の保存待機中に追加した変更は未保存のまま保ち、控えを消さない', async () => {
    const delayed = delayedGateway(), discard = vi.fn(() => Promise.resolve(undefined));
    useAppStore.setState({ autoSaver: saver(discard) });
    const original = useAppStore.getState().document;
    const pending = savePart(deps, false);
    await delayed.started.promise;
    const edited = { ...original, name: '保存待機中の編集' };
    useAppStore.setState({ document: edited });
    delayed.completed.resolve('A.pcad'); await pending;
    const state = useAppStore.getState();
    expect(state.savedDocument).toBe(original);
    expect(state.document).toBe(edited);
    expect(hasUnsavedChanges(state.document, state.savedDocument)).toBe(true);
    expect(discard).not.toHaveBeenCalled();
  });

  it('保存を続けて押しても依頼順に書き、古い内容を後から上書きしない', async () => {
    const firstStarted = deferred<void>(), firstFinished = deferred<string | null>();
    const names: string[] = [];
    const gateway: FileGateway = { openPcad: () => Promise.resolve(null), hasSaveTarget: () => true,
      savePcad: async (_name, bytes) => {
        const decoded = readPcadFile(bytes);
        if (!decoded.ok) throw new Error(decoded.error.message);
        names.push(decoded.document.name);
        if (names.length === 1) { firstStarted.resolve(); return firstFinished.promise; }
        return 'A.pcad';
      } };
    const original = { ...createEmptyPartDocument(), name: '先の内容' };
    useAppStore.setState({ fileGateway: gateway, document: original });
    const first = savePart(deps, false); await firstStarted.promise;
    const edited = { ...original, name: '新しい内容' };
    useAppStore.setState({ document: edited });
    const second = savePart(deps, false);
    expect(names).toEqual(['先の内容']);
    firstFinished.resolve('A.pcad'); await Promise.all([first, second]);
    expect(names).toEqual(['先の内容', '新しい内容']);
    expect(useAppStore.getState().savedDocument).toBe(edited);
  });

  it('控え消去中に文書が替わったら旧形式の控えを追加消去しない', async () => {
    const delayed = delayedGateway(), discardStarted = deferred<void>(), discardFinished = deferred<void>();
    const discard = vi.fn(async () => { discardStarted.resolve(); await discardFinished.promise; });
    useAppStore.setState({ autoSaver: saver(discard) });
    const pending = savePart(deps, false); await delayed.started.promise;
    delayed.completed.resolve('A.pcad'); await discardStarted.promise;
    useAppStore.setState({ activeDocumentId: crypto.randomUUID() });
    discardFinished.resolve(); await pending;
    expect(discard).toHaveBeenCalledTimes(1);
    expect(useAppStore.getState().fileMessage).toBeNull();
  });

  it('手動保存は現行と旧形式の控えの削除を終えてから完了を表示する（Firefoxの即時再読込）', async () => {
    const delayed = delayedGateway();
    const clears = [
      { started: deferred<void>(), finished: deferred<void>() },
      { started: deferred<void>(), finished: deferred<void>() },
    ];
    let next = 0;
    const discard = vi.fn(async () => {
      const clear = clears[next++];
      if (!clear) throw new Error('予期しない控えの削除');
      clear.started.resolve();
      await clear.finished.promise;
    });
    useAppStore.setState({ autoSaver: saver(discard), fileMessage: { key: 'file.saved', failed: false } });
    const pending = savePart(deps, false);
    await delayed.started.promise;
    expect(useAppStore.getState().fileMessage).toBeNull();
    delayed.completed.resolve('A.pcad');
    await clears[0].started.promise;
    expect(useAppStore.getState().fileMessage).toBeNull();
    clears[0].finished.resolve();
    await clears[1].started.promise;
    expect(useAppStore.getState().fileMessage).toBeNull();
    clears[1].finished.resolve();
    await pending;
    expect(useAppStore.getState().fileMessage).toEqual({ key: 'file.saved', failed: false });
  });

  it('控えの削除待機中の編集には古い保存完了を表示せず、新しい控えも消さない', async () => {
    const delayed = delayedGateway(), started = deferred<void>(), finished = deferred<void>();
    const discard = vi.fn(async () => { started.resolve(); await finished.promise; });
    useAppStore.setState({ autoSaver: saver(discard) });
    const pending = savePart(deps, false);
    await delayed.started.promise;
    delayed.completed.resolve('A.pcad');
    await started.promise;
    const state = useAppStore.getState();
    useAppStore.setState({ document: { ...state.document, name: '削除待機中の編集' }, documentVersion: state.documentVersion + 1 });
    finished.resolve();
    await pending;
    expect(discard).toHaveBeenCalledTimes(1);
    expect(useAppStore.getState().fileMessage).toBeNull();
    expect(hasUnsavedChanges(useAppStore.getState().document, useAppStore.getState().savedDocument)).toBe(true);
  });

  it('復元失敗の控えが残ったときは通常の失敗より詳しい案内を出す', async () => {
    const delayed = delayedGateway();
    const pending = savePart(deps, false); await delayed.started.promise;
    delayed.completed.reject(new Error(`${SAVE_RECOVERY_COPY_MARKER} retained`)); await pending;
    expect(useAppStore.getState().fileMessage).toEqual({ key: 'file.saveRecoveryCopyRetained', failed: true });
    expect(useAppStore.getState().savedDocument).toBeNull();
  });
});

describe('ブラウザの保存先も古い非同期完了で戻さない（レビュー R02）', () => {
  it('close 待機中に解除した保存先は復活しない', async () => {
    const closing = deferred<void>(), finished = deferred<void>();
    const gateway = createBrowserFileGateway({ showSaveFilePicker: () => Promise.resolve({ name: 'A.pcad',
      createWritable: () => Promise.resolve({ write: () => Promise.resolve(undefined), close: async () => { closing.resolve(); await finished.promise; } }) }) });
    const pending = gateway.savePcad('A.pcad', Uint8Array.of(1), true); await closing.promise;
    gateway.clearSaveTarget?.(); finished.resolve();
    expect(await pending).toBeNull(); expect(gateway.hasSaveTarget()).toBe(false);
  });

  it('新しい文書で確定した保存先は古い close の完了後も保たれる', async () => {
    const closing = deferred<void>(), finished = deferred<void>();
    const written: string[] = [];
    // 実際のFileでsize/arrayBufferの契約を共有し、読込前のサイズ検査をすり抜けるmockを作らない。
    const handle = (name: string) => ({ name, getFile: () => Promise.resolve(new File([], name)),
      createWritable: () => Promise.resolve({ write: () => { written.push(name); return Promise.resolve(); }, close: async () => {
        if (name === 'A.pcad') { closing.resolve(); await finished.promise; }
      } }) });
    const gateway = createBrowserFileGateway({ showSaveFilePicker: () => Promise.resolve(handle('A.pcad')),
      showOpenFilePicker: () => Promise.resolve([handle('B.pcad')]) });
    const pending = gateway.savePcad('A.pcad', Uint8Array.of(1), true); await closing.promise;
    gateway.clearSaveTarget?.();
    const opened = await gateway.openPcad();
    if (opened?.saveTargetToken == null) throw new Error('検証する保存先が必要');
    await gateway.confirmSaveTarget?.(opened.saveTargetToken);
    finished.resolve(); expect(await pending).toBeNull();
    await gateway.savePcad('B.pcad', Uint8Array.of(2), false);
    expect(written).toEqual(['A.pcad', 'B.pcad']);
  });
});
