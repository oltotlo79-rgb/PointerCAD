import {
  IO_LIMITS, readArchive, readDrawingBundle, readPcadaFile, readPcadEntries,
} from '@pointercad/io';
import {
  SAVE_POINT_CHUNK_BYTES, SavePointError, archiveOf, cancelled, checkedUsage, refuse,
  sha256, verifySavePointState,
} from './namedSavePointIntegrity.js';
export {
  MAX_NAMED_SAVE_POINTS, MAX_NAMED_SAVE_POINT_BYTES, SAVE_POINT_CHUNK_BYTES, SavePointError,
  isNamedSavePoint, isSavePointBlob, checkedUsage, sha256, verifySavePointState,
} from './namedSavePointIntegrity.js';
const COPY_SLICE_MS = 8;
export type SavePointKind = 'part' | 'assembly' | 'drawing';
export type SavePointErrorCode = 'invalid' | 'corrupt' | 'limitPoints' | 'limitBytes' | 'unavailable' |
  'quota' | 'aborted' | 'conflict' | 'cancelled';

export interface SavePointEntry { readonly name: string; readonly sha256: string; readonly byteLength: number; readonly level: 0 | 6 }
export interface NamedSavePoint {
  readonly version: 1; readonly id: string; readonly originId: string; readonly name: string;
  readonly createdAt: string; readonly kind: SavePointKind;
  readonly sourceSha256: string; readonly sourceByteLength: number; readonly entries: readonly SavePointEntry[];
}
export interface CreatedSavePointListing { readonly point: NamedSavePoint; readonly points: readonly NamedSavePoint[] }
export interface SavePointBlob { readonly version: 1; readonly sha256: string; readonly byteLength: number; readonly chunkCount: number }
interface CapturedSavePoint { readonly kind: SavePointKind; readonly sourceSha256: string; readonly sourceByteLength: number;
  readonly entries: readonly SavePointEntry[]; readonly blobs: ReadonlyMap<string, Uint8Array> }
export interface SavePointState { readonly revision: number; readonly points: readonly unknown[];
  readonly blobs: readonly unknown[]; readonly chunkKeys: readonly unknown[] }
export interface SavePointChange { readonly pointPut?: NamedSavePoint; readonly pointDelete?: string;
  readonly blobPut?: ReadonlyMap<string, Uint8Array>; readonly blobDelete?: readonly SavePointBlob[] }
export interface SavePointStorage {
  load(): Promise<SavePointState>;
  readBlob(blob: SavePointBlob, signal?: AbortSignal): Promise<Uint8Array>;
  commit(revision: number, change: SavePointChange, signal?: AbortSignal): Promise<void>;
}

async function ownBytes(source: Uint8Array, signal?: AbortSignal): Promise<Uint8Array> {
  if (!(source instanceof Uint8Array)) refuse('invalid', '通常保存のbyte列が必要です。');
  if (source.byteLength > IO_LIMITS.archiveCompressedBytes)
    refuse('invalid', '通常保存のZIPが読取り上限を超えます。');
  const owned = new Uint8Array(source.byteLength);
  let sliceStart = performance.now();
  await new Promise<void>(resolve => setTimeout(resolve, 0));
  for (let offset = 0; offset < source.length; offset += SAVE_POINT_CHUNK_BYTES) {
    cancelled(signal);
    owned.set(source.subarray(offset, Math.min(source.length, offset + SAVE_POINT_CHUNK_BYTES)), offset);
    if (performance.now() - sliceStart >= COPY_SLICE_MS) {
      await new Promise<void>(resolve => setTimeout(resolve, 0)); sliceStart = performance.now();
    }
  }
  cancelled(signal);
  return owned;
}
function levelOf(kind: SavePointKind, name: string): 0 | 6 {
  return kind !== 'drawing' && (name === 'thumbnail.png' || /(?:^|\/)canvases\/[^/]+\.png$/.test(name)) ? 0 : 6;
}
export async function sameBytes(a: Uint8Array, b: Uint8Array, signal?: AbortSignal): Promise<boolean> {
  cancelled(signal);
  if (a.length !== b.length) return false;
  const left = new DataView(a.buffer, a.byteOffset, a.byteLength);
  const right = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let sliceStart = performance.now();
  for (let start = 0; start < a.length; start += SAVE_POINT_CHUNK_BYTES) {
    cancelled(signal);
    const end = Math.min(start + SAVE_POINT_CHUNK_BYTES, a.length);
    let i = start;
    // Compare all bits, including unaligned views and every final tail byte.
    // Keep the deadline/cancellation check outside the per-word hot loop.
    for (; i + 4 <= end; i += 4) if (left.getUint32(i) !== right.getUint32(i)) return false;
    for (; i < end; i += 1) if (a[i] !== b[i]) return false;
    if (performance.now() - sliceStart >= COPY_SLICE_MS) {
      await new Promise<void>(resolve => setTimeout(resolve, 0)); cancelled(signal); sliceStart = performance.now();
    }
  }
  return true;
}

