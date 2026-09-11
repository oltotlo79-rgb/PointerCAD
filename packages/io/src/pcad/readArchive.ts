/**
 * `.pcad` / `.pcada` / `.pcadd` / 3MF が共有する上限つきZIP読み込み。
 * 出力を確保する前に中央目録とraw DEFLATEの実展開長を検査し、固定出力へ展開してCRCを照合する。
 * 宣言サイズだけを信用せず、選択されたエントリの累積も同じ予算へ数える（R06/R10）。
 */
import { inflateSync } from 'fflate';
import { IO_LIMITS, type IoLimits } from '../limits.js';
import { DeflateSizeError, deflateExpandedSize } from './deflateExpandedSize.js';
import { ZipDirectoryError, zipDirectory } from './zipDirectory.js';
import { zipCrc32 } from './zipCrc32.js';

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

function failure(kind: ArchiveReadErrorKind, entryName?: string): ReadArchiveResult {
  const oversized = kind === 'compressedInput' || kind === 'entryCount' || kind === 'entryExpanded' || kind === 'totalExpanded';
  const error: ArchiveReadError = { kind, reason: oversized ? ARCHIVE_TOO_LARGE_MESSAGE : ARCHIVE_BROKEN_MESSAGE,
    ...(entryName === undefined ? {} : { entryName }) };
  return { ok: false, error };
}

export function readArchive(bytes: Uint8Array, options: ReadArchiveOptions): ReadArchiveResult {
  const limits = options.limits ?? IO_LIMITS;
  if (!Object.values(limits).every((value) => Number.isSafeInteger(value) && value >= 0)) return failure('invalidZip');
  if (bytes.length > limits.archiveCompressedBytes) return failure('compressedInput');
  const entries = new Map<string, Uint8Array>();
  let name: string | undefined, total = 0;
  try {
    for (const entry of zipDirectory(bytes, limits.archiveEntryCount)) {
      name = entry.name;
      if (!options.shouldExtract(name)) continue;
      const remaining = limits.archiveTotalExpandedBytes - total;
      if (entry.expandedSize > limits.archiveEntryExpandedBytes) return failure('entryExpanded', name);
      if (entry.expandedSize > remaining) return failure('totalExpanded', name);
      const budget = Math.min(limits.archiveEntryExpandedBytes, remaining);
      let actualSize: number;
      try {
        actualSize = entry.method === 0 ? entry.compressed.length : deflateExpandedSize(entry.compressed, budget);
      } catch (error) {
        if (error instanceof DeflateSizeError && error.kind === 'expandedLimit') {
          return failure(limits.archiveEntryExpandedBytes <= remaining ? 'entryExpanded' : 'totalExpanded', name);
        }
        throw error;
      }
      if (actualSize > limits.archiveEntryExpandedBytes) return failure('entryExpanded', name);
      if (actualSize > remaining) return failure('totalExpanded', name);
      if (actualSize !== entry.expandedSize) return failure('invalidZip', name);
      // この地点までは展開出力を確保しない。実長と予算が一致してから固定領域へ出す。
      const output = new Uint8Array(actualSize);
      if (entry.method === 0) output.set(entry.compressed);
      else {
        const decoded = inflateSync(entry.compressed, { out: output });
        if (decoded.length !== actualSize) return failure('invalidZip', name);
      }
      if (zipCrc32(output) !== entry.crc32) return failure('invalidZip', name);
      total += actualSize; entries.set(name, output);
    }
    return { ok: true, entries };
  } catch (error) {
    return error instanceof ZipDirectoryError ? failure(error.kind, error.entryName) : failure('invalidZip', name);
  }
}
