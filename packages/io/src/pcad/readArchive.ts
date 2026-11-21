/**
 * `.pcad` / `.pcada` / `.pcadd` / 3MF が共有する上限つきZIP読み込み。
 * 出力を確保する前に中央目録とraw DEFLATEの実展開長を検査し、固定出力へ展開してCRCを照合する。
 * 宣言サイズだけを信用せず、選択されたエントリの累積も同じ予算へ数える。
 */
import { inflateSync } from 'fflate';
import { IO_LIMITS, type IoLimits } from '../limits.js';
import { DeflateSizeError, deflateExpandedSize } from './deflateExpandedSize.js';
import { ZipDirectoryError, zipDirectory, type ZipEntryRegion } from './zipDirectory.js';
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
  | { readonly ok: true; readonly entries: ReadonlyMap<string, Uint8Array>; readonly omittedOptional?: true }
  | { readonly ok: false; readonly error: ArchiveReadError };

export interface ReadArchiveOptions {
  /** `true` のエントリだけを inflate する。名前の安全性と個数は全エントリを検査する。 */
  readonly shouldExtract: (name: string) => boolean;
  /** 小さな値を注入して大きな実ファイルを作らず検査するための口。 */
  readonly limits?: ArchiveReadLimits;
  /** Extract optional members after required data. A local payload failure omits just that member. */
  readonly optionalEntry?: (name: string) => boolean;
}

export const ARCHIVE_TOO_LARGE_MESSAGE = 'ファイルが大きすぎるため開けません。';
export const ARCHIVE_BROKEN_MESSAGE = 'ファイルが壊れているため開けません。';

function failure(kind: ArchiveReadErrorKind, entryName?: string): ReadArchiveResult {
  const oversized = kind === 'compressedInput' || kind === 'entryCount' || kind === 'entryExpanded' || kind === 'totalExpanded';
  const error: ArchiveReadError = { kind, reason: oversized ? ARCHIVE_TOO_LARGE_MESSAGE : ARCHIVE_BROKEN_MESSAGE,
    ...(entryName === undefined ? {} : { entryName }) };
  return { ok: false, error };
}

interface ExpansionBudget {
  readonly limit: number;
  remaining: number;
}

function expandEntry(
  entry: ZipEntryRegion, budget: ExpansionBudget,
): Uint8Array | 'entryExpanded' | 'totalExpanded' | 'invalidZip' {
  const { limit, remaining } = budget;
  if (entry.expandedSize > limit) return 'entryExpanded';
  if (entry.expandedSize > remaining) return 'totalExpanded';
  try {
    const actual = entry.method === 0 ? entry.compressed.length : deflateExpandedSize(entry.compressed, Math.min(limit, remaining));
    if (actual > limit) return 'entryExpanded';
    if (actual > remaining) return 'totalExpanded';
    if (actual !== entry.expandedSize) return 'invalidZip';
    const output = new Uint8Array(actual);
    // Count every allocated output, including one that later fails its CRC.
    budget.remaining -= actual;
    if (entry.method === 0) output.set(entry.compressed);
    else if (inflateSync(entry.compressed, { out: output }).length !== actual) return 'invalidZip';
    return zipCrc32(output) === entry.crc32 ? output : 'invalidZip';
  } catch (error) {
    if (error instanceof DeflateSizeError && error.kind === 'expandedLimit') {
      return limit <= remaining ? 'entryExpanded' : 'totalExpanded';
    }
    return 'invalidZip';
  }
}

export function readArchive(bytes: Uint8Array, options: ReadArchiveOptions): ReadArchiveResult {
  const limits = options.limits ?? IO_LIMITS;
  if (!Object.values(limits).every((value) => Number.isSafeInteger(value) && value >= 0)) return failure('invalidZip');
  if (bytes.length > limits.archiveCompressedBytes) return failure('compressedInput');
  const entries = new Map<string, Uint8Array>();
  const budget = { limit: limits.archiveEntryExpandedBytes, remaining: limits.archiveTotalExpandedBytes };
  let name: string | undefined;
  try {
    const directory = zipDirectory(bytes, limits.archiveEntryCount);
    const optional: ZipEntryRegion[] = [];
    for (const entry of directory) {
      name = entry.name;
      if (!options.shouldExtract(entry.name)) continue;
      if (options.optionalEntry?.(entry.name)) {
        optional.push(entry);
        continue;
      }
      const data = expandEntry(entry, budget);
      if (typeof data === 'string') return failure(data, entry.name);
      entries.set(entry.name, data);
    }
    let omittedOptional = false;
    for (const entry of optional) {
      name = entry.name;
      const data = expandEntry(entry, budget);
      if (typeof data === 'string') omittedOptional = true;
      else entries.set(entry.name, data);
    }
    return omittedOptional ? { ok: true, entries, omittedOptional } : { ok: true, entries };
  } catch (error) {
    return error instanceof ZipDirectoryError ? failure(error.kind, error.entryName) : failure('invalidZip', name);
  }
}
