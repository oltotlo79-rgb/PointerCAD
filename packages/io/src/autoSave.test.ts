import {
  createEmptyPartDocument, createAssemblyDocument, createPartDocumentBundle,
  createAssemblyDocumentBundle, type PartDocument,
} from '@pointercad/model';
import { afterEach, describe, expect, it } from 'vitest';

import {
  AUTO_SAVE_INTERVAL_MS,
  autoSaveRecordKey,
  type AutoSaveIdentity,
  createAutoSaver,
  createIndexedDbAutoSaveStorage,
  createMemoryAutoSaveStorage,
  type AutoSaveRecord,
  type AutoSaveStorage,
  type AutoSaveTimerHandle,
} from './autoSave.js';
import { readDocumentBundle, readPcadFile, type ImportedMeshBytes, type PcadAttachments } from './pcad/pcadFile.js';

/** 検査で保存時刻を固定する。 */
const SAVED_AT = '2026-09-03T01:23:45.678Z';

const originalIndexedDb = Object.getOwnPropertyDescriptor(globalThis, 'indexedDB');

afterEach(() => {
  if (originalIndexedDb === undefined) {
    Reflect.deleteProperty(globalThis, 'indexedDB');
    return;
  }
  Object.defineProperty(globalThis, 'indexedDB', originalIndexedDb);
});

function withName(document: PartDocument, name: string): PartDocument {
  return { ...document, name };
}

/**
 * setTimeout / clearTimeout の代わりに注入する、手で進められる偽のタイマー。
 * `pending` に予約中の呼び出しを1つだけ持つ(自動保存は常に「次の1回」だけを予約するため)。
 */
function createManualTimer(): {
  readonly schedule: (handler: () => void, ms: number) => AutoSaveTimerHandle;
  readonly cancel: (handle: AutoSaveTimerHandle) => void;
  readonly scheduledMs: number[];
  readonly fire: () => void;
  readonly pendingCount: () => number;
} {
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
      const [firstEntry] = pending;
      if (firstEntry === undefined) {
        return;
      }
      const [id, handler] = firstEntry;
      pending.delete(id);
      handler();
    },
    pendingCount: () => pending.size,
  };
}

function createDeferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function flush(): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
}

type FakeIdbOutcome = 'complete' | 'manual' | 'aborted' | 'error' | 'quota';

interface FakeIdbRequest<T> {
  result: T;
  error: unknown;
  onsuccess: (() => void) | null;
  onerror: (() => void) | null;
}

interface FakeIdbTransaction {
  error: unknown;
  oncomplete: (() => void) | null;
  onabort: (() => void) | null;
  onerror: (() => void) | null;
  objectStore(name: string): FakeIdbObjectStore;
}

interface FakeIdbObjectStore {
  getAll(): FakeIdbRequest<unknown>;
  get(key: string): FakeIdbRequest<unknown>;
  put(value: unknown, key: string): FakeIdbRequest<unknown>;
  delete(key: string): FakeIdbRequest<undefined>;
}

interface FakeIndexedDb {
  readonly putCount: () => number;
  readonly closeCount: () => number;
  readonly completeManualTransaction: () => void;
}

