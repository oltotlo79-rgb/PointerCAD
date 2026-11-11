import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { sha256Hex } from './sha256.js';
import { attachmentsDigestOf, canonicalPartDocumentText, contentHashOf, CONTENT_HASH_ALGORITHM } from './assembly/partLibrary.js';
import { canonicalDrawingSourceText, drawingSourceContentHash, drawingSourceInputHash } from './drawing/sourceLibrary.js';
import { createEmptyPartDocument } from './part/createPartDocument.js';
import { sha256ScriptSource } from './scripting/scriptModules.js';

// Published expected bytes, never generated from sha256Hex:
// RFC 8017 §7.1.1 (empty); RFC 6234 §8.5 SHA256 tests 1 and 2 (abc and 56-byte padding boundary).
const vectors = [
  ['', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'],
  ['abc', 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'],
  ['abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq',
    '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1'],
] as const;

describe('internal model SHA-256 byte digest', () => {
  it.each(vectors)('matches the published vector %j without changing bytes', async (source, expected) => {
    const bytes = new TextEncoder().encode(source), before = bytes.slice();
    expect(await sha256Hex(bytes)).toBe(expected);
    expect(bytes).toEqual(before);
    expect(await sha256ScriptSource(source)).toBe(expected);
  });

  it('hashes only the specified Uint8Array/DataView range, including an empty offset view', async () => {
    const buffer = new Uint8Array([255, 97, 98, 99, 254]);
    const before = buffer.slice();
    expect(await sha256Hex(buffer.subarray(1, 4))).toBe(vectors[1][1]);
    expect(await sha256Hex(new DataView(buffer.buffer, 1, 3))).toBe(vectors[1][1]);
    expect(await sha256Hex(buffer.subarray(2, 2))).toBe(vectors[0][1]);
    expect(buffer).toEqual(before);
  });

  it('preserves the existing canonical inputs, attachment domain and UTF-8 handling', async () => {
    const document = { ...createEmptyPartDocument(), name: '部品\uFEFFé😀\uD800' };
    const nodeHash = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');
    expect(CONTENT_HASH_ALGORITHM).toBe('SHA-256');
    expect(await contentHashOf(document)).toBe(nodeHash(canonicalPartDocumentText(document)));
    expect(await drawingSourceContentHash(document)).toBe(nodeHash(canonicalDrawingSourceText(document)));
    expect(await drawingSourceInputHash({ sourceKind: 'part', document }))
      .toBe(nodeHash(canonicalDrawingSourceText(document)));
    // Original empty attachment canonical bytes are exactly the domain, with no entries.
    const attachments = { shapes: new Map<string, Uint8Array>(), meshes: new Map(), canvases: new Map<string, Uint8Array>() };
    expect(await attachmentsDigestOf(attachments)).toBe(nodeHash('PointerCAD-PartAttachments-1'));
    const input = { sourceKind: 'part' as const, document, attachments };
    const originalCanonical = canonicalDrawingSourceText({ document, dependencies: {
      attachments: nodeHash('PointerCAD-PartAttachments-1'),
    } });
    expect(await drawingSourceInputHash(input)).toBe(nodeHash(originalCanonical));
    expect(await sha256ScriptSource(document.name)).toBe(nodeHash(document.name));
  });

  it('preserves the original digest failure object through the helper and consumers', async () => {
    const failure = new Error('digest unavailable');
    const spy = vi.spyOn(crypto.subtle, 'digest').mockRejectedValue(failure);
    try {
      await expect(sha256Hex(new Uint8Array())).rejects.toBe(failure);
      await expect(contentHashOf(createEmptyPartDocument())).rejects.toBe(failure);
      await expect(drawingSourceContentHash(createEmptyPartDocument())).rejects.toBe(failure);
      await expect(sha256ScriptSource('abc')).rejects.toBe(failure);
    } finally { spy.mockRestore(); }
  });
});
