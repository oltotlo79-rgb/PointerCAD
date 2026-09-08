/** P7-22。既存のPNG bytesを31枚まとめる。画像の縮小・再圧縮はしない。 */
import { zipSync, type Zippable } from 'fflate';
import { IO_LIMITS } from './limits.js';

export const PNG_SEQUENCE_FRAME_COUNT = 31;
export interface PngSequenceLimits {
  readonly maxFrameBytes?: number;
  readonly maxTotalBytes?: number;
}
export type PngSequenceZipResult =
  | { readonly ok: true; readonly bytes: Uint8Array; readonly frameCount: number; readonly inputBytes: number }
  | { readonly ok: false; readonly reason: 'frameCount' | 'invalidPng' | 'sizeLimit' | 'invalidLimit' | 'zipFailed'; readonly frame?: number };

const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

/** ブラウザが生成したPNGの封筒を検査する。画素のデコードはしない。 */
function completePng(bytes: Uint8Array): boolean {
  if (bytes.length < 45 || SIGNATURE.some((value, index) => bytes[index] !== value)) return false;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 8, first = true, imageData = false;
  while (offset + 12 <= bytes.length) {
    const size = view.getUint32(offset), type = view.getUint32(offset + 4);
    if (size > bytes.length - offset - 12) return false;
    if (first) {
      if (type !== 0x49484452 || size !== 13) return false;
      const width = view.getUint32(offset + 8), height = view.getUint32(offset + 12);
      if (width === 0 || height === 0 || width > 0x7fffffff || height > 0x7fffffff) return false;
      first = false;
    } else if (type === 0x49484452) return false;
    if (type === 0x49444154) imageData = true;
    offset += size + 12;
    if (type === 0x49454e44) return size === 0 && imageData && offset === bytes.length;
  }
  return false;
}

export function createPngSequenceZip(frames: readonly Uint8Array[], limits: PngSequenceLimits = {}): PngSequenceZipResult {
  const perFrame = limits.maxFrameBytes ?? IO_LIMITS.archiveEntryExpandedBytes;
  const totalLimit = limits.maxTotalBytes ?? IO_LIMITS.archiveTotalExpandedBytes;
  if (!Number.isSafeInteger(perFrame) || perFrame <= 0 || perFrame > IO_LIMITS.archiveEntryExpandedBytes
    || !Number.isSafeInteger(totalLimit) || totalLimit <= 0 || totalLimit > IO_LIMITS.archiveTotalExpandedBytes) {
    return { ok: false, reason: 'invalidLimit' };
  }
  const candidate: unknown = frames;
  if (!Array.isArray(candidate) || candidate.length !== PNG_SEQUENCE_FRAME_COUNT) return { ok: false, reason: 'frameCount' };
  let inputBytes = 0;
  const validated: Uint8Array[] = [];
  for (let frame = 0; frame < candidate.length; frame++) {
    const bytes: unknown = candidate[frame];
    if (!Object.hasOwn(candidate, frame) || !(bytes instanceof Uint8Array)) return { ok: false, reason: 'invalidPng', frame };
    inputBytes += bytes.byteLength;
    if (bytes.byteLength > perFrame || inputBytes > totalLimit) return { ok: false, reason: 'sizeLimit', frame };
    if (!completePng(bytes)) return { ok: false, reason: 'invalidPng', frame };
    validated.push(bytes);
  }
  const entries: Zippable = {};
  for (let frame = 0; frame < validated.length; frame++) {
    // ZIPのDOS日時はローカル年月日で格納される。UTC文字列から作るとTZで日付が変わる。
    entries[`frame-${String(frame).padStart(2, '0')}.png`] = [validated[frame], { mtime: new Date(1980, 0, 1), level: 0 }];
  }
  try {
    const bytes = zipSync(entries);
    return bytes.byteLength > IO_LIMITS.archiveCompressedBytes
      ? { ok: false, reason: 'sizeLimit' }
      : { ok: true, bytes, frameCount: frames.length, inputBytes };
  } catch { return { ok: false, reason: 'zipFailed' }; }
}