/** request と transaction の出来事を別々に起こせる、最小の IndexedDB 偽物。 */
function installFakeIndexedDb(
  outcomes: readonly FakeIdbOutcome[],
  initialRecords: ReadonlyMap<string, unknown> = new Map(),
): FakeIndexedDb {
  const stored = new Map(initialRecords);
  let commitManual: () => void = () => undefined;
  let nextOutcome = 0;
  let puts = 0;
  let closes = 0;
  let manualTransaction: FakeIdbTransaction | null = null;

  const eventRequest = <T>(
    result: T,
    transaction: FakeIdbTransaction,
    outcome: FakeIdbOutcome,
    commit: () => void,
  ): FakeIdbRequest<T> => {
    const request: FakeIdbRequest<T> = {
      result,
      error: null,
      onsuccess: null,
      onerror: null,
    };
    queueMicrotask(() => {
      if (outcome === 'quota') {
        request.error = { name: 'QuotaExceededError' };
        request.onerror?.();
        return;
      }
      request.onsuccess?.();
      if (outcome === 'complete') {
        queueMicrotask(() => { commit(); transaction.oncomplete?.(); });
      } else if (outcome === 'aborted') {
        transaction.onabort?.();
      } else if (outcome === 'error') {
        transaction.onerror?.();
      }
    });
    return request;
  };

  const database = {
    objectStoreNames: { contains: () => true },
    createObjectStore: () => undefined,
    transaction: (): FakeIdbTransaction => {
      const outcome = outcomes[nextOutcome] ?? 'complete';
      nextOutcome += 1;
      const changes: (() => void)[] = [];
      const commit = (): void => { for (const change of changes) change(); changes.length = 0; };
      const transaction: FakeIdbTransaction = {
        error: null,
        oncomplete: null,
        onabort: null,
        onerror: null,
        objectStore: () => ({
          get: (key) => eventRequest(stored.get(key), transaction, outcome, commit),
          getAll: () => eventRequest([...stored.values()], transaction, outcome, commit),
          put: (value, key) => {
            puts += 1;
            changes.push(() => { stored.set(key, value); });
            return eventRequest(undefined, transaction, outcome, commit);
          },
          delete: (key) => {
            changes.push(() => { stored.delete(key); });
            return eventRequest(undefined, transaction, outcome, commit);
          },
        }),
      };
      if (outcome === 'manual') {
        manualTransaction = transaction;
        commitManual = commit;
      }
      return transaction;
    },
    close: () => {
      closes += 1;
    },
  };
  const factory = {
    open: () => {
      const request: FakeIdbRequest<typeof database> & {
        onupgradeneeded: (() => void) | null;
      } = {
        result: database,
        error: null,
        onsuccess: null,
        onerror: null,
        onupgradeneeded: null,
      };
      queueMicrotask(() => {
        request.onsuccess?.();
      });
      return request;
    },
  };
  Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: factory });

  return {
    putCount: () => puts,
    closeCount: () => closes,
    completeManualTransaction: () => {
      commitManual();
      manualTransaction?.oncomplete?.();
    },
  };
}

describe('AUTO_SAVE_INTERVAL_MS', () => {
  it('既定は5分(FR-805)', () => {
    expect(AUTO_SAVE_INTERVAL_MS).toBe(300_000);
  });
});

