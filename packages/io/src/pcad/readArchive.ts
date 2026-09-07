/**
 * `.pcad` / `.pcada` / 3MF が共有する、上限つきの ZIP 読み込み入口。
 *
 * fflate のストリーミング API が返す実際の inflate 出力を数える。ZIP ヘッダの
 * `originalSize` は早期判定にも使わず、偽の宣言サイズで上限を抜けられないようにする。
 */

import { Unzip, UnzipInflate } from 'fflate';

import { IO_LIMITS, type IoLimits } from '../limits.js';

export type ArchiveReadLimits = Pick<
  IoLimits,
  | 'archiveCompressedBytes'
  | 'archiveEntryCount'
  | 'archiveEntryExpandedBytes'
  | 'archiveTotalExpandedBytes'
>;

export type ArchiveReadErrorKind =
  | 'compressedInput'
  | 'entryCount'
  | 'entryExpanded'
  | 'totalExpanded'
  | 'invalidName'
  | 'duplicateName'
  | 'invalidZip';

export interface ArchiveReadError {
  readonly kind: ArchiveReadErrorKind;
  /** 利用者へそのまま示せる日本語。 */
  readonly reason: string;
  /** エントリに固有の失敗だけで付く名前。 */
  readonly entryName?: string;
}

export type ReadArchiveResult =
  | { readonly ok: true; readonly entries: ReadonlyMap<string, Uint8Array> }
  | { readonly ok: false; readonly error: ArchiveReadError };

export interface ReadArchiveOptions {
  /** `true` のエントリだけを inflate する。名前の安全性と個数は全エントリを検査する。 */
  readonly shouldExtract: (name: string) => boolean;
  /** 小さな値を注入して大きな実ファイルを作らず検査するための口。 */
  readonly limits?: ArchiveReadLimits;
}

export const ARCHIVE_TOO_LARGE_MESSAGE = 'ファイルが大きすぎるため開けません。';
export const ARCHIVE_BROKEN_MESSAGE = 'ファイルが壊れているため開けません。';

class ArchiveAbort extends Error {
  readonly archiveError: ArchiveReadError;

  constructor(archiveError: ArchiveReadError) {
    super(archiveError.reason);
    this.archiveError = archiveError;
  }
}

function tooLarge(kind: ArchiveReadErrorKind, entryName?: string): ArchiveReadError {
  return entryName === undefined
    ? { kind, reason: ARCHIVE_TOO_LARGE_MESSAGE }
    : { kind, reason: ARCHIVE_TOO_LARGE_MESSAGE, entryName };
}

function broken(kind: ArchiveReadErrorKind, entryName?: string): ArchiveReadError {
  return entryName === undefined
    ? { kind, reason: ARCHIVE_BROKEN_MESSAGE }
    : { kind, reason: ARCHIVE_BROKEN_MESSAGE, entryName };
}

/** 絶対パス、親参照、Windows 区切りを含む名前を通さない。 */
function hasUnsafeName(name: string): boolean {
  if (name.startsWith('/') || name.includes('\\') || name.includes('\0')) {
    return true;
  }
  if (/^[A-Za-z]:\//.test(name)) {
    return true;
  }
  return name.split('/').includes('..');
}

function joinChunks(chunks: readonly Uint8Array[], byteLength: number): Uint8Array {
  if (chunks.length === 1) {
    return chunks[0] ?? new Uint8Array(0);
  }
  const joined = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.length;
  }
  return joined;
}

/**
 * ZIP を同期的に読み、許可されたエントリだけを返す。失敗・上限超過は例外を外へ出さない。
 */
export function readArchive(bytes: Uint8Array, options: ReadArchiveOptions): ReadArchiveResult {
  const limits = options.limits ?? IO_LIMITS;
  if (bytes.byteLength > limits.archiveCompressedBytes) {
    return { ok: false, error: tooLarge('compressedInput') };
  }

  const entries = new Map<string, Uint8Array>();
  const names = new Set<string>();
  let entryCount = 0;
  let totalExpandedBytes = 0;
  let pendingAbort: ArchiveReadError | null = null;

  try {
    const unzip = new Unzip((file) => {
      entryCount += 1;
      if (entryCount > limits.archiveEntryCount) {
        throw new ArchiveAbort(tooLarge('entryCount', file.name));
      }
      if (hasUnsafeName(file.name)) {
        throw new ArchiveAbort(broken('invalidName', file.name));
      }
      if (names.has(file.name)) {
        throw new ArchiveAbort(broken('duplicateName', file.name));
      }
      names.add(file.name);

      if (!options.shouldExtract(file.name)) {
        return;
      }

      const chunks: Uint8Array[] = [];
      let entryExpandedBytes = 0;
      file.ondata = (error, chunk, final) => {
        if (pendingAbort !== null) {
          throw new ArchiveAbort(pendingAbort);
        }
        if (error !== null) {
          file.terminate();
          throw new ArchiveAbort(broken('invalidZip', file.name));
        }

        const nextEntryBytes = entryExpandedBytes + chunk.byteLength;
        if (nextEntryBytes > limits.archiveEntryExpandedBytes) {
          pendingAbort = tooLarge('entryExpanded', file.name);
          file.terminate();
          throw new ArchiveAbort(pendingAbort);
        }
        const nextTotalBytes = totalExpandedBytes + chunk.byteLength;
        if (nextTotalBytes > limits.archiveTotalExpandedBytes) {
          pendingAbort = tooLarge('totalExpanded', file.name);
          file.terminate();
          throw new ArchiveAbort(pendingAbort);
        }

        entryExpandedBytes = nextEntryBytes;
        totalExpandedBytes = nextTotalBytes;
        chunks.push(chunk);
        if (final) {
          entries.set(file.name, joinChunks(chunks, entryExpandedBytes));
        }
      };
      file.start();
    });
    unzip.register(UnzipInflate);
    unzip.push(bytes, true);
    const isEmptyZip =
      bytes.byteLength >= 22 &&
      bytes[0] === 0x50 &&
      bytes[1] === 0x4b &&
      bytes[2] === 0x05 &&
      bytes[3] === 0x06;
    if (entryCount === 0 && !isEmptyZip) {
      return { ok: false, error: broken('invalidZip') };
    }
    return { ok: true, entries };
  } catch (error) {
    if (error instanceof ArchiveAbort) {
      return { ok: false, error: error.archiveError };
    }
    return { ok: false, error: broken('invalidZip') };
  }
}
