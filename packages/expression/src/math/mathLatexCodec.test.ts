import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMathLatexCodec } from './mathLatexCodec.js';
import type { DisplayMathJson } from './mathNotationConversion.js';

afterEach(() => { vi.restoreAllMocks(); });
const number = (value: number): DisplayMathJson => ({ num: String(value) });
const vector = (...values: number[]): DisplayMathJson => ['List', ...values.map(number)];

describe('数学記号の別表記は意味を保ち、表示定義を重複させない', () => {
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
});