describe('文書と窓で分ける自動保存', () => {
  const partIdentity: AutoSaveIdentity = { kind: 'part', documentId: 'doc-1', sessionId: 'window-1' };
  const assemblyIdentity: AutoSaveIdentity = { ...partIdentity, kind: 'assembly' };
  const secondWindow: AutoSaveIdentity = { ...partIdentity, sessionId: 'window-2' };
  const legacy: AutoSaveRecord = { savedAt: SAVED_AT, bytes: Uint8Array.of(1), documentName: '旧部品' };
  const record = (identity: AutoSaveIdentity): AutoSaveRecord => ({ ...legacy, ...identity });

  it('鍵はkind:documentId:sessionIdで区切り文字を含むIDも衝突しない', () => {
    expect(autoSaveRecordKey(partIdentity)).toBe('part:doc-1:window-1');
    expect(autoSaveRecordKey()).toBe('part:default:default');
    expect(autoSaveRecordKey({ ...partIdentity, documentId: 'a:b', sessionId: 'c' }))
      .toBe('part:a%3Ab:c');
    expect(autoSaveRecordKey({ ...partIdentity, documentId: 'a', sessionId: 'b:c' }))
      .toBe('part:a:b%3Ac');
  });

  it.each(['memory', 'indexedDb'] as const)('%sで部品・組立・別窓の3控えを独立して読み書き/破棄する', async (kind) => {
    if (kind === 'indexedDb') installFakeIndexedDb([]);
    const storage = kind === 'memory' ? createMemoryAutoSaveStorage() : createIndexedDbAutoSaveStorage();
    const identities = [partIdentity, assemblyIdentity, secondWindow];
    for (const identity of identities) await storage.write(record(identity));
    expect(await storage.listRecords()).toHaveLength(3);
    for (const identity of identities) expect(await storage.read(identity)).toEqual(record(identity));
    await storage.clear(secondWindow);
    expect(await storage.read(secondWindow)).toBeNull();
    expect(await storage.read(partIdentity)).toEqual(record(partIdentity));
    expect(await storage.listRecords()).toHaveLength(2);
  });

  it('currentの旧控えを既定の鍵と一覧から読み、新しい保存後も重複させない', async () => {
    installFakeIndexedDb([], new Map([['current', legacy]]));
    const storage = createIndexedDbAutoSaveStorage();
    expect(await storage.read()).toEqual(legacy);
    expect(await storage.listRecords()).toEqual([legacy]);
    const updated = { ...legacy, savedAt: '2026-09-07T00:00:00.000Z' };
    await storage.write(updated);
    expect(await storage.read()).toEqual(updated);
    expect(await storage.listRecords()).toEqual([updated]);
    await storage.clear();
    expect(await storage.listRecords()).toEqual([]);
    expect(await storage.read()).toBeNull();
  });

  it('listRecordsは新しい時刻の順で壊れたメタデータを候補にしない', async () => {
    const older = { ...record(partIdentity), savedAt: '2026-09-01T00:00:00.000Z' };
    installFakeIndexedDb([], new Map<string, unknown>([
      [autoSaveRecordKey(partIdentity), older],
      [autoSaveRecordKey(assemblyIdentity), record(assemblyIdentity)],
      ['broken', { ...legacy, kind: 'assembly' }],
    ]));
    expect(await createIndexedDbAutoSaveStorage().listRecords()).toEqual([record(assemblyIdentity), older]);
  });

  it('文書別の書き込みもrequest成功だけでは確定せずcompleteで確定する', async () => {
    const fake = installFakeIndexedDb(['manual']);
    const storage = createIndexedDbAutoSaveStorage();
    let done = false;
    const writing = storage.write(record(assemblyIdentity)).then(() => { done = true; });
    await flush();
    expect(done).toBe(false);
    expect(await storage.listRecords()).toEqual([]);
    fake.completeManualTransaction();
    await writing;
    expect(done).toBe(true);
    expect(await storage.read(assemblyIdentity)).toEqual(record(assemblyIdentity));
  });

  it('request成功後abortした別文書の控えは一覧に入らない', async () => {
    installFakeIndexedDb(['aborted']);
    const storage = createIndexedDbAutoSaveStorage();
    await expect(storage.write(record(assemblyIdentity))).rejects.toMatchObject({ reason: 'aborted' });
    expect(await storage.listRecords()).toEqual([]);
  });

  it('旧currentの置換がabortしたら元の控えが残る', async () => {
    installFakeIndexedDb(['aborted'], new Map([['current', legacy]]));
    const storage = createIndexedDbAutoSaveStorage();
    await expect(storage.write({ ...legacy, documentName: '新しい控え' }))
      .rejects.toMatchObject({ reason: 'aborted' });
    expect(await storage.read()).toEqual(legacy);
    expect(await storage.listRecords()).toEqual([legacy]);
  });

  it('最初のmarkDirty前でも指定されたアセンブリ/窓の控えを復元・破棄する', async () => {
    const storage = createMemoryAutoSaveStorage();
    await storage.write(record(assemblyIdentity));
    await storage.write(record(partIdentity));
    const saver = createAutoSaver({ storage, ...assemblyIdentity });
    try {
      expect(await saver.readLatest()).toEqual(record(assemblyIdentity));
      await saver.discard();
      expect(await storage.read(assemblyIdentity)).toBeNull();
      expect(await storage.read(partIdentity)).toEqual(record(partIdentity));
    } finally { saver.stop(); }
  });

  it('同じ保管庫で部品とアセンブリの束を別々に保存・復元できる', async () => {
    const storage = createMemoryAutoSaveStorage();
    const partSaver = createAutoSaver({ storage, ...partIdentity });
    const assemblySaver = createAutoSaver({ storage, ...assemblyIdentity });
    const part = createPartDocumentBundle(createEmptyPartDocument());
    const assembly = createAssemblyDocumentBundle(createAssemblyDocument('組立1'));
    try {
      await partSaver.saveNow(part);
      await assemblySaver.saveNow(assembly);
      expect(await assemblySaver.listRecords()).toHaveLength(2);
      const partRecord = await partSaver.readLatest();
      const assemblyRecord = await assemblySaver.readLatest();
      if (partRecord === null || assemblyRecord === null) throw new Error('控えが必要');
      expect(partRecord.kind).toBe('part');
      expect(assemblyRecord.kind).toBe('assembly');
      const restored = await readDocumentBundle(assemblyRecord.bytes, 'assembly');
      expect(restored.ok).toBe(true);
      if (restored.ok) expect(restored.bundle.document).toEqual(assembly.document);
      await assemblySaver.discard();
      expect(await partSaver.readLatest()).toEqual(partRecord);
    } finally { partSaver.stop(); assemblySaver.stop(); }
  });

  it('sessionIdを省いた別々のsaverも互いの束の控えを上書きしない', async () => {
    const storage = createMemoryAutoSaveStorage();
    const first = createAutoSaver({ storage });
    const second = createAutoSaver({ storage });
    const bundle = createPartDocumentBundle(createEmptyPartDocument());
    try {
      await first.saveNow(bundle);
      await second.saveNow(bundle);
      const records = await storage.listRecords();
      expect(records).toHaveLength(2);
      expect(records[0].sessionId).not.toBe(records[1].sessionId);
    } finally { first.stop(); second.stop(); }
  });
});

