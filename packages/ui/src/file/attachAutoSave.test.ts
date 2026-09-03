/**
 * 自動保存の見張りとクラッシュ復元の検査(計画書 docs/plans/P2-ソリッド基礎.md タスク24
 * 手順7、「検証」の表)。
 *
 * ブラウザの API は使わない。保管庫は記憶上の偽物、時計とタイマーは `packages/io` の
 * `createAutoSaver` の差し替え口から注入し、時間は手で進める。IndexedDB そのものの
 * 読み書きは Node では確かめられないので E2E(タスク27)へ送る
 * (docs/報告記録.md 2026-09-02 14:50 の④と同じ理由)。
 */

import {
  AUTO_SAVE_INTERVAL_MS,
  createAutoSaver,
  readPcadFile,
  writePcadFile,
  type AutoSaveRecord,
  type AutoSaver,
  type AutoSaveStorage,
  type AutoSaveTimerHandle,
} from '@pointercad/io';
import {
  absoluteCoordinate,
  appendFeature,
  createEmptyPartDocument,
  createEmptySketchDocument,
  createPointFeature,
  replaceSketch,
  type PartDocument,
} from '@pointercad/model';
import { beforeEach, describe, expect, it } from 'vitest';

import { createInitialDocumentState, useAppStore } from '../store/useAppStore.js';
import {
  attachAutoSave,
  createAutoSaveStorageForBrowser,
  createUnsavedOnlyStorage,
  discardAutoSave,
  formatSavedAt,
  loadAutoSavePrompt,
  restoreAutoSave,
  startAutoSave,
  type VisibilityTarget,
} from './attachAutoSave.js';

/** 検査で保存時刻を固定する。 */
const SAVED_AT = '2026-09-03T09:30:00.000Z';
const FIXED_NOW = new Date(SAVED_AT).getTime();

/** 点を 1 つかいた部品。空の部品と中身が違うので「保存していない変更」になる。 */
function partWithPoint(): PartDocument {
  const sketch = createEmptySketchDocument();
  const drawn = appendFeature(sketch, createPointFeature(sketch, absoluteCoordinate(1, 2, 3)));
  return replaceSketch(createEmptyPartDocument(), drawn);
}

/** 待っている書き込みが片付くまで、いったん実行を手放す。 */
function flush(): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
}

interface ManualTimer {
  readonly schedule: (handler: () => void, ms: number) => AutoSaveTimerHandle;
  readonly cancel: (handle: AutoSaveTimerHandle) => void;
  /** 予約されたときの間隔(ミリ秒)を、予約された順に並べたもの。 */
  readonly scheduledMs: number[];
  /** 予約中の 1 件を実行する(自動保存は常に「次の 1 回」だけを予約する)。 */
  readonly fire: () => void;
  readonly pendingCount: () => number;
}

/** `setTimeout` / `clearTimeout` の代わりに注入する、手で進められる偽のタイマー。 */
function createManualTimer(): ManualTimer {
  let nextId = 0;
  const pending = new Map<number, () => void>();
  const scheduledMs: number[] = [];
  return {
    schedule: (handler, ms) => {
      const id = nextId;
      nextId += 1;
      pending.set(id, handler);
      scheduledMs.push(ms);
      return id;
    },
    cancel: (handle) => {
      if (typeof handle === 'number') {
        pending.delete(handle);
      }
    },
    scheduledMs,
    fire: () => {
      const [entry] = pending;
      if (entry === undefined) {
        return;
      }
      const [id, handler] = entry;
      pending.delete(id);
      handler();
    },
    pendingCount: () => pending.size,
  };
}

interface RecordingStorage {
  readonly storage: AutoSaveStorage;
  /** 書かれたものを書かれた順に並べたもの。 */
  readonly writes: AutoSaveRecord[];
  readonly clearCount: () => number;
  readonly stored: () => AutoSaveRecord | null;
}

