import { describe, expect, it } from 'vitest';
import { createMathLatexCodec } from './mathLatexCodec.js';
import { MATH_INPUT_LIMITS } from './mathInputContract.js';
const codec = createMathLatexCodec();
describe('独自の数式読み取りは値を書き換えず、実行命令を解釈しない', () => {
  it('整数と小数をJavaScriptの数値精度で丸めない', () => {
    expect(codec.parse('9007199254740993')).toEqual({ num: '9007199254740993' });
    expect(codec.parse('0.123456789012345678901234567890123456789')).toEqual({ num: '0.123456789012345678901234567890123456789' });
  });
  it('単項の負号より累乗を先に結び、右結合と括弧を保つ', () => {
    expect(codec.parse('-2^2')).toEqual(['Negate', ['Power', 2, 2]]);
    expect(codec.parse('2^{3^2}')).toEqual(['Power', 2, ['Power', 3, 2]]);
    expect(codec.parse('(-2)^2')).toEqual(['Power', ['Negate', 2], 2]);
  });
  it.each([String.raw`\input{file}`, String.raw`\href{https://example.invalid}{2}`,
    String.raw`\operatorname{Assign}(X,1)`, String.raw`\def\foo{2}\foo`, String.raw`\frac{1}{2}garbage\unknown`])('%sを値として受け入れない', source => {
    expect(() => codec.parse(source)).toThrow();
  });
  it('式の長さ・入れ子と未閉鎖の入力を断る', () => {
    for (const source of ['1+'.repeat(MATH_INPUT_LIMITS.sourceCodeUnits),
      '{'.repeat(MATH_INPUT_LIMITS.depth + 1) + '1' + '}'.repeat(MATH_INPUT_LIMITS.depth + 1),
      String.raw`\frac{1}{2`, String.raw`\begin{pmatrix}1&2\end{bmatrix}`]) {
      expect(() => codec.parse(source)).toThrow();
    }
  });
  it('ローマン体の虚数と総和の添字iを区別する', () => {
    expect(codec.parse(String.raw`\mathrm{i}`)).toBe('ImaginaryUnit');
    expect(codec.parse(String.raw`\sum_{i=1}^{3}{i}`)).toEqual(['Sum', 'i', ['Tuple', 'i', 1, 3]]);
  });
});
