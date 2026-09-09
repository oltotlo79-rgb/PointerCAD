import { describe, expect, it } from 'vitest';
import { composeExpressionSource } from './combineExpression.js';
import { evaluateExpression } from './evaluateExpression.js';

describe('自動生成した積・商で部分式を保つ', () => {
  it.each([
    { left: '1+1', right: '4', operator: '*' as const, expected: 8 },
    { left: '20+4', right: '2+2', operator: '/' as const, expected: 6 },
    { left: '20', right: '10/2', operator: '/' as const, expected: 4 },
    { left: '10/2', right: '2+2', operator: '*' as const, expected: 20 },
    { left: '-2', right: '3', operator: '*' as const, expected: -6 },
  ])('$left $operator $right の優先順位を保つ', ({ left, right, operator, expected }) => {
    const source = composeExpressionSource(left, right, operator);
    expect(evaluateExpression(source)).toMatchObject({ ok: true, value: { value: expected } });
  });
  it('既存の単一リテラル・名前の保存形を変えない', () => {
    expect(composeExpressionSource('5', '8', '*')).toBe('5*8');
    expect(composeExpressionSource('全長', '4', '/')).toBe('全長/4');
  });
  it('簡約で入力した部分式を消さない', () => {
    expect(composeExpressionSource('1/7', '7', '*')).toBe('(1/7)*7');
    expect(composeExpressionSource('板厚+1', '巻数', '*')).toBe('(板厚+1)*巻数');
  });
});
