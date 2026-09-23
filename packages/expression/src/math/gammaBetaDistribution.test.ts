import { beforeAll, describe, expect, it } from 'vitest';
import { createMathBackend } from './createMathBackend.js';
import { executeMathWorkRequest, type MathExecutionBackend } from './mathWorkExecution.js';
import { createMathWorkEnvelope, type MathWorkRequest } from './mathWorkRequest.js';
import { decodeMathWorkReply } from './mathWorkReply.js';
import { sameMathMeaning } from './mathNotationConversion.js';
import { gammaBetaDistributionDecimal } from './gammaBetaDistributionNumeric.js';
import { exact } from './statisticsData.js';
import { MathInputProblem } from './mathInputContract.js';

let backend: MathExecutionBackend;
beforeAll(() => { backend = createMathBackend(); });
function input(source: string): MathWorkRequest {
  return { source, angleUnit: 'degree', notation: 'text', coefficients: [],
    identity: { documentId: 'gamma-beta', documentVersion: 1, editorId: 'coordinate', inputRevision: 1 } };
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
const reference: readonly (readonly [string, number])[] = [
  [
    "gammapdf(0.35,2.4,0.001)",
    25.755005059160133
  ],
  [
    "gammacdf(0.35,2.4,0.001)",
    0.07360844441251876
  ],
  [
    "gammapdf(0.35,2.4,2)",
    0.08006837787671592
  ],
  [
    "gammacdf(0.35,2.4,2)",
    0.8706528603640818
  ],
  [
    "gammapdf(0.35,2.4,20)",
    9.914079927013652e-06
  ],
  [
    "gammacdf(0.35,2.4,20)",
    0.9999777778110801
  ],
  [
    "gammapdf(2.75,0.3,0.2)",
    0.5233669328634852
  ],
  [
    "gammacdf(2.75,0.3,0.2)",
    0.045901535283490474
  ],
  [
    "gammapdf(2.75,0.3,3)",
    0.005291159077421262
  ],
  [
    "gammacdf(2.75,0.3,3)",
    0.9981144994717062
  ],
  [
    "gammapdf(10,2,20)",
    0.06255501786056665
  ],
  [
    "gammacdf(10,2,20)",
    0.5420702855281478
  ],
  [
    "gammapdf(100,0.5,55)",
    0.045342886360846726
  ],
  [
    "gammacdf(100,0.5,55)",
    0.8417213299399129
  ],
  [
    "gammaquantile(0.35,2.4,0.025)",
    4.569907742343712e-05
  ],
  [
    "gammaquantile(0.35,2.4,0.975)",
    4.963998990879606
  ],
  [
    "gammaquantile(2.75,0.3,0.5)",
    0.7274435110063275
  ],
  [
    "gammaquantile(10,2,0.9)",
    28.411980584305635
  ],
  [
    "betapdf(0.35,0.7,0.001)",
    26.25980741994093
  ],
  [
    "betacdf(0.35,0.7,0.001)",
    0.0750113408520786
  ],
  [
    "betapdf(0.35,0.7,0.75)",
    0.5382565946724717
  ],
  [
    "betacdf(0.35,0.7,0.75)",
    0.8282237564336742
  ],
  [
    "betapdf(0.35,0.7,0.999)",
    2.34122749590815
  ],
  [
    "betacdf(0.35,0.7,0.999)",
    0.9966566686108965
  ],
  [
    "betapdf(2.75,1.3,0.2)",
    0.24768913818757607
  ],
  [
    "betacdf(2.75,1.3,0.2)",
    0.018361650619820022
  ],
  [
    "betapdf(2.75,1.3,0.9)",
    1.8454482238256742
  ],
  [
    "betacdf(2.75,1.3,0.9)",
    0.8457400484079809
  ],
  [
    "betapdf(100,70,0.6)",
    10.142280388710102
  ],
  [
    "betacdf(100,70,0.6)",
    0.6190461871260963
  ],
  [
    "betapdf(1.5,200,0.01)",
    43.27297215521364
  ],
  [
    "betacdf(1.5,200,0.01)",
    0.741238848306005
  ],
  [
    "betaquantile(0.35,0.7,0.025)",
    4.332126813454669e-05
  ],
  [
    "betaquantile(0.35,0.7,0.975)",
    0.982402403964964
  ],
  [
    "betaquantile(2.75,1.3,0.5)",
    0.710593504834164
  ],
  [
    "betaquantile(100,70,0.9)",
    0.636333669332222
  ]
];


describe('Gamma・Beta分布の密度・累積・分位点を原式と条件のまま利用する', () => {
  it.each(reference)('%sを独立な90桁計算と相対誤差で照合する', (source, expected) => {
    expect(Math.abs(number(source)/expected-1)).toBeLessThan(4e-13);
  });
  it.each(['gammapdf(2.75,0.3,0.2)', 'gammacdf(2.75,0.3,0.2)', 'gammaquantile(2.75,0.3,0.5)',
    'betapdf(0.35,0.7,0.75)', 'betacdf(0.35,0.7,0.75)', 'betaquantile(0.35,0.7,0.025)'])('%sを表示・保存往復しても条件を保つ', source => {
    const request: MathWorkRequest = { ...input(source), presentationNotation: 'latex' }, result = evaluate(request);
    if (result.evaluation.status !== 'value' || result.evaluation.kind !== 'real' || result.definition === null
      || result.presentation === undefined || result.presentation === null) throw new Error(JSON.stringify(result));
    expect(result.definition.source).toBe(source);
    expect(sameMathMeaning(result.definition.expression, result.presentation.expression)).toBe(true);
    const saved: unknown = JSON.parse(JSON.stringify(createMathWorkEnvelope(2, { ...request, definition: result.definition })));
    expect(executeMathWorkRequest(saved, backend).evaluation).toEqual(result.evaluation);
    expect(evaluate({ ...request, source: result.presentation.source, notation: 'latex', definition: result.presentation, presentationNotation: 'text' }).evaluation).toEqual(result.evaluation);
    expect(evaluate({ ...request, angleUnit: 'radian' }).evaluation).toEqual(result.evaluation);
  });
  it('Gamma形状1を指数分布の独立な閉形式で照合し、尺度を率と取り違えない', () => {
    for (const x of [0.001, 0.5, 2, 10]) {
      expect(number(`gammapdf(1,2,${x})`)).toBeCloseTo(Math.exp(-x/2)/2, 14);
      expect(number(`gammacdf(1,2,${x})`)).toBeCloseTo(-Math.expm1(-x/2), 14);
    }
    expect(number('gammaquantile(1,2,0.975)')).toBeCloseTo(-2*Math.log(0.025), 13);
    expect(number('gammaquantile(1,2,1-1e-1000)')).toBeCloseTo(2000*Math.LN10, 10);
  });
  it('整数Gamma累積をPoissonの有限和から独立に照合する', () => {
    for (const a of [2, 5, 12]) for (const x of [0.5, 3, 18]) {
      let term = 1, sum = 1;
      for (let k = 1; k < a; k += 1) { term *= x/k; sum += term; }
      expect(number(`gammacdf(${a},1,${x})`)).toBeCloseTo(1-Math.exp(-x)*sum, 13);
    }
  });
  it('Beta整数形状を二項有限和で、半整数形状を逆正弦の閉形式で照合する', () => {
    for (const [a,b] of [[2,3],[5,4]]) for (const x of [0.1,0.4,0.9]) {
      const n = a+b-1; let choose = 1, sum = 0;
      for (let k = 0; k <= n; k += 1) {
        if (k >= a) sum += choose*x**k*(1-x)**(n-k);
        choose *= (n-k)/(k+1);
      }
      expect(number(`betacdf(${a},${b},${x})`)).toBeCloseTo(sum, 14);
    }
    for (const x of [0.01,0.25,0.99]) {
      expect(number(`betacdf(1/2,1/2,${x})`)).toBeCloseTo(2/Math.PI*Math.asin(Math.sqrt(x)), 14);
      expect(number(`betapdf(1/2,1/2,${x})`)).toBeCloseTo(1/(Math.PI*Math.sqrt(x*(1-x))), 13);
      expect(number(`betaquantile(1/2,1/2,${x})`)).toBeCloseTo(Math.sin(Math.PI*x/2)**2, 14);
    }
  });
  it('小さい値と1との差を消さず、支持範囲内の密度を計算する', () => {
    expect(Math.abs(number('gammacdf(1,1,1e-100)')/1e-100-1)).toBeLessThan(1e-14);
    expect(Math.abs(number('betaquantile(2,1,1e-100)')/1e-50-1)).toBeLessThan(1e-14);
    expect(Math.abs(number('betapdf(1,2,1-1e-100)')/2e-100-1)).toBeLessThan(1e-14);
    expect(number('betacdf(2,3,0.4)')+number('betacdf(3,2,0.6)')).toBeCloseTo(1, 14);
  });
  it('範囲外と有限な端点を厳密に扱い、Beta(1,1)を一様分布として保つ', () => {
    for (const source of ['gammapdf(2,3,-1)','gammacdf(2,3,0)','gammaquantile(2,3,0)',
      'gammapdf(2,3,0)','betapdf(2,3,0)','betapdf(2,3,1)','betapdf(2,3,2)','betacdf(2,3,-1)','betaquantile(2,3,0)']) expect(number(source)).toBe(0);
    expect(number('gammapdf(1,2,0)')).toBe(0.5);
    expect(number('betapdf(1,3,0)')).toBe(3);
    expect(number('betapdf(3,1,1)')).toBe(3);
    expect(number('betacdf(2,3,2)')).toBe(1);
    expect(number('betaquantile(2,3,1)')).toBe(1);
    expect(number('betapdf(1,1,1/3)')).toBe(1);
    expect(number('betacdf(1,1,1/3)')).toBe(1/3);
    expect(number('betaquantile(1,1,1/3)')).toBe(1/3);
    expect(number('betaquantile(7,7,1/2)')).toBe(0.5);
  });
  it('尺度の係数を変えて元の式と分位点の倍率を保つ', () => {
    const source = 'gammaquantile(1,coef("尺度"),0.5)';
    for (const decimal of ['1','2']) {
      const result = evaluate({ ...input(source), coefficients: [{ id: 'scale', label: '尺度', decimal }] });
      expect(result.definition?.source).toBe(source);
      if (result.evaluation.status !== 'value' || result.evaluation.kind !== 'real') throw new Error(JSON.stringify(result));
      expect(result.evaluation.coordinate).toBeCloseTo(Number(decimal)*Math.LN2, 14);
    }
  });
  it('内部の余分な桁を結果へ漏らさず、正確に1.5と0.6875になる例を通常の返信でも保つ', () => {
    expect(evaluate(input('betapdf(2,2,0.5)')).evaluation).toMatchObject({ status: 'value', kind: 'real', decimal: '1.5', coordinate: 1.5 });
    expect(evaluate(input('betacdf(2,3,0.5)')).evaluation).toMatchObject({ status: 'value', kind: 'real', decimal: '0.6875', coordinate: 0.6875 });
    for (const [source] of reference) {
      const result = evaluate(input(source)).evaluation;
      if (result.status !== 'value' || result.kind !== 'real') throw new Error(JSON.stringify(result));
      const significant = result.decimal.split(/[eE]/u)[0].replace(/[^0-9]/gu,'').replace(/^0+/u,'');
      expect(significant.length).toBeLessThanOrEqual(40);
    }
    expect(evaluate(input('betaquantile(2,3,1-1e-150)')).evaluation).toMatchObject({ status: 'stopped', reason: 'budget' });
  });
  it.each(['gammapdf(0,1,-1)','gammacdf(1,0,-1)','gammaquantile(-1,2,0)','gammaquantile(1,2,1)',
    'gammaquantile(1,2,-1)','gammapdf(1/2,2,0)','betapdf(1/2,2,0)','betapdf(2,1/2,1)',
    'betacdf(0,1,-1)','betacdf(1,-1,2)','betaquantile(1,0,0)','betaquantile(1,1,-0.1)','betaquantile(1,1,1.1)',
    'betapdf(1,1,1/0)','betacdf(i,1,0)','gammapdf(1,true,0)','betacdf(1,1,[0])'])('%sの不正を端点・0倍・成分選択で消さない', source => {
    for (const formula of [source,`0*${source}`,`component([1,${source}],1)`]) {
      expect(evaluate(input(formula)).evaluation).toMatchObject({ status: 'invalid', reason: 'domain' });
    }
  });
  it.each(['gammacdf(pi,1,0)','betapdf(1,sqrt(2),0)'])('%sの条件を勝手に丸めない', source => {
    expect(evaluate(input(source)).evaluation).toMatchObject({ status: 'invalid', reason: 'unsupported' });
  });
  it('数値域・桁数・中止の上限を越えた結果を採用しない', () => {
    expect(evaluate(input('gammacdf(30000,1,1)')).evaluation).toMatchObject({ status: 'stopped', reason: 'budget' });
    expect(evaluate(input('betaquantile(2,3,1-1e-1000)')).evaluation).toMatchObject({ status: 'stopped', reason: 'budget' });
    expect(evaluate(input('gammacdf(2,1,1e-1000)')).evaluation).toMatchObject({ status: 'invalid', reason: 'non-finite' });
    const stopped = new MathInputProblem('budget', '中止');
    expect(() => gammaBetaDistributionDecimal('gamma-cdf',[exact(2n),exact(1n),exact(3n)], () => { throw stopped; })).toThrow(stopped);
  });
});
