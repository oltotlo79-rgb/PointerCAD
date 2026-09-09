import { describe, expect, it } from 'vitest';
import { decodeDxfString, dxfString } from './dxfDrawingTypes.js';

describe('R12のASCIIと日本語CIF表現', () => {
  it('通常のASCII文字を変えない', () => { expect(dxfString('LINE 20 +0.1')).toBe('LINE 20 +0.1'); });
  it('日本語をUTF16コード単位のCIFへ写す', () => { expect(dxfString('外形')).toBe('\\U+5916\\U+5F62'); });
  it('直径と公差の文字を符号化する', () => { expect(dxfString('φ20±0.1')).toBe('\\U+03C620\\U+00B10.1'); });
  it('引用符や括弧を本文の文字として保つ', () => { expect(dxfString('"A" (B)')).toBe('"A" (B)'); });
  it('DXFの制御指示として解釈されるpercentを符号化する', () => { expect(dxfString('%%d')).toBe('\\U+0025\\U+0025d'); });
  it('元の文字列のCIF風の綴りを文字のまま往復する', () => {
    const literal = '\\U+65E5'; expect(decodeDxfString(dxfString(literal))).toBe(literal);
  });
  it('補助平面の文字もサロゲート対を保つ', () => { expect(decodeDxfString(dxfString('𠮷'))).toBe('𠮷'); });
  it.each(['\n', '\r', '\t', '\u0000', '\u007f'])('制御文字%jを出力に混ぜない', (value) => { expect(() => dxfString(value)).toThrow(); });
  it.each(['\ud800', '\udc00', 'x\udfff', '\ud800x'])('不正なサロゲート%jを拒否する', (value) => { expect(() => dxfString(value)).toThrow(); });
  it('外部のCIF表現を復号する', () => { expect(decodeDxfString('A\\U+5916\\U+5f62')).toBe('A外形'); });
  it('未完のCIF風文字列を勝手に捨てない', () => { expect(decodeDxfString('\\U+GGGG')).toBe('\\U+GGGG'); });
});
