import { ARCHIVE_READ_CHUNK_BYTES, readArchiveRange, type ArchiveReadSource } from './archiveReadSource.js';

/** 展開せずZIPの領域・宣言値・対応関係を検査する。
 * PKWARE APPNOTE 6.3.10 §4.3/4.5.3:
 * https://pkware.cachefly.net/webdocs/casestudies/APPNOTE.TXT */
export class ZipDirectoryError extends Error {
  constructor(readonly kind: 'invalidZip' | 'entryCount' | 'invalidName' | 'duplicateName', readonly entryName?: string) {
    super(kind);
  }
}

export interface ZipEntryLocation {
  readonly name: string;
  readonly method: 0 | 8;
  readonly crc32: number;
  readonly expandedSize: number;
  readonly dataOffset: number;
  readonly compressedSize: number;
}

export interface ZipEntryRegion extends Omit<ZipEntryLocation, 'dataOffset' | 'compressedSize'> {
  readonly compressed: Uint8Array;
}

class ZipBytes {
  readonly view: DataView;
  constructor(readonly bytes: Uint8Array) { this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength); }
  range(offset: number, length: number, limit = this.bytes.length): void {
    requireRange(offset, length, limit);
  }
  u16(offset: number): number { this.range(offset, 2); return this.view.getUint16(offset, true); }
  u32(offset: number): number { this.range(offset, 4); return this.view.getUint32(offset, true); }
  u64(offset: number): number {
    const value = this.u32(offset) + this.u32(offset + 4) * 4294967296;
    if (!Number.isSafeInteger(value)) throw new ZipDirectoryError('invalidZip');
    return value;
  }
  sub(offset: number, length: number): Uint8Array { this.range(offset, length); return this.bytes.subarray(offset, offset + length); }
}

type ZipRead = Generator<readonly [offset: number, length: number], DirectoryLocation, Uint8Array>;

function requireRange(offset: number, length: number, limit: number): void {
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || offset > limit - length) {
    throw new ZipDirectoryError('invalidZip');
  }
}

interface DirectoryLocation { readonly start: number; readonly size: number; readonly count: number }
function* directoryLocation(length: number): ZipRead {
  if (length < 22) throw new ZipDirectoryError('invalidZip');
  const tailOffset = Math.max(0, length - (65535 + 22 + 20));
  const reader = new ZipBytes(yield [tailOffset, length - tailOffset]);
  const bytes = reader.bytes;
  let end = bytes.length - 22;
  const first = Math.max(0, end - 65535);
  for (; end >= first; end--) {
    if (reader.u32(end) === 0x06054b50 && end + 22 + reader.u16(end + 20) === bytes.length) break;
  }
  if (end < first || reader.u16(end + 4) !== 0 || reader.u16(end + 6) !== 0) throw new ZipDirectoryError('invalidZip');
  let count = reader.u16(end + 10), size = reader.u32(end + 12), start = reader.u32(end + 16);
  if (reader.u16(end + 8) !== count) throw new ZipDirectoryError('invalidZip');
  let directoryEnd = tailOffset + end;
  const hasLocator = end >= 20 && reader.u32(end - 20) === 0x07064b50;
  if (hasLocator) {
    const locator = end - 20, zip64 = reader.u64(locator + 8);
    if (reader.u32(locator + 4) !== 0 || reader.u32(locator + 16) !== 1) throw new ZipDirectoryError('invalidZip');
    const locatorOffset = tailOffset + locator;
    requireRange(zip64, 56, locatorOffset);
    const wide = new ZipBytes(yield [zip64, 56]);
    const recordSize = wide.u64(4);
    if (wide.u32(0) !== 0x06064b50 || recordSize < 44 || recordSize !== locatorOffset - zip64 - 12
      || wide.u32(16) !== 0 || wide.u32(20) !== 0) throw new ZipDirectoryError('invalidZip');
    const count64 = wide.u64(32), size64 = wide.u64(40), start64 = wide.u64(48);
    if (wide.u64(24) !== count64 || (count !== 65535 && count !== count64)
      || (size !== 0xffffffff && size !== size64) || (start !== 0xffffffff && start !== start64)) throw new ZipDirectoryError('invalidZip');
    count = count64; size = size64; start = start64; directoryEnd = zip64;
  } else if (count === 65535 || size === 0xffffffff || start === 0xffffffff) {
    throw new ZipDirectoryError('invalidZip');
  }
  requireRange(start, size, directoryEnd);
  if (start + size !== directoryEnd) throw new ZipDirectoryError('invalidZip');
  return { start, size, count };
}

/** 未知の追加欄も長さを検査し、ZIP64の重複は解釈を一意にできないため断る。 */
function zip64Extra(reader: ZipBytes, offset: number, length: number): number | null {
  const end = offset + length; reader.range(offset, length);
  let found: number | null = null;
  for (let cursor = offset; cursor < end;) {
    reader.range(cursor, 4, end);
    const id = reader.u16(cursor), size = reader.u16(cursor + 2);
    reader.range(cursor + 4, size, end);
    if (id === 1) {
      if (found !== null) throw new ZipDirectoryError('invalidZip');
      found = cursor;
    }
    cursor += 4 + size;
  }
  return found;
}

