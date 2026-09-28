/** 図面の参照元を既存の部品・アセンブリ保存形式で抱き込む。投影結果は保存しない。 */
import { createAssemblyDocumentBundle, createPartDocumentBundle, partLibraryOfBundle,
  type DrawingDocument, type DrawingSourceInput } from '@pointercad/model';
import { IO_LIMITS } from '../limits.js';
import { documentBundleEntries, FIXED_ENTRY_MTIME, isPcaddArchiveEntry, PCAD_DOCUMENT_ENTRY, pcaddEntries,
  readDocumentBundleEntries, readPcaddFile, zipPcadEntries, type PcadZipEntries, type ReadPcadFileOptions,
  type ReadPcaddFileResult, type WritePcaddFileOptions } from './pcadFile.js';
import { ARCHIVE_TOO_LARGE_MESSAGE, readArchive, type ArchiveReadLimits } from './readArchive.js';

/**
 * 図面の束では、図面の項目も参照元の項目も同じ強さで圧縮する。以前の版(参照元を一度 ZIP に
 * してから展開し直して結合していた)と同じバイト列を保つための値(R06)。
 */
const BUNDLE_LEVEL = 6;

function sourcePrefix(ref: string): string {
  if (!/^[A-Za-z0-9_-]+$/u.test(ref)) throw new Error('Invalid drawing source reference');
  return `source/${ref}/`;
}

function sourceEntryName(ref: string): string {
  return `source/${ref}.json`;
}

/**
 * 書いた図面が同じ上限の読み手で必ず開き直せることを、圧縮の前に確かめる。
 * 読み手の 2 回の取り出し(図面の項目と、参照元の名前空間)と同じ数え方にする。
 * 以前の版は途中の ZIP を展開し直す際に同じ上限で断っていたので、その断りを明示の検査で保つ。
 */
function assertReopenable(entries: PcadZipEntries, ref: string, limits: ArchiveReadLimits): void {
  if (entries.size > limits.archiveEntryCount) throw new Error(ARCHIVE_TOO_LARGE_MESSAGE);
  const sourceEntry = sourceEntryName(ref), prefix = sourcePrefix(ref);
  let drawingTotal = 0, sourceTotal = 0;
  for (const [name, [bytes]] of entries) {
    if (bytes.length > limits.archiveEntryExpandedBytes) throw new Error(ARCHIVE_TOO_LARGE_MESSAGE);
    if (isPcaddArchiveEntry(name)) drawingTotal += bytes.length;
    if (name === sourceEntry || name.startsWith(prefix)) sourceTotal += bytes.length;
  }
  if (drawingTotal > limits.archiveTotalExpandedBytes || sourceTotal > limits.archiveTotalExpandedBytes) {
    throw new Error(ARCHIVE_TOO_LARGE_MESSAGE);
  }
}

/**
 * 固定した時刻で文書と依存一式を書く。原本のダイジェスト検査も共有する。
 * 図面と参照元の項目を圧縮前の表のまま結合し、最後に 1 回だけ圧縮する(R06。以前は圧縮 3 回・展開 2 回)。
 * `limits` は検査で小さな上限を注入するための口。既定は読み手と同じ `IO_LIMITS`。
 */
export async function writeDrawingBundle(document: DrawingDocument, options: WritePcaddFileOptions,
  limits: ArchiveReadLimits = IO_LIMITS): Promise<Uint8Array> {
  if (document.source.sourceKind !== options.source.sourceKind) throw new Error('Drawing source kind mismatch');
  const ref = document.source.sourceRef;
  const prefix = sourcePrefix(ref);
  const savedAt = options.savedAt ?? new Date().toISOString();
  const source = options.source;
  const bundle = source.sourceKind === 'part'
    ? createPartDocumentBundle(source.document, source.attachments)
    : createAssemblyDocumentBundle(source.document, source.library);
  const native = await documentBundleEntries(bundle, { savedAt });
  const entries: PcadZipEntries = new Map();
  for (const [name, [bytes]] of pcaddEntries(document, { ...options, savedAt })) {
    entries.set(name, [bytes, { level: BUNDLE_LEVEL, mtime: FIXED_ENTRY_MTIME }]);
  }
  // 参照元の document.json は図面側の同じ名前の封筒を置き換える(位置は図面側のまま。以前と同じ)。
  for (const [name, [bytes]] of native) {
    const path = name === PCAD_DOCUMENT_ENTRY ? sourceEntryName(ref) : `${prefix}${name}`;
    entries.set(path, [bytes, { level: BUNDLE_LEVEL, mtime: FIXED_ENTRY_MTIME }]);
  }
  assertReopenable(entries, ref, limits);
  const zipped = zipPcadEntries(entries);
  if (zipped.length > limits.archiveCompressedBytes) throw new Error(ARCHIVE_TOO_LARGE_MESSAGE);
  return zipped;
}

/** 読み込みの資源上限。省略時は通常の上限(`IO_LIMITS`)。 */
export type ReadDrawingBundleOptions = ReadPcadFileOptions;

/**
 * 検証完了後に参照元一式を返す。古い、添付なしの図面も同じ読み手を通る。
 * 参照元の名前空間は 1 回だけ展開し、ZIP を作り直さずに部品・アセンブリの読み手の検査へ渡す(R06)。
 */
export async function readDrawingBundle(bytes: Uint8Array, options: ReadDrawingBundleOptions = {}): Promise<ReadPcaddFileResult> {
  const drawing = readPcaddFile(bytes, options);
  if (!drawing.ok) return drawing;
  try {
    const ref = drawing.document.source.sourceRef;
    const prefix = sourcePrefix(ref);
    const sourceEntry = sourceEntryName(ref);
    const archive = readArchive(bytes, { shouldExtract: (name) => name === sourceEntry || name.startsWith(prefix),
      limits: options.limits });
    if (!archive.ok) return { ok: false, error: { code: 'notZip', message: archive.error.reason } };
    const entries = new Map<string, Uint8Array>();
    for (const [name, value] of archive.entries) {
      entries.set(name === sourceEntry ? PCAD_DOCUMENT_ENTRY : name.slice(prefix.length), value);
    }
    // 形式の検査を複製せず、部品・アセンブリの読み手へ戻して原本まで検査する。
    const parsed = await readDocumentBundleEntries(entries, drawing.source.sourceKind);
    if (!parsed.ok) return parsed;
    const bundle = parsed.bundle;
    const source: DrawingSourceInput = bundle.kind === 'part'
      ? { sourceKind: 'part', document: bundle.document, attachments: bundle.attachments,
          ...(drawing.document.source.flatSheet === undefined ? {} : { flatSheet: drawing.document.source.flatSheet }) }
      : { sourceKind: 'assembly', document: bundle.document, library: partLibraryOfBundle(bundle) };
    return { ...drawing, source };
  } catch (error) {
    return { ok: false, error: { code: 'invalidField', message: error instanceof Error ? error.message : 'Invalid drawing source' } };
  }
}
