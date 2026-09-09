/** 図面の参照元を既存の部品・アセンブリ保存形式で抱き込む。投影結果は保存しない。 */
import { createAssemblyDocumentBundle, createPartDocumentBundle, partLibraryOfBundle,
  type DrawingDocument, type DrawingSourceInput } from '@pointercad/model';
import { zipSync, type Zippable } from 'fflate';
import { FIXED_ENTRY_MTIME, PCAD_DOCUMENT_ENTRY, readDocumentBundle, readPcaddFile,
  writeDocumentBundle, writePcaddFile, type ReadPcaddFileResult, type WritePcaddFileOptions } from './pcadFile.js';
import { readArchive } from './readArchive.js';

function sourcePrefix(ref: string): string {
  if (!/^[A-Za-z0-9_-]+$/u.test(ref)) throw new Error('Invalid drawing source reference');
  return `source/${ref}/`;
}

function archiveEntries(bytes: Uint8Array): ReadonlyMap<string, Uint8Array> {
  const archive = readArchive(bytes, { shouldExtract: () => true });
  if (!archive.ok) throw new Error(archive.error.reason);
  return archive.entries;
}

function addEntry(entries: Zippable, name: string, bytes: Uint8Array, level: 0 | 6): void {
  Object.defineProperty(entries, name, { configurable: true, enumerable: true, writable: true,
    value: [bytes, { level, mtime: FIXED_ENTRY_MTIME }] });
}

/** 固定した時刻で文書と依存一式を書く。原本のダイジェスト検査も共有する。 */
export async function writeDrawingBundle(document: DrawingDocument, options: WritePcaddFileOptions): Promise<Uint8Array> {
  if (document.source.sourceKind !== options.source.sourceKind) throw new Error('Drawing source kind mismatch');
  const prefix = sourcePrefix(document.source.sourceRef);
  const savedAt = options.savedAt ?? new Date().toISOString();
  const source = options.source;
  const bundle = source.sourceKind === 'part'
    ? createPartDocumentBundle(source.document, source.attachments)
    : createAssemblyDocumentBundle(source.document, source.library);
  const native = archiveEntries(await writeDocumentBundle(bundle, { savedAt }));
  const entries: Zippable = {};
  for (const [name, bytes] of archiveEntries(writePcaddFile(document, { ...options, savedAt }))) {
    addEntry(entries, name, bytes, 6);
  }
  for (const [name, bytes] of native) {
    const path = name === PCAD_DOCUMENT_ENTRY ? `source/${document.source.sourceRef}.json` : `${prefix}${name}`;
    addEntry(entries, path, bytes, 6);
  }
  return zipSync(entries);
}

/** 検証完了後に参照元一式を返す。古い、添付なしの図面も同じ読み手を通る。 */
export async function readDrawingBundle(bytes: Uint8Array): Promise<ReadPcaddFileResult> {
  const drawing = readPcaddFile(bytes);
  if (!drawing.ok) return drawing;
  try {
    const ref = drawing.document.source.sourceRef;
    const prefix = sourcePrefix(ref);
    const archive = readArchive(bytes, { shouldExtract: (name) => name === `source/${ref}.json` || name.startsWith(prefix) });
    if (!archive.ok) return { ok: false, error: { code: 'notZip', message: archive.error.reason } };
    const entries: Zippable = {};
    for (const [name, value] of archive.entries) {
      const path = name === `source/${ref}.json` ? PCAD_DOCUMENT_ENTRY : name.slice(prefix.length);
      addEntry(entries, path, value, 0);
    }
    // 形式の検査を複製せず、部品・アセンブリの読み手へ戻して原本まで検査する。
    const parsed = await readDocumentBundle(zipSync(entries), drawing.source.sourceKind);
    if (!parsed.ok) return parsed;
    const bundle = parsed.bundle;
    const source: DrawingSourceInput = bundle.kind === 'part'
      ? { sourceKind: 'part', document: bundle.document, attachments: bundle.attachments }
      : { sourceKind: 'assembly', document: bundle.document, library: partLibraryOfBundle(bundle) };
    return { ...drawing, source };
  } catch (error) {
    return { ok: false, error: { code: 'invalidField', message: error instanceof Error ? error.message : 'Invalid drawing source' } };
  }
}
