import { describe, expect, it } from 'vitest';
import { CANDIDATE_MATH_OPERATIONS } from './mathOperations.js';
import { parseMathText } from './mathTextSyntax.js';

const options = { operations: CANDIDATE_MATH_OPERATIONS,
  names: { axes: new Set<never>(), parameters: new Set<never>(), declared: [], coefficients: [] } };

describe('通常入力へ貼り付けた Unicode と LaTeX', () => {
  it.each(['1≤2', '√(4)', 'π', '2×3', 'sum(π*k,k,1,3)'])(
    '%s を通常入力の式として読む', source => {
      expect(parseMathText(source, options)).toBeDefined();
    });

  it('LaTeX の貼付は受け入れず、LaTeX 入力を案内する', () => {
    expect(() => parseMathText(String.raw`\frac{1}{2}`, options))
      .toThrow('この記号は数式パレットまたはLaTeX入力で指定してください');
  });
});
