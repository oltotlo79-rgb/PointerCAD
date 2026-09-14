import { openFileThrough, type FileGateway } from '../file/fileGateway.js';
import { t } from '../i18n/t.js';
import { DEFINITION_DIFF_MAX_FILE_BYTES, type DefinitionDiffRequest } from './definitionDiffProtocol.js';
import type { DefinitionDiffExecution } from './definitionDiffClient.js';

export interface ComparisonFile { readonly fileName: string; readonly documentName: string; readonly bytes: Uint8Array }
export type PickComparisonResult = { readonly status: 'ready'; readonly file: ComparisonFile }
  | { readonly status: 'cancelled' } | { readonly status: 'failed'; readonly message: string };
export type DefinitionDiffExecutor = (request: DefinitionDiffRequest, signal: AbortSignal) => Promise<DefinitionDiffExecution>;

/** 不正な候補を既存の比較入力へ置き換えず、保存先の登録にも触れない。 */
export async function pickComparisonFile(gateway: FileGateway, signal: AbortSignal, execute: DefinitionDiffExecutor): Promise<PickComparisonResult> {
  if (signal.aborted) return { status: 'cancelled' };
  try {
    const picked = await openFileThrough(gateway, ['pcad']);
    if (picked === null || signal.aborted) return { status: 'cancelled' };
    if (picked.kind !== 'pcad' || picked.bytes.byteLength > DEFINITION_DIFF_MAX_FILE_BYTES) return { status: 'failed', message: t('documentDiff.fileLimit') };
    const result = await execute({ kind: 'inspect', bytes: picked.bytes }, signal);
    if (signal.aborted || (!result.ok && result.reason === 'cancelled')) return { status: 'cancelled' };
    if (!result.ok) return { status: 'failed', message: t(result.reason === 'timeout' ? 'documentDiff.timeout' : 'documentDiff.failed') };
    if (result.reply.kind === 'failed') return { status: 'failed', message: result.reply.message };
    if (result.reply.kind !== 'inspected') return { status: 'failed', message: t('documentDiff.failed') };
    return { status: 'ready', file: { fileName: picked.fileName, documentName: result.reply.name, bytes: picked.bytes } };
  } catch (error) {
    if (signal.aborted) return { status: 'cancelled' };
    return { status: 'failed', message: error instanceof Error ? error.message : t('documentDiff.failed') };
  }
}
