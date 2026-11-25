import { validArchiveReadRange } from '../limits.js';
export { ARCHIVE_READ_CHUNK_BYTES } from '../limits.js';

export interface ArchiveReadSource {
  readonly size: number;
  read(offset: number, length: number): Promise<Uint8Array>;
}

export class ArchiveReadSourceError extends Error {}

export async function readArchiveRange(source: ArchiveReadSource, offset: number, length: number): Promise<Uint8Array> {
  if (!validArchiveReadRange(source.size, offset, length)) throw new ArchiveReadSourceError('Invalid file range');
  try {
    const bytes = await source.read(offset, length);
    if (!(bytes instanceof Uint8Array) || bytes.byteLength !== length) throw new Error('Short file read');
    return bytes;
  } catch (cause) {
    throw new ArchiveReadSourceError('File range could not be read', { cause });
  }
}
