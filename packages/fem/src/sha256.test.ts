import { describe, expect, it, vi } from 'vitest';
import { sha256Hex } from './sha256.js';

// RFC 8017 section 7.1.1 (empty) and RFC 6234 section 8.5 SHA256 tests 1/2.
// These published constants are independent of this implementation.
const vectors = [
  ['', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'],
  ['abc', 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'],
  ['abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq',
    '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1'],
] as const;

describe('internal FEM SHA-256 byte digest', () => {
  it.each(vectors)('matches the published vector %j without changing input', async (source, expected) => {
    const bytes = new TextEncoder().encode(source), before = bytes.slice();
    expect(await sha256Hex(bytes)).toBe(expected);
    expect(bytes).toEqual(before);
  });

  it('preserves the requested byte range and an empty offset view', async () => {
    const bytes = new Uint8Array([255, 97, 98, 99, 254]), before = bytes.slice();
    expect(await sha256Hex(bytes.subarray(1, 4))).toBe(vectors[1][1]);
    expect(await sha256Hex(new DataView(bytes.buffer, 1, 3))).toBe(vectors[1][1]);
    expect(await sha256Hex(bytes.subarray(2, 2))).toBe(vectors[0][1]);
    expect(bytes).toEqual(before);
  });

  it('propagates the original digest failure without fallback', async () => {
    const failure = new Error('digest unavailable');
    const spy = vi.spyOn(crypto.subtle, 'digest').mockRejectedValue(failure);
    try { await expect(sha256Hex(new Uint8Array())).rejects.toBe(failure); }
    finally { spy.mockRestore(); }
  });

  it('keeps crypto capability failure as a rejected call', async () => {
    vi.stubGlobal('crypto', undefined);
    try { await expect(sha256Hex(new Uint8Array())).rejects.toBeInstanceOf(TypeError); }
    finally { vi.unstubAllGlobals(); }
  });
});
