import {
  attachmentsDigestOf, compareAssemblyDocuments, compareDocuments, compareDrawingDocuments, drawingSourceContentHash,
  drawingSourceInputHash, partLibraryOfBundle, type AssemblyLibraryDigest, type DocumentDefinitionComparison,
  type DocumentRelationship, type PartLibrary,
} from '@pointercad/model';
import { IO_LIMITS, readDocumentBundle, readDrawingBundle, readPcadFile } from '@pointercad/io';
import { isDefinitionDiffRequest, type DefinitionDiffReply, DEFINITION_DIFF_MAX_FILE_BYTES,
  type DefinitionDiffDocumentKind } from './definitionDiffProtocol.js';

const limits = { ...IO_LIMITS, archiveCompressedBytes: DEFINITION_DIFF_MAX_FILE_BYTES,
  archiveEntryExpandedBytes: 32 * 1024 * 1024, archiveTotalExpandedBytes: 64 * 1024 * 1024 };
function read(bytes: Uint8Array) {
  const file = readPcadFile(bytes, { limits });
  if (!file.ok) throw new Error(file.error.message);
  if (file.kind !== 'part') throw new Error('比較には部品の.pcadを選んでください。');
  return file;
}
async function textDigest(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
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
  if (!result.ok) throw new Error(result.error.message);
  if (result.bundle.kind !== 'assembly') throw new Error('比較には組立の.pcadaを選んでください。');
  return { document: result.bundle.document, library: await libraryDigestOf(partLibraryOfBundle(result.bundle)) };
}
async function readDrawing(bytes: Uint8Array) {
  const result = await readDrawingBundle(bytes, { limits });
  if (!result.ok) throw new Error(result.error.message);
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
  if (!isDefinitionDiffRequest(value)) return { kind: 'failed', message: '比較の入力が不正か、ファイルが上限の32MiBを超えています。' };
  try {
    if (value.kind === 'inspect') return { kind: 'inspected', name: read(value.bytes).document.name };
    return { kind: 'compared', result: await compare(value.documentKind ?? 'part', value.before, value.after, value.relationship) };
  } catch (error) {
    return { kind: 'failed', message: error instanceof Error ? error.message.slice(0, 4_096) : '文書を比較できませんでした。' };
  }
}
