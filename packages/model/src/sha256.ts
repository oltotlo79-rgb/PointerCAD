/** Internal byte digest only; callers retain their own canonicalization and encoding. */
export async function sha256Hex(bytes: BufferSource): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  let text = '';
  for (const byte of new Uint8Array(digest)) {
    text += byte.toString(16).padStart(2, '0');
  }
  return text;
}