/** 何回書かれたか・消されたかを数える記憶上の保管庫。 */
function createRecordingStorage(initial: AutoSaveRecord | null = null): RecordingStorage {
  let stored: AutoSaveRecord | null = initial;
  const writes: AutoSaveRecord[] = [];
  let clearCount = 0;
  return {
    storage: {
      read: () => Promise.resolve(stored),
      write: (record) => {
        writes.push(record);
        stored = record;
        return Promise.resolve();
      },
      clear: () => {
        clearCount += 1;
        stored = null;
        return Promise.resolve();
      },
    },
    writes,
    clearCount: () => clearCount,
    stored: () => stored,
  };
}

/** 画面の見え隠れを知らせる偽物。`hide` で `visibilitychange` を起こす。 */
interface FakeVisibility {
  readonly target: VisibilityTarget;
  readonly hide: () => void;
  readonly show: () => void;
  readonly listenerCount: () => number;
}

function createFakeVisibility(): FakeVisibility {
  const listeners = new Set<() => void>();
  let state = 'visible';
  const target: VisibilityTarget = {
    get visibilityState() {
      return state;
    },
    addEventListener: (_type, listener) => {
      listeners.add(listener);
    },
    removeEventListener: (_type, listener) => {
      listeners.delete(listener);
    },
  };
  const notify = (): void => {
    for (const listener of [...listeners]) {
      listener();
    }
  };
  return {
    target,
    hide: () => {
      state = 'hidden';
      notify();
    },
    show: () => {
      state = 'visible';
      notify();
    },
    listenerCount: () => listeners.size,
  };
}

/**
 * 検査用の控えを書く人。保管庫は**本番と同じように**「未保存のときだけ書く」包みを
 * 通し、時計とタイマーは差し替える。
 */
function createTestSaver(storage: AutoSaveStorage, timer: ManualTimer): AutoSaver {
  return createAutoSaver({
    storage: createUnsavedOnlyStorage(storage),
    now: () => FIXED_NOW,
    setTimeout: timer.schedule,
    clearTimeout: timer.cancel,
  });
}

/** 控え 1 件。中身は本物の `.pcad` にする(復元は「開く」と同じ経路を通るため)。 */
function recordOf(document: PartDocument, documentName = document.name): AutoSaveRecord {
  return { savedAt: SAVED_AT, bytes: writePcadFile(document, { savedAt: SAVED_AT }), documentName };
}

beforeEach(() => {
  useAppStore.setState(createInitialDocumentState());
});

describe('保管庫を選ぶ(§0.a-0.11)', () => {
  it('IndexedDB が無ければ記憶上の保管庫に落とす(書いたものが読み返せる)', async () => {
    const storage = createAutoSaveStorageForBrowser({});
    const record = recordOf(createEmptyPartDocument(), '部品1');

    await storage.write(record);

    expect(await storage.read()).toEqual(record);
  });

  it('IndexedDB があれば IndexedDB の保管庫を選ぶ(Node では読み書きが起きない)', async () => {
    // 選ばれた保管庫は本物の globalThis.indexedDB を見に行く。Node には無いので
    // 「静かに何もしない」形になり、書いても読み返せない(例外は出ない)。
    const storage = createAutoSaveStorageForBrowser({ indexedDB: {} });

    await storage.write(recordOf(createEmptyPartDocument(), '部品1'));

    expect(await storage.read()).toBeNull();
  });
});

