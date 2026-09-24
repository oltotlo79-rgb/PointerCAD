/** MC-31c: a component/tensor-element selection evaluates every listed value, not only the selected
 * one, so it cannot silently return a value next to one that numeric evaluation proves undefined. */
import { describe, expect, it } from 'vitest';
import { createMathBackend } from './createMathBackend.js';
import { executeMathWorkRequest } from './mathWorkExecution.js';
import { coordinateFromMath } from './mathInputContract.js';
import type { MathWorkRequest } from './mathWorkRequest.js';

const backend = createMathBackend();
function request(source: string): MathWorkRequest {
  return { source, notation: 'text', angleUnit: 'radian', coefficients: [],
    identity: { documentId: 'unselected-element-domain', documentVersion: 1, editorId: 'component', inputRevision: 1 } };
}
function evaluate(source: string) {
  return executeMathWorkRequest({ kind: 'evaluate-math', serial: 1, request: request(source) }, backend).evaluation;
}

describe('成分の選択は選ばれない要素も評価し、有限でない値を理由付きで拒否する', () => {
  it.each([
    // 1/(pi-pi) and 1/(sqrt(2)-sqrt(2)): decimal arithmetic subtracts the identical cached
    // decimal twice and lands on an exact zero, then divides by it (nativeMathNumber.ts's
    // decimalOperation returns the 'ComplexInfinity' sentinel instead of throwing).
    'component([7,1/(pi-pi)],1)',
    'component([7,1/(sqrt(2)-sqrt(2))],1)',
    'tensorelement([7,1/(pi-pi)],[1])',
    'tensorelement([7,1/(sqrt(2)-sqrt(2))],[1])',
    // Nested inside an unselected row of a matrix-shaped literal list (two-level selection).
    'component([[1,2],[3,1/(pi-pi)]],1,1)',
    'tensorelement([[1,2],[3,1/(pi-pi)]],[1,1])',
    // A thrown domain problem from evaluating the sibling itself (not just a sentinel).
    'component([7,1/0],1)',
    'tensorelement([7,1/0],[1])',
  ])('%sは選ばれない要素の非有限を理由に拒否する', source => {
    const result = evaluate(source);
    expect(result, source).toMatchObject({ status: 'invalid', reason: 'domain' });
    if (result.status !== 'invalid') throw new Error(JSON.stringify(result));
    expect(result.detail.length).toBeGreaterThan(0);
  });

  it.each([
    ['component([3,4,5],2)', 4],
    ['component([[1,2],[3,4]],2,1)', 3],
    ['tensorelement([[1,2],[3,4]],[2,1])', 3],
    // sqrt(-1) is a finite complex value (i); it is not selected, so it must not be rejected either.
    ['component([7,sqrt(-1)],1)', 7],
    ['tensorelement([7,sqrt(-1)],[1])', 7],
    // Same case as complexErrorFunctions.test.ts:59: erfc(ln(-1)) evaluates to a finite complex
    // value here too (ln(-1) becomes a complex log), so it must keep returning the selected 1.
    ['component([1,erfc(ln(-1))],1)', 1],
  ] as const)('%sは選ばれない要素が有限なら従来どおり%sを返す', (source, expected) => {
    const result = evaluate(source);
    expect(result, source).toMatchObject({ status: 'value', kind: 'real' });
    if (result.status !== 'value' || result.kind !== 'real') throw new Error(JSON.stringify(result));
    expect(coordinateFromMath(result)).toBeCloseTo(expected, 12);
  });

  it('選ばれない要素の評価は通常式の200msの期限内に収まる(超えれば stopped/budget になり invalid/domain と一致しない)', () => {
    for (const source of ['component([7,1/(pi-pi)],1)', 'tensorelement([7,1/(sqrt(2)-sqrt(2))],[1])']) {
      expect(evaluate(source), source).toMatchObject({ status: 'invalid', reason: 'domain' });
    }
  });
});
