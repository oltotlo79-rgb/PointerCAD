import { beforeAll, describe, expect, it } from 'vitest';
import { createMathBackend } from './createMathBackend.js';
import { executeMathWorkRequest, type MathExecutionBackend } from './mathWorkExecution.js';
import { decodeMathEvaluation, decodeMathWorkReply } from './mathWorkReply.js';
import { CANDIDATE_MATH_BY_ID } from './mathOperations.js';
import { mathScalarExpression } from './mathScalarExpression.js';

let backend: MathExecutionBackend;
beforeAll(() => { backend = createMathBackend(); });
const scope = { operationsById: CANDIDATE_MATH_BY_ID, coefficientIds: new Set<string>(), declaredIds: new Set<string>() };
function calculate(source: string, angleUnit: 'degree' | 'radian' = 'radian') {
  const request = { source, angleUnit, notation: 'text' as const, coefficients: [],
    identity: { documentId: 'quadrature', documentVersion: 1, editorId: 'value', inputRevision: 1 } };
  return decodeMathWorkReply(executeMathWorkRequest({ kind: 'evaluate-math', serial: 1, request }, backend), request, scope).result;
}
describe('JITを使わない数値積分を実Worker処理から返す', () => {
  it.each([
    ['integrate(sin(x^2),x,0,1)', '0.3102683017233811018'],
    ['integrate(sin(x^2),x,1,0)', '-0.3102683017233811018'],
    ['integrate(cos(x^2),x,0,1)', '0.9045242379002720815'],
  ] as const)('%sを独立した級数値と照合する', (source, expected) => {
    const result = calculate(source);
    expect(result.evaluation, JSON.stringify(result.evaluation)).toMatchObject({ status: 'value', kind: 'real', exact: null,
      approximation: { absoluteError: null } });
    if (result.evaluation.status !== 'value' || result.evaluation.kind !== 'real') throw new Error(JSON.stringify(result));
    expect(result.evaluation.coordinate).toBeCloseTo(Number(expected), 12);
    expect(result.evaluation.approximation?.estimatedAbsoluteError).toBeGreaterThan(0);
    expect(result.evaluation.approximation?.estimatedAbsoluteError).toBeLessThanOrEqual(1e-10);
    expect(mathScalarExpression(result).ok).toBe(false);
  });

  it('度のsin(x²)をラジアンの積分へ取り違えない', () => {
    // Integrate the convergent sine power series termwise, independently of quadrature nodes.
    const k = Math.PI / 180;
    const expected = k/3 - k**3/(6*7) + k**5/(120*11) - k**7/(5040*15);
    const result = calculate('integrate(sin(x^2),x,0,1)', 'degree');
    if (result.evaluation.status !== 'value' || result.evaluation.kind !== 'real') throw new Error(JSON.stringify(result));
    expect(result.evaluation.coordinate).toBeCloseTo(expected, 13);
  });

  it('極を挟む通常の積分を主値0へ置き換えない', () => {
    const result = calculate('integrate(1/x,x,-1,1)').evaluation;
    expect(['invalid', 'unresolved', 'stopped']).toContain(result.status);
  });

  it('推定誤差を保証した上限やNaNへ改竄したWorker返信を拒否する', () => {
    const evaluation = calculate('integrate(sin(x^2),x,0,1)').evaluation;
    expect(() => decodeMathEvaluation({ ...evaluation, approximation: { absoluteError: 0, estimatedAbsoluteError: 1e-12 } }, scope)).toThrow();
    expect(() => decodeMathEvaluation({ ...evaluation, approximation: { absoluteError: null, estimatedAbsoluteError: NaN } }, scope)).toThrow();
  });

  it.each(['2*integrate(sin(x^2),x,0,1)', '1+integrate(cos(x^2),x,0,1)'])('外側の演算%sで未知誤差の積分を正確な座標へ変えない', source => {
    expect(mathScalarExpression(calculate(source)).ok).toBe(false);
  });
});
