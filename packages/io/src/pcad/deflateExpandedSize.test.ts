import { describe, expect, it } from 'vitest';
import { deflateSync, inflateSync, strToU8 } from 'fflate';
import { DeflateSizeError, deflateExpandedSize } from './deflateExpandedSize.js';
import { zipCrc32 } from './zipCrc32.js';

describe('確保前のDEFLATE長検査', () => {
  it('空・短文・反復・非圧縮で実fflateと長さが一致する', () => {
    const samples = [new Uint8Array(), strToU8('PointerCAD 図面'), new Uint8Array(100000).fill(65),
      Uint8Array.from({ length: 8192 }, (_, i) => (i * 37 + Math.floor(i / 17)) & 255)];
    for (const input of samples) for (const level of [0, 1, 6, 9] as const) {
      const compressed = deflateSync(input, { level });
      expect(deflateExpandedSize(compressed, input.length)).toBe(input.length);
      expect(inflateSync(compressed)).toEqual(input);
    }
  });
  it('200万バイトの出力を作らず1024バイトの予算で中止する', () => {
    const compressed = deflateSync(new Uint8Array(2000000).fill(65));
    expect(compressed.length).toBeLessThan(4096);
    try { deflateExpandedSize(compressed, 1024); throw new Error('受理してはいけません'); }
    catch (error) { expect(error).toBeInstanceOf(DeflateSizeError); expect(error).toMatchObject({ kind: 'expandedLimit' }); }
  });
  it('予算ちょうどを許し1バイト不足を断る', () => {
    const compressed = deflateSync(strToU8('123456789'));
    expect(deflateExpandedSize(compressed, 9)).toBe(9);
    expect(() => deflateExpandedSize(compressed, 8)).toThrow('expandedLimit');
  });
  it('全ての途中切断と末尾の余剰バイトを断る', () => {
    const compressed = deflateSync(strToU8('PointerCADの保存'.repeat(100)));
    for (let end = 0; end < compressed.length; end++) expect(() => deflateExpandedSize(compressed.subarray(0, end), 100000)).toThrow();
    const extra = new Uint8Array(compressed.length + 1); extra.set(compressed);
    expect(() => deflateExpandedSize(extra, 100000)).toThrow('invalidDeflate');
  });
  it('予約ブロック、壊れたLEN/NLEN、安全でない予算を断る', () => {
    expect(() => deflateExpandedSize(Uint8Array.of(7), 100)).toThrow('invalidDeflate');
    expect(() => deflateExpandedSize(Uint8Array.of(1, 1, 0, 0, 0, 65), 100)).toThrow('invalidDeflate');
    for (const maximum of [-1, NaN, Infinity, 1.1, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => deflateExpandedSize(Uint8Array.of(3, 0), maximum)).toThrow('expandedLimit');
    }
  });
  it('keeps zero-padded Huffman lookahead inside the actual view boundary', () => {
    // Fixed Huffman: final empty block and final literal A followed by end-of-block.
    for (const compressed of [Uint8Array.of(3, 0), Uint8Array.of(0x73, 4, 0)]) {
      const length = compressed.length === 2 ? 0 : 1;
      const backing = new Uint8Array(compressed.length + 8).fill(255);
      backing.set(compressed, 3);
      const view = backing.subarray(3, 3 + compressed.length);
      expect(deflateExpandedSize(view, length)).toBe(length);
      expect(inflateSync(view).length).toBe(length);
      // The hidden backing bytes must not satisfy a truncated Huffman symbol.
      expect(() => deflateExpandedSize(view.subarray(0, view.length - 1), length)).toThrow('invalidDeflate');
    }
  });
  it('counts stored and Huffman literals against one exact output budget', () => {
    // Non-final stored A, then final fixed-Huffman A: the second block has prior output.
    const compressed = Uint8Array.of(0, 1, 0, 0xfe, 0xff, 65, 0x73, 4, 0);
    expect(inflateSync(compressed)).toEqual(Uint8Array.of(65, 65));
    expect(deflateExpandedSize(compressed, 2)).toBe(2);
    expect(() => deflateExpandedSize(compressed, 1)).toThrow('expandedLimit');
  });
  it('synchronizes a fixed block cursor before the next stored block', () => {
    // Non-final fixed A + EOB (18 bits), final stored header + alignment, then stored B.
    const compressed = Uint8Array.of(0x72, 0x04, 0x04, 1, 0, 0xfe, 0xff, 66);
    const expected = Uint8Array.of(65, 66), backing = new Uint8Array(compressed.length + 11).fill(255);
    backing.set(compressed, 5);
    for (const view of [compressed, backing.subarray(5, 5 + compressed.length)]) {
      expect(inflateSync(view)).toEqual(expected);
      expect(deflateExpandedSize(view, expected.length)).toBe(2);
      expect(() => deflateExpandedSize(view, 1)).toThrow('expandedLimit');
      for (let end = 0; end < view.length; end++) expect(() => deflateExpandedSize(view.subarray(0, end), 2)).toThrow('invalidDeflate');
    }
  });
  it('synchronizes literal, length/distance and literal cursors without reading outside a view', () => {
    // Final fixed block: literal A, length 4/distance 1, literal B, EOB => AAAAAB.
    const compressed = Uint8Array.of(0x73, 0x04, 0x01, 0x27, 0), expected = Uint8Array.of(65, 65, 65, 65, 65, 66);
    const backing = new Uint8Array(compressed.length + 13).fill(255); backing.set(compressed, 7);
    for (const view of [compressed, backing.subarray(7, 7 + compressed.length)]) {
      expect(inflateSync(view)).toEqual(expected);
      expect(deflateExpandedSize(view, expected.length)).toBe(6);
      expect(() => deflateExpandedSize(view, 5)).toThrow('expandedLimit');
      for (let end = 0; end < view.length; end++) expect(() => deflateExpandedSize(view.subarray(0, end), 6)).toThrow('invalidDeflate');
    }
    expect(() => deflateExpandedSize(Uint8Array.of(...compressed, 0), 6)).toThrow('invalidDeflate');
  });
  it('CRC32の既知値、空、1バイト違いを確認する', () => {
    expect(zipCrc32(strToU8('123456789'))).toBe(0xcbf43926);
    expect(zipCrc32(new Uint8Array())).toBe(0);
    expect(zipCrc32(strToU8('{"length":20}'))).not.toBe(zipCrc32(strToU8('{"length":90}')));
  });
  it('refills lookahead across mixed 8/9-bit literals without borrowing hidden view bytes', () => {
    // RFC1951 fixed codes (0..143: 00110000..10111111; 144..255: 110010000..111111111), then EOB.
    const compressed = Uint8Array.of(0x63, 0xe8, 0x9f, 0xf0, 0xdf, 0xd1, 0x89, 0xe1, 0xff, 0x84, 0x7e, 0xc6, 0x7f, 0xf5, 0x0d, 0x27, 0x78, 0x01);
    const expected = Uint8Array.of(0, 143, 144, 255, 65, 66, 0, 255, 144, 143, 1, 254, 127, 128, 200, 13);
    const backing = new Uint8Array(compressed.length + 11).fill(255); backing.set(compressed, 5);
    for (const view of [compressed, backing.subarray(5, 5 + compressed.length)]) {
      expect(inflateSync(view)).toEqual(expected);
      expect(deflateExpandedSize(view, expected.length)).toBe(16);
      for (let budget = 0; budget < expected.length; budget++) expect(() => deflateExpandedSize(view, budget)).toThrow('expandedLimit');
      for (let end = 0; end < view.length; end++) expect(() => deflateExpandedSize(view.subarray(0, end), 16)).toThrow('invalidDeflate');
    }
    expect(() => deflateExpandedSize(Uint8Array.of(...compressed, 0), 16)).toThrow('invalidDeflate');
  });
  it('rejects a distance before any output even with buffered lookahead', () => {
    // Final fixed block, length symbol 257 (0000001), distance symbol 0, EOB: no prior literal.
    expect(() => deflateExpandedSize(Uint8Array.of(0x03, 0x02, 0), 3)).toThrow('invalidDeflate');
  });
});
