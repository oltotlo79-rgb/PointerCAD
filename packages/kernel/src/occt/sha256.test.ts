import { afterEach, describe, expect, it, vi } from 'vitest';
import { sha256Hex } from './sha256.js';

afterEach(() => vi.restoreAllMocks());

// SHA-256 known-answer vectors: NIST FIPS 180-4 / SHA examples (empty, "abc", two-block message).
// Constants are fixed independently of this helper and its consumers.
describe('internal OCCT SHA-256 bytes and lowercase hexadecimal', () => {
  it.each([
    ['', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'],
    ['abc', 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'],
    ['abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq',
      '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1'],
  ])('matches the independent vector for %s without changing its input', async (text, expected) => {
    const bytes = new TextEncoder().encode(text).buffer;
    const before = bytes.slice(0);
    expect(await sha256Hex(bytes)).toBe(expected);
    expect(bytes).toEqual(before);
  });

  it('hashes precisely the supplied ArrayBuffer range, including an empty slice', async () => {
    const backing = new TextEncoder().encode('--abc++').buffer;
    const before = backing.slice(0);
    expect(await sha256Hex(backing.slice(2, 5))).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(await sha256Hex(backing.slice(2, 2))).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(backing).toEqual(before);
  });

  it('passes the exact buffer to WebCrypto and preserves the original rejection', async () => {
    const bytes = Uint8Array.of(0, 128, 255).buffer;
    const primary = new Error('digest fixture rejection');
    const digest = vi.spyOn(crypto.subtle, 'digest').mockRejectedValueOnce(primary);
    await expect(sha256Hex(bytes)).rejects.toBe(primary);
    expect(digest).toHaveBeenCalledExactlyOnceWith('SHA-256', bytes);
    expect(digest.mock.calls[0]?.[1]).toBe(bytes);
  });
});
