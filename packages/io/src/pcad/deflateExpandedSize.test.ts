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
  it('CRC32の既知値、空、1バイト違いを確認する', () => {
    expect(zipCrc32(strToU8('123456789'))).toBe(0xcbf43926);
    expect(zipCrc32(new Uint8Array())).toBe(0);
    expect(zipCrc32(strToU8('{"length":20}'))).not.toBe(zipCrc32(strToU8('{"length":90}')));
  });
});
