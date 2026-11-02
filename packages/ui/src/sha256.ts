/** Internal digest only: callers retain input preparation, capability checks and error translation. */
export async function sha256Hex(subtle: SubtleCrypto, bytes: BufferSource): Promise<string> {
  const digest = await subtle.digest('SHA-256', bytes);
  let text = '';
  for (const byte of new Uint8Array(digest)) {
    text += byte.toString(16).padStart(2, '0');
  }
  return text;
}
