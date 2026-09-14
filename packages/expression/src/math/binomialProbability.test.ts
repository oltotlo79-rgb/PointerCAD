import { beforeAll, describe, expect, it } from 'vitest';
import { createMathBackend } from './createMathBackend.js';
import { executeMathWorkRequest, type MathExecutionBackend } from './mathWorkExecution.js';
import { decodeMathWorkReply } from './mathWorkReply.js';
import { CANDIDATE_MATH_BY_ID } from './mathOperations.js';
import { rationalOfExpression, rational } from './exactRational.js';

let backend: MathExecutionBackend;
beforeAll(() => { backend = createMathBackend(); });
function evaluate(source: string, presentation = false) {
  const request = { source, angleUnit: 'degree' as const, notation: 'text' as const, coefficients: [],
    ...(presentation ? { presentationNotation: 'latex' as const } : {}),
    identity: { documentId: 'binomial', documentVersion: 1, editorId: 'coordinate', inputRevision: 1 } };
  return decodeMathWorkReply(executeMathWorkRequest({ kind: 'evaluate-math', serial: 1, request }, backend), request,
    { operationsById: CANDIDATE_MATH_BY_ID, coefficientIds: new Set(), declaredIds: new Set() }).result;
}
function expectFraction(source: string, numerator: bigint, denominator = 1n) {
  const result = evaluate(source, true), value = result.evaluation;
  expect(result.presentation, JSON.stringify(value)).not.toBeNull();
  expect(value).toMatchObject({ status: 'value', kind: 'real' });
  if (value.status !== 'value' || value.kind !== 'real' || value.exact === null) throw new Error(JSON.stringify(value));
  expect(rationalOfExpression(value.exact)).toEqual(rational(numerator, denominator));
}

describe('二項分布の確率と累積確率を原式と分数のまま扱う', () => {
  it('4回の公平な試行16通りを全て数え、各確率と累積確率を独立に照合する', () => {
    const counts = [0, 0, 0, 0, 0];
    for (let pattern = 0; pattern < 16; pattern += 1) {
      counts[pattern.toString(2).replaceAll('0', '').length] += 1;
    }
    let total = 0n;
    for (const [k, count] of counts.entries()) {
      total += BigInt(count);
      expectFraction(`binomialpmf(4,1/2,${k})`, BigInt(count), 16n);
      expectFraction(`binomialcdf(4,1/2,${k})`, total, 16n);
    }
  });
  it.each([
    ['binomialpmf(3,1/3,0)', 8n, 27n], ['binomialpmf(3,1/3,1)', 12n, 27n],
    ['binomialpmf(3,1/3,2)', 6n, 27n], ['binomialpmf(3,1/3,3)', 1n, 27n],
    ['binomialcdf(3,1/3,2)', 26n, 27n], ['binomialpmf(10,0.1,2)', 387420489n, 2000000000n],
    ['binomialcdf(4,0.5,2.9)', 11n, 16n], ['binomialpmf(4,1/2,1/2)', 0n, 1n],
    ['binomialpmf(4,1/2,-1)', 0n, 1n], ['binomialcdf(4,1/2,-1/2)', 0n, 1n],
    ['binomialpmf(4,1/2,5)', 0n, 1n], ['binomialcdf(4,1/2,5)', 1n, 1n],
    ['binomialpmf(0,1/3,0)', 1n, 1n], ['binomialcdf(0,1/3,0)', 1n, 1n],
    ['binomialpmf(10001,0,0)', 1n, 1n], ['binomialpmf(10001,0,1)', 0n, 1n],
    ['binomialcdf(10001,0,1/2)', 1n, 1n], ['binomialcdf(10001,1,10000)', 0n, 1n],
    ['binomialpmf(10001,1,10001)', 1n, 1n], ['binomialcdf(10001,1,10001)', 1n, 1n],
  ] as const)('%sを範囲と端点の規約どおりに計算する', (source, numerator, denominator) => {
    expectFraction(source, numerator, denominator);
  });
  it.each(['binomialpmf(-1,1/2,-1)', 'binomialcdf(1/2,1/2,3)', 'binomialpmf(4,-0.1,-1)',
    'binomialcdf(4,1.1,5)', 'binomialpmf(4,true,1)', 'binomialcdf(4,1/2,[1,2])',
    'binomialpmf(4,1/0,1)', 'binomialpmf(4,1/2,i)'])('0*%sでも不正な条件を0へ簡約しない', source => {
    expect(evaluate(`0*${source}`).evaluation).toMatchObject({ status: 'invalid', reason: 'domain' });
  });
  it.each(['binomialpmf(10001,1/2,1)', 'binomialcdf(10001,1/2,9999)',
    'binomialpmf(3,1e-1000,1)'])('%sの計算量や桁数の超過を近似値で隠さない', source => {
    expect(evaluate(source).evaluation).toMatchObject({ status: 'stopped', reason: 'budget' });
  });
});