describe('createMemoryAutoSaveStorage', () => {
  it('read の初回は null', async () => {
    const storage = createMemoryAutoSaveStorage();
    expect(await storage.read()).toBeNull();
  });

  it('write の後、read で同じレコードが読める', async () => {
    const storage = createMemoryAutoSaveStorage();
    const record: AutoSaveRecord = {
      savedAt: SAVED_AT,
      bytes: new Uint8Array([1, 2, 3]),
      documentName: '部品1',
    };
    await storage.write(record);
    expect(await storage.read()).toEqual(record);
  });

  it('write の後に clear すると read は null に戻る', async () => {
    const storage = createMemoryAutoSaveStorage();
    await storage.write({ savedAt: SAVED_AT, bytes: new Uint8Array(), documentName: '部品1' });
    await storage.clear();
    expect(await storage.read()).toBeNull();
  });

  it('write を2回行うと、後の1件だけが残る', async () => {
    const storage = createMemoryAutoSaveStorage();
    await storage.write({ savedAt: SAVED_AT, bytes: new Uint8Array([1]), documentName: '1回目' });
    const second: AutoSaveRecord = {
      savedAt: '2026-09-03T02:00:00.000Z',
      bytes: new Uint8Array([2]),
      documentName: '2回目',
    };
    await storage.write(second);
    expect(await storage.read()).toEqual(second);
  });
});

describe('createIndexedDbAutoSaveStorage(indexedDB が無い環境)', () => {
  // Node の Vitest 環境には indexedDB が無いので、この分岐が自然に検査できる
  // (docs/報告記録.md 2026-09-02 14:50 の④と同じ理由で、実際の読み書きは E2E へ送る)。

  it('read は null を返す', async () => {
    const storage = createIndexedDbAutoSaveStorage();
    expect(await storage.read()).toBeNull();
  });

  it('write は unavailable の理由つきで失敗する', async () => {
    const storage = createIndexedDbAutoSaveStorage();
    await expect(
      storage.write({ savedAt: SAVED_AT, bytes: new Uint8Array([1]), documentName: '部品1' }),
    ).rejects.toMatchObject({ reason: 'unavailable' });
    expect(await storage.read()).toBeNull();
  });

  it('clear も unavailable の理由つきで失敗する', async () => {
    const storage = createIndexedDbAutoSaveStorage();
    await expect(storage.clear()).rejects.toMatchObject({ reason: 'unavailable' });
  });

  it('db 名・ストア名を渡しても(使われないだけで)同じ挙動', async () => {
    const storage = createIndexedDbAutoSaveStorage('別名', '別ストア');
    expect(await storage.read()).toBeNull();
  });
});