describe('文書の変化を見張る(FR-805)', () => {
  it('文書を変えずに時間を進めても控えを書かない', async () => {
    const recording = createRecordingStorage();
    const timer = createManualTimer();
    const detach = attachAutoSave({
      saver: createTestSaver(recording.storage, timer),
      visibility: null,
    });

    timer.fire();
    await flush();

    expect(recording.writes).toEqual([]);
    detach();
  });

  it('間隔が来るまでは控えを書かない(予約だけがある)', () => {
    const recording = createRecordingStorage();
    const timer = createManualTimer();
    const detach = attachAutoSave({
      saver: createTestSaver(recording.storage, timer),
      visibility: null,
    });

    useAppStore.getState().applyDocument(partWithPoint());

    expect(timer.scheduledMs).toEqual([AUTO_SAVE_INTERVAL_MS]);
    expect(timer.pendingCount()).toBe(1);
    expect(recording.writes).toEqual([]);
    detach();
  });

  it('文書を変えてから間隔が来ると 1 回だけ書き、控えから同じ部品が読める', async () => {
    const recording = createRecordingStorage();
    const timer = createManualTimer();
    const detach = attachAutoSave({
      saver: createTestSaver(recording.storage, timer),
      visibility: null,
    });
    const document = partWithPoint();

    useAppStore.getState().applyDocument(document);
    timer.fire();
    await flush();

    expect(recording.writes).toHaveLength(1);
    expect(recording.writes[0].savedAt).toBe(SAVED_AT);
    expect(recording.writes[0].documentName).toBe(document.name);
    const read = readPcadFile(recording.writes[0].bytes);
    expect(read.ok).toBe(true);
    if (read.ok) {
      expect(read.document).toEqual(document);
    }
    detach();
  });

  it('続けてもう一度間隔が来ても、変更が無ければ増えない', async () => {
    const recording = createRecordingStorage();
    const timer = createManualTimer();
    const detach = attachAutoSave({
      saver: createTestSaver(recording.storage, timer),
      visibility: null,
    });

    useAppStore.getState().applyDocument(partWithPoint());
    timer.fire();
    await flush();
    timer.fire();
    await flush();

    expect(recording.writes).toHaveLength(1);
    detach();
  });

  it('手で保存した後は、控えを作り直さない(次の起動で古いほうを勧めない)', async () => {
    const recording = createRecordingStorage();
    const timer = createManualTimer();
    const detach = attachAutoSave({
      saver: createTestSaver(recording.storage, timer),
      visibility: null,
    });
    const document = partWithPoint();

    useAppStore.getState().applyDocument(document);
    // 手で保存できた状態(savePart が呼ぶもの)。文書そのものは変わらない。
    useAppStore.getState().setFileState('部品1.pcad', document);
    timer.fire();
    await flush();

    expect(recording.writes).toEqual([]);
    detach();
  });

  it('見張りをやめると、以後は間隔が来ても書かない', async () => {
    const recording = createRecordingStorage();
    const timer = createManualTimer();
    const detach = attachAutoSave({
      saver: createTestSaver(recording.storage, timer),
      visibility: null,
    });

    useAppStore.getState().applyDocument(partWithPoint());
    detach();
    timer.fire();
    await flush();

    expect(recording.writes).toEqual([]);
    expect(timer.pendingCount()).toBe(0);
  });

  it('画面が隠れたとき、未保存の変更があれば間隔を待たずに書く', async () => {
    const recording = createRecordingStorage();
    const timer = createManualTimer();
    const visibility = createFakeVisibility();
    const detach = attachAutoSave({
      saver: createTestSaver(recording.storage, timer),
      visibility: visibility.target,
    });

    useAppStore.getState().applyDocument(partWithPoint());
    visibility.hide();
    await flush();

    expect(recording.writes).toHaveLength(1);
    detach();
    expect(visibility.listenerCount()).toBe(0);
  });

  it('画面が隠れても、未保存の変更が無ければ書かない', async () => {
    const recording = createRecordingStorage();
    const timer = createManualTimer();
    const visibility = createFakeVisibility();
    const detach = attachAutoSave({
      saver: createTestSaver(recording.storage, timer),
      visibility: visibility.target,
    });

    visibility.hide();
    await flush();

    expect(recording.writes).toEqual([]);
    detach();
  });
});

