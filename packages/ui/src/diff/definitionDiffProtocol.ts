import type { DocumentDefinitionComparison, DocumentDefinitionChange, DocumentRelationship, DefinitionDifference } from '@pointercad/model';

export const DEFINITION_DIFF_MAX_FILE_BYTES = 32 * 1024 * 1024;
export const DEFINITION_DIFF_TIMEOUT_MS = 120_000;
export type DefinitionDiffRequest = { readonly kind: 'inspect'; readonly bytes: Uint8Array }
  | { readonly kind: 'compare'; readonly before: Uint8Array; readonly after: Uint8Array; readonly relationship: DocumentRelationship };
export type DefinitionDiffReply = { readonly kind: 'inspected'; readonly name: string }
  | { readonly kind: 'compared'; readonly result: DocumentDefinitionComparison }
  | { readonly kind: 'failed'; readonly message: string };

function record(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null; }
export function isDefinitionDiffRequest(value: unknown): value is DefinitionDiffRequest {
  if (!record(value)) return false;
  const bytes = (entry: unknown): boolean => entry instanceof Uint8Array && entry.byteLength <= DEFINITION_DIFF_MAX_FILE_BYTES;
  return value.kind === 'inspect' ? bytes(value.bytes) : value.kind === 'compare' && bytes(value.before) && bytes(value.after)
    && (value.relationship === 'versions' || value.relationship === 'unrelated');
}
const groups = new Set(['document', 'sketch', 'sketch-feature', 'reference', 'solid', 'parameter', 'configuration',
  'sheet-unfold', 'named-view', 'selection-set', 'canvas', 'appearance', 'note', 'folder', 'attachments']);
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
  if (value.kind === 'failed') return typeof value.message === 'string' && value.message.length <= 4_096;
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
