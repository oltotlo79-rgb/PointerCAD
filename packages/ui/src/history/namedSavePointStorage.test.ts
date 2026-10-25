import { createHash } from 'node:crypto';
import { emptyPcadAttachments, readArchive, writePcadFile } from '@pointercad/io';
import { createEmptyPartDocument } from '@pointercad/model';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createNamedSavePoints } from './namedSavePoints.js';
import { createIndexedDbSavePointStorage } from './namedSavePointStorage.js';

const image = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10, ...Array.from({ length: 80 }, (_, i) => i * 7 % 256)]);
const pcad = (alias: string, time: string): Uint8Array => writePcadFile(createEmptyPartDocument(), {
  savedAt: time, attachments: { ...emptyPcadAttachments(), canvases: new Map([[alias, image]]) },
});
const hash = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const tick = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0));
afterEach(() => vi.unstubAllGlobals());

type Request<T> = { result: T; error: { name: string } | null; onsuccess: (() => void) | null; onerror: (() => void) | null };
type Transaction = { error: { name: string } | null; oncomplete: (() => void) | null;
  onabort: (() => void) | null; onerror: (() => void) | null; abort: () => void;
  objectStore: (name: string) => Store };
type Store = { get: (key: string) => Request<unknown>; getAll: () => Request<unknown[]>;
  getAllKeys: () => Request<string[]>; put: (value: unknown) => Request<unknown>; delete: (key: string) => Request<unknown> };

/** autoSave.test.tsと同じくrequest成功とtransaction完了を分離し、変更はcomplete時だけ反映する。 */
function fakeIndexedDb() {
  const persisted = new Map<string, Map<string, unknown>>();
  let manualNext = false, quotaAt = 0, putNumber = 0, release: (() => void) | null = null,
    abortHeld: (() => void) | null = null, closes = 0, maximumPendingWrites = 0;
  let afterPut: (() => void) | undefined;
  const database = {
    version: 1,
    objectStoreNames: { contains: (name: string) => persisted.has(name), get length() { return persisted.size; } },
    createObjectStore(name: string) { persisted.set(name, new Map()); },
    close() { closes += 1; },
    transaction(_names: string | string[], mode: 'readonly' | 'readwrite'): Transaction {
      const staged: (() => void)[] = [];
      let pending = 0, pendingWrites = 0, stopped = false, completed = false;
      const manual = mode === 'readwrite' && manualNext;
      if (mode === 'readwrite') manualNext = false;
      const transaction: Transaction = {
        error: null, oncomplete: null, onabort: null, onerror: null,
        abort() { if (stopped || completed) return; stopped = true; queueMicrotask(() => transaction.onabort?.()); },
        objectStore(name): Store {
          const records = persisted.get(name);
          if (!records) throw new Error(`missing store ${name}`);
          const request = <T>(operation: () => T): Request<T> => {
            pending += 1;
            if (mode === 'readwrite') {
              pendingWrites += 1;
              maximumPendingWrites = Math.max(maximumPendingWrites, pendingWrites);
            }
            const result: Request<T> = { result: undefined as T, error: null, onsuccess: null, onerror: null };
            queueMicrotask(() => {
              if (stopped) return;
              if (mode === 'readwrite') pendingWrites -= 1;
              try { result.result = operation(); result.onsuccess?.(); }
              catch (cause) {
                result.error = { name: cause instanceof Error ? cause.name : 'UnknownError' };
                result.onerror?.(); transaction.error = result.error; transaction.onerror?.(); transaction.abort();
              }
              pending -= 1;
              queueMicrotask(() => {
                if (pending !== 0 || stopped || completed) return;
                const finish = (): void => {
                  if (stopped || completed) return;
                  completed = true; for (const change of staged) change(); transaction.oncomplete?.();
                };
                if (manual) { release = finish; abortHeld = () => transaction.abort(); } else finish();
              });
            });
            return result;
          };
          return {
            get(key) { return request(() => structuredClone(records.get(key))); },
            getAll() { return request(() => [...records.values()].map(value => structuredClone(value))); },
            getAllKeys() { return request(() => [...records.keys()]); },
            put(value) { return request(() => {
              putNumber += 1;
              if (putNumber === quotaAt) { const failure = new Error('quota'); failure.name = 'QuotaExceededError'; throw failure; }
              if (typeof value !== 'object' || value === null) throw new Error('bad value');
              const key = 'id' in value ? value.id : 'sha256' in value ? value.sha256 : 'key' in value ? value.key : null;
              if (typeof key !== 'string') throw new Error('bad key');
              const copy = structuredClone(value); staged.push(() => records.set(key, copy));
              afterPut?.();
              return undefined;
            }); },
            delete(key) { return request(() => { staged.push(() => { records.delete(key); }); return undefined; }); },
          };
        },
      };
      return transaction;
    },
  };
  const factory = { open: () => {
    const request: Request<typeof database> & { onupgradeneeded: (() => void) | null; onblocked: (() => void) | null } = {
      result: database, error: null, onsuccess: null, onerror: null, onupgradeneeded: null, onblocked: null,
    };
    queueMicrotask(() => { if (persisted.size === 0) request.onupgradeneeded?.(); request.onsuccess?.(); });
    return request;
  } };
  vi.stubGlobal('indexedDB', factory);
  return { persisted, closeCount: () => closes,
    maximumPendingWrites: () => maximumPendingWrites,
    afterPut(callback: () => void) { afterPut = callback; },
    setVersion(version: number) { database.version = version; },
    holdNextWrite() { manualNext = true; },
    hasHeldWrite() { return release !== null; },
    finishWrite() { const finish = release; release = null; finish?.(); },
    abortHeldWrite() { const abort = abortHeld; abortHeld = null; release = null; abort?.(); },
    quotaOnNextPut(offset = 1) { quotaAt = putNumber + offset; },
  };
}

