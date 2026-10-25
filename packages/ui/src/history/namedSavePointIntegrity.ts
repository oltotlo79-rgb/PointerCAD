import { FIXED_ENTRY_MTIME, IO_LIMITS, zipPcadEntries, type PcadZipEntries } from '@pointercad/io';
import type {
  NamedSavePoint, SavePointBlob, SavePointEntry, SavePointErrorCode, SavePointStorage,
} from './namedSavePoints.js';

export const MAX_NAMED_SAVE_POINTS = 100;
export const MAX_NAMED_SAVE_POINT_BYTES = 512 * 1024 * 1024;
export const SAVE_POINT_CHUNK_BYTES = 1024 * 1024;
const SHA = /^[0-9a-f]{64}$/;
const POINT_ID = /^point:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
export class SavePointError extends Error {
  constructor(readonly reason: SavePointErrorCode, message: string) { super(message); this.name = 'SavePointError'; }
}

export function refuse(reason: SavePointErrorCode, message: string): never { throw new SavePointError(reason, message); }
export function cancelled(signal?: AbortSignal): void { if (signal?.aborted) refuse('cancelled', '保存点の操作を取り消しました。'); }
function safe(value: unknown): value is number { return Number.isSafeInteger(value) && typeof value === 'number' && value >= 0; }
function cleanArray(value: unknown, maximum: number): value is unknown[] {
  try {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > maximum) return false;
    const keys = Reflect.ownKeys(value);
    if (keys.length !== value.length + 1) return false;
    const own = new Set(keys);
    if (!own.has('length')) return false;
    for (let index = 0; index < value.length; index += 1) {
      const key = String(index), descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!own.has(key) || descriptor === undefined || !('value' in descriptor)) return false;
    }
    return true;
  } catch { return false; }
}
function plain(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  try {
    if (typeof value !== 'object' || value === null || Object.getPrototypeOf(value) !== Object.prototype) return false;
    const own = Reflect.ownKeys(value);
    return own.length === keys.length && own.every(key => {
      if (typeof key !== 'string' || !keys.includes(key)) return false;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return descriptor !== undefined && 'value' in descriptor;
    });
  } catch { return false; }
}
function entries(value: unknown): value is readonly SavePointEntry[] {
  return cleanArray(value, 4096) &&
    value.every(item => plain(item, ['name', 'sha256', 'byteLength', 'level']) &&
      typeof item.name === 'string' && item.name.length > 0 && !item.name.includes('\\') &&
      !item.name.split('/').some(segment => segment === '' || segment === '.' || segment === '..') &&
      typeof item.sha256 === 'string' &&
      SHA.test(item.sha256) && safe(item.byteLength) && item.byteLength <= IO_LIMITS.archiveEntryExpandedBytes &&
      (item.level === 0 || item.level === 6));
}
export function isNamedSavePoint(value: unknown): value is NamedSavePoint {
  return plain(value, ['version', 'id', 'originId', 'name', 'createdAt', 'kind', 'sourceSha256', 'sourceByteLength', 'entries']) &&
    value.version === 1 && typeof value.id === 'string' && POINT_ID.test(value.id) &&
    typeof value.originId === 'string' && POINT_ID.test(value.originId) &&
    typeof value.name === 'string' && value.name.trim().length > 0 && value.name === value.name.trim() && value.name.length <= 128 &&
    typeof value.createdAt === 'string' && ISO_TIME.test(value.createdAt) &&
    Number.isFinite(Date.parse(value.createdAt)) && new Date(value.createdAt).toISOString() === value.createdAt &&
    (value.kind === 'part' || value.kind === 'assembly' || value.kind === 'drawing') &&
    typeof value.sourceSha256 === 'string' && SHA.test(value.sourceSha256) &&
    safe(value.sourceByteLength) && value.sourceByteLength > 0 &&
    value.sourceByteLength <= IO_LIMITS.archiveCompressedBytes && entries(value.entries) && value.entries.length > 0;
}
export function isSavePointBlob(value: unknown): value is SavePointBlob {
  return plain(value, ['version', 'sha256', 'byteLength', 'chunkCount']) && value.version === 1 &&
    typeof value.sha256 === 'string' && SHA.test(value.sha256) && safe(value.byteLength) &&
    value.byteLength <= MAX_NAMED_SAVE_POINT_BYTES && safe(value.chunkCount) &&
    value.chunkCount === Math.max(1, Math.ceil(value.byteLength / SAVE_POINT_CHUNK_BYTES));
}
export function checkedUsage(pointCount: number, currentBytes: number, addedBytes: number): number {
  if (!safe(pointCount) || !safe(currentBytes) || !safe(addedBytes)) refuse('corrupt', '保存点の容量情報が壊れています。');
  if (pointCount > MAX_NAMED_SAVE_POINTS) refuse('limitPoints', '保存点は100件までです。');
  if (currentBytes > MAX_NAMED_SAVE_POINT_BYTES || addedBytes > MAX_NAMED_SAVE_POINT_BYTES - currentBytes)
    refuse('limitBytes', '保存点の実体は合計512MiBまでです。');
  return currentBytes + addedBytes;
}