describe('createIndexedDbAutoSaveStorage(transaction の完了)', () => {
  const record: AutoSaveRecord = {
    savedAt: SAVED_AT,
    bytes: new Uint8Array([1]),
    documentName: '部品1',
  };

  it('request が成功しても transaction の complete までは write を成功にしない', async () => {
    const fake = installFakeIndexedDb(['manual']);
    let settled = false;
    const writing = createIndexedDbAutoSaveStorage()
      .write(record)
      .then(() => {
        settled = true;
      });

    await flush();
    expect(settled).toBe(false);
    expect(fake.closeCount()).toBe(0);

    fake.completeManualTransaction();
    await writing;
    expect(settled).toBe(true);
    expect(fake.closeCount()).toBe(1);
  });

  it('request 成功後に transaction が abort したら aborted で失敗する', async () => {
    installFakeIndexedDb(['aborted']);
    await expect(createIndexedDbAutoSaveStorage().write(record)).rejects.toMatchObject({
      reason: 'aborted',
    });
  });

  it('transaction の error は error の理由で失敗する', async () => {
    installFakeIndexedDb(['error']);
    await expect(createIndexedDbAutoSaveStorage().write(record)).rejects.toMatchObject({
      reason: 'error',
    });
  });

  it('request の容量不足は quota の理由で失敗する', async () => {
    installFakeIndexedDb(['quota']);
    await expect(createIndexedDbAutoSaveStorage().write(record)).rejects.toMatchObject({
      reason: 'quota',
    });
  });

  it('abort 後は保存済み扱いにせず、次の周期で同じ dirty 文書を再試行する', async () => {
    const fake = installFakeIndexedDb(['aborted', 'complete']);
    const timer = createManualTimer();
    const errors: unknown[] = [];
    let successes = 0;
    const saver = createAutoSaver({
      storage: createIndexedDbAutoSaveStorage(),
      intervalMs: 1000,
      now: () => 0,
      setTimeout: timer.schedule,
      clearTimeout: timer.cancel,
      onError: (error) => {
        errors.push(error);
      },
      onSuccess: () => {
        successes += 1;
      },
    });
    const document = withName(createEmptyPartDocument(), '再試行');

    await saver.saveNow(document);
    expect(errors[0]).toMatchObject({ reason: 'aborted' });
    expect(fake.putCount()).toBe(1);
    expect(successes).toBe(0);

    timer.fire();
    await flush();
    saver.stop();
    expect(fake.putCount()).toBe(2);
    expect(errors).toHaveLength(1);
    expect(successes).toBe(1);
  });
});