describe('名前付き保存点IndexedDBのtransaction', () => {
  it('bounds concurrent writes and publishes all bytes and revision only on complete', async () => {
    const fake = fakeIndexedDb(), storage = createIndexedDbSavePointStorage();
    await storage.load();
    const bytes = Uint8Array.from({ length: 9 * 1024 * 1024 + 3 }, (_, i) => (i * 13) & 255);
    const digest = hash(bytes);
    fake.holdNextWrite();
    let settled = false;
    const writing = storage.commit(0, { blobPut: new Map([[digest, bytes]]) }).then(() => { settled = true; });
    for (let i = 0; i < 50 && !fake.hasHeldWrite(); i += 1) await tick();
    expect(fake.hasHeldWrite()).toBe(true);
    expect(fake.maximumPendingWrites()).toBe(4);
    expect(settled).toBe(false);
    for (const store of fake.persisted.values()) expect(store.size).toBe(0);
    fake.finishWrite(); await writing;
    expect((await storage.load()).revision).toBe(1);
    const actual = await storage.readBlob({ version: 1, sha256: digest, byteLength: bytes.length, chunkCount: 10 });
    expect(Buffer.compare(Buffer.from(actual), Buffer.from(bytes))).toBe(0);
  });

  it('rolls back later-batch quota and cancellation with requests still queued', async () => {
    const fake = fakeIndexedDb(), storage = createIndexedDbSavePointStorage();
    await storage.load();
    const bytes = new Uint8Array(9 * 1024 * 1024 + 3), digest = hash(bytes);
    fake.quotaOnNextPut(6);
    await expect(storage.commit(0, { blobPut: new Map([[digest, bytes]]) })).rejects.toMatchObject({ reason: 'quota' });
    for (const store of fake.persisted.values()) expect(store.size).toBe(0);
    const controller = new AbortController();
    let puts = 0;
    fake.afterPut(() => { if (++puts === 6) controller.abort(); });
    await expect(storage.commit(0, { blobPut: new Map([[digest, bytes]]) }, controller.signal))
      .rejects.toMatchObject({ reason: 'cancelled' });
    for (const store of fake.persisted.values()) expect(store.size).toBe(0);
    expect((await storage.load()).revision).toBe(0);
  });

  it('複数読取窓を越える全chunkと末尾3byteを保持し、中間欠落を拒否する', async () => {
    const fake = fakeIndexedDb(), storage = createIndexedDbSavePointStorage();
    await storage.load();
    const bytes = Uint8Array.from({ length: 9 * 1024 * 1024 + 3 }, (_, i) => (i * 17 + (i >>> 20)) & 255);
    const digest = hash(bytes);
    await storage.commit(0, { blobPut: new Map([[digest, bytes]]) });
    const descriptor = { version: 1 as const, sha256: digest, byteLength: bytes.length, chunkCount: 10 };
    const actual = await storage.readBlob(descriptor);
    expect(Buffer.compare(Buffer.from(actual), Buffer.from(bytes))).toBe(0);
    fake.persisted.get('chunks')?.delete(`${digest}:4`);
    await expect(storage.readBlob(descriptor)).rejects.toMatchObject({ reason: 'corrupt' });
    const controller = new AbortController(); controller.abort();
    await expect(storage.readBlob(descriptor, controller.signal)).rejects.toMatchObject({ reason: 'cancelled' });
  });

  it('通常PCADの項目をchunk CASへ置き、異名画像は同一実byteを持つ', async () => {
    const fake = fakeIndexedDb(), repo = createNamedSavePoints(createIndexedDbSavePointStorage());
    const aBytes = pcad('left', '2026-10-04T01:00:00.000Z');
    const bBytes = pcad('right', '2026-10-04T02:00:00.000Z');
    const a = await repo.create('A', aBytes, 'part'), b = await repo.create('B', bBytes, 'part');
    expect((await repo.read(a.id)).bytes).toEqual(aBytes);
    expect((await repo.read(b.id)).bytes).toEqual(bBytes);
    const blobs = fake.persisted.get('blobs');
    const chunks = fake.persisted.get('chunks');
    expect(blobs?.has(hash(image))).toBe(true);
    expect(chunks?.has(`${hash(image)}:0`)).toBe(true);
    expect([...(blobs?.keys() ?? [])].filter(key => key === hash(image))).toHaveLength(1);
    const unique = new Map<string, number>();
    for (const source of [aBytes, bBytes]) {
      const archive = readArchive(source, { shouldExtract: () => true });
      if (!archive.ok) throw new Error('test fixture must be a PCAD archive');
      for (const payload of archive.entries.values()) unique.set(hash(payload), payload.byteLength);
    }
    const actualBytes = [...(chunks?.values() ?? [])].reduce<number>((total, row) => {
      if (typeof row !== 'object' || row === null || !('bytes' in row) || !(row.bytes instanceof Uint8Array))
        throw new Error('invalid test chunk');
      return total + row.bytes.byteLength;
    }, 0);
    expect(actualBytes).toBe([...unique.values()].reduce((total, length) => total + length, 0));
    const alias = await repo.clone(a.id, 'A alias');
    await repo.remove(a.id);
    expect((await repo.read(alias.id)).bytes).toEqual(aBytes);
    expect(chunks?.has(`${hash(image)}:0`)).toBe(true);
    await repo.remove(b.id);
    expect(chunks?.has(`${hash(image)}:0`)).toBe(true);
    await repo.remove(alias.id);
    expect(chunks?.has(`${hash(image)}:0`)).toBe(false);
    expect(fake.closeCount()).toBeGreaterThan(0);
  });

  it('request成功だけでは保存成功にせず、oncomplete後だけ確定する', async () => {
    const fake = fakeIndexedDb(), repo = createNamedSavePoints(createIndexedDbSavePointStorage());
    fake.holdNextWrite();
    let settled = false;
    const writing = repo.create('A', pcad('left', '2026-10-04T01:00:00.000Z'), 'part')
      .then(point => { settled = true; return point; });
    for (let i = 0; i < 50 && !fake.hasHeldWrite(); i += 1) await tick();
    expect(fake.hasHeldWrite()).toBe(true);
    expect(settled).toBe(false);
    expect(fake.persisted.get('points')?.size ?? 0).toBe(0);
    fake.finishWrite();
    const point = await writing;
    expect(settled).toBe(true);
    expect((await repo.read(point.id)).point.sourceSha256).toBe(hash(pcad('left', '2026-10-04T01:00:00.000Z')));
  });

  it('途中putのquotaは全storeをrollbackし、旧保存点とblobを保持する', async () => {
    const fake = fakeIndexedDb(), repo = createNamedSavePoints(createIndexedDbSavePointStorage());
    const a = await repo.create('A', pcad('first', '2026-10-04T01:00:00.000Z'), 'part');
    const beforePoints = structuredClone([...(fake.persisted.get('points') ?? [])]);
    const beforeBlobs = structuredClone([...(fake.persisted.get('blobs') ?? [])]);
    const beforeChunks = structuredClone([...(fake.persisted.get('chunks') ?? [])]);
    fake.quotaOnNextPut(3);
    await expect(repo.create('B', pcad('second', '2026-10-04T02:00:00.000Z'), 'part'))
      .rejects.toMatchObject({ reason: 'quota' });
    expect([...(fake.persisted.get('points') ?? [])]).toEqual(beforePoints);
    expect([...(fake.persisted.get('blobs') ?? [])]).toEqual(beforeBlobs);
    expect([...(fake.persisted.get('chunks') ?? [])]).toEqual(beforeChunks);
    expect((await repo.read(a.id)).point.name).toBe('A');
  });

  it('request全成功の後でtransactionがabortしても旧repositoryを維持する', async () => {
    const fake = fakeIndexedDb(), repo = createNamedSavePoints(createIndexedDbSavePointStorage());
    const a = await repo.create('A', pcad('first', '2026-10-04T01:00:00.000Z'), 'part');
    const before = structuredClone([...(fake.persisted.get('points') ?? [])]);
    fake.holdNextWrite();
    const writing = repo.clone(a.id, 'alias');
    for (let i = 0; i < 50 && !fake.hasHeldWrite(); i += 1) await tick();
    expect(fake.hasHeldWrite()).toBe(true);
    fake.abortHeldWrite();
    await expect(writing).rejects.toMatchObject({ reason: 'aborted' });
    expect([...(fake.persisted.get('points') ?? [])]).toEqual(before);
    expect(await repo.list()).toHaveLength(1);
  });

  it('利用者キャンセルはcommit前の全store書込みを戻す', async () => {
    const fake = fakeIndexedDb(), repo = createNamedSavePoints(createIndexedDbSavePointStorage());
    const a = await repo.create('A', pcad('first', '2026-10-04T01:00:00.000Z'), 'part');
    const before = structuredClone([...(fake.persisted.get('points') ?? [])]);
    const controller = new AbortController();
    fake.holdNextWrite();
    const writing = repo.clone(a.id, 'cancelled alias', controller.signal);
    for (let i = 0; i < 50 && !fake.hasHeldWrite(); i += 1) await tick();
    expect(fake.hasHeldWrite()).toBe(true);
    controller.abort();
    await expect(writing).rejects.toMatchObject({ reason: 'cancelled' });
    expect([...(fake.persisted.get('points') ?? [])]).toEqual(before);
  });

  it('最後の参照削除中にabortするとpointも実blobも保持する', async () => {
    const fake = fakeIndexedDb(), repo = createNamedSavePoints(createIndexedDbSavePointStorage());
    const a = await repo.create('A', pcad('first', '2026-10-04T01:00:00.000Z'), 'part');
    const beforePoints = structuredClone([...(fake.persisted.get('points') ?? [])]);
    const beforeBlobs = structuredClone([...(fake.persisted.get('blobs') ?? [])]);
    const beforeChunks = structuredClone([...(fake.persisted.get('chunks') ?? [])]);
    fake.holdNextWrite();
    const deleting = repo.remove(a.id);
    for (let i = 0; i < 50 && !fake.hasHeldWrite(); i += 1) await tick();
    expect(fake.hasHeldWrite()).toBe(true);
    fake.abortHeldWrite();
    await expect(deleting).rejects.toMatchObject({ reason: 'aborted' });
    expect([...(fake.persisted.get('points') ?? [])]).toEqual(beforePoints);
    expect([...(fake.persisted.get('blobs') ?? [])]).toEqual(beforeBlobs);
    expect([...(fake.persisted.get('chunks') ?? [])]).toEqual(beforeChunks);
  });

  it('競合revisionと破損chunkをfail closedにする', async () => {
    const fake = fakeIndexedDb(), storage = createIndexedDbSavePointStorage(), repo = createNamedSavePoints(storage);
    const a = await repo.create('A', pcad('first', '2026-10-04T01:00:00.000Z'), 'part');
    await expect(storage.commit(0, { pointDelete: a.id })).rejects.toMatchObject({ reason: 'conflict' });
    expect(await repo.list()).toHaveLength(1);
    const imageChunk = fake.persisted.get('chunks')?.get(`${hash(image)}:0`);
    if (typeof imageChunk !== 'object' || imageChunk === null || !('bytes' in imageChunk) ||
        !(imageChunk.bytes instanceof Uint8Array)) throw new Error('missing test chunk');
    imageChunk.bytes[0] ^= 1;
    await expect(repo.list()).rejects.toMatchObject({ reason: 'corrupt' });
    expect(fake.persisted.get('points')?.size).toBe(2); // revision record + A
  });

  it('保存先が無いと理由付きで拒否する', async () => {
    vi.stubGlobal('indexedDB', undefined);
    await expect(createIndexedDbSavePointStorage().load()).rejects.toMatchObject({ reason: 'unavailable' });
  });

  it('未知DB versionを拒否して自動修復しない', async () => {
    const fake = fakeIndexedDb(); fake.setVersion(2);
    await expect(createIndexedDbSavePointStorage().load()).rejects.toMatchObject({ reason: 'corrupt' });
  });

  it('専用DBの余分なstoreを未知schemaとして拒否する', async () => {
    const fake = fakeIndexedDb(), storage = createIndexedDbSavePointStorage();
    await storage.load();
    fake.persisted.set('unexpected', new Map());
    await expect(storage.load()).rejects.toMatchObject({ reason: 'corrupt' });
  });
});