/** WebCryptoへ渡す配列はこのrepository所有のArrayBufferに限る。 */
export async function sha256(bytes: Uint8Array): Promise<string> {
  const buffer = bytes.buffer;
  if (!(buffer instanceof ArrayBuffer) || bytes.byteOffset !== 0 || bytes.byteLength !== buffer.byteLength)
    refuse('invalid', 'SHA-256の入力byte境界が不正です。');
  if (!globalThis.crypto?.subtle) refuse('unavailable', 'この端末ではSHA-256を利用できません。');
  const digest = await globalThis.crypto.subtle.digest('SHA-256', buffer);
  return [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('');
}
export function archiveOf(entriesToWrite: readonly SavePointEntry[], blobs: ReadonlyMap<string, Uint8Array>): Uint8Array {
  const entries: PcadZipEntries = new Map();
  for (const entry of entriesToWrite) {
    const bytes = blobs.get(entry.sha256);
    if (!bytes || bytes.byteLength !== entry.byteLength || entries.has(entry.name))
      refuse('corrupt', '保存点のZIP項目参照が壊れています。');
    entries.set(entry.name, [bytes, { level: entry.level, mtime: FIXED_ENTRY_MTIME }]);
  }
  try { return zipPcadEntries(entries); } catch { return refuse('corrupt', '保存点のZIPを再構築できません。'); }
}
interface VerifiedState { revision: number; points: NamedSavePoint[]; blobs: Map<string, SavePointBlob>;
  usedBytes: number; selectedBytes?: Uint8Array }
/** 一覧でも全参照・全実byteを再検証する。blobは一つずつ読み捨てる。 */
export async function verifySavePointState(storage: SavePointStorage, signal?: AbortSignal, selectedId?: string): Promise<VerifiedState> {
  cancelled(signal);
  const raw = await storage.load();
  if (!safe(raw.revision) || raw.revision === Number.MAX_SAFE_INTEGER ||
      !cleanArray(raw.points, MAX_NAMED_SAVE_POINTS + 1) ||
      !cleanArray(raw.blobs, 409600) || !cleanArray(raw.chunkKeys, 524288))
    refuse('corrupt', '保存点の目録が壊れています。');
  const points: NamedSavePoint[] = [], blobs = new Map<string, SavePointBlob>();
  const ids = new Set<string>(), references = new Map<string, number>();
  const origins = new Map<string, string>();
  for (const value of raw.points) {
    if (!isNamedSavePoint(value) || ids.has(value.id)) refuse('corrupt', '保存点のmanifestが壊れています。');
    ids.add(value.id); points.push(value);
    const sourceIdentity = JSON.stringify([value.kind, value.sourceSha256, value.sourceByteLength, value.entries]);
    const originIdentity = origins.get(value.originId);
    if (originIdentity !== undefined && originIdentity !== sourceIdentity)
      refuse('corrupt', '同じ原点を持つ保存点の内容が一致しません。');
    origins.set(value.originId, sourceIdentity);
    const names = new Set<string>();
    for (const entry of value.entries) {
      if (names.has(entry.name)) refuse('corrupt', '保存点の項目名が重複しています。');
      names.add(entry.name); references.set(entry.sha256, (references.get(entry.sha256) ?? 0) + 1);
    }
  }
  checkedUsage(points.length, 0, 0);
  let usedBytes = 0;
  for (const value of raw.blobs) {
    if (!isSavePointBlob(value) || blobs.has(value.sha256) || !references.has(value.sha256))
      refuse('corrupt', '保存点のblob目録が壊れています。');
    usedBytes = checkedUsage(points.length, usedBytes, value.byteLength);
    blobs.set(value.sha256, value);
  }
  for (const point of points) for (const entry of point.entries) {
    if (blobs.get(entry.sha256)?.byteLength !== entry.byteLength) refuse('corrupt', '保存点の参照長が一致しません。');
  }
  if (blobs.size !== references.size) refuse('corrupt', '保存点に欠けたblobがあります。');
  const expectedChunks = new Set<string>();
  for (const blob of blobs.values()) for (let i = 0; i < blob.chunkCount; i += 1) expectedChunks.add(`${blob.sha256}:${i}`);
  if (raw.chunkKeys.length !== expectedChunks.size || raw.chunkKeys.some(key => typeof key !== 'string' || !expectedChunks.delete(key)))
    refuse('corrupt', '保存点のbyte片の参照が壊れています。');
  const hashed = new Set<string>(), validatedSource = new Set<string>();
  let selectedBytes: Uint8Array | undefined;
  for (const point of points) {
    const sourceKey = JSON.stringify([point.sourceSha256, point.sourceByteLength, point.entries]);
    if (validatedSource.has(sourceKey) && point.id !== selectedId) continue;
    const payloads = new Map<string, Uint8Array>();
    for (const entry of point.entries) if (!payloads.has(entry.sha256)) {
      cancelled(signal);
      const blob = blobs.get(entry.sha256);
      if (!blob) refuse('corrupt', '保存点のblobが見つかりません。');
      const bytes = await storage.readBlob(blob, signal);
      if (bytes.byteLength !== blob.byteLength || (!hashed.has(blob.sha256) && await sha256(bytes) !== blob.sha256))
        refuse('corrupt', '保存点のblob hashまたは長さが一致しません。');
      hashed.add(blob.sha256); payloads.set(blob.sha256, bytes);
    }
    const source = archiveOf(point.entries, payloads);
    if (source.byteLength !== point.sourceByteLength || await sha256(source) !== point.sourceSha256)
      refuse('corrupt', '保存点の元ZIPのhashまたは長さが一致しません。');
    if (point.id === selectedId) selectedBytes = source;
    validatedSource.add(sourceKey);
  }
  cancelled(signal);
  return { revision: raw.revision, points, blobs, usedBytes, selectedBytes };
}

