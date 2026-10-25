import {
  MAX_NAMED_SAVE_POINT_BYTES, SAVE_POINT_CHUNK_BYTES, SavePointError, isSavePointBlob,
  type SavePointBlob, type SavePointChange, type SavePointState, type SavePointStorage,
} from './namedSavePoints.js';

const DB_NAME = 'pointercad-save-points';
const DB_VERSION = 1;
const POINTS = 'points', BLOBS = 'blobs', CHUNKS = 'chunks';
const META_ID = '__meta__';
type RevisionRecord = { id: typeof META_ID; version: 1; revision: number };

function error(reason: ConstructorParameters<typeof SavePointError>[0], message: string): SavePointError {
  return new SavePointError(reason, message);
}
function isRevision(value: unknown): value is RevisionRecord {
  if (typeof value !== 'object' || value === null || Object.getPrototypeOf(value) !== Object.prototype) return false;
  const keys = Reflect.ownKeys(value);
  if (keys.length !== 3 || !keys.every(key => typeof key === 'string' && ['id', 'version', 'revision'].includes(key))) return false;
  const record = value as Record<string, unknown>;
  return record.id === META_ID && record.version === 1 && Number.isSafeInteger(record.revision) &&
    typeof record.revision === 'number' && record.revision >= 0;
}
function failureFrom(value: unknown): SavePointError {
  if (typeof value === 'object' && value !== null && 'name' in value && value.name === 'QuotaExceededError')
    return error('quota', '端末の保存容量が不足しています。');
  return error('unavailable', '端末の保存先を利用できません。');
}

/** 既存自動保存DBとは別所有。未知versionや欠けたstoreを自動修復せず拒否する。 */
async function open(factory: IDBFactory | undefined): Promise<IDBDatabase> {
  if (!factory) throw error('unavailable', 'この端末ではIndexedDBを利用できません。');
  return new Promise<IDBDatabase>((resolve, reject) => {
    let request: IDBOpenDBRequest;
    let blocked = false;
    try { request = factory.open(DB_NAME, DB_VERSION); } catch (cause) { reject(failureFrom(cause)); return; }
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(POINTS)) db.createObjectStore(POINTS, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(BLOBS)) db.createObjectStore(BLOBS, { keyPath: 'sha256' });
      if (!db.objectStoreNames.contains(CHUNKS)) db.createObjectStore(CHUNKS, { keyPath: 'key' });
    };
    request.onerror = () => reject(request.error?.name === 'VersionError'
      ? error('corrupt', '保存点DBの版が未対応です。') : failureFrom(request.error));
    request.onblocked = () => { blocked = true; reject(error('unavailable', '保存点DBが他の画面により使用中です。')); };
    request.onsuccess = () => {
      const db = request.result;
      if (blocked) { db.close(); return; }
      if (db.version !== DB_VERSION || db.objectStoreNames.length !== 3 ||
          ![POINTS, BLOBS, CHUNKS].every(name => db.objectStoreNames.contains(name))) {
        db.close(); reject(error('corrupt', '保存点DBの構造が不正です。')); return;
      }
      resolve(db);
    };
  });
}

async function load(db: IDBDatabase): Promise<SavePointState> {
  return new Promise<SavePointState>((resolve, reject) => {
    let tx: IDBTransaction;
    try { tx = db.transaction([POINTS, BLOBS, CHUNKS], 'readonly'); } catch (cause) { reject(failureFrom(cause)); return; }
    const pointRequest = tx.objectStore(POINTS).getAll();
    const blobRequest = tx.objectStore(BLOBS).getAll();
    const chunkRequest = tx.objectStore(CHUNKS).getAllKeys();
    tx.onerror = () => reject(failureFrom(tx.error));
    tx.onabort = () => reject(error('aborted', '保存点DBの読取りが中断されました。'));
    tx.oncomplete = () => {
      const points: unknown = pointRequest.result, blobs: unknown = blobRequest.result, chunkKeys: unknown = chunkRequest.result;
      if (!Array.isArray(points) || !Array.isArray(blobs) || !Array.isArray(chunkKeys)) {
        reject(error('corrupt', '保存点DBの目録が壊れています。')); return;
      }
      const revisionRows = points.filter((value: unknown) => typeof value === 'object' && value !== null && 'id' in value && value.id === META_ID);
      if (revisionRows.length > 1 || (revisionRows.length === 1 && !isRevision(revisionRows[0])) ||
          (revisionRows.length === 0 && (points.length > 0 || blobs.length > 0 || chunkKeys.length > 0))) {
        reject(error('corrupt', '保存点DBの版記録が壊れています。')); return;
      }
      resolve({ revision: revisionRows.length === 0 ? 0 : (revisionRows[0] as RevisionRecord).revision,
        points: points.filter(value => value !== revisionRows[0]), blobs, chunkKeys });
    };
  });
}