/** 普通の保存codecの出力だけを受ける。入力は借用し、返すblobは全て所有byte。 */
async function capturePcadSavePoint(bytes: Uint8Array, kind: SavePointKind, signal?: AbortSignal): Promise<CapturedSavePoint> {
  if (kind !== 'part' && kind !== 'assembly' && kind !== 'drawing') refuse('invalid', '保存点の文書種別が不正です。');
  const owned = await ownBytes(bytes, signal);
  const partArchive = kind === 'part' ? readArchive(owned, { shouldExtract: () => true }) : null;
  if (partArchive !== null && !partArchive.ok) refuse('invalid', '通常保存のZIPを読めません。');
  try {
    const valid = partArchive?.ok ? readPcadEntries(partArchive.entries) :
      kind === 'assembly' ? await readPcadaFile(owned) : await readDrawingBundle(owned);
    if (!valid.ok || (kind === 'part' && 'kind' in valid && valid.kind !== 'part'))
      refuse('invalid', '通常保存のPointerCAD文書を読めません。');
  } catch (cause) {
    if (cause instanceof SavePointError) throw cause;
    refuse('invalid', '通常保存のPointerCAD文書を読めません。');
  }
  const archive = partArchive ?? readArchive(owned, { shouldExtract: () => true });
  if (!archive.ok || archive.entries.size === 0) refuse('invalid', '通常保存のZIPを読めません。');
  const blobs = new Map<string, Uint8Array>(), items: SavePointEntry[] = [];
  let uniqueBytes = 0;
  for (const [name, payload] of archive.entries) {
    cancelled(signal);
    const hash = await sha256(payload);
    const duplicate = blobs.get(hash);
    if (duplicate && !await sameBytes(duplicate, payload, signal)) refuse('corrupt', '同じSHAに異なるbyte列があります。');
    if (!duplicate) uniqueBytes = checkedUsage(1, uniqueBytes, payload.byteLength);
    blobs.set(hash, payload);
    items.push({ name, sha256: hash, byteLength: payload.byteLength, level: levelOf(kind, name) });
  }
  const rebuilt = archiveOf(items, blobs);
  if (!await sameBytes(owned, rebuilt, signal)) refuse('invalid', '通常保存のcanonical ZIPと一致しません。');
  return { kind, sourceSha256: await sha256(owned), sourceByteLength: owned.byteLength, entries: items, blobs };
}

function publicPoint(point: NamedSavePoint): NamedSavePoint { return { ...point, entries: point.entries.map(entry => ({ ...entry })) }; }
function named(name: string): string {
  if (typeof name !== 'string' || name.trim().length === 0 || name.length > 128)
    refuse('invalid', '保存点の名前は1〜128文字で指定してください。');
  return name.trim();
}
function findPoint(state: Awaited<ReturnType<typeof verifySavePointState>>, id: string): NamedSavePoint {
  const point = state.points.find(item => item.id === id);
  if (!point) refuse('invalid', '指定した保存点が見つかりません。');
  return point;
}

