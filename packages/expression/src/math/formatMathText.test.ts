import { describe, expect, it } from 'vitest';
import { formatMathText } from './formatMathText.js';
import { parseMathText } from './mathTextSyntax.js';
import { convertMathNotation } from './mathNotationConversion.js';
import { CANDIDATE_MATH_BY_ID, CANDIDATE_MATH_OPERATIONS } from './mathOperations.js';
const options = { operations: CANDIDATE_MATH_OPERATIONS,
  names: { axes: new Set<never>(), parameters: new Set<never>(), declared: [],
    coefficients: [{ role: 'coefficient' as const, id: 'coefficient-log', label: 'log' }] } };
describe('数式のテキスト表示と再解析の意味を照合する', () => {
  it.each([
    '1/3 + 4^2', 'sum(i^2,i,1,10)', 'integrate(sin(X),X,0,180)',
    'coef("log")+log(8,2)', 'rank([[1,2],[2,4]])', 'abs(3+4*i)',
    'limit(sin(X)/X,X,0)', 'forall(x,ℝ,x==x)', 'which(1<2,3,2<1,4)',
    '[1,2,3]', '{1,2,3}', 'interval(open(0),open(1))', 'interval(open(0),1)',
    'interval(0,open(1))', 'interval(0,1)', 'sup(interval(open(0),open(1)))',
  ])('%sの演算・束縛・型・係数を保持する', source => {
    const original = parseMathText(source, options);
    const converted = convertMathNotation(original, node => formatMathText(node, CANDIDATE_MATH_BY_ID), text => parseMathText(text, options));
    expect(converted.source.length).toBeGreaterThan(0);
  });
  it('開いた端点を単独の演算や壊れた値として表示しない', () => {
    const open = { kind: 'operation' as const, operation: 'open-endpoint', operands: [{ kind: 'number' as const, decimal: '0' }] };
    expect(() => formatMathText(open, CANDIDATE_MATH_BY_ID)).toThrow();
    expect(() => formatMathText({ kind: 'operation', operation: 'interval',
      operands: [{ ...open, operands: [] }, { kind: 'number', decimal: '1' }] }, CANDIDATE_MATH_BY_ID)).toThrow();
  });
});