interface Sizes { readonly expanded: number; readonly compressed: number; readonly local: number; readonly disk: number; readonly zip64: boolean }
function resolveSizes(reader: ZipBytes, extra: number | null, expanded: number, compressed: number, local: number, disk: number): Sizes {
  const zip64 = expanded === 0xffffffff || compressed === 0xffffffff;
  let position = extra === null ? -1 : extra + 4;
  const end = extra === null ? -1 : position + reader.u16(extra + 2);
  const wide = (): number => {
    if (extra === null) throw new ZipDirectoryError('invalidZip');
    reader.range(position, 8, end); const value = reader.u64(position); position += 8; return value;
  };
  if (expanded === 0xffffffff) expanded = wide();
  if (compressed === 0xffffffff) compressed = wide();
  if (local === 0xffffffff) local = wide();
  if (disk === 65535) {
    if (extra === null) throw new ZipDirectoryError('invalidZip');
    reader.range(position, 4, end); disk = reader.u32(position);
  }
  return { expanded, compressed, local, disk, zip64 };
}

/** 項目名として受け入れる名前か(空・絶対パス・逆斜線・NUL・ドライブ名・`..` を断る)。 */
export function isSafeZipEntryName(name: string): boolean {
  return !(!name || name.startsWith('/') || name.includes('\\') || name.includes('\0')
    || /^[A-Za-z]:/.test(name) || name.split('/').includes('..'));
}

function entryName(bytes: Uint8Array, utf8: boolean): string {
  const name = utf8 ? new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    : Array.from(bytes, (byte) => String.fromCharCode(byte)).join('');
  if (!isSafeZipEntryName(name)) throw new ZipDirectoryError('invalidName', name);
  return name;
}

function descriptorEnd(reader: ZipBytes, start: number, limit: number, crc: number, sizes: Sizes): number {
  // CRC自身が署名と同値になる場合もあるため、署名あり/なしを実値で照合する。
  const candidates = reader.u32(start) === 0x08074b50 ? [start + 4, start] : [start];
  const length = sizes.zip64 ? 20 : 12;
  for (const cursor of candidates) {
    if (cursor > limit - length) continue;
    // 誤った候補の64-bit欄がunsafe integerでも、もう一方の正しい候補を捨てない。
    try {
      const compressed = sizes.zip64 ? reader.u64(cursor + 4) : reader.u32(cursor + 4);
      const expanded = sizes.zip64 ? reader.u64(cursor + 12) : reader.u32(cursor + 8);
      if (reader.u32(cursor) === crc && compressed === sizes.compressed && expanded === sizes.expanded) return cursor + length;
    } catch (error) {
      if (!(error instanceof ZipDirectoryError)) throw error;
    }
  }
  throw new ZipDirectoryError('invalidZip');
}

interface CentralEntry {
  readonly name: string;
  readonly rawName: Uint8Array;
  readonly method: 0 | 8;
  readonly crc: number;
  readonly flags: number;
  readonly sizes: Sizes;
  readonly next: number;
}

function* centralEntry(cursor: number, centralEnd: number):
  Generator<readonly [number, number], CentralEntry, Uint8Array> {
  requireRange(cursor, 46, centralEnd);
  const reader = new ZipBytes(yield [cursor, 46]);
  if (reader.u32(0) !== 0x02014b50) throw new ZipDirectoryError('invalidZip');
  const flags = reader.u16(8), method = reader.u16(10), crc = reader.u32(16);
  // 圧縮オプション、descriptor、UTF-8だけを許容。
  if ((flags & ~0x080e) !== 0 || (method !== 0 && method !== 8)) throw new ZipDirectoryError('invalidZip');
  const nameLength = reader.u16(28), extraLength = reader.u16(30);
  const next = cursor + 46 + nameLength + extraLength + reader.u16(32);
  requireRange(cursor, next - cursor, centralEnd);
  if (nameLength === 0) throw new ZipDirectoryError('invalidName', '');
  const fields = new ZipBytes(yield [cursor + 46, nameLength + extraLength]);
  const rawName = fields.sub(0, nameLength), name = entryName(rawName, (flags & 0x0800) !== 0);
  const sizes = resolveSizes(fields, zip64Extra(fields, nameLength, extraLength),
    reader.u32(24), reader.u32(20), reader.u32(42), reader.u16(34));
  if (sizes.disk !== 0) throw new ZipDirectoryError('invalidZip', name);
  return { name, rawName, method, crc, flags, sizes, next };
}

interface ParsedEntry {
  readonly entry: ZipEntryLocation;
  readonly localStart: number;
  readonly localEnd: number;
}

