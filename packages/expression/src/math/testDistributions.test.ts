import { beforeAll, describe, expect, it } from 'vitest';
import { createMathBackend } from './createMathBackend.js';
import { executeMathWorkRequest, type MathExecutionBackend } from './mathWorkExecution.js';
import { createMathWorkEnvelope, type MathWorkRequest } from './mathWorkRequest.js';
import { decodeMathWorkReply } from './mathWorkReply.js';
import { sameMathMeaning } from './mathNotationConversion.js';
import { testDistributionDecimal } from './testDistributionsNumeric.js';
import { exact } from './statisticsData.js';
import { MathInputProblem } from './mathInputContract.js';

let backend: MathExecutionBackend;
beforeAll(() => { backend = createMathBackend(); });
function input(source: string): MathWorkRequest {
  return { source, angleUnit: 'degree', notation: 'text', coefficients: [],
    identity: { documentId: 'chi-t-f', documentVersion: 1, editorId: 'coordinate', inputRevision: 1 } };
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
    "chisquarepdf(0.5,0.001)",
    41.22344464937346
  ],
  [
    "chisquarecdf(0.5,0.001)",
    0.16495975076841285
  ],
  [
    "chisquarepdf(1,3)",
    0.05139344326792309
  ],
  [
    "chisquarecdf(1,3)",
    0.9167354833364496
  ],
  [
    "chisquarepdf(3.5,0.2)",
    0.08753777370528659
  ],
  [
    "chisquarecdf(3.5,0.2)",
    0.010378019336111289
  ],
  [
    "chisquarepdf(3.5,10)",
    0.012256882963481631
  ],
  [
    "chisquarecdf(3.5,10)",
    0.9719601382856896
  ],
  [
    "chisquarepdf(10,12)",
    0.06692630876999167
  ],
  [
    "chisquarecdf(10,12)",
    0.7149434996833688
  ],
  [
    "chisquarepdf(100,110)",
    0.020250717569759047
  ],
  [
    "chisquarecdf(100,110)",
    0.7677952194991436
  ],
  [
    "chisquarequantile(0.5,0.025)",
    5.273202591259992e-07
  ],
  [
    "chisquarequantile(3.5,0.5)",
    2.8605894030665504
  ],
  [
    "chisquarequantile(10,0.9)",
    15.987179172105261
  ],
  [
    "chisquarequantile(100,0.975)",
    129.5611971858366
  ],
  [
    "tpdf(0.5,-3)",
    0.029633133748884072
  ],
  [
    "tcdf(0.5,-3)",
    0.18365407799297173
  ],
  [
    "tpdf(1,0.25)",
    0.29958577523180296
  ],
  [
    "tcdf(1,0.25)",
    0.5779791303773694
  ],
  [
    "tpdf(2.5,-0.02)",
    0.36170743986979753
  ],
  [
    "tcdf(2.5,-0.02)",
    0.4927645008065566
  ],
  [
    "tpdf(2.5,2)",
    0.06796349050979465
  ],
  [
    "tcdf(2.5,2)",
    0.921304252121017
  ],
  [
    "tpdf(10,5)",
    0.0003960010564637989
  ],
  [
    "tcdf(10,5)",
    0.9997313331986217
  ],
  [
    "tpdf(100,-3)",
    0.005126089702320253
  ],
  [
    "tcdf(100,-3)",
    0.0017039576716647248
  ],
  [
    "tquantile(0.5,0.025)",
    -164.55767348048855
  ],
  [
    "tquantile(2.5,0.4)",
    -0.28145951274854764
  ],
  [
    "tquantile(10,0.6)",
    0.2601848294920802
  ],
  [
    "tquantile(100,0.975)",
    1.9839715185235522
  ],
  [
    "fpdf(0.5,0.7,0.001)",
    26.361380726347925
  ],
  [
    "fcdf(0.5,0.7,0.001)",
    0.10548166819871481
  ],
  [
    "fpdf(2,2,3)",
    0.0625
  ],
  [
    "fcdf(2,2,3)",
    0.75
  ],
  [
    "fpdf(3.5,1.3,0.2)",
    0.5873987164550775
  ],
  [
    "fcdf(3.5,1.3,0.2)",
    0.09729309695197956
  ],
  [
    "fpdf(3.5,1.3,10)",
    0.01051614549123659
  ],
  [
    "fcdf(3.5,1.3,10)",
    0.8293808020973175
  ],
  [
    "fpdf(5,10,1.5)",
    0.28645862666105676
  ],
  [
    "fcdf(5,10,1.5)",
    0.7267134845242298
  ],
  [
    "fpdf(100,70,1.2)",
    1.0724347449744756
  ],
  [
    "fcdf(100,70,1.2)",
    0.7901339062818161
  ],
  [
    "fquantile(0.5,0.7,0.025)",
    3.154305011860888e-06
  ],
  [
    "fquantile(3.5,1.3,0.5)",
    1.45906267009133
  ],
  [
    "fquantile(5,10,0.9)",
    2.5216406862096234
  ],
  [
    "fquantile(100,70,0.975)",
    1.5581079289235722
  ]
];

