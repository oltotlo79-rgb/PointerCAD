import { sha256Hex } from '../sha256.js';
import {
  attachmentsDigestOf, compareAssemblyDocuments, compareDocuments, compareDrawingDocuments, drawingSourceContentHash,
  drawingSourceInputHash, partLibraryOfBundle, DocumentComparisonLimit,
  type AssemblyLibraryDigest, type DocumentDefinitionComparison,
  type DocumentRelationship, type PartLibrary,
} from '@pointercad/model';
import { IO_LIMITS, readDocumentBundle, readDrawingBundle, readPcadFile, type ReadPcadFileError } from '@pointercad/io';
import { isDefinitionDiffRequestShape, type DefinitionDiffReply, DEFINITION_DIFF_MAX_FILE_BYTES,
  type DefinitionDiffDocumentKind, type DefinitionDiffFailure } from './definitionDiffProtocol.js';

const limits = { ...IO_LIMITS, archiveCompressedBytes: DEFINITION_DIFF_MAX_FILE_BYTES,
  archiveEntryExpandedBytes: 32 * 1024 * 1024, archiveTotalExpandedBytes: 64 * 1024 * 1024 };
class DefinitionDiffReadError extends Error {
  constructor(readonly failure: DefinitionDiffFailure) { super(failure.code); }
}

function documentReadError(error: ReadPcadFileError): DefinitionDiffReadError {
  return new DefinitionDiffReadError({ code: 'documentRead', reason: error.code,
    ...(error.diagnostic === undefined ? {} : { diagnostic: error.diagnostic }) });
}

function read(bytes: Uint8Array) {
  const file = readPcadFile(bytes, { limits });
  if (!file.ok) throw documentReadError(file.error);
  if (file.kind !== 'part') throw new DefinitionDiffReadError({ code: 'partRequired' });
  return file;
}
async function textDigest(text: string): Promise<string> {
  return sha256Hex(crypto.subtle, new TextEncoder().encode(text));
}
/** 組立が抱き込む部品・サブ組立は内容ハッシュ、添付は部品ごとのダイジェストを1つにまとめた値で比べる。 */
async function libraryDigestOf(library: PartLibrary): Promise<AssemblyLibraryDigest> {
  const parts = new Map<string, { name: string; hash: string }>();
  for (const [ref, document] of library.parts) parts.set(ref, { name: document.name, hash: await drawingSourceContentHash(document) });
  const assemblies = new Map<string, { name: string; hash: string }>();
  for (const [ref, document] of library.assemblies ?? []) assemblies.set(ref, { name: document.name, hash: await drawingSourceContentHash(document) });
  const lines: string[] = [];
  for (const [ref, attachments] of [...library.attachments].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
    lines.push(`${ref}=${await attachmentsDigestOf(attachments)}`);
  }
  return { parts, assemblies, attachmentsDigest: await textDigest(lines.join('\n')) };
}
async function readAssembly(bytes: Uint8Array) {
  const result = await readDocumentBundle(bytes, 'assembly', { limits });
  if (!result.ok) throw documentReadError(result.error);
  if (result.bundle.kind !== 'assembly') throw new Error('Expected an assembly comparison bundle');
  return { document: result.bundle.document, library: await libraryDigestOf(partLibraryOfBundle(result.bundle)) };
}
async function readDrawing(bytes: Uint8Array) {
  const result = await readDrawingBundle(bytes, { limits });
  if (!result.ok) throw documentReadError(result.error);
  return { document: result.document, sourceHash: await drawingSourceInputHash(result.source) };
}
async function compare(kind: DefinitionDiffDocumentKind, before: Uint8Array, after: Uint8Array,
  relationship: DocumentRelationship): Promise<DocumentDefinitionComparison> {
  if (kind === 'assembly') {
    const first = await readAssembly(before), second = await readAssembly(after);
    return compareAssemblyDocuments(first.document, second.document, { relationship,
      beforeLibrary: first.library, afterLibrary: second.library });
  }
  if (kind === 'drawing') {
    const first = await readDrawing(before), second = await readDrawing(after);
    return compareDrawingDocuments(first.document, second.document, { relationship,
      beforeSourceHash: first.sourceHash, afterSourceHash: second.sourceHash });
  }
  const first = read(before), second = read(after);
  return compareDocuments(first.document, second.document, { relationship,
    beforeAttachmentsDigest: await attachmentsDigestOf(first.attachments),
    afterAttachmentsDigest: await attachmentsDigestOf(second.attachments) });
}
/** ファイル選択の上書き先、現在の文書、保存の口を持たない独立した読込み。 */
export async function executeDefinitionDiffWork(value: unknown): Promise<DefinitionDiffReply> {
  if (!isDefinitionDiffRequestShape(value)) return { kind: 'failed', failure: { code: 'invalidRequest' } };
  const inputFiles = value.kind === 'inspect' ? [value.bytes] : [value.before, value.after];
  if (inputFiles.some(bytes => bytes.byteLength > DEFINITION_DIFF_MAX_FILE_BYTES)) {
    return { kind: 'failed', failure: { code: 'fileLimit' } };
  }
  try {
    if (value.kind === 'inspect') return { kind: 'inspected', name: read(value.bytes).document.name };
    return { kind: 'compared', result: await compare(value.documentKind ?? 'part', value.before, value.after, value.relationship) };
  } catch (error) {
    if (error instanceof DefinitionDiffReadError) return { kind: 'failed', failure: error.failure };
    if (error instanceof DocumentComparisonLimit) return { kind: 'failed', failure: { code: error.code } };
    if (error instanceof Error && 'code' in error && error.code === 'document-comparison-duplicate-identifier') {
      return { kind: 'failed', failure: { code: 'duplicateIdentifier' } };
    }
    if (import.meta.env.DEV) console.error('PointerCAD document definition comparison', error);
    return { kind: 'failed', failure: { code: 'internal' } };
  }
}