function* localEntry(central: CentralEntry, dataEnd: number):
  Generator<readonly [number, number], ParsedEntry, Uint8Array> {
  const { name, rawName, method, crc, flags, sizes } = central;
  const local = sizes.local, nameLength = rawName.length;
  requireRange(local, 30, dataEnd);
  const reader = new ZipBytes(yield [local, 30]);
  if (reader.u32(0) !== 0x04034b50 || reader.u16(6) !== flags || reader.u16(8) !== method
    || reader.u16(26) !== nameLength) throw new ZipDirectoryError('invalidZip', name);
  const extraLength = reader.u16(28), data = local + 30 + nameLength + extraLength;
  requireRange(local, data - local, dataEnd);
  const fields = new ZipBytes(yield [local + 30, nameLength + extraLength]);
  if (!rawName.every((value, index) => value === fields.bytes[index])) throw new ZipDirectoryError('invalidZip', name);
  const localSizes = resolveSizes(fields, zip64Extra(fields, nameLength, extraLength), reader.u32(22), reader.u32(18), 0, 0);
  const streaming = (flags & 8) !== 0;
  if ((reader.u32(14) !== crc && !(streaming && reader.u32(14) === 0))
    || (localSizes.expanded !== sizes.expanded && !(streaming && localSizes.expanded === 0))
    || (localSizes.compressed !== sizes.compressed && !(streaming && localSizes.compressed === 0))) throw new ZipDirectoryError('invalidZip', name);
  requireRange(data, sizes.compressed, dataEnd);
  const dataLimit = data + sizes.compressed;
  let localEnd = dataLimit;
  if (streaming) {
    const length = Math.min(24, dataEnd - dataLimit);
    if (length < 12) throw new ZipDirectoryError('invalidZip', name);
    const descriptor = new ZipBytes(yield [dataLimit, length]);
    localEnd += descriptorEnd(descriptor, 0, length, crc, { ...sizes, zip64: sizes.zip64 || localSizes.zip64 });
  }
  return { entry: { name, method, crc32: crc, expandedSize: sizes.expanded, dataOffset: data, compressedSize: sizes.compressed },
    localStart: local, localEnd };
}

function* directoryEntries(size: number, maximumEntries: number):
  Generator<readonly [number, number], readonly ZipEntryLocation[], Uint8Array> {
  if (!Number.isSafeInteger(maximumEntries) || maximumEntries < 0) throw new ZipDirectoryError('entryCount');
  if (!Number.isSafeInteger(size) || size < 22) throw new ZipDirectoryError('invalidZip');
  const directory = yield* directoryLocation(size);
  if (directory.count > maximumEntries) throw new ZipDirectoryError('entryCount');
  const entries: ParsedEntry[] = [], names = new Set<string>();
  let cursor = directory.start;
  for (let index = 0; index < directory.count; index++) {
    const central = yield* centralEntry(cursor, directory.start + directory.size);
    const parsed = yield* localEntry(central, directory.start);
    if (names.has(parsed.entry.name)) throw new ZipDirectoryError('duplicateName', parsed.entry.name);
    names.add(parsed.entry.name); entries.push(parsed); cursor = central.next;
  }
  if (cursor !== directory.start + directory.size) throw new ZipDirectoryError('invalidZip');
  let end = 0;
  for (const entry of [...entries].sort((left, right) => left.localStart - right.localStart)) {
    if (entry.localStart !== end) throw new ZipDirectoryError('invalidZip', entry.entry.name);
    end = entry.localEnd;
  }
  if (end !== directory.start) throw new ZipDirectoryError('invalidZip');
  return entries.map((entry) => entry.entry);
}

export function zipDirectory(bytes: Uint8Array, maximumEntries: number): readonly ZipEntryRegion[] {
  const reader = new ZipBytes(bytes), scan = directoryEntries(bytes.length, maximumEntries);
  let step = scan.next();
  while (!step.done) step = scan.next(reader.sub(...step.value));
  return step.value.map(({ dataOffset, compressedSize, ...entry }) => ({
    ...entry, compressed: reader.sub(dataOffset, compressedSize),
  }));
}

interface ZipReadWindow {
  readonly offset: number;
  readonly bytes: Uint8Array;
}

/** Keep a bounded lookup window for each of the central and local metadata streams. */
export async function zipDirectoryFromSource(source: ArchiveReadSource, maximumEntries: number): Promise<readonly ZipEntryLocation[]> {
  const scan = directoryEntries(source.size, maximumEntries);
  let first: ZipReadWindow | undefined;
  let second: ZipReadWindow | undefined;
  let step = scan.next();
  while (!step.done) {
    const [offset, length] = step.value;
    const covers = (window: ZipReadWindow | undefined) => window !== undefined
      && offset >= window.offset && offset - window.offset <= window.bytes.length - length;
    const hit = [first, second].find(covers);
    const window = hit ?? { offset, bytes: await readArchiveRange(source, offset,
      Math.min(Math.max(length, 65536), ARCHIVE_READ_CHUNK_BYTES, source.size - offset)) };
    if (window !== first) { second = first; first = window; }
    const start = offset - window.offset;
    step = scan.next(window.bytes.subarray(start, start + length));
  }
  return step.value;
}
