import type { ReadDocumentBundleResult, ReadPcadFileErrorCode, ReadPcadFileResult, ReadPcaddFileResult } from '@pointercad/io';

/** UI内の読込操作だけの識別子。保存形式のkindは増やさない。 */
export interface PcadReadResults {
  readonly part: ReadPcadFileResult;
  readonly assembly: ReadDocumentBundleResult;
  readonly drawing: ReadPcaddFileResult;
}
export type PcadReadKind = keyof PcadReadResults;
export interface PcadReadRequest {
  readonly id: string;
  readonly kind: PcadReadKind;
  readonly bytes: Uint8Array;
}
export type PcadReadReply = {
  [K in PcadReadKind]: { readonly id: string; readonly kind: K; readonly result: PcadReadResults[K] }
}[PcadReadKind] | { readonly id: string; readonly kind: 'failure'; readonly message: string };

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
function readKind(value: unknown): value is PcadReadKind {
  return value === 'part' || value === 'assembly' || value === 'drawing';
}
export function isPcadReadRequest(value: unknown): value is PcadReadRequest {
  return record(value) && typeof value.id === 'string' && value.id.length > 0
    && readKind(value.kind) && value.bytes instanceof Uint8Array
    && value.bytes.buffer instanceof ArrayBuffer;
}

const ERROR_CODES = {
  notZip: true, missingDocument: true, invalidJson: true, notPcad: true, unsupportedKind: true,
  unsupportedOldVersion: true, unsupportedNewVersion: true, versionMismatch: true, missingField: true, invalidField: true,
} satisfies Readonly<Record<ReadPcadFileErrorCode, true>>;

function attachments(value: unknown): boolean {
  return record(value) && value.shapes instanceof Map && value.meshes instanceof Map && value.canvases instanceof Map;
}

/** The strict IO reader owns document validation; the host checks the transport envelope, never parses ZIP/JSON again. */
export function isPcadReadReplyFor<K extends PcadReadKind>(
  value: unknown, kind: K,
): value is { readonly id: string; readonly kind: K; readonly result: PcadReadResults[K] } {
  if (!record(value) || typeof value.id !== 'string' || value.kind !== kind || !record(value.result)) return false;
  const result = value.result;
  if (result.ok === false) return record(result.error) && typeof result.error.code === 'string'
    && Object.hasOwn(ERROR_CODES, result.error.code) && typeof result.error.message === 'string';
  if (result.ok !== true || typeof result.savedAt !== 'string'
    || (result.thumbnailPng !== undefined && !(result.thumbnailPng instanceof Uint8Array))) return false;
  if (kind === 'assembly') return record(result.bundle) && result.bundle.kind === 'assembly'
    && record(result.bundle.document) && attachments(result.bundle.attachments)
    && result.bundle.embeddedDocuments instanceof Map && result.bundle.embeddedAssemblies instanceof Map
    && Array.isArray(result.bundle.partFiles);
  if (!record(result.document)) return false;
  if (kind === 'part') return (result.kind === 'part' || result.kind === 'partTemplate') && attachments(result.attachments);
  if (!record(result.source) || !record(result.source.document)) return false;
  return result.source.sourceKind === 'part'
    ? result.source.attachments === undefined || attachments(result.source.attachments)
    : result.source.sourceKind === 'assembly' && record(result.source.library)
      && result.source.library.parts instanceof Map && result.source.library.attachments instanceof Map
      && Array.isArray(result.source.library.partFiles);
}

/** Only Worker-owned result buffers reach this function. Preserve shared views with one transfer per buffer. */
export function pcadReadTransferables(value: unknown): ArrayBuffer[] {
  const buffers = new Set<ArrayBuffer>(), visited = new Set<object>();
  const add = (buffer: ArrayBufferLike): void => {
    if (!(buffer instanceof ArrayBuffer)) throw new Error('Shared read buffer cannot be transferred');
    buffers.add(buffer);
  };
  const visit = (item: unknown): void => {
    if (typeof item === 'function' || typeof item === 'symbol') throw new Error('Read result cannot be cloned');
    if (typeof item !== 'object' || item === null || visited.has(item)) return;
    visited.add(item);
    if (ArrayBuffer.isView(item)) { add(item.buffer); return; }
    if (item instanceof ArrayBuffer) { add(item); return; }
    if (item instanceof Map) { for (const [key, entry] of item) { visit(key); visit(entry); } return; }
    if (Array.isArray(item)) { for (const entry of item) visit(entry); return; }
    if (Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) {
      throw new Error('Unsupported read result object');
    }
    for (const entry of Object.values(item)) visit(entry);
  };
  visit(value);
  return [...buffers];
}
