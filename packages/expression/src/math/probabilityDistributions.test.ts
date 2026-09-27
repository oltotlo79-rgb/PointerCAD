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
    identity: { documentId: 'distributions', documentVersion: 1, editorId: 'coordinate', inputRevision: 1 } };
}
function evaluate(request: MathWorkRequest) {
  return decodeMathWorkReply(executeMathWorkRequest(createMathWorkEnvelope(1, request), backend), request,
    { operationsById: backend.operationsById, coefficientIds: new Set(request.coefficients.map(value => value.id)), declaredIds: new Set() }).result;
}
function coordinate(source: string): number {
  const value = evaluate(input(source)).evaluation;
  if (value.status !== 'value' || value.kind !== 'real') throw new Error(JSON.stringify(value));
  return value.coordinate;
}

const cases = [
  ['uniformpdf(2,6,1)', 0], ['uniformpdf(2,6,2)', 0.25], ['uniformpdf(2,6,6)', 0.25], ['uniformpdf(2,6,7)', 0],
  ['uniformcdf(2,6,1)', 0], ['uniformcdf(2,6,2)', 0], ['uniformcdf(2,6,3)', 0.25], ['uniformcdf(2,6,6)', 1],
  ['uniformcdf(2,6,7)', 1], ['uniformquantile(2,6,0)', 2], ['uniformquantile(2,6,1/4)', 3], ['uniformquantile(2,6,1)', 6],
  ['exponentialpdf(2,-1)', 0], ['exponentialpdf(2,0)', 2], ['exponentialpdf(2,1)', 0.2706705664732254],
  ['exponentialcdf(2,-1)', 0], ['exponentialcdf(2,0)', 0], ['exponentialcdf(2,1)', 0.8646647167633873],
  ['exponentialquantile(2,0)', 0], ['exponentialquantile(2,3/4)', 0.6931471805599453],
  ['poissonpmf(2,0)', 0.1353352832366127], ['poissonpmf(2,3)', 0.1804470443154836],
  ['poissoncdf(2,2)', 0.6766764161830635], ['poissoncdf(2,2.9)', 0.6766764161830635],
  ['poissonpmf(2,-1)', 0], ['poissonpmf(2,1/2)', 0], ['poissoncdf(2,-1/2)', 0],
  ['poissonpmf(0,0)', 1], ['poissonpmf(0,1)', 0], ['poissoncdf(0,0)', 1], ['poissoncdf(0,10001)', 1],
] as const;

describe('分布の密度・確率・累積と分位点を明示した条件で計算する', () => {
  it.each(cases)('%sの値・角度非依存・保存と構造入力の意味を保つ', (source, expected) => {
    const request: MathWorkRequest = { ...input(source), presentationNotation: 'latex' };
    const result = evaluate(request), value = result.evaluation;
    if (value.status !== 'value' || value.kind !== 'real' || result.definition === null
      || result.presentation === null || result.presentation === undefined) throw new Error(JSON.stringify(result));
    expect(value.coordinate).toBeCloseTo(expected, 12);
    expect(value.exact).not.toBeNull();
    expect(result.definition.source).toBe(source);
    expect(sameMathMeaning(result.definition.expression, result.presentation.expression)).toBe(true);
    expect(evaluate({ ...request, angleUnit: 'radian' }).evaluation).toEqual(value);
    const saved: unknown = JSON.parse(JSON.stringify(createMathWorkEnvelope(2, { ...request, definition: result.definition })));
    expect(executeMathWorkRequest(saved, backend).evaluation).toEqual(value);
    const back = evaluate({ ...request, source: result.presentation.source, notation: 'latex', definition: result.presentation, presentationNotation: 'text' });
    expect(back.evaluation).toEqual(value);
    if (back.presentation === null || back.presentation === undefined) throw new Error(JSON.stringify(back));
    expect(sameMathMeaning(back.presentation.expression, result.definition.expression)).toBe(true);
  });
  it('一様分布の区間長の比をdoubleで失われる位置でも分数のまま求める', () => {
    const result = evaluate(input('uniformcdf(100000000000000000000,100000000000000000003,100000000000000000001)')).evaluation;
    if (result.status !== 'value' || result.kind !== 'real' || result.exact === null) throw new Error(JSON.stringify(result));
    expect(rationalOfExpression(result.exact)).toEqual(rational(1n, 3n));
  });
  it('ポアソンの隣接確率の比・累積の差を別々の式で照合する', () => {
    for (let k = 1; k <= 12; k += 1) {
      const mass = coordinate(`poissonpmf(3,${k})`);
      expect(mass / coordinate(`poissonpmf(3,${k-1})`)).toBeCloseTo(3/k, 12);
      expect(coordinate(`poissoncdf(3,${k})`) - coordinate(`poissoncdf(3,${k-1})`)).toBeCloseTo(mass, 12);
    }
  });
  it('非常に小さい指数分布の累積を0へ丸めて消さない', () => {
    const value = coordinate('exponentialcdf(2,1e-30)');
    expect(value).toBeGreaterThan(0);
    expect(value / 2e-30).toBeCloseTo(1, 9);
  });
  it('係数の変更で分布条件と保存した原式を再評価する', () => {
    const source = 'uniformquantile(coef("下端"),coef("上端"),1/4)';
    for (const [upper, expected] of [['6', 3], ['10', 4]] as const) {
      const result = evaluate({ ...input(source), coefficients: [{ id: 'lower', label: '下端', decimal: '2' },
        { id: 'upper', label: '上端', decimal: upper }] });
      expect(result.evaluation).toMatchObject({ status: 'value', kind: 'real', coordinate: expected });
      expect(result.definition?.source).toBe(source);
    }
  });
  it.each(['uniformpdf(2,2,-100)', 'uniformcdf(3,2,100)', 'uniformquantile(2,6,-0.1)', 'uniformquantile(2,6,1.1)',
    'exponentialpdf(0,-1)', 'exponentialcdf(-1,-1)', 'exponentialquantile(2,1)', 'exponentialquantile(2,-1)',
    'poissonpmf(-1,-1)', 'poissoncdf(-1,-1)', 'uniformpdf(0,1,true)', 'exponentialpdf(2,[1,2])',
    'poissonpmf(i,0)', 'uniformcdf(0,1,1/0)', 'poissoncdf(2,∞)'])('%sの不正を範囲外や0倍で隠さない', source => {
    for (const formula of [source, `0*${source}`, `component([1,${source}],1)`]) {
      expect(evaluate(input(formula)).evaluation).toMatchObject({ status: 'invalid', reason: 'domain' });
    }
  });
  it.each(['poissonpmf(2,10001)', 'poissoncdf(2,10001)', 'poissonpmf(1e1000,3)'])('%sの資源超過を途中の値で返さない', source => {
    expect(evaluate(input(source)).evaluation).toMatchObject({ status: 'stopped', reason: 'budget' });
  });
});