function isChunk(value: unknown, key: string, length: number): value is { key: string; bytes: Uint8Array } {
  if (typeof value !== 'object' || value === null || Object.getPrototypeOf(value) !== Object.prototype) return false;
  const keys = Reflect.ownKeys(value);
  if (keys.length !== 2 || !keys.every(item => typeof item === 'string' && ['key', 'bytes'].includes(item))) return false;
  return 'key' in value && value.key === key && 'bytes' in value &&
    value.bytes instanceof Uint8Array && Object.getPrototypeOf(value.bytes) === Uint8Array.prototype &&
    value.bytes.byteLength === length;
}
async function readBlob(db: IDBDatabase, blob: SavePointBlob, signal?: AbortSignal): Promise<Uint8Array> {
  if (!isSavePointBlob(blob) || blob.byteLength > MAX_NAMED_SAVE_POINT_BYTES)
    throw error('corrupt', '保存点のblob長が不正です。');
  if (signal?.aborted) throw error('cancelled', '保存点の操作を取り消しました。');
  return new Promise<Uint8Array>((resolve, reject) => {
    let tx: IDBTransaction;
    try { tx = db.transaction(CHUNKS, 'readonly'); } catch (cause) { reject(failureFrom(cause)); return; }
    const store = tx.objectStore(CHUNKS), bytes = new Uint8Array(blob.byteLength);
    let index = 0, finished = 0, rejected: SavePointError | null = null;
    const fail = (cause: SavePointError): void => { rejected = cause; try { tx.abort(); } catch { reject(cause); } };
    const onCancel = (): void => fail(error('cancelled', '保存点の操作を取り消しました。'));
    signal?.addEventListener('abort', onCancel, { once: true });
    const next = (): void => {
      if (rejected || index >= blob.chunkCount) return;
      const chunkIndex = index++;
      const offset = chunkIndex * SAVE_POINT_CHUNK_BYTES;
      const expected = Math.min(SAVE_POINT_CHUNK_BYTES, blob.byteLength - offset);
      const key = `${blob.sha256}:${chunkIndex}`;
      let request: IDBRequest<unknown>;
      try { request = store.get(key); } catch (cause) { fail(failureFrom(cause)); return; }
      request.onerror = () => fail(failureFrom(request.error));
      request.onsuccess = () => {
        if (!isChunk(request.result, key, expected)) { fail(error('corrupt', '保存点のbyte片が壊れています。')); return; }
        bytes.set(request.result.bytes, offset); finished += 1; next();
      };
    };
    tx.onerror = () => { if (!rejected) rejected = failureFrom(tx.error); };
    tx.onabort = () => { signal?.removeEventListener('abort', onCancel);
      reject(rejected ?? error('aborted', '保存点blobの読取りが中断されました。')); };
    tx.oncomplete = () => { signal?.removeEventListener('abort', onCancel);
      if (rejected) reject(rejected);
      else if (finished === blob.chunkCount) resolve(bytes);
      else reject(error('corrupt', '保存点blobが途中で切れています。')); };
    // Keep at most four 1MiB requests in flight in this same readonly snapshot.
    // Avoid one browser/storage round trip per chunk; validate every returned byte.
    for (let lane = 0; lane < Math.min(4, blob.chunkCount); lane += 1) next();
  });
}

