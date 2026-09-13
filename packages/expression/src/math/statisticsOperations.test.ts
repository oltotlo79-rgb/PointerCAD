import { beforeAll, describe, expect, it } from 'vitest';
import { createMathBackend } from './createMathBackend.js';
import { executeMathWorkRequest, type MathExecutionBackend } from './mathWorkExecution.js';
import { decodeMathWorkReply } from './mathWorkReply.js';
import { CANDIDATE_MATH_BY_ID } from './mathOperations.js';
import { rationalOfExpression } from './exactRational.js';

let backend: MathExecutionBackend;
beforeAll(() => { backend = createMathBackend(); });
function evaluate(source: string, presentation = false) {
  const request = { source, angleUnit: 'degree' as const, notation: 'text' as const, coefficients: [],
    ...(presentation ? { presentationNotation: 'latex' as const } : {}),
    identity: { documentId: 'statistics', documentVersion: 1, editorId: 'coordinate', inputRevision: 1 } };
  const output = executeMathWorkRequest({ kind: 'evaluate-math', serial: 1, request }, backend);
  return decodeMathWorkReply(output, request, { operationsById: CANDIDATE_MATH_BY_ID,
    coefficientIds: new Set(), declaredIds: new Set() }).result;
}

describe('統計入力の規約・保存する式・座標への境界', () => {
  it.each([
    ['mean([1,2,6])', 3], ['median([9,1,3])', 3], ['median([9,1,3,5])', 4],
    ['populationvariance([1,2,3])', 2/3], ['samplevariance([1,2,3])', 1],
    ['populationstandarddeviation([1,3])', 1], ['samplestandarddeviation([1,3])', Math.sqrt(2)],
    ['populationcovariance([1,2,3],[2,4,6])', 4/3], ['samplecovariance([1,2,3],[2,4,6])', 2],
    ['correlation([1,2,3],[6,4,2])', -1], ['regressionslope([1,2,3],[3,5,7])', 2],
    ['regressionintercept([1,2,3],[3,5,7])', 1], ['rsquared([1,2,3],[3,5,7])', 1],
    ['quantile([10,0,30,20],0.25)', 7.5], ['quantile([10,0,30,20],0)', 0],
    ['quantile([10,0,30,20],1)', 30], ['quantile([7],0.4)', 7],
    ['populationvariance([4])', 0], ['regressionslope([1,2,3],[5,5,5])', 0],
    ['regressionintercept([1,2,3],[5,5,5])', 5],
    ['2*mean([1,2,3])', 4], ['3*populationvariance([1,2,3])', 2],
    ['2*samplecovariance([1,2,3],[2,4,6])', 4],
  ] as const)('%sを原式と型を保って評価・表示変換する', (source, expected) => {
    const result = evaluate(source, true), value = result.evaluation;
    expect(result.presentation, JSON.stringify(value)).not.toBeNull();
    expect(value).toMatchObject({ status: 'value', kind: 'real' });
    if (value.status !== 'value' || value.kind !== 'real') throw new Error(JSON.stringify(value));
    expect(value.coordinate).toBeCloseTo(expected, 11);
  });
  it('倍精度では同じ数になる大きなオフセットでも標本分散1を厳密に保持する', () => {
    const value = evaluate('samplevariance([100000000000000000001,100000000000000000002,100000000000000000003])').evaluation;
    expect(value).toMatchObject({ status: 'value', kind: 'real', coordinate: 1, approximation: null });
    if (value.status !== 'value' || value.kind !== 'real' || value.exact === null) throw new Error(JSON.stringify(value));
    expect(rationalOfExpression(value.exact)).toEqual({ numerator: 1n, denominator: 1n });
  });
  it('0.1と1/10を同じ観測値として集計し、同数の最頻値を勝手に一つへ絞らない', () => {
    const value = evaluate('modes([0.1,1/10,2,2,3])').evaluation;
    expect(value).toMatchObject({ status: 'value', kind: 'vector' });
    if (value.status !== 'value' || value.kind !== 'vector' || value.expression.kind !== 'operation') throw new Error(JSON.stringify(value));
    expect(value.expression.operands.map(operand => rationalOfExpression(operand))).toEqual([
      { numerator: 1n, denominator: 10n }, { numerator: 2n, denominator: 1n },
    ]);
  });
  it.each([
    'mean([])', 'mean(1)', 'mean([[1,2],[3,4]])', 'mean([true,2])',
    'samplevariance([2])', 'samplecovariance([1],[2])', 'quantile([1,2],-0.1)', 'quantile([1,2],1.1)',
    'correlation([2,2],[1,3])', 'rsquared([1,3],[2,2])', 'regressionslope([2,2],[1,3])',
    'samplecovariance([1,2],[3,4,5])', 'mean([1/0,2])',
  ])('0*%sでも定義できない計算を0へ簡約しない', source => {
    expect(evaluate(`0*${source}`).evaluation).toMatchObject({ status: 'invalid', reason: 'domain' });
  });
  it('一覧の上限256個を超えず平均を計算し、途中の全要素を二次的に複製しない', () => {
    const source = `samplevariance([${Array.from({ length: 256 }, (_, index) => index + 1).join(',')}])`;
    expect(evaluate(source).evaluation).toMatchObject({ status: 'value', kind: 'real', coordinate: 5482.666666666667 });
  });
});