describe('起動時の案内(§2.9)', () => {
  it('控えがあれば、時刻と名前を案内へ入れる', async () => {
    const recording = createRecordingStorage(recordOf(partWithPoint(), '部品1'));
    const timer = createManualTimer();

    await loadAutoSavePrompt(createTestSaver(recording.storage, timer));

    expect(useAppStore.getState().restorePrompt).toEqual({
      savedAt: SAVED_AT,
      documentName: '部品1',
    });
  });

  it('控えが無ければ案内を出さない', async () => {
    const recording = createRecordingStorage();
    const timer = createManualTimer();

    await loadAutoSavePrompt(createTestSaver(recording.storage, timer));

    expect(useAppStore.getState().restorePrompt).toBeNull();
  });

  it('控えが壊れていたら、案内を出さずに黙って捨てる(例外にしない)', async () => {
    const broken: AutoSaveRecord = {
      savedAt: SAVED_AT,
      bytes: new Uint8Array([0, 1, 2, 3]),
      documentName: '部品1',
    };
    const recording = createRecordingStorage(broken);
    const timer = createManualTimer();

    await loadAutoSavePrompt(createTestSaver(recording.storage, timer));

    expect(useAppStore.getState().restorePrompt).toBeNull();
    expect(recording.clearCount()).toBe(1);
    expect(recording.stored()).toBeNull();
  });

  it('片付けの後に読み終わった結果では案内を出さない(StrictMode の二重実行)', async () => {
    const recording = createRecordingStorage(recordOf(partWithPoint(), '部品1'));
    const timer = createManualTimer();

    await loadAutoSavePrompt(createTestSaver(recording.storage, timer), {
      shouldApply: () => false,
    });

    expect(useAppStore.getState().restorePrompt).toBeNull();
  });
});

describe('案内の返事', () => {
  it('「復元する」で控えの部品が入り、案内が閉じる', async () => {
    const document = partWithPoint();
    const recording = createRecordingStorage(recordOf(document, '部品1'));
    const timer = createManualTimer();
    const saver = createTestSaver(recording.storage, timer);
    await loadAutoSavePrompt(saver);

    await restoreAutoSave(saver);

    const state = useAppStore.getState();
    expect(state.document).toEqual(document);
    expect(state.restorePrompt).toBeNull();
    // 控えはファイルに書いたものとは限らないので、未保存の部品として扱う。
    expect(state.fileName).toBeNull();
    expect(state.savedDocument).toBeNull();
    // 破棄を選ぶまで控えは残す(復元した直後にもう一度落ちても始められるように)。
    expect(recording.stored()).not.toBeNull();
  });

  it('「復元する」を押したときに控えが消えていれば、案内を閉じるだけ', async () => {
    const recording = createRecordingStorage();
    const timer = createManualTimer();
    const saver = createTestSaver(recording.storage, timer);
    useAppStore.getState().setRestorePrompt({ savedAt: SAVED_AT, documentName: '部品1' });

    await restoreAutoSave(saver);

    const state = useAppStore.getState();
    expect(state.restorePrompt).toBeNull();
    expect(state.document).toEqual(createEmptyPartDocument());
  });

  it('「破棄する」で控えが消え、案内が閉じる', async () => {
    const recording = createRecordingStorage(recordOf(partWithPoint(), '部品1'));
    const timer = createManualTimer();
    const saver = createTestSaver(recording.storage, timer);
    await loadAutoSavePrompt(saver);

    await discardAutoSave(saver);

    expect(recording.clearCount()).toBe(1);
    expect(recording.stored()).toBeNull();
    expect(useAppStore.getState().restorePrompt).toBeNull();
  });
});

describe('起動時の配線', () => {
  it('控えを書く人をストアへ差し出し、片付けで取り下げる', async () => {
    const recording = createRecordingStorage();
    const timer = createManualTimer();
    const saver = createTestSaver(recording.storage, timer);

    const detach = startAutoSave({ saver });
    expect(useAppStore.getState().autoSaver).toBe(saver);
    await flush();

    detach();
    expect(useAppStore.getState().autoSaver).toBeNull();
    expect(timer.pendingCount()).toBe(0);
  });
});

describe('控えの時刻の見せ方', () => {
  it('その場所の時計の読みで「2026/09/03 18:30」の形にする', () => {
    expect(formatSavedAt('2026-09-03T18:30:00')).toBe('2026/09/03 18:30');
  });

  it('世界共通の書き方(末尾が Z)も同じ形になる', () => {
    expect(formatSavedAt(SAVED_AT)).toMatch(/^\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}$/);
  });

  it('読み取れない文字列はそのまま返す(案内を出せないよりはまし)', () => {
    expect(formatSavedAt('いつか')).toBe('いつか');
  });
});
