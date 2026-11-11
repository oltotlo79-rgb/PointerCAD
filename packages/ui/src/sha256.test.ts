import { describe, expect, it, vi } from 'vitest';
import { createEmptyPartDocument } from '@pointercad/model';
import { sha256Hex } from './sha256.js';
import { sha256 as savePointSha256 } from './history/namedSavePointIntegrity.js';
import { saveTutorialCheckpoint, type TutorialCheckpointStorage } from './tutorial/tutorialCheckpoint.js';

const empty = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const abc = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';

describe('UI internal SHA-256 and distinct caller boundaries', () => {
  it('matches the published empty/abc/56-byte vectors and preserves a partial view', async () => {
    // Same primary sources as the model leaf: RFC8017 §7.1.1; RFC6234 §8.5 SHA256 tests1/2.
    for (const [source, expected] of [
      ['', empty], ['abc', abc],
      ['abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq',
        '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1'],
    ]) expect(await sha256Hex(crypto.subtle, new TextEncoder().encode(source))).toBe(expected);
    const bytes = new Uint8Array([255, 97, 98, 99, 254]), before = bytes.slice();
    expect(await sha256Hex(crypto.subtle, new DataView(bytes.buffer, 1, 3))).toBe(abc);
    expect(bytes).toEqual(before);
  });

  it('propagates the digest failure object without fallback', async () => {
    const error = new Error('digest refused');
    const spy = vi.spyOn(crypto.subtle, 'digest').mockRejectedValue(error);
    try {
      await expect(sha256Hex(crypto.subtle, new Uint8Array())).rejects.toBe(error);
      await expect(savePointSha256(new Uint8Array())).rejects.toBe(error);
    } finally { spy.mockRestore(); }
  });

  it('retains save-point rejection for offset-zero truncated buffers and shared buffers', async () => {
    const bytes = new Uint8Array([97, 98, 99, 0]);
    await expect(savePointSha256(bytes.subarray(0, 3))).rejects.toMatchObject({
      reason: 'invalid', message: 'SHA-256の入力byte境界が不正です。',
    });
    await expect(savePointSha256(new Uint8Array(new SharedArrayBuffer(3)))).rejects.toMatchObject({ reason: 'invalid' });
  });

  it('retains the save-point unavailable refusal before attempting a digest', async () => {
    vi.stubGlobal('crypto', undefined);
    try {
      await expect(savePointSha256(new Uint8Array([97, 98, 99]))).rejects.toMatchObject({
        reason: 'unavailable', message: 'この端末ではSHA-256を利用できません。',
      });
    } finally { vi.unstubAllGlobals(); }
  });

  it('keeps the tutorial partial view and copies shared bytes to an owned ArrayBuffer', async () => {
    const document = createEmptyPartDocument();
    const input = { stageHint: 'pointCoordinates' as const, owned: { sketchId: document.activeSketchId } };
    for (const buffer of [new ArrayBuffer(5), new SharedArrayBuffer(5)]) {
      const bytes = new Uint8Array(buffer); bytes.set([255, 97, 98, 99, 254]);
      const before = Array.from(bytes);
      const data = new Map<string, string>();
      const storage: TutorialCheckpointStorage = { getItem: key => data.get(key) ?? null,
        setItem: (key, value) => { data.set(key, value); } };
      const spy = vi.spyOn(crypto.subtle, 'digest');
      try {
        const result = await saveTutorialCheckpoint(input, { part: { document, savedBytes: bytes.subarray(1, 4) } }, storage);
        expect(result.ok).toBe(true);
        if (!result.ok) throw new Error(result.reason);
        expect(result.checkpoint.savedSha256).toBe(abc);
        const call = spy.mock.calls.find(([, value]) => ArrayBuffer.isView(value) && value.byteLength === 3);
        expect(call).toBeDefined();
        const value = call?.[1];
        if (value === undefined || !ArrayBuffer.isView(value)) throw new Error('Missing digest byte view');
        expect(value.buffer).toBeInstanceOf(ArrayBuffer);
        expect([value.byteOffset, value.byteLength]).toEqual([buffer instanceof ArrayBuffer ? 1 : 0, 3]);
        if (buffer instanceof ArrayBuffer) expect(value.buffer).toBe(buffer);
        else expect(value.buffer).not.toBe(buffer);
        expect(Array.from(bytes)).toEqual(before);
      } finally { spy.mockRestore(); }
    }
  });
});
