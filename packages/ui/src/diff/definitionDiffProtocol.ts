import { isObject as record } from '../valueGuards.js';
import type { ReadPcadFileError, ReadPcadFileErrorCode } from '@pointercad/io';
import type { DocumentDefinitionComparison, DocumentDefinitionChange, DocumentRelationship, DefinitionDifference } from '@pointercad/model';

export const DEFINITION_DIFF_MAX_FILE_BYTES = 32 * 1024 * 1024;
export const DEFINITION_DIFF_TIMEOUT_MS = 120_000;
export type DefinitionDiffDocumentKind = 'part' | 'assembly' | 'drawing';
export type DefinitionDiffRequest = { readonly kind: 'inspect'; readonly bytes: Uint8Array }
  | { readonly kind: 'compare'; readonly before: Uint8Array; readonly after: Uint8Array; readonly relationship: DocumentRelationship;
    /** 省略は部品。保存点の比較が組立・図面を指す。 */
    readonly documentKind?: DefinitionDiffDocumentKind };
const failureCodes = {
  invalidRequest: true, fileLimit: true, partRequired: true,
  duplicateIdentifier: true, comparisonLimit: true, internal: true,
} as const;
const readErrorCodes = {
  notZip: true, archiveExpansionLimit: true, missingDocument: true, subAssemblyCycle: true,
  subAssemblyDepth: true, invalidJson: true, notPcad: true, unsupportedKind: true,
  unsupportedOldVersion: true, unsupportedNewVersion: true, versionMismatch: true,
  missingField: true, invalidField: true,
} satisfies Record<ReadPcadFileErrorCode, true>;
const archiveDiagnostics = {
  embeddedDocument: true, partAttachmentInvalid: true, partAttachmentMissing: true,
  partAttachmentDigestMissing: true, partAttachmentDigestMismatch: true,
} satisfies Record<NonNullable<ReadPcadFileError['diagnostic']>, true>;

export type DefinitionDiffFailure = { readonly code: keyof typeof failureCodes }
  | ({ readonly code: 'documentRead' } & Pick<ReadPcadFileError, 'diagnostic'> & { readonly reason: ReadPcadFileErrorCode });

function isDefinitionDiffFailure(value: unknown): value is DefinitionDiffFailure {
  if (!record(value) || !Object.hasOwn(value, 'code') || typeof value.code !== 'string') return false;
  const fields = Object.keys(value);
  if (value.code !== 'documentRead') return fields.length === 1 && Object.hasOwn(failureCodes, value.code);
  if (!Object.hasOwn(value, 'reason') || typeof value.reason !== 'string' || !Object.hasOwn(readErrorCodes, value.reason)) return false;
  if (fields.length === 2) return value.diagnostic === undefined;
  return fields.length === 3 && Object.hasOwn(value, 'diagnostic')
    && typeof value.diagnostic === 'string' && Object.hasOwn(archiveDiagnostics, value.diagnostic);
}

export type DefinitionDiffReply = { readonly kind: 'inspected'; readonly name: string }
  | { readonly kind: 'compared'; readonly result: DocumentDefinitionComparison }
  | { readonly kind: 'failed'; readonly failure: DefinitionDiffFailure };

export function isDefinitionDiffRequestShape(value: unknown): value is DefinitionDiffRequest {
  if (!record(value)) return false;
  const bytes = (entry: unknown): boolean => entry instanceof Uint8Array;
  return value.kind === 'inspect' ? bytes(value.bytes) : value.kind === 'compare' && bytes(value.before) && bytes(value.after)
    && (value.relationship === 'versions' || value.relationship === 'unrelated')
    && (value.documentKind === undefined || value.documentKind === 'part' || value.documentKind === 'assembly' || value.documentKind === 'drawing');
}
const groups = new Set(['document', 'sketch', 'sketch-feature', 'reference', 'solid', 'parameter', 'configuration',
  'sheet-unfold', 'named-view', 'selection-set', 'canvas', 'appearance', 'note', 'folder', 'math-problem', 'attachments',
  'assembly-document', 'component', 'mate', 'joint', 'presentation', 'library-part', 'library-assembly', 'drawing-document',
  'drawing-view', 'dimension', 'annotation', 'table', 'balloon', 'datum', 'gdt', 'weld', 'layer', 'drawing-parameter', 'drawing-source']);
const differenceKinds = new Set(['value', 'expression', 'expression-and-value', 'stored-value', 'order']);
const text = (value: unknown): value is string => typeof value === 'string' && value.length <= 131_072;
function difference(value: unknown): value is DefinitionDifference {
  if (!record(value) || !Array.isArray(value.path) || value.path.length > 64
    || !value.path.every(text) || !text(value.kind) || !differenceKinds.has(value.kind) || !text(value.before) || !text(value.after)) return false;
  return ['beforeStoredValue', 'afterStoredValue'].every(key => !Object.hasOwn(value, key)
    || (typeof value[key] === 'number' && Number.isFinite(value[key])));
}
function change(value: unknown): value is DocumentDefinitionChange {
  return record(value) && text(value.key) && text(value.group) && groups.has(value.group)
    && (value.beforeName === null || text(value.beforeName)) && (value.afterName === null || text(value.afterName))
    && text(value.owner) && text(value.ownerName) && typeof value.status === 'string' && ['added', 'removed', 'changed'].includes(value.status)
    && Array.isArray(value.differences) && value.differences.length <= 1_024 && value.differences.every(difference);
}
export function isDefinitionDiffReply(value: unknown): value is DefinitionDiffReply {
  if (!record(value)) return false;
  if (value.kind === 'inspected') return text(value.name);
  if (value.kind === 'failed') return !Object.hasOwn(value, 'message') && isDefinitionDiffFailure(value.failure);
  if (value.kind !== 'compared' || !record(value.result)) return false;
  const result = value.result;
  if (!(result.geometryCompared === false && (result.relationship === 'versions' || result.relationship === 'unrelated')
    && Number.isSafeInteger(result.unchanged) && typeof result.unchanged === 'number' && result.unchanged >= 0
    && Array.isArray(result.changes) && result.changes.length <= 10_000 && result.changes.every(change))) return false;
  let characters = 0;
  for (const item of result.changes) {
    characters += item.key.length + item.group.length + item.owner.length + item.ownerName.length + (item.beforeName?.length ?? 0) + (item.afterName?.length ?? 0) + item.status.length;
    for (const field of item.differences) {
      characters += field.before.length + field.after.length + field.path.reduce((sum, segment) => sum + segment.length, 0);
      if (characters > 8_000_000) return false;
    }
    if (characters > 8_000_000) return false;
  }
  return true;
}
