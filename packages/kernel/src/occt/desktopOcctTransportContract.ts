/** Shared by Electron main and the renderer without loading the kernel entry point. */
export const DESKTOP_OCCT_TRANSPORT_ORIGIN = 'http://127.0.0.1:49721';

export interface DesktopOcctIdentity {
  readonly sha256: string;
  readonly byteLength: number;
}

export type DesktopOcctTransportReply =
  | { readonly kind: 'http'; readonly url: string; readonly sha256: string; readonly byteLength: number }
  | { readonly kind: 'direct'; readonly reason: 'port-unavailable' };

export function desktopOcctTransportUrl(sha256: string): string {
  if (!/^[a-f0-9]{64}$/.test(sha256)) throw new Error('Desktop OCCT transport SHA-256 is invalid.');
  return `${DESKTOP_OCCT_TRANSPORT_ORIGIN}/occt/${sha256}.wasm`;
}

/** An IPC response is untrusted even when it comes from the application's preload. */
export function validateDesktopOcctTransportReply(
  value: unknown, expected: DesktopOcctIdentity,
): DesktopOcctTransportReply {
  const url = desktopOcctTransportUrl(expected.sha256);
  if (!Number.isSafeInteger(expected.byteLength) || expected.byteLength <= 0 ||
      expected.byteLength > 64 * 1024 * 1024) throw new Error('Desktop OCCT transport byte length is invalid.');
  if (typeof value !== 'object' || value === null || !('kind' in value)) {
    throw new Error('Desktop OCCT transport response is invalid.');
  }
  if (value.kind === 'direct' && 'reason' in value && value.reason === 'port-unavailable' &&
      Object.keys(value).length === 2) return { kind: 'direct', reason: value.reason };
  if (value.kind === 'http' && 'url' in value && value.url === url &&
      'sha256' in value && value.sha256 === expected.sha256 &&
      'byteLength' in value && value.byteLength === expected.byteLength &&
      Object.keys(value).length === 4) {
    return { kind: 'http', url, sha256: expected.sha256, byteLength: expected.byteLength };
  }
  throw new Error('Desktop OCCT transport response does not match the build identity.');
}
