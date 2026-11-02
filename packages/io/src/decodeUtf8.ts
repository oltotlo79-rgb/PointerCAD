import { strFromU8 } from 'fflate';

export function decodeUtf8(bytes: Uint8Array): string | null {
  try {
    return strFromU8(bytes);
  } catch {
    return null;
  }
}