describe('createAutoSaver', () => {
  it('一度も markDirty しなければ、間隔が来ても書かない', () => {
    const storage = createMemoryAutoSaveStorage();
    const timer = createManualTimer();
    const saver = createAutoSaver({
      storage,
      now: () => 0,
      setTimeout: timer.schedule,
      clearTimeout: timer.cancel,
    });
    timer.fire();
    saver.stop();
    return storage.read().then((record) => {
      expect(record).toBeNull();
    });
  });

  it('変更後、間隔が経過すると1回書く', async () => {
    const storage = createMemoryAutoSaveStorage();
    const timer = createManualTimer();
    const saver = createAutoSaver({
      storage,
      intervalMs: 1000,
      now: () => 12_345,
      setTimeout: timer.schedule,
      clearTimeout: timer.cancel,
    });
    const document = withName(createEmptyPartDocument(), '部品A');
    saver.markDirty(document);
    timer.fire();
    // 書き込みは Promise チェーンを1段挟むので、マイクロタスクを1つ待つ。
    await Promise.resolve();
    await Promise.resolve();
    saver.stop();

    const record = await storage.read();
    expect(record).not.toBeNull();
    if (record === null) {
      throw new Error('unreachable');
    }
    expect(record.documentName).toBe('部品A');
    expect(record.savedAt).toBe(new Date(12_345).toISOString());
    const parsed = readPcadFile(record.bytes);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.document).toEqual(document);
    }
  });

  it('intervalMs を渡すと、その値でタイマーを予約する', () => {
    const storage = createMemoryAutoSaveStorage();
    const timer = createManualTimer();
    const saver = createAutoSaver({
      storage,
      intervalMs: 42_000,
      setTimeout: timer.schedule,
      clearTimeout: timer.cancel,
    });
    saver.stop();
    expect(timer.scheduledMs[0]).toBe(42_000);
  });

  it('間隔内の連続した変更は、最新の内容で1回だけ書く', async () => {
    const storage = createMemoryAutoSaveStorage();
    const timer = createManualTimer();
    const saver = createAutoSaver({
      storage,
      intervalMs: 1000,
      now: () => 0,
      setTimeout: timer.schedule,
      clearTimeout: timer.cancel,
    });
    const first = withName(createEmptyPartDocument(), '途中の内容');
    const second = withName(createEmptyPartDocument(), '最新の内容');
    saver.markDirty(first);
    saver.markDirty(second);
    timer.fire();
    await Promise.resolve();
    await Promise.resolve();
    saver.stop();

    const record = await storage.read();
    expect(record?.documentName).toBe('最新の内容');
  });

  it('変更が無い間隔では書かない(前回と同じ内容を積み増ししない)', async () => {
    const storage = createMemoryAutoSaveStorage();
    const timer = createManualTimer();
    const saver = createAutoSaver({
      storage,
      intervalMs: 1000,
      now: () => 0,
      setTimeout: timer.schedule,
      clearTimeout: timer.cancel,
    });
    const document = withName(createEmptyPartDocument(), '部品A');
    saver.markDirty(document);
    timer.fire();
    await Promise.resolve();
    await Promise.resolve();
    const afterFirstWrite = await storage.read();

    // 2度目の間隔: markDirty を呼んでいないので変更なし。
    timer.fire();
    await Promise.resolve();
    await Promise.resolve();
    saver.stop();
    const afterSecondTick = await storage.read();

    expect(afterSecondTick).toEqual(afterFirstWrite);
  });

  it('saveNow は間隔を待たずすぐ書く', async () => {
    const storage = createMemoryAutoSaveStorage();
    const timer = createManualTimer();
    const saver = createAutoSaver({
      storage,
      now: () => 999,
      setTimeout: timer.schedule,
      clearTimeout: timer.cancel,
    });
    const document = withName(createEmptyPartDocument(), '即時保存');
    await saver.saveNow(document);
    saver.stop();

    const record = await storage.read();
    expect(record?.documentName).toBe('即時保存');
  });

  it('readLatest は保管庫の内容をそのまま返し、readPcadFile で元の文書に戻る(往復)', async () => {
    const storage = createMemoryAutoSaveStorage();
    const timer = createManualTimer();
    const saver = createAutoSaver({
      storage,
      setTimeout: timer.schedule,
      clearTimeout: timer.cancel,
    });
    const document = withName(createEmptyPartDocument(), '復元候補');
    await saver.saveNow(document);
    saver.stop();

    const latest = await saver.readLatest();
    expect(latest).not.toBeNull();
    if (latest === null) {
      throw new Error('unreachable');
    }
    const parsed = readPcadFile(latest.bytes);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.document).toEqual(document);
    }
  });

  it('discard の後は readLatest が null になる', async () => {
    const storage = createMemoryAutoSaveStorage();
    const timer = createManualTimer();
    const saver = createAutoSaver({
      storage,
      setTimeout: timer.schedule,
      clearTimeout: timer.cancel,
    });
    await saver.saveNow(withName(createEmptyPartDocument(), '破棄予定'));
    await saver.discard();
    saver.stop();

    expect(await saver.readLatest()).toBeNull();
  });

  it('stop の後は、間隔が来ても書かない', async () => {
    const storage = createMemoryAutoSaveStorage();
    const timer = createManualTimer();
    const saver = createAutoSaver({
      storage,
      intervalMs: 1000,
      now: () => 0,
      setTimeout: timer.schedule,
      clearTimeout: timer.cancel,
    });
    saver.markDirty(withName(createEmptyPartDocument(), '止めた後'));
    saver.stop();
    // stop は予約済みのタイマーも取り消すので、fire しても何も起きない。
    expect(timer.pendingCount()).toBe(0);
    timer.fire();
    await Promise.resolve();

    expect(await storage.read()).toBeNull();
  });

  it('書き込み中に saveNow を重ねても、書き込みは1回だけ(重複防止)', async () => {
    const writeCalls: AutoSaveRecord[] = [];
    const deferred = createDeferred();
    const storage: AutoSaveStorage = {
      read: () => Promise.resolve(null),
      write: (record) => {
        writeCalls.push(record);
        return deferred.promise;
      },
      clear: () => Promise.resolve(),
    };
    const timer = createManualTimer();
    const saver = createAutoSaver({
      storage,
      now: () => 0,
      setTimeout: timer.schedule,
      clearTimeout: timer.cancel,
    });
    const document = withName(createEmptyPartDocument(), '重複防止');

    const first = saver.saveNow(document);
    const second = saver.saveNow(document);
    deferred.resolve();
    await Promise.all([first, second]);
    saver.stop();

    expect(writeCalls.length).toBe(1);
  });

  it('書き込みが失敗しても例外にならず、onError へ渡る', async () => {
    const failure = new Error('保存できませんでした');
    const errors: unknown[] = [];
    const storage: AutoSaveStorage = {
      read: () => Promise.resolve(null),
      write: () => Promise.reject(failure),
      clear: () => Promise.resolve(),
    };
    const timer = createManualTimer();
    const saver = createAutoSaver({
      storage,
      now: () => 0,
      setTimeout: timer.schedule,
      clearTimeout: timer.cancel,
      onError: (error) => {
        errors.push(error);
      },
    });

    await expect(saver.saveNow(createEmptyPartDocument())).resolves.toBeUndefined();
    saver.stop();

    expect(errors).toEqual([failure]);
  });

  it('ZIP 化が投げても dirty を保ち、次の周期で再試行する', async () => {
    const failure = new Error('ZIP 化できません');
    const errors: unknown[] = [];
    const writes: AutoSaveRecord[] = [];
    const storage: AutoSaveStorage = {
      read: () => Promise.resolve(null),
      write: (record) => {
        writes.push(record);
        return Promise.resolve();
      },
      clear: () => Promise.resolve(),
    };
    const timer = createManualTimer();
    const saver = createAutoSaver({
      storage,
      intervalMs: 1000,
      now: () => 0,
      setTimeout: timer.schedule,
      clearTimeout: timer.cancel,
      onError: (error) => {
        errors.push(error);
      },
    });
    const document = createEmptyPartDocument();
    Object.defineProperty(document, 'name', {
      get: () => {
        throw failure;
      },
    });

    saver.markDirty(document);
    timer.fire();
    await flush();
    expect(errors).toEqual([failure]);
    expect(writes).toEqual([]);

    timer.fire();
    await flush();
    saver.stop();
    expect(errors).toEqual([failure, failure]);
    expect(writes).toEqual([]);
  });
});

