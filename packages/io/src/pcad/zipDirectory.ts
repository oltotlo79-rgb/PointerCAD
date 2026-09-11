/** R06/R10: 展開せずZIPの領域・宣言値・対応関係を検査する。
 * PKWARE APPNOTE 6.3.10 §4.3/4.5.3:
 * https://pkware.cachefly.net/webdocs/casestudies/APPNOTE.TXT */
export class ZipDirectoryError extends Error {
  constructor(readonly kind: 'invalidZip' | 'entryCount' | 'invalidName' | 'duplicateName', readonly entryName?: string) {
    super(kind);
  }
}

export interface ZipEntryRegion {
  readonly name: string;
  readonly method: 0 | 8;
  readonly crc32: number;
  readonly expandedSize: number;
  readonly compressed: Uint8Array;
}

class ZipBytes {
  readonly view: DataView;
  constructor(readonly bytes: Uint8Array) { this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength); }
  range(offset: number, length: number, limit = this.bytes.length): void {
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || offset > limit - length) {
      throw new ZipDirectoryError('invalidZip');
    }
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

interface DirectoryLocation { readonly start: number; readonly size: number; readonly count: number }
function directoryLocation(reader: ZipBytes): DirectoryLocation {
  const bytes = reader.bytes;
  let end = bytes.length - 22;
  const first = Math.max(0, end - 65535);
  for (; end >= first; end--) {
    if (reader.u32(end) === 0x06054b50 && end + 22 + reader.u16(end + 20) === bytes.length) break;
  }
  if (end < first || reader.u16(end + 4) !== 0 || reader.u16(end + 6) !== 0) throw new ZipDirectoryError('invalidZip');
  let count = reader.u16(end + 10), size = reader.u32(end + 12), start = reader.u32(end + 16);
  if (reader.u16(end + 8) !== count) throw new ZipDirectoryError('invalidZip');
  let directoryEnd = end;
  const hasLocator = end >= 20 && reader.u32(end - 20) === 0x07064b50;
  if (hasLocator) {
    const locator = end - 20, zip64 = reader.u64(locator + 8);
    if (reader.u32(locator + 4) !== 0 || reader.u32(locator + 16) !== 1) throw new ZipDirectoryError('invalidZip');
    reader.range(zip64, 56, locator);
    const recordSize = reader.u64(zip64 + 4);
    if (reader.u32(zip64) !== 0x06064b50 || recordSize < 44 || zip64 + 12 + recordSize !== locator
      || reader.u32(zip64 + 16) !== 0 || reader.u32(zip64 + 20) !== 0) throw new ZipDirectoryError('invalidZip');
    const count64 = reader.u64(zip64 + 32), size64 = reader.u64(zip64 + 40), start64 = reader.u64(zip64 + 48);
    if (reader.u64(zip64 + 24) !== count64 || (count !== 65535 && count !== count64)
      || (size !== 0xffffffff && size !== size64) || (start !== 0xffffffff && start !== start64)) throw new ZipDirectoryError('invalidZip');
    count = count64; size = size64; start = start64; directoryEnd = zip64;
  } else if (count === 65535 || size === 0xffffffff || start === 0xffffffff) {
    throw new ZipDirectoryError('invalidZip');
  }
  reader.range(start, size, directoryEnd);
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

function entryName(bytes: Uint8Array, utf8: boolean): string {
  const name = utf8 ? new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    : Array.from(bytes, (byte) => String.fromCharCode(byte)).join('');
  if (!name || name.startsWith('/') || name.includes('\\') || name.includes('\0')
    || /^[A-Za-z]:/.test(name) || name.split('/').includes('..')) throw new ZipDirectoryError('invalidName', name);
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

interface ParsedEntry { readonly entry: ZipEntryRegion; readonly localStart: number; readonly localEnd: number; readonly next: number }
function parseEntry(reader: ZipBytes, cursor: number, centralEnd: number, dataEnd: number): ParsedEntry {
  reader.range(cursor, 46, centralEnd);
  if (reader.u32(cursor) !== 0x02014b50) throw new ZipDirectoryError('invalidZip');
  const flags = reader.u16(cursor + 8), method = reader.u16(cursor + 10), crc = reader.u32(cursor + 16);
  // 圧縮オプション、descriptor、UTF-8だけを許容。暗号化/特殊ヘッダは対応しない。
  if ((flags & ~0x080e) !== 0 || (method !== 0 && method !== 8)) throw new ZipDirectoryError('invalidZip');
  const nameLength = reader.u16(cursor + 28), extraLength = reader.u16(cursor + 30), commentLength = reader.u16(cursor + 32);
  const next = cursor + 46 + nameLength + extraLength + commentLength;
  reader.range(cursor, next - cursor, centralEnd);
  const rawName = reader.sub(cursor + 46, nameLength), name = entryName(rawName, (flags & 0x0800) !== 0);
  const sizes = resolveSizes(reader, zip64Extra(reader, cursor + 46 + nameLength, extraLength),
    reader.u32(cursor + 24), reader.u32(cursor + 20), reader.u32(cursor + 42), reader.u16(cursor + 34));
  if (sizes.disk !== 0) throw new ZipDirectoryError('invalidZip', name);
  const local = sizes.local; reader.range(local, 30, dataEnd);
  if (reader.u32(local) !== 0x04034b50 || reader.u16(local + 6) !== flags || reader.u16(local + 8) !== method
    || reader.u16(local + 26) !== nameLength) throw new ZipDirectoryError('invalidZip', name);
  const localExtraLength = reader.u16(local + 28), data = local + 30 + nameLength + localExtraLength;
  reader.range(local, data - local, dataEnd);
  if (!rawName.every((value, index) => value === reader.bytes[local + 30 + index])) throw new ZipDirectoryError('invalidZip', name);
  const localSizes = resolveSizes(reader, zip64Extra(reader, local + 30 + nameLength, localExtraLength), reader.u32(local + 22), reader.u32(local + 18), 0, 0);
  const streaming = (flags & 8) !== 0;
  if ((reader.u32(local + 14) !== crc && !(streaming && reader.u32(local + 14) === 0))
    || (localSizes.expanded !== sizes.expanded && !(streaming && localSizes.expanded === 0))
    || (localSizes.compressed !== sizes.compressed && !(streaming && localSizes.compressed === 0))) throw new ZipDirectoryError('invalidZip', name);
  reader.range(data, sizes.compressed, dataEnd);
  const localEnd = streaming ? descriptorEnd(reader, data + sizes.compressed, dataEnd, crc, { ...sizes, zip64: sizes.zip64 || localSizes.zip64 })
    : data + sizes.compressed;
  return { entry: { name, method, crc32: crc, expandedSize: sizes.expanded, compressed: reader.sub(data, sizes.compressed) }, localStart: local, localEnd, next };
}

export function zipDirectory(bytes: Uint8Array, maximumEntries: number): readonly ZipEntryRegion[] {
  if (!Number.isSafeInteger(maximumEntries) || maximumEntries < 0) throw new ZipDirectoryError('entryCount');
  const reader = new ZipBytes(bytes), directory = directoryLocation(reader);
  if (directory.count > maximumEntries) throw new ZipDirectoryError('entryCount');
  const entries: ParsedEntry[] = [], names = new Set<string>();
  let cursor = directory.start;
  for (let index = 0; index < directory.count; index++) {
    const parsed = parseEntry(reader, cursor, directory.start + directory.size, directory.start);
    if (names.has(parsed.entry.name)) throw new ZipDirectoryError('duplicateName', parsed.entry.name);
    names.add(parsed.entry.name); entries.push(parsed); cursor = parsed.next;
  }
  if (cursor !== directory.start + directory.size) throw new ZipDirectoryError('invalidZip');
  // 同じデータを別entryと偽る重複・内包・隠されたlocal headerを受理しない。
  let end = 0;
  for (const entry of [...entries].sort((left, right) => left.localStart - right.localStart)) {
    if (entry.localStart !== end) throw new ZipDirectoryError('invalidZip', entry.entry.name);
    end = entry.localEnd;
  }
  if (end !== directory.start) throw new ZipDirectoryError('invalidZip');
  return entries.map((entry) => entry.entry);
}
