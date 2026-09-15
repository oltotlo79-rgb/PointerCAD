import { attachmentsDigestOf, compareDocuments } from '@pointercad/model';
import { IO_LIMITS, readPcadFile } from '@pointercad/io';
import { isDefinitionDiffRequest, type DefinitionDiffReply, DEFINITION_DIFF_MAX_FILE_BYTES } from './definitionDiffProtocol.js';

const limits = { ...IO_LIMITS, archiveCompressedBytes: DEFINITION_DIFF_MAX_FILE_BYTES,
  archiveEntryExpandedBytes: 32 * 1024 * 1024, archiveTotalExpandedBytes: 64 * 1024 * 1024 };
function read(bytes: Uint8Array) {
  const file = readPcadFile(bytes, { limits });
  if (!file.ok) throw new Error(file.error.message);
  if (file.kind !== 'part') throw new Error('比較には部品の.pcadを選んでください。');
  return file;
}
/** ファイル選択の上書き先、現在の文書、保存の口を持たない独立した読込み。 */
export async function executeDefinitionDiffWork(value: unknown): Promise<DefinitionDiffReply> {
  if (!isDefinitionDiffRequest(value)) return { kind: 'failed', message: '比較の入力が不正か、ファイルが上限の32MiBを超えています。' };
  try {
    if (value.kind === 'inspect') return { kind: 'inspected', name: read(value.bytes).document.name };
    const before = read(value.before), after = read(value.after);
    const beforeAttachmentsDigest = await attachmentsDigestOf(before.attachments);
    const afterAttachmentsDigest = await attachmentsDigestOf(after.attachments);
    const result = compareDocuments(before.document, after.document, { relationship: value.relationship,
      beforeAttachmentsDigest, afterAttachmentsDigest });
    return { kind: 'compared', result };
  } catch (error) {
    return { kind: 'failed', message: error instanceof Error ? error.message.slice(0, 4_096) : '文書を比較できませんでした。' };
  }
}