/*
 * 添付つきの控え(P6 タスク32、タスク21 の申し送り)。
 *
 * 読み込んだ形(`importedSolid` / `importedMesh`)を含む文書は、`shapes/*.brep` /
 * `meshes/*.bin` が一緒に入っていないと `readPcadFile` が `missingField` で断る。
 * 添付を渡さずに控えを取ると「開けない控え」になるので、渡す口があることと、
 * 渡したときに復元できることを両方固定する。
 */

/** 検査用の B-rep のバイト列(中身は解釈されないので、見分けの付く並びにする)。 */
function fakeBrepBytes(seed: number): Uint8Array {
  return Uint8Array.from([seed, seed + 1, seed + 2, seed + 3]);
}

/** 三角形 1 枚ぶんの網(頂点 3・三角形 1)。 */
function oneTriangleMesh(): ImportedMeshBytes {
  return {
    positions: Float32Array.from([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    normals: Float32Array.from([0, 0, 1, 0, 0, 1, 0, 0, 1]),
    indices: Uint32Array.from([0, 1, 2]),
  };
}

/** 読み込んだ形 1 つと読み込んだ三角形 1 つを履歴に持つ部品文書。 */
function importedDocument(): PartDocument {
  return {
    ...createEmptyPartDocument(),
    solids: [
      {
        id: 'importedSolid-1',
        kind: 'importedSolid',
        name: '読み込んだ形1',
        suppressed: false,
        shapeRef: 'shape-1',
        source: { format: 'step', fileName: 'bracket.step', unit: 'mm', byteLength: 4494 },
        bodyKind: 'solid',
      },
      {
        id: 'importedMesh-1',
        kind: 'importedMesh',
        name: '読み込んだ三角形の形1',
        suppressed: false,
        meshRef: 'mesh-1',
        source: { format: 'stl', fileName: 'cover.stl', unit: 'mm', byteLength: 684 },
        triangleCount: 1,
      },
    ],
  };
}

/** 上の文書がそろえておくべき添付。 */
function importedAttachments(): PcadAttachments {
  return {
    shapes: new Map([['shape-1', fakeBrepBytes(7)]]),
    meshes: new Map([['mesh-1', oneTriangleMesh()]]),
    canvases: new Map(),
  };
}

describe('createAutoSaver の添付(P6 §0.a-0.9・0.24)', () => {
  it('添付を渡さないと、読み込んだ形を含む文書の控えは復元できない(申し送りの再現)', async () => {
    const storage = createMemoryAutoSaveStorage();
    const timer = createManualTimer();
    const saver = createAutoSaver({
      storage,
      now: () => 0,
      setTimeout: timer.schedule,
      clearTimeout: timer.cancel,
    });
    await saver.saveNow(importedDocument());
    saver.stop();

    const record = await storage.read();
    if (record === null) {
      throw new Error('unreachable');
    }
    const parsed = readPcadFile(record.bytes);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.error.code).toBe('missingField');
    }
  });

  it('attachmentsOf を渡すと、読み込んだ形を含む文書の控えが復元できる', async () => {
    const storage = createMemoryAutoSaveStorage();
    const timer = createManualTimer();
    const document = importedDocument();
    const seen: PartDocument[] = [];
    const saver = createAutoSaver({
      storage,
      now: () => 0,
      setTimeout: timer.schedule,
      clearTimeout: timer.cancel,
      attachmentsOf: (target) => {
        seen.push(target);
        return importedAttachments();
      },
    });
    await saver.saveNow(document);
    saver.stop();

    // 書く直前に、いま書く文書そのものを渡して呼ばれる。
    expect(seen).toEqual([document]);

    const record = await storage.read();
    if (record === null) {
      throw new Error('unreachable');
    }
    const parsed = readPcadFile(record.bytes);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.document).toEqual(document);
      expect(parsed.attachments.shapes.get('shape-1')).toEqual(fakeBrepBytes(7));
      expect(parsed.attachments.meshes.get('mesh-1')?.indices).toEqual(Uint32Array.from([0, 1, 2]));
    }
  });

  it('attachmentsOf が undefined を返したときは、添付なしで書く(版 6 までと同じ)', async () => {
    const storage = createMemoryAutoSaveStorage();
    const timer = createManualTimer();
    const saver = createAutoSaver({
      storage,
      now: () => 0,
      setTimeout: timer.schedule,
      clearTimeout: timer.cancel,
      attachmentsOf: () => undefined,
    });
    await saver.saveNow(createEmptyPartDocument());
    saver.stop();

    const record = await storage.read();
    if (record === null) {
      throw new Error('unreachable');
    }
    const parsed = readPcadFile(record.bytes);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.attachments.shapes.size).toBe(0);
      expect(parsed.attachments.meshes.size).toBe(0);
      expect(parsed.attachments.canvases.size).toBe(0);
    }
  });

  it('間隔ごとの書き込みでも添付を渡す(saveNow だけの配線にしない)', async () => {
    const storage = createMemoryAutoSaveStorage();
    const timer = createManualTimer();
    const saver = createAutoSaver({
      storage,
      intervalMs: 1000,
      now: () => 0,
      setTimeout: timer.schedule,
      clearTimeout: timer.cancel,
      attachmentsOf: () => importedAttachments(),
    });
    saver.markDirty(importedDocument());
    timer.fire();
    await Promise.resolve();
    await Promise.resolve();
    saver.stop();

    const record = await storage.read();
    if (record === null) {
      throw new Error('unreachable');
    }
    expect(readPcadFile(record.bytes).ok).toBe(true);
  });
});
