import { beforeAll, describe, expect, it } from 'vitest';
import { createMathBackend } from './createMathBackend.js';
import { executeMathWorkRequest, type MathExecutionBackend } from './mathWorkExecution.js';
import { createMathWorkEnvelope, type MathWorkRequest } from './mathWorkRequest.js';
import { decodeMathWorkReply } from './mathWorkReply.js';
import { sameMathMeaning } from './mathNotationConversion.js';
import { normalDistributionDecimal } from './normalDistributionNumeric.js';
import { decimalRational } from './exactRational.js';
import { exact } from './statisticsData.js';
import { MathInputProblem } from './mathInputContract.js';

let backend: MathExecutionBackend;
beforeAll(() => { backend = createMathBackend(); });
function input(source: string): MathWorkRequest {
  return { source, angleUnit: 'degree', notation: 'text', coefficients: [],
    identity: { documentId: 'normal', documentVersion: 1, editorId: 'coordinate', inputRevision: 1 } };
}
function evaluate(request: MathWorkRequest) {
  return decodeMathWorkReply(executeMathWorkRequest(createMathWorkEnvelope(1, request), backend), request,
    { operationsById: backend.operationsById, coefficientIds: new Set(request.coefficients.map(value => value.id)), declaredIds: new Set() }).result;
}
function number(source: string): number {
  const value = evaluate(input(source)).evaluation;
  if (value.status !== 'value' || value.kind !== 'real') throw new Error(source+': '+JSON.stringify(value));
  return value.coordinate;
}
// Independently generated with Python's standard library: math.erfc/exp and NormalDist.inv_cdf.
const reference: readonly (readonly [string, number])[] = [
  [
    "normalcdf(0,1,0)",
    0.5
  ],
  [
    "normalpdf(0,1,0)",
    0.3989422804014327
  ],
  [
    "normalcdf(0,1,-0.1)",
    0.460172162722971
  ],
  [
    "normalpdf(0,1,-0.1)",
    0.3969525474770118
  ],
  [
    "normalcdf(0,1,0.1)",
    0.539827837277029
  ],
  [
    "normalpdf(0,1,0.1)",
    0.3969525474770118
  ],
  [
    "normalcdf(0,1,-1)",
    0.15865525393145707
  ],
  [
    "normalpdf(0,1,-1)",
    0.24197072451914337
  ],
  [
    "normalcdf(0,1,1)",
    0.8413447460685429
  ],
  [
    "normalpdf(0,1,1)",
    0.24197072451914337
  ],
  [
    "normalcdf(0,1,-3.999)",
    3.180534005420206e-05
  ],
  [
    "normalpdf(0,1,-3.999)",
    0.00013436655155540952
  ],
  [
    "normalcdf(0,1,3.999)",
    0.9999681946599458
  ],
  [
    "normalpdf(0,1,3.999)",
    0.00013436655155540952
  ],
  [
    "normalcdf(0,1,-4)",
    3.1671241833119965e-05
  ],
  [
    "normalpdf(0,1,-4)",
    0.00013383022576488537
  ],
  [
    "normalcdf(0,1,4)",
    0.9999683287581669
  ],
  [
    "normalpdf(0,1,4)",
    0.00013383022576488537
  ],
  [
    "normalcdf(0,1,-4.001)",
    3.1537678933520786e-05
  ],
  [
    "normalpdf(0,1,-4.001)",
    0.0001332959074295653
  ],
  [
    "normalcdf(0,1,4.001)",
    0.9999684623210665
  ],
  [
    "normalpdf(0,1,4.001)",
    0.0001332959074295653
  ],
  [
    "normalcdf(0,1,-8)",
    6.220960574271819e-16
  ],
  [
    "normalpdf(0,1,-8)",
    5.052271083536893e-15
  ],
  [
    "normalcdf(0,1,8)",
    0.9999999999999993
  ],
  [
    "normalpdf(0,1,8)",
    5.052271083536893e-15
  ],
  [
    "normalcdf(0,1,-10)",
    7.619853024160595e-24
  ],
  [
    "normalpdf(0,1,-10)",
    7.69459862670642e-23
  ],
  [
    "normalcdf(0,1,-20)",
    2.753624118606332e-89
  ],
  [
    "normalpdf(0,1,-20)",
    5.520948362159764e-88
  ],
  [
    "normalcdf(0,1,-37)",
    5.7255712225251394e-300
  ],
  [
    "normalpdf(0,1,-37)",
    2.120006551524606e-298
  ],
  [
    "normalquantile(0,1,0.1)",
    -1.2815515655446008
  ],
  [
    "normalquantile(0,1,0.25)",
    -0.6744897501960817
  ],
  [
    "normalquantile(0,1,0.75)",
    0.6744897501960817
  ],
  [
    "normalquantile(0,1,0.975)",
    1.9599639845400536
  ],
  [
    "normalquantile(0,1,1e-20)",
    -9.262340089798405
  ],
  [
    "normalquantile(0,1,1e-100)",
    -21.27345356096532
  ],
  [
    "normalquantile(0,1,1e-300)",
    -37.0470962993612
  ]
];

