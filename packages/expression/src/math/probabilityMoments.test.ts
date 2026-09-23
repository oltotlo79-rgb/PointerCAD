import { beforeAll, describe, expect, it } from 'vitest';
import { createMathBackend } from './createMathBackend.js';
import { executeMathWorkRequest, type MathExecutionBackend } from './mathWorkExecution.js';
import { createMathWorkEnvelope, type MathWorkRequest } from './mathWorkRequest.js';
import { decodeMathWorkReply } from './mathWorkReply.js';
import { rationalOfExpression, rational } from './exactRational.js';
import { sameMathMeaning } from './mathNotationConversion.js';

let backend: MathExecutionBackend;
beforeAll(() => { backend = createMathBackend(); });
function input(source: string): MathWorkRequest {
  return { source, angleUnit: 'degree', notation: 'text', coefficients: [],
    identity: { documentId: 'moments', documentVersion: 1, editorId: 'coordinate', inputRevision: 1 } };
}
function evaluate(request: MathWorkRequest) {
  return decodeMathWorkReply(executeMathWorkRequest(createMathWorkEnvelope(1, request), backend), request,
    { operationsById: backend.operationsById, coefficientIds: new Set(request.coefficients.map(value => value.id)), declaredIds: new Set() }).result;
}
const cases = [
  ['expectation([1,2,3,4,5,6],[1/6,1/6,1/6,1/6,1/6,1/6])', 7n, 2n],
  ['probabilityvariance([1,2,3,4,5,6],[1/6,1/6,1/6,1/6,1/6,1/6])', 35n, 12n],
  ['expectation([0,4],[1/4,3/4])', 3n, 1n],
  ['probabilityvariance([0,4],[1/4,3/4])', 3n, 1n],
  ['expectation([-100,7],[0,1])', 7n, 1n],
  ['probabilityvariance([-100,7],[0,1])', 0n, 1n],
  ['expectation([1,1,4],[1/8,1/8,3/4])', 13n, 4n],
  ['probabilityvariance([1,1,4],[1/8,1/8,3/4])', 27n, 16n],
  ['expectation([100000000000000000000,100000000000000000002],[1/2,1/2])', 100000000000000000001n, 1n],
  ['probabilityvariance([100000000000000000000,100000000000000000002],[1/2,1/2])', 1n, 1n],
  ['conditionalprobability(1/6,1/2)', 1n, 3n],
  ['conditionalprobability(0,1/2)', 0n, 1n],
  ['conditionalprobability(1/2,1/2)', 1n, 1n],
  ['conditionalprobability(0.1,0.3)', 1n, 3n],
] as const;
function fraction(source: string) {
  const value = evaluate(input(source)).evaluation;
  if (value.status !== 'value' || value.kind !== 'real' || value.exact === null) throw new Error(JSON.stringify(value));
  return rationalOfExpression(value.exact);
}
describe('明示した有限確率表の期待値・分散と条件付き確率', () => {
  it.each(cases)('%sを厳密な分数で計算し保存と表示往復で意味を保つ', (source, numerator, denominator) => {
    const request: MathWorkRequest = { ...input(source), presentationNotation: 'latex' };
    const result = evaluate(request), value = result.evaluation;
    if (value.status !== 'value' || value.kind !== 'real' || value.exact === null || result.definition === null
      || result.presentation === undefined || result.presentation === null) throw new Error(JSON.stringify(result));
    expect(rationalOfExpression(value.exact)).toEqual(rational(numerator, denominator));
    expect(result.definition.source).toBe(source);
    expect(sameMathMeaning(result.definition.expression, result.presentation.expression)).toBe(true);
    const saved: unknown = JSON.parse(JSON.stringify(createMathWorkEnvelope(2, { ...request, definition: result.definition })));
    expect(executeMathWorkRequest(saved, backend).evaluation).toEqual(value);
    const back = evaluate({ ...request, source: result.presentation.source, notation: 'latex', definition: result.presentation, presentationNotation: 'text' });
    expect(back.evaluation).toEqual(value);
    expect(evaluate({ ...request, angleUnit: 'radian' }).evaluation).toEqual(value);
    if (back.presentation === null || back.presentation === undefined) throw new Error(JSON.stringify(back));
    expect(sameMathMeaning(back.presentation.expression, result.definition.expression)).toBe(true);
  });
  it('サイコロ36通りの和を列挙した表の期待値と分散を解析値で照合する', () => {
    const sums = Array.from({ length: 6 }, (_, a) => Array.from({ length: 6 }, (_, b) => a+b+2)).flat();
    const values = `[${sums.join(',')}]`, weights = `[${sums.map(() => '1/36').join(',')}]`;
    expect(fraction(`expectation(${values},${weights})`)).toEqual(rational(7n));
    expect(fraction(`probabilityvariance(${values},${weights})`)).toEqual(rational(35n, 6n));
  });
  it('並べ替えと同じ値の分割で期待値と分散が変わらない', () => {
    for (const op of ['expectation', 'probabilityvariance']) {
      const reference = fraction(`${op}([1,4],[1/4,3/4])`);
      expect(fraction(`${op}([4,1],[3/4,1/4])`)).toEqual(reference);
      expect(fraction(`${op}([1,1,4],[1/8,1/8,3/4])`)).toEqual(reference);
    }
  });
  it('保存した元の式を係数変更で計算し直す', () => {
    const source = 'expectation([0,coef("値")],[1/4,3/4])';
    for (const [decimal, expected] of [['4', 3], ['8', 6]] as const) {
      const result = evaluate({ ...input(source), coefficients: [{ id: 'value', label: '値', decimal }] });
      expect(result.evaluation).toMatchObject({ status: 'value', kind: 'real', coordinate: expected });
      expect(result.definition?.source).toBe(source);
    }
  });
  it.each(['expectation([],[])', 'expectation([1],[1/2])', 'expectation([1,2],[1])',
    'expectation([1,2],[-1,2])', 'probabilityvariance([1,2],[1/3,1/3])',
    'expectation([1,2],[0.5,0.49999999999999999999])', 'expectation([1/0,1],[0,1])',
    'expectation([true],[1])', 'expectation([1],[1/0])',
    'conditionalprobability(0,0)', 'conditionalprobability(1/2,1/3)', 'conditionalprobability(-1/2,1)',
    'conditionalprobability(0,2)', 'conditionalprobability(0,-1)', 'conditionalprobability(i,1)',
    'conditionalprobability(0,1/0)'])('%sの不正を0倍と成分選択で隠さない', source => {
    for (const formula of [source, `0*${source}`, `component([1,${source}],1)`]) {
      expect(evaluate(input(formula)).evaluation).toMatchObject({ status: 'invalid', reason: 'domain' });
    }
  });
  it.each(['sqrt(-1)', 'sqrt(2)', 'pi'])('%sを有理数の値に確定できなければ確率0でも採用しない', value => {
    const source = `probabilityvariance([${value},1],[0,1])`;
    for (const formula of [source, `0*${source}`, `component([1,${source}],1)`]) {
      expect(evaluate(input(formula)).evaluation).toMatchObject({ status: 'invalid', reason: 'unsupported' });
    }
  });
  it('有限確率表の256個上限を越えた入力を途中の値で返さない', () => {
    const source = `expectation([${Array.from({ length: 257 }, () => '1').join(',')}],[${Array.from({ length: 257 }, () => '1/257').join(',')}])`;
    expect(evaluate(input(source)).evaluation).toMatchObject({ status: 'stopped', reason: 'budget' });
  });
});
