import { beforeAll, describe, expect, it } from 'vitest';
import { createMathBackend } from './createMathBackend.js';
import { executeMathWorkRequest, type MathExecutionBackend } from './mathWorkExecution.js';
import { decodeMathWorkReply } from './mathWorkReply.js';
import { CANDIDATE_MATH_BY_ID } from './mathOperations.js';

let backend: MathExecutionBackend;
beforeAll(() => { backend = createMathBackend(); });
function evaluate(source: string, angleUnit: 'degree' | 'radian' = 'degree') {
  const request = { source, angleUnit, notation: 'text' as const, coefficients: [],
    identity: { documentId: 'elementary', documentVersion: 1, editorId: 'coordinate', inputRevision: 1 } };
  const output = executeMathWorkRequest({ kind: 'evaluate-math', serial: 1, request }, backend);
  return decodeMathWorkReply(output, request, { operationsById: CANDIDATE_MATH_BY_ID,
    coefficientIds: new Set(), declaredIds: new Set() }).result.evaluation;
}

describe('初等数学を同じ定義域と角度規約で座標へ渡す', () => {
  it.each(['permutations(5,3)', 'component([[1,2],[3,4]],2,1)', 'atan2(1,-1)',
    'arccot(-1)', 'coth(ln(3))', 'acsch(1)', 'clamp(8,1,5)', 'reciprocal(4)', 're(cis(60))'])('%sを構造入力へ変換しても意味が同じ', source => {
    const request = { source, angleUnit: 'degree' as const, notation: 'text' as const, coefficients: [], presentationNotation: 'latex' as const,
      identity: { documentId: 'elementary', documentVersion: 1, editorId: 'conversion', inputRevision: 1 } };
    const output = executeMathWorkRequest({ kind: 'evaluate-math', serial: 1, request }, backend);
    const result = decodeMathWorkReply(output, request, { operationsById: CANDIDATE_MATH_BY_ID,
      coefficientIds: new Set(), declaredIds: new Set() }).result;
    expect(result.presentation, JSON.stringify(result.evaluation)).not.toBeNull();
    expect(result.evaluation).toMatchObject({ status: 'value', kind: 'real' });
  });
  it.each([
    ['(-1)!!', 1], ['permutations(5,3)', 60], ['permutations(5,0)', 1], ['reciprocal(4)', 0.25],
    ['clamp(8,1,5)', 5], ['clamp(-3,1,5)', 1], ['clamp(3,1,5)', 3],
    ['arccot(-1)', 135], ['arcsec(2)', 60], ['arccsc(2)', 30],
    ['atan2(1,-1)', 135], ['atan2(-1,-1)', -135], ['atan2(1,0)', 90],
    ['arg(1+i)', 45], ['re(cis(60))', 0.5], ['im(cis(30))', 0.5],
    ['sech(0)', 1], ['coth(ln(3))', 1.25], ['csch(ln(3))', 0.75],
    ['acoth(2)', Math.log(3)/2], ['asech(1)', 0], ['acsch(1)', Math.log(1+Math.sqrt(2))],
    ['component([3,4,5],2)', 4], ['component([[1,2],[3,4]],2,1)', 3],
    ['acoth(2)×2', Math.log(3)], ['asech(1)×2', 0], ['acsch(1)×2', 2*Math.log(1+Math.sqrt(2))],
    ['reciprocal(4)×2', 0.5], ['clamp(8,1,5)×2', 10], ['permutations(5,3)×2', 120],
  ] as const)('%s', (source, expected) => {
    const result = evaluate(source);
    expect(result, JSON.stringify(result)).toMatchObject({ status: 'value', kind: 'real' });
    if (result.status !== 'value' || result.kind !== 'real') throw new Error(JSON.stringify(result));
    expect(result.coordinate).toBeCloseTo(expected, 11);
  });
  it.each([
    '0*tan(90)', '0*sec(-90)', '0*cot(180)', '0*csc(0)', '0*ln(0)', '0*log(5,1)', '0*log(5,0)',
    '0*atan2(0,0)', '0*arg(0)', '0*arcsec(0)', '0*coth(0)', '0*csch(0)', '0*acsch(0)',
    '0*reciprocal(0)', 'clamp(2,5,1)', 'permutations(3,4)', 'permutations(3.5,2)',
    'component([1,2],0)', 'component([1,2],3)', 'component([[1,2]],1,3)',
    'reciprocal(0)×0', 'permutations(3,4)×0', 'acsch(0)×0',
  ])('%sを0へ簡約せず拒否する', source => {
    expect(evaluate(source)).toMatchObject({ status: 'invalid', reason: 'domain' });
  });
  it.each(['0*tan(pi/2)', '0*sec(-3*pi/2)', '0*cot(2*pi)', '0*csc(pi+pi)'])('%sのπ倍数を丸めず判定する', source => {
    expect(evaluate(source, 'radian')).toMatchObject({ status: 'invalid', reason: 'domain' });
  });
  it('ラジアンの逆正接・偏角を度へ誤変換しない', () => {
    for (const source of ['atan2(1,1)', 'arg(1+i)', 'arccot(1)']) {
      const result = evaluate(source, 'radian');
      if (result.status !== 'value' || result.kind !== 'real') throw new Error(JSON.stringify(result));
      expect(result.coordinate).toBeCloseTo(Math.PI/4, 12);
    }
  });
});