describe('正規分布の密度・累積・分位点を元の条件のまま計算する', () => {
  it.each(reference)('%sを独立な実装の値と相対誤差で照合する', (source, expected) => {
    expect(Math.abs(number(source)/expected-1)).toBeLessThan(4e-13);
  });
  it.each(['normalpdf(3,2,4)', 'normalcdf(3,2,4)', 'normalquantile(3,2,0.975)'])('%sの原式と値を保存・表示往復で保つ', source => {
    const request: MathWorkRequest = { ...input(source), presentationNotation: 'latex' };
    const result = evaluate(request);
    if (result.evaluation.status !== 'value' || result.evaluation.kind !== 'real' || result.definition === null
      || result.presentation === undefined || result.presentation === null) throw new Error(JSON.stringify(result));
    expect(result.definition.source).toBe(source);
    expect(sameMathMeaning(result.definition.expression, result.presentation.expression)).toBe(true);
    const saved: unknown = JSON.parse(JSON.stringify(createMathWorkEnvelope(2, { ...request, definition: result.definition })));
    expect(executeMathWorkRequest(saved, backend).evaluation).toEqual(result.evaluation);
    const back = evaluate({ ...request, source: result.presentation.source, notation: 'latex', definition: result.presentation, presentationNotation: 'text' });
    expect(back.evaluation).toEqual(result.evaluation);
    expect(evaluate({ ...request, angleUnit: 'radian' }).evaluation).toEqual(result.evaluation);
  });
  it('平均・標準偏差の移動と倍率を密度・累積・分位点に反映する', () => {
    expect(number('normalpdf(3,2,5)')).toBeCloseTo(number('normalpdf(0,1,1)')/2, 14);
    expect(number('normalcdf(3,2,5)')).toBe(number('normalcdf(0,1,1)'));
    expect(number('normalquantile(3,2,0.975)')).toBeCloseTo(3+2*1.959963984540054, 13);
    expect(number('normalcdf(100000000000000000000,1,100000000000000000001)')).toBe(number('normalcdf(0,1,1)'));
  });
  it('中央値は厳密に平均、平均位置の累積確率は厳密に1/2になる', () => {
    expect(number('normalcdf(7,2,7)')).toBe(0.5);
    expect(number('normalquantile(7,2,1/2)')).toBe(7);
  });
  it('1に近い確率を先に丸めず、下側と上側の分位点を対称に保つ', () => {
    const lower = number('normalquantile(0,1,1e-100)');
    expect(number('normalquantile(0,1,1-1e-100)')).toBe(-lower);
    expect(number('normalquantile(0,1,1e-1000)')).toBeLessThan(-67);
    expect(number('normalquantile(0,1,1e-1000)')).toBeGreaterThan(-69);
    expect(number('normalquantile(0,1,1-1e-1000)')).toBe(-number('normalquantile(0,1,1e-1000)'));
  });
  it('1/2からの非常に小さい差を消さず、中央の解析的な一次項を満たす', () => {
    const value = number('normalquantile(0,1,1/2+1e-100)');
    expect(Math.abs(value/(Math.sqrt(2*Math.PI)*1e-100)-1)).toBeLessThan(1e-14);
    expect(number('normalquantile(0,1,1/2-1e-100)')).toBe(-value);
  });
  it('標準偏差の係数を再評価し、元の式を保持する', () => {
    const source = 'normalquantile(3,coef("幅"),0.975)';
    for (const decimal of ['1', '2']) {
      const result = evaluate({ ...input(source), coefficients: [{ id: 'width', label: '幅', decimal }] });
      expect(result.evaluation).toMatchObject({ status: 'value', kind: 'real' });
      expect(result.definition?.source).toBe(source);
      if (result.evaluation.status !== 'value' || result.evaluation.kind !== 'real') throw new Error(JSON.stringify(result));
      expect(result.evaluation.coordinate).toBeCloseTo(3+Number(decimal)*1.959963984540054, 13);
    }
  });
  it.each(['normalpdf(0,0,0)', 'normalcdf(0,-1,0)', 'normalquantile(0,0,1/2)',
    'normalquantile(0,1,0)', 'normalquantile(0,1,1)', 'normalquantile(0,1,-1)', 'normalquantile(0,1,2)',
    'normalcdf(1/0,1,0)', 'normalpdf(0,1,1/0)', 'normalcdf(i,1,0)', 'normalpdf(0,true,1)', 'normalcdf(0,1,[1])'])('%sの不正を0倍や成分選択で隠さない', source => {
    for (const formula of [source, `0*${source}`, `component([1,${source}],1)`]) {
      expect(evaluate(input(formula)).evaluation).toMatchObject({ status: 'invalid', reason: 'domain' });
    }
  });
  it.each(['normalcdf(pi,1,0)', 'normalpdf(0,sqrt(2),0)'])('%sの未対応の条件を勝手に丸めない', source => {
    expect(evaluate(input(source)).evaluation).toMatchObject({ status: 'invalid', reason: 'unsupported' });
  });
  it.each(['normalcdf(0,1,-50)', 'normalpdf(0,1,50)'])('%sを座標で表現できなければ0で代用しない', source => {
    expect(evaluate(input(source)).evaluation).toMatchObject({ status: 'invalid', reason: 'non-finite' });
  });
  it('平均との相殺ですべての有効桁が失われた位置を0と断定しない', () => {
    const p = exact(39n, 40n), check = (): void => { /* arithmetic-only reference */ };
    const z = normalDistributionDecimal('normal-quantile', [exact(0n), exact(1n), p], check);
    const mean = decimalRational('-'+z);
    if (mean === null) throw new Error('The computed decimal must be a valid bounded literal');
    expect(() => normalDistributionDecimal('normal-quantile', [mean, exact(1n), p], check)).toThrow('0と確定できません');
    expect(evaluate(input(`normalquantile(-(${z}),1,39/40)`)).evaluation).toMatchObject({ status: 'stopped', reason: 'budget' });
  });
  it('計算域と中止の検査を越えた答えを採用しない', () => {
    expect(evaluate(input('normalcdf(0,1,-1000001)')).evaluation).toMatchObject({ status: 'stopped', reason: 'budget' });
    const stopped = new MathInputProblem('budget', '中止');
    expect(() => normalDistributionDecimal('normal-cdf', [exact(0n), exact(1n), exact(8n)], () => { throw stopped; })).toThrow(stopped);
  });
});