type WriteRequest = IDBRequest<IDBValidKey> | IDBRequest<undefined>;
type WriteStep = (points: IDBObjectStore, blobs: IDBObjectStore, chunks: IDBObjectStore) => WriteRequest;
function writeSteps(change: SavePointChange): WriteStep[] {
  const steps: WriteStep[] = [];
  if (change.pointPut) steps.push(points => points.put(change.pointPut));
  const pointDelete = change.pointDelete;
  if (pointDelete !== undefined) steps.push(points => points.delete(pointDelete));
  for (const [hash, payload] of change.blobPut ?? []) {
    if (payload.byteLength > MAX_NAMED_SAVE_POINT_BYTES)
      throw error('limitBytes', '保存点のblobが512MiBを超えます。');
    const chunkCount = Math.max(1, Math.ceil(payload.byteLength / SAVE_POINT_CHUNK_BYTES));
    steps.push((_points, blobs) => blobs.put({ version: 1, sha256: hash, byteLength: payload.byteLength, chunkCount }));
    for (let index = 0; index < chunkCount; index += 1) {
      const offset = index * SAVE_POINT_CHUNK_BYTES;
      steps.push((_points, _blobs, chunks) => chunks.put({ key: `${hash}:${index}`,
        bytes: new Uint8Array(payload.subarray(offset, Math.min(payload.length, offset + SAVE_POINT_CHUNK_BYTES))) }));
    }
  }
  for (const blob of change.blobDelete ?? []) {
    steps.push((_points, blobs) => blobs.delete(blob.sha256));
    for (let index = 0; index < blob.chunkCount; index += 1)
      steps.push((_points, _blobs, chunks) => chunks.delete(`${blob.sha256}:${index}`));
  }
  return steps;
}
async function commit(db: IDBDatabase, revision: number, change: SavePointChange, signal?: AbortSignal): Promise<void> {
  if (!Number.isSafeInteger(revision) || revision < 0 || !Number.isSafeInteger(revision + 1))
    throw error('corrupt', '保存点DBのrevisionが不正です。');
  const steps = writeSteps(change);
  return new Promise<void>((resolve, reject) => {
    let tx: IDBTransaction;
    try { tx = db.transaction([POINTS, BLOBS, CHUNKS], 'readwrite'); } catch (cause) { reject(failureFrom(cause)); return; }
    const points = tx.objectStore(POINTS), blobs = tx.objectStore(BLOBS), chunks = tx.objectStore(CHUNKS);
    let failure: SavePointError | null = null, completed = false;
    const onCancel = (): void => { failure = error('cancelled', '保存点の操作を取り消しました。'); try { tx.abort(); } catch { reject(failure); } };
    signal?.addEventListener('abort', onCancel, { once: true });
    const fail = (cause: SavePointError): void => { failure = cause; try { tx.abort(); } catch { reject(cause); } };
    let nextIndex = 0, finished = 0;
    const execute = (): void => {
      if (failure || completed) return;
      if (signal?.aborted) { onCancel(); return; }
      if (nextIndex >= steps.length && finished !== steps.length) return;
      const index = nextIndex++;
      if (index > steps.length) return;
      const step: WriteStep = index < steps.length ? steps[index] :
        (store: IDBObjectStore) => store.put({ id: META_ID, version: 1, revision: revision + 1 });
      let request: WriteRequest;
      try { request = step(points, blobs, chunks); } catch (cause) { fail(failureFrom(cause)); return; }
      request.onerror = () => fail(failureFrom(request.error));
      request.onsuccess = () => { if (index < steps.length) { finished += 1; execute(); } };
    };
    tx.onerror = () => { if (!failure) failure = failureFrom(tx.error); };
    tx.onabort = () => { signal?.removeEventListener('abort', onCancel); reject(failure ?? error('aborted', '保存点の書込みが中断されました。')); };
    tx.oncomplete = () => { completed = true; signal?.removeEventListener('abort', onCancel);
      if (failure) reject(failure); else resolve(); };
    let request: IDBRequest<unknown>;
    try { request = points.get(META_ID); } catch (cause) { fail(failureFrom(cause)); return; }
    request.onerror = () => fail(failureFrom(request.error));
    request.onsuccess = () => {
      const current = request.result;
      if ((current === undefined && revision !== 0) || (current !== undefined && (!isRevision(current) || current.revision !== revision))) {
        fail(error('conflict', '別の画面で保存点が更新されました。もう一度お試しください。')); return;
      }
      // Issue in original order with at most four outstanding requests. Enqueue
      // the revision only after every data request succeeded; the single
      // transaction's oncomplete remains the sole success boundary.
      for (let lane = 0; lane < Math.min(4, Math.max(1, steps.length)); lane += 1) execute();
    };
  });
}

/** IndexedDBはput成功後にtransaction全体がabortし得るため、oncompleteのみを成功とする。 */
export function createIndexedDbSavePointStorage(factory?: IDBFactory): SavePointStorage {
  const selected = (): IDBFactory | undefined => factory ?? globalThis.indexedDB;
  return {
    async load() { const db = await open(selected()); try { return await load(db); } finally { db.close(); } },
    async readBlob(blob, signal) { const db = await open(selected()); try { return await readBlob(db, blob, signal); } finally { db.close(); } },
    async commit(revision, change, signal) {
      const db = await open(selected());
      try { await commit(db, revision, change, signal); } finally { db.close(); }
    },
  };
}
