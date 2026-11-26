/**
 * A-25: 保存点の「中断」(reason=aborted)は 5 か所から同じ文で出る。利用者に見せる文は変えず、どこで・何の誤りの名前で
 * 中断したかの細目(detail)を SavePointError に残す。細目は固定の語と IndexedDB の誤りの名前だけで、個人の情報を含まない。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPcadSavePointClient, type PcadSaveWorkerPort } from '../file/pcadSaveWorker.js';
import { SavePointError, type SavePointBlob } from './namedSavePoints.js';
import { createIndexedDbSavePointStorage } from './namedSavePointStorage.js';

afterEach(() => { vi.useRealTimers(); });

interface Handlers { onabort: (() => void) | null; onerror: (() => void) | null; oncomplete: (() => void) | null }
/** 取引を作った直後(handler を付けた後)に、指定の誤りの名前で onabort を起こす IndexedDB の代わり。 */
function abortingFactory(errorName: string | null, firstRequestError?: string): IDBFactory {
  const request = () => ({ onsuccess: null, onerror: null as (() => void) | null, result: undefined,
    error: firstRequestError === undefined ? null : { name: firstRequestError } });
  const transaction = (): Handlers & { objectStore: () => unknown; abort: () => void; error: unknown } => {
    const first = request();
    const tx: Handlers & { objectStore: () => unknown; abort: () => void; error: unknown } = {
      onabort: null, onerror: null, oncomplete: null, abort: () => undefined,
      error: errorName === null ? null : { name: errorName },
      objectStore: (name?: string) => ({ getAll: name === 'points' ? () => first : request,
        getAllKeys: request, get: request, put: request, delete: request }) };
    setTimeout(() => {
      if (firstRequestError !== undefined) { first.onerror?.(); tx.onerror?.(); }
      tx.onabort?.();
    }, 0);
    return tx;
  };
  const db = { version: 1, close: () => undefined, transaction,
    objectStoreNames: { length: 3, contains: () => true } };
  return { open: () => {
    const opening: { onsuccess: (() => void) | null; result: unknown } = { onsuccess: null, result: db };
    setTimeout(() => { opening.onsuccess?.(); }, 0);
    return opening;
  } } as unknown as IDBFactory;
}
const blob: SavePointBlob = { version: 1, sha256: 'a'.repeat(64), byteLength: 3, chunkCount: 1 };

describe('A-25: 保存点の中断の細目', () => {
  it('SavePointError は細目を持ち、文の末尾の印から読み戻せる(作業者を越えても細目が残る)', () => {
    const direct = new SavePointError('aborted', '保存点の書込みが中断されました。', 'storage-write-abort:AbortError');
    expect(direct.detail).toBe('storage-write-abort:AbortError');
    const rebuilt = new SavePointError(direct.reason, direct.message);
    expect(rebuilt.detail).toBe('storage-write-abort:AbortError');
    expect(new SavePointError('invalid', '名前を確認してください。').detail).toBeNull();
  });

  it('読取りの取引の中断(namedSavePointStorage.ts の load): storage-read-abort と誤りの名前', async () => {
    const storage = createIndexedDbSavePointStorage(abortingFactory('AbortError'));
    await expect(storage.load()).rejects.toMatchObject({ reason: 'aborted', detail: 'storage-read-abort:AbortError' });
  });

  it('retains a catalog request quota failure when the transaction later reports AbortError', async () => {
    const storage = createIndexedDbSavePointStorage(abortingFactory('AbortError', 'QuotaExceededError'));
    await expect(storage.load()).rejects.toMatchObject({ reason: 'quota', detail: 'storage-read-abort:QuotaExceededError' });
  });

  it('byte 片の読取りの取引の中断(readBlob): storage-chunk-abort と誤りの名前', async () => {
    const storage = createIndexedDbSavePointStorage(abortingFactory('UnknownError'));
    await expect(storage.readBlob(blob)).rejects.toMatchObject({ reason: 'aborted', detail: 'storage-chunk-abort:UnknownError' });
  });

  it('書込みの取引の中断(commit): storage-write-abort と誤りの名前。誤りの名前が無い時は名前を付けない', async () => {
    const named = createIndexedDbSavePointStorage(abortingFactory('QuotaExceededError'));
    await expect(named.commit(0, {})).rejects.toMatchObject({ reason: 'aborted', detail: 'storage-write-abort:QuotaExceededError' });
    const plain = createIndexedDbSavePointStorage(abortingFactory(null));
    await expect(plain.commit(0, {})).rejects.toMatchObject({ reason: 'aborted', detail: 'storage-write-abort' });
  });

  function workerFixture() {
    const port: PcadSaveWorkerPort = { onmessage: null, onerror: null, onmessageerror: null,
      postMessage: () => undefined, terminate: vi.fn() };
    return { port, client: createPcadSavePointClient(() => port) };
  }

  it('作業者が 25 秒で応答しない時間切れ: worker-request-timeout(利用者に見える reason は aborted のまま)', async () => {
    vi.useFakeTimers();
    const { client } = workerFixture();
    const listing = client.list();
    const settled = expect(listing).rejects.toMatchObject({ reason: 'aborted', detail: 'worker-request-timeout' });
    await vi.advanceTimersByTimeAsync(25_000);
    await settled;
  });

  it('取り消しの後に作業者が 25 秒で終わらない時間切れ: worker-cancel-timeout', async () => {
    vi.useFakeTimers();
    const { client } = workerFixture();
    const controller = new AbortController();
    const listing = client.list(controller.signal);
    const settled = expect(listing).rejects.toMatchObject({ reason: 'aborted', detail: 'worker-cancel-timeout' });
    controller.abort();
    await vi.advanceTimersByTimeAsync(25_000);
    await settled;
  });
});
