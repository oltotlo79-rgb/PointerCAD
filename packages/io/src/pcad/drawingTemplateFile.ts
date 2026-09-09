import type { DrawingTemplate } from '@pointercad/model';
import { strToU8, zipSync } from 'fflate';
import { FIXED_ENTRY_MTIME, PCAD_DOCUMENT_ENTRY } from './pcadFile.js';
import { readArchive } from './readArchive.js';
import { parseDrawingTemplate, serializeDrawingTemplate, type ParseDrawingTemplateResult } from './drawingTemplateJson.js';

/** 参照モデルを抱き込まない、設定1エントリだけの.pcadt。 */
export function writeDrawingTemplateFile(template: DrawingTemplate, savedAt: string): Uint8Array {
  return zipSync({ [PCAD_DOCUMENT_ENTRY]: [strToU8(serializeDrawingTemplate(template, savedAt)), { level: 6, mtime: FIXED_ENTRY_MTIME }] });
}

export type ReadDrawingTemplateFileResult = ParseDrawingTemplateResult
  | { readonly ok: false; readonly error: { readonly code: 'notZip' | 'missingDocument'; readonly message: string } };

export function readDrawingTemplateFile(bytes: Uint8Array): ReadDrawingTemplateFileResult {
  const archive = readArchive(bytes, { shouldExtract: (name) => name === PCAD_DOCUMENT_ENTRY });
  if (!archive.ok) return { ok: false, error: { code: 'notZip', message: archive.error.reason } };
  const content = archive.entries.get(PCAD_DOCUMENT_ENTRY);
  if (content === undefined) return { ok: false, error: { code: 'missingDocument', message: '図面ひな形の設定が見つかりません。' } };
  try { return parseDrawingTemplate(new TextDecoder('utf-8', { fatal: true }).decode(content)); }
  catch { return { ok: false, error: { code: 'invalidTemplate', message: '図面ひな形の文字を読み取れませんでした。' } }; }
}
