/**
 * 大きい項目を区切って圧縮する ZIP の書き手(取消の1秒)。
 *
 * fflate の一括圧縮は 1 項目を 1 回の長い処理で圧縮する。保存 Worker がその処理の途中だと、
 * 取消で Worker を終わらせても Chromium は処理の終わり(最長 2 秒の強制終了)まで止まらない。
 * そこで 1MiB を超える項目だけを 1MiB ずつ圧縮し、区切りごとに呼出し側へ制御を返す。
 *
 * - 区切りは同期の書き手(`zipEntriesSync`)と Worker(`zipEntriesAsync`)で同じなので、同じ入力から
 *   同じバイト列ができる(保存 Worker と従来の書き手の全バイト一致を保つ)。
 * - 小さい項目は一括圧縮(`deflateSync`)のままで、ZIP の枠(各項目の見出し・目録・終端)も
 *   fflate の一括の書き手と同じ並びと値で書く(`zipSteps.test.ts` が小さい ZIP の全バイト一致で確かめる)。
 */
import { Deflate, deflateSync, strToU8, type ZipOptions } from 'fflate';
import { finishZipCrc32, startZipCrc32, updateZipCrc32, zipCrc32 } from './zipCrc32.js';
import { zipDirectory } from './zipDirectory.js';

/** この大きさを超える項目は区切って圧縮する。1 区切りの大きさも同じ。 */
export const ZIP_STEP_BYTES = 1024 * 1024;

/** 中身と圧縮の指定。指定された先頭は、残りと辞書を共有しない非圧縮ブロックにする。 */
export interface ZipChunkedBytes {
  readonly length: number;
  readonly pending: (Uint8Array | undefined)[];
}

export type ZipStepEntry<Bytes = Uint8Array> = readonly [bytes: Bytes, options: ZipOptions, storedPrefixLength?: number];
type OwnedZipEntry = ZipStepEntry<Uint8Array | ZipChunkedBytes>;

export interface ZipStepsControl {
  readonly signal?: AbortSignal;
}

interface WrittenEntry {
  readonly fileName: string;
  readonly name: Uint8Array;
  readonly utf8: boolean;
  readonly compression: 0 | 8;
  readonly mtime: ZipOptions['mtime'];
  readonly crc: number;
  readonly size: number;
  readonly data: readonly Uint8Array[];
  readonly dataLength: number;
}

/** 区切って処理する必要のある項目(1MiB を超える項目。無圧縮でも検査値の計算を区切る)を含むか。 */
export function hasSteppedZipEntry(entries: ReadonlyMap<string, OwnedZipEntry>): boolean {
  for (const [, [bytes]] of entries) {
    if (bytes.length > ZIP_STEP_BYTES) return true;
  }
  return false;
}

function writeLittle(target: Uint8Array, offset: number, value: number, length: number): void {
  for (let index = 0; index < length; index += 1) target[offset + index] = Math.floor(value / 2 ** (8 * index)) & 0xff;
}

function dosTime(mtime: ZipOptions['mtime']): number {
  const date = new Date(mtime ?? Date.now()), year = date.getFullYear() - 1980;
  if (year < 0 || year > 119) throw new Error('ZIP の日時は 1980〜2099 年だけを書けます。');
  return ((year << 25) | ((date.getMonth() + 1) << 21) | (date.getDate() << 16) | (date.getHours() << 11)
    | (date.getMinutes() << 5) | (date.getSeconds() >> 1)) >>> 0;
}

/** 見出し(項目の前の見出しは central=false、目録の見出しは central=true)を書き、次の位置を返す。 */
function writeHeader(target: Uint8Array, offset: number, entry: WrittenEntry, central: boolean, offsetOfEntry = 0): number {
  let cursor = offset;
  writeLittle(target, cursor, central ? 0x02014b50 : 0x04034b50, 4); cursor += 4;
  if (central) { target[cursor] = 20; target[cursor + 1] = 0; cursor += 2; }
  target[cursor] = 20; target[cursor + 1] = 0; cursor += 2;
  target[cursor] = 0; target[cursor + 1] = entry.utf8 ? 8 : 0; cursor += 2;
  writeLittle(target, cursor, entry.compression, 2); cursor += 2;
  writeLittle(target, cursor, dosTime(entry.mtime), 4); cursor += 4;
  writeLittle(target, cursor, entry.crc, 4);
  writeLittle(target, cursor + 4, entry.dataLength, 4);
  writeLittle(target, cursor + 8, entry.size, 4);
  writeLittle(target, cursor + 12, entry.name.length, 2);
  writeLittle(target, cursor + 14, 0, 2); cursor += 16;
  if (central) {
    // 注記の長さ・開始ディスク・内部属性・外部属性は 0。最後に項目の見出しの位置。
    writeLittle(target, cursor + 10, offsetOfEntry, 4); cursor += 14;
  }
  target.set(entry.name, cursor);
  return cursor + entry.name.length;
}

