/**
 * 大きい項目を区切って圧縮する ZIP の書き手(レビュー R06、取消の1秒)。
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

/** この大きさを超える項目は区切って圧縮する。1 区切りの大きさも同じ。 */
export const ZIP_STEP_BYTES = 1024 * 1024;

/** `zipPcadEntries` と同じ形の 1 項目(中身と圧縮の指定)。 */
export type ZipStepEntry = readonly [bytes: Uint8Array, options: ZipOptions];

export interface ZipStepsControl {
  readonly signal?: AbortSignal;
}

interface WrittenEntry {
  readonly name: Uint8Array;
  readonly utf8: boolean;
  readonly compression: 0 | 8;
  readonly mtime: ZipOptions['mtime'];
  readonly crc: number;
  readonly size: number;
  readonly data: readonly Uint8Array[];
  readonly dataLength: number;
  readonly offset: number;
}

/** 区切って処理する必要のある項目(1MiB を超える項目。無圧縮でも検査値の計算を区切る)を含むか。 */
export function hasSteppedZipEntry(entries: ReadonlyMap<string, ZipStepEntry>): boolean {
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
function writeHeader(target: Uint8Array, offset: number, entry: WrittenEntry, central: boolean): number {
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
    writeLittle(target, cursor + 10, entry.offset, 4); cursor += 14;
  }
  target.set(entry.name, cursor);
  return cursor + entry.name.length;
}

function abortCheck(control: ZipStepsControl): void {
  control.signal?.throwIfAborted();
}

/**
 * ZIP を 1 項目ずつ・大きい項目は 1MiB ずつ作る手順。`yield` の位置が区切りで、
 * 同期の書き手は区切りで止まらずに進め、Worker は区切りごとに処理を返す。
 */
export function* zipEntriesSteps(entries: ReadonlyMap<string, ZipStepEntry>,
  control: ZipStepsControl = {}): Generator<void, Uint8Array, void> {
  const written: WrittenEntry[] = [];
  let offset = 0, centralLength = 0;
  for (const [fileName, [bytes, options]] of entries) {
    abortCheck(control);
    const name = strToU8(fileName), compression = options.level === 0 ? 0 : 8;
    if (name.length > 65535) throw new Error('ZIP の項目名が長すぎます。');
    let crc: number, data: Uint8Array[], dataLength: number;
    if (bytes.length <= ZIP_STEP_BYTES) {
      const compressed = compression === 0 ? bytes : deflateSync(bytes, options);
      crc = zipCrc32(bytes); data = [compressed]; dataLength = compressed.length;
    } else {
      const parts: Uint8Array[] = [];
      const deflate = compression === 0 ? null : new Deflate(options, chunk => { parts.push(chunk); });
      let running = startZipCrc32();
      for (let start = 0; start < bytes.length; start += ZIP_STEP_BYTES) {
        const end = Math.min(start + ZIP_STEP_BYTES, bytes.length), chunk = bytes.subarray(start, end);
        running = updateZipCrc32(running, chunk);
        deflate?.push(chunk, end === bytes.length);
        if (end < bytes.length) { yield; abortCheck(control); }
      }
      crc = finishZipCrc32(running);
      data = deflate === null ? [bytes] : parts;
      dataLength = data.reduce((total, part) => total + part.length, 0);
    }
    const utf8 = name.length !== fileName.length;
    written.push({ name, utf8, compression, mtime: options.mtime, crc, size: bytes.length, data, dataLength, offset });
    offset += 30 + name.length + dataLength;
    centralLength += 46 + name.length;
    yield;
  }
  abortCheck(control);
  const output = new Uint8Array(offset + centralLength + 22);
  let cursor = 0;
  for (const entry of written) {
    cursor = writeHeader(output, cursor, entry, false);
    for (const part of entry.data) { output.set(part, cursor); cursor += part.length; }
  }
  const centralStart = cursor;
  for (const entry of written) cursor = writeHeader(output, cursor, entry, true);
  writeLittle(output, cursor, 0x06054b50, 4);
  writeLittle(output, cursor + 8, written.length, 2);
  writeLittle(output, cursor + 10, written.length, 2);
  writeLittle(output, cursor + 12, cursor - centralStart, 4);
  writeLittle(output, cursor + 16, centralStart, 4);
  return output;
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

/** 区切りごとに処理を返し、取消を確かめながら作る(保存 Worker 用)。 */
export async function zipEntriesAsync(entries: ReadonlyMap<string, ZipStepEntry>,
  control: ZipStepsControl = {}): Promise<Uint8Array> {
  const steps = zipEntriesSteps(entries, control);
  for (;;) {
    const next = steps.next();
    if (next.done === true) return next.value;
    await nextTask();
    abortCheck(control);
  }
}
