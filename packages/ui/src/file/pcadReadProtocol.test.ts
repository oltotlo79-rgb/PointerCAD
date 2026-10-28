import { describe, expect, it } from 'vitest';
import { createEmptyPartDocument } from '@pointercad/model';
import { readPcadFile, writePcadFile } from '@pointercad/io';
import { isPcadReadReplyFor, isPcadReadRequest, pcadReadTransferables } from './pcadReadProtocol.js';

describe('read Worker transport ownership', () => {
  it('accepts exactly the three read kinds and owned ArrayBuffer input', () => {
    for (const kind of ['part', 'assembly', 'drawing']) {
      expect(isPcadReadRequest({ id: 'one', kind, bytes: Uint8Array.of(1) })).toBe(true);
    }
    for (const value of [null, {}, { id: '', kind: 'part', bytes: Uint8Array.of(1) },
      { id: 'one', kind: 'template', bytes: Uint8Array.of(1) }, { id: 'one', kind: 'part', bytes: [1] },
      { id: 'one', kind: 'part', bytes: new Uint8Array(new SharedArrayBuffer(1)) }]) {
      expect(isPcadReadRequest(value)).toBe(false);
    }
  });

  it('keeps reader success and every error code without confusing reply kinds', () => {
    const result = readPcadFile(writePcadFile(createEmptyPartDocument()));
    expect(isPcadReadReplyFor({ id: 'one', kind: 'part', result }, 'part')).toBe(true);
    expect(isPcadReadReplyFor({ id: 'one', kind: 'part', result }, 'assembly')).toBe(false);
    for (const code of ['notZip', 'missingDocument', 'invalidJson', 'notPcad', 'unsupportedKind',
      'unsupportedOldVersion', 'unsupportedNewVersion', 'versionMismatch', 'missingField', 'invalidField']) {
      for (const kind of ['part', 'assembly', 'drawing'] as const) {
        expect(isPcadReadReplyFor({ id: 'one', kind, result: { ok: false, error: { code, message: code } } }, kind)).toBe(true);
      }
    }
    expect(isPcadReadReplyFor({ id: 'one', kind: 'part', result: { ok: true, savedAt: '', document: {} } }, 'part')).toBe(false);
    expect(isPcadReadReplyFor({ id: 'one', kind: 'part', result: { ok: false, error: { code: 'unknown', message: '' } } }, 'part')).toBe(false);
  });

  it('transfers each buffer once while preserving shared view offset, length, alias and repeated references', () => {
    const duplicate = new ArrayBuffer(8);
    expect(() => structuredClone(new Uint8Array(duplicate), { transfer: [duplicate, duplicate] })).toThrow();
    expect(duplicate.byteLength).toBe(8);
    const buffer = new ArrayBuffer(48);
    const first = new Uint8Array(buffer, 3, 5), second = new Float32Array(buffer, 16, 3);
    first.set([1, 2, 3, 4, 5]); second.set([1.25, 2.5, 5]);
    const original = { first, again: first, nested: new Map([['second', second]]) };
    const transfer = pcadReadTransferables(original);
    expect(transfer).toEqual([buffer]);
    const copy = structuredClone(original, { transfer });
    expect(buffer.byteLength).toBe(0);
    expect(copy.first.byteOffset).toBe(3); expect(copy.first.byteLength).toBe(5);
    expect(copy.again).toBe(copy.first);
    expect(copy.nested.get('second')?.buffer).toBe(copy.first.buffer);
    expect(copy.nested.get('second')?.byteOffset).toBe(16);
    expect([...copy.first]).toEqual([1, 2, 3, 4, 5]);
    expect([...copy.nested.get('second') ?? []]).toEqual([1.25, 2.5, 5]);
  });

  it('rejects shared memory and unclonable values instead of dropping them', () => {
    for (const value of [new Uint8Array(new SharedArrayBuffer(8)), new SharedArrayBuffer(8),
      { nested: new Map([['callback', () => 1]]) }, Symbol('unsupported')]) {
      expect(() => pcadReadTransferables(value)).toThrow();
    }
  });
});