/** 非終端の DEFLATE 非圧縮ブロック。次のブロックを新しい辞書で始められるよう、バイト境界で終わる。 */
function storedPrefixBlock(prefix: Uint8Array): Uint8Array {
  const block = new Uint8Array(5 + prefix.byteLength);
  writeLittle(block, 1, prefix.byteLength, 2);
  writeLittle(block, 3, prefix.byteLength ^ 0xffff, 2);
  block.set(prefix, 5);
  return block;
}

function abortCheck(control: ZipStepsControl): void {
  control.signal?.throwIfAborted();
}

/**
 * ZIP を 1 項目ずつ・大きい項目は 1MiB ずつ作る手順。`yield` の位置が区切りで、
 * 同期の書き手は区切りで止まらずに進め、Worker は区切りごとに処理を返す。
 *
 * 結果は、順につなぐと ZIP の全体になる部分の並び(各項目の見出し・圧縮した中身の各部分・最後の目録と終端)。
 * 全体の大きさの並びをここで確保しないのは、圧縮した中身の部分と全体の写しが同時に残り、
 * 128MiB の保存で記憶量の山が倍になるため。全体が要る呼び出し側は `concatZipParts` でつなぐ。
 */
interface PackedZipData { readonly crc: number; readonly data: Uint8Array[] }

function zipStoredPrefix(bytes: Uint8Array, compression: 0 | 8, storedPrefixLength: number): Uint8Array | null {
  if (!Number.isInteger(storedPrefixLength) || storedPrefixLength < 0 || storedPrefixLength > 65_535
    || (storedPrefixLength !== 0 && (compression !== 8 || storedPrefixLength >= bytes.length))) {
    throw new Error('ZIP の非圧縮先頭ブロックの指定が正しくありません。');
  }
  return storedPrefixLength === 0 ? null : bytes.subarray(0, storedPrefixLength);
}

function* packZipBytes(bytes: Uint8Array, options: ZipOptions, compression: 0 | 8, storedPrefixLength: number,
  control: ZipStepsControl): Generator<void, PackedZipData, void> {
  const prefix = zipStoredPrefix(bytes, compression, storedPrefixLength);
  const parts = prefix === null ? [] : [storedPrefixBlock(prefix)];
  let crc: number, data: Uint8Array[];
  if (bytes.length <= ZIP_STEP_BYTES) {
    const payload = prefix === null ? bytes : bytes.subarray(storedPrefixLength);
    const compressed = compression === 0 ? payload : deflateSync(payload, options);
    crc = zipCrc32(bytes); data = [...parts, compressed];
  } else {
    const deflate = compression === 0 ? null : new Deflate(options, chunk => { parts.push(chunk); });
    let running = startZipCrc32();
    if (prefix !== null) running = updateZipCrc32(running, prefix);
    for (let start = storedPrefixLength; start < bytes.length; start += ZIP_STEP_BYTES) {
      const end = Math.min(start + ZIP_STEP_BYTES, bytes.length), chunk = bytes.subarray(start, end);
      running = updateZipCrc32(running, chunk);
      deflate?.push(chunk, end === bytes.length);
      if (end < bytes.length) { yield; abortCheck(control); }
    }
    crc = finishZipCrc32(running);
    data = deflate === null ? [bytes] : parts;
  }
  return { crc, data };
}

/** A PCM1 entry owns full independent pieces, starting at the entry's first byte. */
function* packMeshChunks(source: ZipChunkedBytes, options: ZipOptions, compression: 0 | 8, storedPrefixLength: number,
  control: ZipStepsControl): Generator<void, PackedZipData, void> {
  if (compression !== 8 || storedPrefixLength !== 0 || source.length <= ZIP_STEP_BYTES) {
    throw new Error('Invalid segmented mesh ZIP entry');
  }
  const data: Uint8Array[] = [];
  const deflate = new Deflate(options, chunk => { data.push(chunk); });
  let crc = startZipCrc32();
  try {
    if (source.pending.length !== Math.ceil(source.length / ZIP_STEP_BYTES)) throw new Error('Invalid mesh ZIP length');
    for (let index = 0; index < source.pending.length; index += 1) {
      const chunk = source.pending[index];
      const expected = Math.min(ZIP_STEP_BYTES, source.length - index * ZIP_STEP_BYTES);
      if (chunk === undefined || chunk.length !== expected) throw new Error('Invalid mesh ZIP chunk');
      const last = index === source.pending.length - 1;
      crc = updateZipCrc32(crc, chunk);
      deflate.push(chunk, last);
      const buffer = chunk.buffer;
      if (buffer instanceof ArrayBuffer && !data.some(part => part.buffer === buffer)) detachScratchBuffer(buffer);
      source.pending[index] = undefined;
      if (!last) { yield; abortCheck(control); }
    }
    return { crc: finishZipCrc32(crc), data };
  } finally { source.pending.length = 0; }
}

