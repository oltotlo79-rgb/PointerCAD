/** picker/input/種類つき入口が共用し、本文を取る前にサイズを検査する。 */
import { IO_LIMITS } from '@pointercad/io';
import { t } from '../i18n/t.js';

export interface BrowserReadableFile {
  readonly size: number;
  arrayBuffer(): Promise<ArrayBuffer>;
  slice?(start: number, end: number): Pick<Blob, 'size' | 'arrayBuffer'>;
}

const DOCUMENT_READ_CHUNK_BYTES = 1024 * 1024;

function assertReadLength(buffer: ArrayBuffer, expected: number): void {
  if (!(buffer instanceof ArrayBuffer) || buffer.byteLength !== expected) {
    throw new Error(t('file.error.corrupted'));
  }
}

async function readDocumentSlices(file: BrowserReadableFile, slice: NonNullable<BrowserReadableFile['slice']>,
  size: number, signal: AbortSignal): Promise<Uint8Array> {
  const bytes = new Uint8Array(size);
  for (let start = 0; start < size; start += DOCUMENT_READ_CHUNK_BYTES) {
    signal.throwIfAborted();
    const end = Math.min(start + DOCUMENT_READ_CHUNK_BYTES, size);
    const part = slice(start, end);
    if (part.size !== end - start) throw new Error(t('file.error.corrupted'));
    const buffer = await part.arrayBuffer();
    signal.throwIfAborted();
    assertReadLength(buffer, end - start);
    bytes.set(new Uint8Array(buffer), start);
  }
  if (file.size !== size) throw new Error(t('file.error.corrupted'));
  return bytes;
}

export async function readBrowserFile(file: BrowserReadableFile, maximumBytes = IO_LIMITS.archiveCompressedBytes,
  signal?: AbortSignal): Promise<Uint8Array> {
  signal?.throwIfAborted();
  const declared = file.size;
  if (!Number.isSafeInteger(declared) || declared < 0 || !Number.isSafeInteger(maximumBytes) || maximumBytes < 0) {
    throw new Error(t('file.error.invalidSize'));
  }
  if (declared > maximumBytes) throw new Error(t('file.error.tooLarge'));
  if (signal !== undefined && declared > DOCUMENT_READ_CHUNK_BYTES && typeof file.slice === 'function') {
    return readDocumentSlices(file, file.slice.bind(file), declared, signal);
  }
  const buffer = await file.arrayBuffer();
  signal?.throwIfAborted();
  assertReadLength(buffer, declared);
  if (file.size !== declared) throw new Error(t('file.error.corrupted'));
  return new Uint8Array(buffer);
}
