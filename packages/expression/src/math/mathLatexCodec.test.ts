import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMathLatexCodec } from './mathLatexCodec.js';
import type { DisplayMathJson } from './mathNotationConversion.js';

afterEach(() => { vi.restoreAllMocks(); });
const number = (value: number): DisplayMathJson => ({ num: String(value) });
const vector = (...values: number[]): DisplayMathJson => ['List', ...values.map(number)];

describe('数学記号の別表記は意味を保ち、表示定義を重複させない', () => {
  it('微分の表示が反復回数と偏微分の順序を省略しない', () => {
    const codec = createMathLatexCodec(), warnings = vi.spyOn(console, 'warn');
    for (const variables of [['X'], ['X', 'X'], ['X', 'Y', 'X']]) {
      const expression: DisplayMathJson = ['D', ['Power', 'X', number(3)], ...variables];
      expect(codec.parse(codec.serialize(expression))).toEqual(['D', ['Power', 'X', 3], ...variables]);
    }
    expect(codec.parse(String.raw`\frac{\mathrm{d}}{\mathrm{d}X}X^2`)).toEqual(['D', ['Power', 'X', 2], 'X']);
    expect(warnings).not.toHaveBeenCalled();
  });
  it.each([
    [String.raw`\operatorname{arccot}\left(1\right)`, ['Arccot', number(1)]],
    [String.raw`\operatorname{arctan2}\left(1,2\right)`, ['Arctan2', number(1), number(2)]],
    [String.raw`\operatorname{tensorproduct}\left(\left[1,2\right],\left[3,4\right]\right)`,
      ['TensorProduct', vector(1, 2), vector(3, 4)]],
    [String.raw`\operatorname{hadamardproduct}\left(\left[1,2\right],\left[3,4\right]\right)`,
      ['HadamardProduct', vector(1, 2), vector(3, 4)]],
  ] satisfies [string, readonly [string, ...DisplayMathJson[]]][])('%sは通常の表示へ変換しても同じ演算と引数を保つ', (source, expected) => {
    const warnings = vi.spyOn(console, 'warn');
    const codec = createMathLatexCodec();
    const parsed = codec.parse(source);
    const canonical = codec.parse(codec.serialize(expected));
    expect(parsed).toEqual(canonical);
    expect(Array.isArray(parsed) ? parsed[0] : null).toBe(expected[0]);
    expect(warnings).not.toHaveBeenCalled();
  });

  it.each([2, 10])('対数の底%sを構造入力の往復で省略しない', base => {
    const warnings = vi.spyOn(console, 'warn');
    const codec = createMathLatexCodec();
    const expression: DisplayMathJson = ['Log', number(100), number(base)];
    expect(codec.parse(codec.serialize(expression))).toEqual(['Log', 100, base]);
    expect(warnings).not.toHaveBeenCalled();
  });

  it('底のないlogを自然対数や常用対数へ読み替えない', () => {
    const codec = createMathLatexCodec();
    expect(() => codec.parse(String.raw`\log\left(100\right)`)).toThrow('底を指定');
  });

  it.each(['Sum', 'Product'])('%sの刻み幅を通常・入れ子・複数範囲の表示往復で保つ', head => {
    const codec = createMathLatexCodec(), warnings = vi.spyOn(console, 'warn');
    const expressions: readonly DisplayMathJson[] = [
      [head, 'k', ['Tuple', 'k', number(1), number(10), number(2)]],
      [head, [head, 'j', ['Tuple', 'j', number(1), 'k', number(2)]], ['Tuple', 'k', number(2), number(8), number(3)]],
      [head, ['Add', 'k', 'j'], ['Tuple', 'k', number(1), number(7), number(3)], ['Tuple', 'j', number(1), 'k']],
    ];
    const expected = [
      [head, 'k', ['Tuple', 'k', 1, 10, 2]],
      [head, [head, 'j', ['Tuple', 'j', 1, 'k', 2]], ['Tuple', 'k', 2, 8, 3]],
      [head, ['Add', 'k', 'j'], ['Tuple', 'k', 1, 7, 3], ['Tuple', 'j', 1, 'k']],
    ];
    expressions.forEach((expression, index) => expect(codec.parse(codec.serialize(expression))).toEqual(expected[index]));
    expect(warnings).not.toHaveBeenCalled();
  });

  it('刻み幅のない総和は従来のΣ表示を使う', () => {
    const codec = createMathLatexCodec();
    const source = codec.serialize(['Sum', 'k', ['Tuple', 'k', number(1), number(3)]]);
    expect(source).toContain(String.raw`\sum`);
    expect(codec.parse(source)).toEqual(['Sum', 'k', ['Tuple', 'k', 1, 3]]);
  });

  it('刻み付き表示の不足した範囲を推測して補わない', () => {
    const codec = createMathLatexCodec();
    expect(() => codec.parse(String.raw`\operatorname{sumstep}\left(k,\left(k,1\right)\right)`)).toThrow('範囲');
  });
});