export function createNamedSavePoints(storage: SavePointStorage) {
  async function createAndList(name: string, bytes: Uint8Array, kind: SavePointKind, signal?: AbortSignal): Promise<CreatedSavePointListing> {
    const state = await verifySavePointState(storage, signal);
    checkedUsage(state.points.length + 1, state.usedBytes, 0);
    const captured = await capturePcadSavePoint(bytes, kind, signal);
    const id = `point:${crypto.randomUUID()}`;
    const point: NamedSavePoint = { version: 1, id, originId: id, name: named(name),
      createdAt: new Date().toISOString(), kind, sourceSha256: captured.sourceSha256,
      sourceByteLength: captured.sourceByteLength, entries: captured.entries.map(entry => ({ ...entry })) };
    let extra = 0;
    const additions = new Map<string, Uint8Array>();
    for (const [hash, payload] of captured.blobs) {
      const stored = state.blobs.get(hash);
      if (stored && stored.byteLength !== payload.byteLength) refuse('corrupt', '既存blobの長さが一致しません。');
      if (!stored) { extra = checkedUsage(state.points.length + 1, extra, payload.byteLength); additions.set(hash, payload); }
    }
    checkedUsage(state.points.length + 1, state.usedBytes, extra);
    cancelled(signal);
    await storage.commit(state.revision, { pointPut: point, blobPut: additions }, signal);
    // The revision-checked transaction commits exactly this fully verified snapshot.
    // Later independent list calls still read and verify all persisted bytes.
    return { point: publicPoint(point), points: [...state.points, point].map(publicPoint) };
  }
  return {
    async list(signal?: AbortSignal): Promise<readonly NamedSavePoint[]> {
      return (await verifySavePointState(storage, signal)).points.map(publicPoint);
    },
    createAndList,
    async create(name: string, bytes: Uint8Array, kind: SavePointKind, signal?: AbortSignal): Promise<NamedSavePoint> {
      return (await createAndList(name, bytes, kind, signal)).point;
    },
    async clone(id: string, name: string, signal?: AbortSignal): Promise<NamedSavePoint> {
      const state = await verifySavePointState(storage, signal), source = findPoint(state, id);
      checkedUsage(state.points.length + 1, state.usedBytes, 0);
      const point: NamedSavePoint = { ...source, id: `point:${crypto.randomUUID()}`, name: named(name),
        createdAt: new Date().toISOString(), entries: source.entries.map(entry => ({ ...entry })) };
      cancelled(signal); await storage.commit(state.revision, { pointPut: point }, signal);
      return publicPoint(point);
    },
    async rename(id: string, name: string, signal?: AbortSignal): Promise<NamedSavePoint> {
      const state = await verifySavePointState(storage, signal), point = { ...findPoint(state, id), name: named(name) };
      cancelled(signal); await storage.commit(state.revision, { pointPut: point }, signal);
      return publicPoint(point);
    },
    async remove(id: string, signal?: AbortSignal): Promise<void> {
      const state = await verifySavePointState(storage, signal);
      findPoint(state, id);
      const remaining = new Set(state.points.filter(point => point.id !== id).flatMap(point => point.entries.map(entry => entry.sha256)));
      const deleted = [...state.blobs.values()].filter(blob => !remaining.has(blob.sha256));
      cancelled(signal); await storage.commit(state.revision, { pointDelete: id, blobDelete: deleted }, signal);
    },
    async read(id: string, signal?: AbortSignal): Promise<{ point: NamedSavePoint; bytes: Uint8Array }> {
      const state = await verifySavePointState(storage, signal, id), point = findPoint(state, id);
      const bytes = state.selectedBytes;
      if (!bytes) refuse('corrupt', '保存点の元ZIPが見つかりません。');
      cancelled(signal);
      return { point: publicPoint(point), bytes };
    },
  };
}