function* packZipEntries(entries: ReadonlyMap<string, OwnedZipEntry>,
  control: ZipStepsControl, ownedBuffers: ReadonlySet<ArrayBuffer>): Generator<void, WrittenEntry[], void> {
  const written: WrittenEntry[] = [];
  for (const [fileName, [bytes, options, storedPrefixLength = 0]] of entries) {
    abortCheck(control);
    const name = strToU8(fileName), compression = options.level === 0 ? 0 : 8;
    if (name.length > 65535) throw new Error('ZIP の項目名が長すぎます。');
    const packed = bytes instanceof Uint8Array
      ? yield* packZipBytes(bytes, options, compression, storedPrefixLength, control)
      : yield* packMeshChunks(bytes, options, compression, storedPrefixLength, control);
    const { crc, data } = packed;
    const dataLength = data.reduce((total, part) => total + part.length, 0);
    const utf8 = name.length !== fileName.length;
    written.push({ fileName, name, utf8, compression, mtime: options.mtime, crc, size: bytes.length, data, dataLength });
    if (bytes instanceof Uint8Array) releaseOwnedBuffer(bytes, compression, data, ownedBuffers);
    yield;
  }
  abortCheck(control);
  return written;
}

function writeZipParts(written: readonly WrittenEntry[]): Uint8Array[] {
  const parts: Uint8Array[] = [];
  let offset = 0, centralLength = 0;
  const offsets: number[] = [];
  for (const entry of written) {
    offsets.push(offset);
    offset += 30 + entry.name.length + entry.dataLength;
    centralLength += 46 + entry.name.length;
    const header = new Uint8Array(30 + entry.name.length);
    writeHeader(header, 0, entry, false);
    parts.push(header, ...entry.data);
  }
  // 目録は全項目の見出しと中身の後(位置 offset)から始まり、長さは centralLength。
  const directory = new Uint8Array(centralLength + 22);
  let cursor = 0;
  for (const [index, entry] of written.entries()) cursor = writeHeader(directory, cursor, entry, true, offsets[index]);
  writeLittle(directory, cursor, 0x06054b50, 4);
  writeLittle(directory, cursor + 8, written.length, 2);
  writeLittle(directory, cursor + 10, written.length, 2);
  writeLittle(directory, cursor + 12, centralLength, 4);
  writeLittle(directory, cursor + 16, offset, 4);
  parts.push(directory);
  return parts;
}

/** Reuse the deflate data made by the one-shot writer, adding prefixes and the full-entry CRC. */
export function restoreZipStoredPrefixes(entries: ReadonlyMap<string, ZipStepEntry>, packed: Uint8Array): Uint8Array {
  const regions = new Map(zipDirectory(packed, entries.size).map(region => [region.name, region]));
  const written: WrittenEntry[] = [];
  for (const [fileName, [bytes, options, storedPrefixLength = 0]] of entries) {
    const region = regions.get(fileName);
    if (region === undefined) throw new Error('The generated ZIP is missing its source entry');
    const { method: compression, compressed } = region;
    const prefix = zipStoredPrefix(bytes, compression, storedPrefixLength);
    const block = prefix === null ? null : storedPrefixBlock(prefix);
    const name = strToU8(fileName);
    written.push({
      fileName, name, utf8: name.length !== fileName.length, compression, mtime: options.mtime,
      crc: prefix === null ? region.crc32 : zipCrc32(bytes), size: bytes.length,
      data: block === null ? [compressed] : [block, compressed],
      dataLength: compressed.length + (block?.length ?? 0),
    });
  }
  return concatZipParts(writeZipParts(written));
}

/**
 * 部分の並びを 1 つの並びにつなぐ(ファイル 1 つを丸ごと受ける口へ渡す時だけ使う)。
 * 部分が 1 つならそのまま返し、写さない(小さい ZIP は一括の書き手の出力 1 つになる)。
 */
export function concatZipParts(parts: readonly Uint8Array[]): Uint8Array {
  if (parts.length === 1) return parts[0];
  const output = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
  let cursor = 0;
  for (const part of parts) { output.set(part, cursor); cursor += part.byteLength; }
  return output;
}

function* buildZipParts(entries: ReadonlyMap<string, ZipStepEntry>, control: ZipStepsControl,
  ownedBuffers: ReadonlySet<ArrayBuffer> = new Set()): Generator<void, Uint8Array[], void> {
  return writeZipParts(yield* packZipEntries(entries, control, ownedBuffers));
}