describe('χ²・t・F分布を自由度と確率の意味を保って利用する', () => {
  it.each(reference)('%sを別の90桁計算と相対誤差で照合する', (source, expected) => {
    expect(Math.abs(number(source)/expected-1)).toBeLessThan(4e-13);
  });
  it.each(['chisquarepdf(3.5,0.2)','chisquarecdf(3.5,0.2)','chisquarequantile(3.5,0.5)',
    'tpdf(2.5,-0.02)','tcdf(2.5,-0.02)','tquantile(2.5,0.4)',
    'fpdf(3.5,1.3,0.2)','fcdf(3.5,1.3,0.2)','fquantile(3.5,1.3,0.5)'])('%sの原式と角度によらない値を表示・保存往復で保つ', source => {
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
  it('χ²自由度2を指数の閉形式で照合する', () => {
    for (const x of [0.001,0.5,2,10]) {
      expect(number(`chisquarepdf(2,${x})`)).toBeCloseTo(Math.exp(-x/2)/2,14);
      expect(number(`chisquarecdf(2,${x})`)).toBeCloseTo(-Math.expm1(-x/2),14);
    }
    for (const p of [0.01,0.5,0.99]) expect(number(`chisquarequantile(2,${p})`)).toBeCloseTo(-2*Math.log1p(-p),12);
  });
  it('t自由度1をCauchyの閉形式、F自由度2・2を有理式で独立に照合する', () => {
    for (const x of [0.001,0.5,2,10]) {
      expect(number(`tpdf(1,${x})`)).toBeCloseTo(1/(Math.PI*(1+x*x)),14);
      expect(number(`tcdf(1,${x})`)).toBeCloseTo(0.5+Math.atan(x)/Math.PI,14);
      expect(number(`fpdf(2,2,${x})`)).toBeCloseTo(1/(1+x)**2,14);
      expect(number(`fcdf(2,2,${x})`)).toBeCloseTo(x/(1+x),14);
    }
    for (const p of [0.01,0.25,0.75,0.99]) {
      expect(number(`tquantile(1,${p})`)).toBeCloseTo(Math.tan(Math.PI*(p-0.5)),11);
      expect(number(`fquantile(2,2,${p})`)).toBeCloseTo(p/(1-p),11);
    }
    expect(evaluate(input('fquantile(2,2,3/4)')).evaluation).toMatchObject({ status:'value',kind:'real',decimal:'3' });
  });
  it('tの対称性とFの自由度交換による逆数関係を保つ', () => {
    for (const k of [0.5,2.5,10]) {
      expect(number(`tcdf(${k},-2)`)+number(`tcdf(${k},2)`)).toBeCloseTo(1,14);
      expect(number(`tpdf(${k},-2)`)).toBe(number(`tpdf(${k},2)`));
      expect(number(`tquantile(${k},0.1)`)).toBe(-number(`tquantile(${k},0.9)`));
    }
    expect(number('fquantile(3.5,7,0.1)')*number('fquantile(7,3.5,0.9)')).toBeCloseTo(1,13);
    expect(number('fcdf(3.5,7,2)')+number('fcdf(7,3.5,1/2)')).toBeCloseTo(1,14);
  });
  it('中央値からの微小な差と両端の小さい確率を途中で消さない', () => {
    expect(Math.abs(number('tquantile(1,1/2+1e-100)')/(Math.PI*1e-100)-1)).toBeLessThan(4e-13);
    expect(Math.abs(number('tquantile(1,1e-100)')/(-1/(Math.PI*1e-100))-1)).toBeLessThan(4e-13);
    expect(Math.abs(number('tquantile(1,1-1e-100)')/(1/(Math.PI*1e-100))-1)).toBeLessThan(4e-13);
    expect(Math.abs(number('tcdf(1,-1e100)')/(1/(Math.PI*1e100))-1)).toBeLessThan(4e-13);
    expect(Math.abs(number('fpdf(2,2,1e100)')/1e-200-1)).toBeLessThan(4e-13);
    expect(Math.abs(number('fquantile(2,2,1-1e-100)')/1e100-1)).toBeLessThan(4e-13);
  });
  it('支持範囲・有限な端点・対称な中央値を正確に保つ', () => {
    for (const source of ['chisquarepdf(3,-1)','chisquarecdf(3,-1)','chisquarepdf(3,0)','chisquarecdf(3,0)',
      'chisquarequantile(3,0)','fpdf(3,4,-1)','fcdf(3,4,0)','fpdf(3,4,0)','fquantile(3,4,0)','tquantile(7,1/2)']) expect(number(source)).toBe(0);
    expect(number('chisquarepdf(2,0)')).toBe(0.5);
    expect(number('fpdf(2,7,0)')).toBe(1);
    expect(number('tcdf(7,0)')).toBe(0.5);
    expect(number('fquantile(7,7,1/2)')).toBe(1);
    expect(number('fcdf(7,7,1)')).toBe(0.5);
  });
  it('自由度の係数を変更しても元の式を保持する', () => {
    const source='chisquarepdf(coef("自由度"),0)';
    for (const [decimal,expected] of [['2',0.5],['3',0]] as const) {
      const result=evaluate({ ...input(source),coefficients:[{id:'degrees',label:'自由度',decimal}] });
      expect(result.definition?.source).toBe(source);
      expect(result.evaluation).toMatchObject({status:'value',kind:'real',coordinate:expected});
    }
  });
  it('出力の文字列に内部の補助桁を漏らさない', () => {
    for (const [source] of reference) {
      const result=evaluate(input(source)).evaluation;
      if(result.status!=='value'||result.kind!=='real')throw new Error(JSON.stringify(result));
      expect(result.decimal.split(/[eE]/u)[0].replace(/[^0-9]/gu,'').replace(/^0+/u,'').length).toBeLessThanOrEqual(40);
    }
  });
  it.each(['chisquarepdf(0,-1)','chisquarecdf(-1,0)','chisquarequantile(0,0)','chisquarequantile(1,1)',
    'chisquarequantile(1,-0.1)','chisquarepdf(1,0)','tpdf(0,0)','tcdf(-1,0)','tquantile(0,1/2)',
    'tquantile(1,0)','tquantile(1,1)','fpdf(0,2,-1)','fcdf(2,0,0)','fquantile(1,-1,0)',
    'fquantile(2,2,1)','fquantile(2,2,-1)','fpdf(1,2,0)','tcdf(i,0)','tpdf(1,true)','fcdf(2,2,[0])','fcdf(2,2,1/0)'])('%sの不正を端点・0倍・成分選択でも隠さない', source => {
    for(const formula of [source,`0*${source}`,`component([1,${source}],1)`]) {
      expect(evaluate(input(formula)).evaluation).toMatchObject({status:'invalid',reason:'domain'});
    }
  });
  it.each(['chisquarecdf(pi,0)','tcdf(sqrt(2),0)','fpdf(2,sqrt(2),0)'])('%sの条件を勝手に有理数へ置換しない', source => {
    expect(evaluate(input(source)).evaluation).toMatchObject({status:'invalid',reason:'unsupported'});
  });
  it('数値範囲・表せない非零値・中止で途中の結果を採用しない', () => {
    expect(evaluate(input('chisquarecdf(100000,1)')).evaluation).toMatchObject({status:'stopped',reason:'budget'});
    expect(evaluate(input('tquantile(1,1e-1000)')).evaluation).toMatchObject({status:'invalid',reason:'non-finite'});
    expect(evaluate(input('fcdf(2,2,1e-1000)')).evaluation).toMatchObject({status:'invalid',reason:'non-finite'});
    const stopped=new MathInputProblem('budget','中止');
    expect(()=>testDistributionDecimal('t-pdf',[exact(2n),exact(1n)],()=>{throw stopped;})).toThrow(stopped);
  });
});
