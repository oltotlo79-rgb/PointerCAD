import type { DrawingTemplate } from '@pointercad/model';
import { strToU8, zipSync, type Zippable } from 'fflate';
import { FIXED_ENTRY_MTIME, PCAD_DOCUMENT_ENTRY, type PcadZipEntries } from './pcadFile.js';
import { readArchive } from './readArchive.js';
import { readDiagnosticMessage } from './readDiagnostics.js';
import { parseDrawingTemplate, serializeDrawingTemplate, type ParseDrawingTemplateResult } from './drawingTemplateJson.js';

/** 参照モデルを抱き込まない、設定1エントリだけの.pcadt。 */
export function drawingTemplateEntries(template: DrawingTemplate, savedAt: string): PcadZipEntries {
  return new Map([[PCAD_DOCUMENT_ENTRY, [strToU8(serializeDrawingTemplate(template, savedAt)), { level: 6, mtime: FIXED_ENTRY_MTIME }]]]);
}

export function writeDrawingTemplateFile(template: DrawingTemplate, savedAt: string): Uint8Array {
  const entries: Zippable = {};
  for (const [name, [bytes, options]] of drawingTemplateEntries(template, savedAt)) {
    entries[name] = [bytes, { ...options }];
  }
  return zipSync(entries);
}

export type ReadDrawingTemplateFileResult = ParseDrawingTemplateResult
  | { readonly ok: false; readonly error: { readonly code: 'notZip' | 'missingDocument'; readonly message: string } }
  | { readonly ok: false; readonly error: { readonly code: 'invalidTemplate'; readonly diagnostic: 'invalidUtf8'; readonly message: string } };

export function readDrawingTemplateFile(bytes: Uint8Array): ReadDrawingTemplateFileResult {
  const archive = readArchive(bytes, { shouldExtract: (name) => name === PCAD_DOCUMENT_ENTRY });
  if (!archive.ok) return { ok: false, error: { code: 'notZip', message: archive.error.reason } };
  const content = archive.entries.get(PCAD_DOCUMENT_ENTRY);
  if (content === undefined) return { ok: false, error: { code: 'missingDocument', message: readDiagnosticMessage('drawingTemplateMissingDocument') } };
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(content); }
  catch (error) {
    if (!(error instanceof TypeError)) throw error;
    return { ok: false, error: { code: 'invalidTemplate', diagnostic: 'invalidUtf8', message: readDiagnosticMessage('drawingTemplateInvalidUtf8') } };
  }
  return parseDrawingTemplate(text);
}
