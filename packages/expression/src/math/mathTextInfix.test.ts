import { describe, expect, it } from 'vitest';
import { formatMathText } from './formatMathText.js';
import { parseMathText } from './mathTextSyntax.js';
import { convertMathNotation, sameMathMeaning } from './mathNotationConversion.js';
import { CANDIDATE_MATH_BY_ID, CANDIDATE_MATH_OPERATIONS } from './mathOperations.js';
import { renameMathDeclaration } from './mathExpressionReferences.js';
import type { MathNode } from './mathInputContract.js';

const declared = (label: string) => [{ role: 'declared' as const, id: 'decl-1', label }];
const optionsFor = (label: string) => ({ operations: CANDIDATE_MATH_OPERATIONS,
  names: { axes: new Set<never>(), parameters: new Set<never>(), declared: declared(label), coefficients: [] } });
const infixText = (node: MathNode): string => formatMathText(node, CANDIDATE_MATH_BY_ID, { infix: true });

describe('C-02k: 名前の変更後の式の文字を利用者の書き方で作る', () => {
  it('既定の書き方は変わらない(中置にしない)', () => {
    const node = parseMathText('sum(i^2,i,1,3)+k', optionsFor('k'));
    expect(formatMathText(node, CANDIDATE_MATH_BY_ID)).toMatch(/^Add\(sum\(/u);
  });

  it.each([
    ['sum(i^2,i,1,3)+k', 'sum(i^2,i,1,3)+k'],
    ['k+k*2', 'k+k*2'],
    ['(k+1)*(k-1)', '(k+1)*(k-1)'],
    ['k-(k-1)', 'k-(k-1)'],
    ['k/(k+1)', 'k/(k+1)'],
    ['(k^2)^3', '(k^2)^3'],
    ['k^2^3', 'k^2^3'],
    ['-(k+1)', '-(k+1)'],
    ['2*sqrt(k)', '2*Sqrt(k)'],
    ['k+k+k', 'k+k+k'],
    ['k*k*k', 'k*k*k'],
    ['k-k-k', 'k-k-k'],
    ['k/k/k', 'k/k/k'],
    ['k/(k/k)', 'k/(k/k)'],
    ['k+(k+k)', 'k+(k+k)'],
    ['2^(-1)', '2^(-1)'],
    ['-k^2', '-k^2'],
    ['(-k)^2', '(-k)^2'],
    ['3*(-2)', '3*(-2)'],
    ['(k+1)^(k-1)', '(k+1)^(k-1)'],
  ])('%s は %s と書かれ、読み直しても同じ意味になる', (source, expected) => {
    const node = parseMathText(source, optionsFor('k'));
    const text = infixText(node);
    expect(text).toBe(expected);
    expect(sameMathMeaning(node, parseMathText(text, optionsFor('k')))).toBe(true);
  });

  it('3 つ以上の項が 1 つの演算に入った木(文字から読むと二項の入れ子になるので普通は出ない形)は、今までの書き方のまま意味が変わらない', () => {
    const k = parseMathText('k', optionsFor('k'));
    const node: MathNode = { kind: 'operation', operation: 'add', operands: [k, k, k] };
    const text = infixText(node);
    expect(text).toMatch(/^Add\(/u);
    expect(sameMathMeaning(node, parseMathText(text, optionsFor('k')))).toBe(true);
  });

  it('記号の名前を変えると、式の文字に内部の書き方(Add(…))が出ず、変える前後で式の意味(構造)が一致する', () => {
    const source = 'sum(i^2,i,1,3)+k';
    const before = parseMathText(source, optionsFor('k'));
    const definition = { format: 'pointercad-math' as never, source, inputNotation: 'text' as const, angleUnit: 'radian' as never,
      expression: before, declarations: [{ id: 'decl-1', label: 'k', meaning: '値が未指定の数', type: 'real' }] } as never;
    const renamed = renameMathDeclaration(definition, 'decl-1', 'a_1', {
      format: node => infixText(node),
      parse: text => parseMathText(text, optionsFor('a_1')),
    });
    expect(renamed.source).toBe('sum(i^2,i,1,3)+a_1');
    expect(renamed.source).not.toContain('Add(');
    const original = convertMathNotation(before, node => infixText(node), text => parseMathText(text, optionsFor('k')));
    expect(original.source).toBe(source);
  });
});
