/** R07: picker/input/種類つき入口が共用し、本文を取る前にサイズを検査する。 */
import { IO_LIMITS } from '@pointercad/io';
import { t } from '../i18n/t.js';

export interface BrowserReadableFile {
  readonly size: number;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export async function readBrowserFile(file: BrowserReadableFile, maximumBytes = IO_LIMITS.archiveCompressedBytes): Promise<Uint8Array> {
  const declared = file.size;
  if (!Number.isSafeInteger(declared) || declared < 0 || !Number.isSafeInteger(maximumBytes) || maximumBytes < 0) {
    throw new Error(t('file.error.invalidSize'));
  }
  if (declared > maximumBytes) throw new Error(t('file.error.tooLarge'));
  const buffer = await file.arrayBuffer();
  if (!(buffer instanceof ArrayBuffer) || buffer.byteLength !== declared || buffer.byteLength > maximumBytes) {
    throw new Error(t('file.error.corrupted'));
  }
  return new Uint8Array(buffer);
}