/** Pack once so the assembly size fallback can omit optional entries after the input pieces have been consumed. */
export async function packOwnedZipEntries(entries: ReadonlyMap<string, OwnedZipEntry>,
  control: ZipStepsControl): Promise<(remaining: ReadonlyMap<string, OwnedZipEntry>) => Uint8Array[]> {
  try {
    let written = await finishZipEntriesAsync(packZipEntries(entries, control, new Set()), control);
    return remaining => {
      written = written.filter(entry => remaining.has(entry.fileName));
      return writeZipParts(written);
    };
  } finally {
    for (const [bytes] of entries.values()) {
      if (!(bytes instanceof Uint8Array)) bytes.pending.length = 0;
    }
  }
}

/** 全項目で1回だけ使う全領域の通常bufferだけを所有候補から選ぶ。共有viewは保守的に保持する。 */
function uniqueOwnedBuffers(entries: ReadonlyMap<string, ZipStepEntry>,
  ownedBuffers: ReadonlySet<ArrayBuffer>): Set<ArrayBuffer> {
  const counts = new Map<ArrayBufferLike, number>();
  for (const [, [bytes]] of entries) counts.set(bytes.buffer, (counts.get(bytes.buffer) ?? 0) + 1);
  return new Set([...ownedBuffers].filter(buffer => counts.get(buffer) === 1));
}

/** CRC・size・offsetを記録済みのscratchだけを切り離す。native transferなしでは従来どおり保持する。 */
function releaseOwnedBuffer(bytes: Uint8Array, compression: 0 | 8, data: readonly Uint8Array[],
  ownedBuffers: ReadonlySet<ArrayBuffer>): void {
  const buffer = bytes.buffer;
  if (!(buffer instanceof ArrayBuffer) || !ownedBuffers.has(buffer) || compression === 0
    || bytes.byteOffset !== 0 || bytes.byteLength === 0 || bytes.byteLength !== buffer.byteLength
    || data.some(part => part.buffer === buffer)) return;
  detachScratchBuffer(buffer);
}

function detachScratchBuffer(buffer: ArrayBuffer): void {
  const transfer: unknown = Reflect.get(ArrayBuffer.prototype, 'transfer');
  if (typeof transfer === 'function') Reflect.apply(transfer, buffer, [0]);
}

/** 借用entryの通常経路。元のbufferを消費せず、同じ入力を再利用できる。 */
export function* zipEntriesSteps(entries: ReadonlyMap<string, ZipStepEntry>,
  control: ZipStepsControl = {}): Generator<void, Uint8Array, void> {
  return concatZipParts(yield* buildZipParts(entries, control));
}

/** package indexには公開しない。保存処理自身が生成したscratchだけを消費する内部経路。 */
export function* zipEntriesWithOwnedBuffersSteps(entries: ReadonlyMap<string, ZipStepEntry>,
  ownedBuffers: ReadonlySet<ArrayBuffer>, control: ZipStepsControl = {}): Generator<void, Uint8Array, void> {
  return concatZipParts(yield* buildZipParts(entries, control, uniqueOwnedBuffers(entries, ownedBuffers)));
}

/** 区切りで止まらずに最後まで作る(従来の同期の書き手用)。 */
export function zipEntriesSync(entries: ReadonlyMap<string, ZipStepEntry>): Uint8Array {
  const steps = zipEntriesSteps(entries);
  for (;;) {
    const next = steps.next();
    if (next.done === true) return next.value;
  }
}

/** 次のタスクまで待つ。Worker の終了要求などの処理をこの間に受け付ける。 */
function nextTask(): Promise<void> {
  return new Promise(resolve => { setTimeout(resolve, 0); });
}

/** 区切りごとに処理を返し、取消を確かめながら作る(保存 Worker 用)。結果は順につなぐと ZIP になる部分の並び。 */
export async function zipEntriesPartsAsync(entries: ReadonlyMap<string, ZipStepEntry>,
  control: ZipStepsControl = {}): Promise<Uint8Array[]> {
  return await finishZipEntriesAsync(buildZipParts(entries, control), control);
}

/** partの新規meshエントリー用。汎用ZIPの借用契約は変えない。結果は順につなぐと ZIP になる部分の並び。 */
export async function zipEntriesWithOwnedBuffersPartsAsync(entries: ReadonlyMap<string, ZipStepEntry>,
  ownedBuffers: ReadonlySet<ArrayBuffer>, control: ZipStepsControl = {}): Promise<Uint8Array[]> {
  return await finishZipEntriesAsync(buildZipParts(entries, control, uniqueOwnedBuffers(entries, ownedBuffers)), control);
}

async function finishZipEntriesAsync<Result>(steps: Generator<void, Result, void>,
  control: ZipStepsControl): Promise<Result> {
  try {
    for (;;) {
      const next = steps.next();
      if (next.done === true) return next.value;
      await nextTask();
      abortCheck(control);
    }
  } finally {
    const iterator: Iterator<void, Result> = steps;
    iterator.return?.();
  }
}
