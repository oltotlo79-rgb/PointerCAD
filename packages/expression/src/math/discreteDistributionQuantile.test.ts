import { beforeAll, describe, expect, it } from 'vitest';
import { createMathBackend } from './createMathBackend.js';
import { executeMathWorkRequest, type MathExecutionBackend } from './mathWorkExecution.js';
import { createMathWorkEnvelope, type MathWorkRequest } from './mathWorkRequest.js';
import { decodeMathWorkReply } from './mathWorkReply.js';
import { sameMathMeaning } from './mathNotationConversion.js';
import { poissonQuantile } from './poissonQuantile.js';
import { binomialQuantile } from './binomialProbability.js';
import { exact } from './statisticsData.js';
import { MathInputProblem } from './mathInputContract.js';

let backend: MathExecutionBackend;
beforeAll(() => { backend = createMathBackend(); });
function input(source: string): MathWorkRequest {
  return { source, angleUnit: 'degree', notation: 'text', coefficients: [],
    identity: { documentId: 'discrete-quantiles', documentVersion: 1, editorId: 'coordinate', inputRevision: 1 } };
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
const reference: readonly (readonly [string,number])[] = [
  [
    "poissonquantile(0.001,0.001)",
    0
  ],
  [
    "poissonquantile(0.001,0.25)",
    0
  ],
  [
    "poissonquantile(0.001,0.5)",
    0
  ],
  [
    "poissonquantile(0.001,0.9)",
    0
  ],
  [
    "poissonquantile(0.001,0.999)",
    0
  ],
  [
    "poissonquantile(0.5,0.001)",
    0
  ],
  [
    "poissonquantile(0.5,0.25)",
    0
  ],
  [
    "poissonquantile(0.5,0.5)",
    0
  ],
  [
    "poissonquantile(0.5,0.9)",
    1
  ],
  [
    "poissonquantile(0.5,0.999)",
    4
  ],
  [
    "poissonquantile(2,0.001)",
    0
  ],
  [
    "poissonquantile(2,0.25)",
    1
  ],
  [
    "poissonquantile(2,0.5)",
    2
  ],
  [
    "poissonquantile(2,0.9)",
    4
  ],
  [
    "poissonquantile(2,0.999)",
    8
  ],
  [
    "poissonquantile(10,0.001)",
    2
  ],
  [
    "poissonquantile(10,0.25)",
    8
  ],
  [
    "poissonquantile(10,0.5)",
    10
  ],
  [
    "poissonquantile(10,0.9)",
    14
  ],
  [
    "poissonquantile(10,0.999)",
    21
  ],
  [
    "poissonquantile(100,0.001)",
    71
  ],
  [
    "poissonquantile(100,0.25)",
    93
  ],
  [
    "poissonquantile(100,0.5)",
    100
  ],
  [
    "poissonquantile(100,0.9)",
    113
  ],
  [
    "poissonquantile(100,0.999)",
    132
  ],
  [
    "poissonquantile(1000,0.001)",
    904
  ],
  [
    "poissonquantile(1000,0.25)",
    979
  ],
  [
    "poissonquantile(1000,0.5)",
    1000
  ],
  [
    "poissonquantile(1000,0.9)",
    1041
  ],
  [
    "poissonquantile(1000,0.999)",
    1099
  ],
  [
    "poissonquantile(2,1e-100)",
    0
  ],
  [
    "poissonquantile(2,1-1e-100)",
    82
  ]
];

describe('離散分布の分位点を最小の回数として確定する', () => {
  it.each(reference)('%sを独立した不完全Gammaによる基準値と照合する', (source, expected) => {
    expect(number(source)).toBe(expected);
  });
  it('公平な4回の全16通りから全ての確率段階を独立に照合する', () => {
    const outcomes=Array.from({length:16},(_,i)=>i.toString(2).replaceAll('0','').length).sort((a,b)=>a-b);
    for(let j=1;j<=16;j++) expect(number(`binomialquantile(4,1/2,${j}/16)`)).toBe(outcomes[j-1]);
    expect(number('binomialquantile(4,1/2,11/16)')).toBe(2);
    expect(number('binomialquantile(4,1/2,11/16-1e-100)')).toBe(2);
    expect(number('binomialquantile(4,1/2,11/16+1e-100)')).toBe(3);
  });
  it('成功率1/3の3回を全27通り列挙して累積の境界を確認する', () => {
    const outcomes=[];
    for(let a=0;a<3;a++)for(let b=0;b<3;b++)for(let c=0;c<3;c++)outcomes.push(Number(a===0)+Number(b===0)+Number(c===0));
    outcomes.sort((a,b)=>a-b);
    for(let j=1;j<=27;j++)expect(number(`binomialquantile(3,1/3,${j}/27)`)).toBe(outcomes[j-1]);
  });
  it('Poissonの最初の跳躍exp(-1)の両側を100桁の入力で区別する', () => {
    // Decimal digits independently computed by the alternating factorial series for exp(-1).
    const below='0.3678794411714423215955237701614608674458111310317678345078368016974614957448998033571472743459196437';
    const above='0.3678794411714423215955237701614608674458111310317678345078368016974614957448998033571472743459196438';
    expect(number(`poissonquantile(1,${below})`)).toBe(0);
    expect(number(`poissonquantile(1,${above})`)).toBe(1);
  });
  it.each([
    ['binomialquantile(4,1/2,0)',0],['binomialquantile(4,1/2,1)',4],
    ['binomialquantile(0,1,1)',0],['binomialquantile(4,0,1)',0],['binomialquantile(4,1,0.1)',4],
    ['binomialquantile(4,1,0)',0],['poissonquantile(0,1)',0],['poissonquantile(0,0)',0],
    ['poissonquantile(2,0)',0],['binomialquantile(10001,0,0.5)',0],['poissonquantile(10001,0)',0],
  ] as const)('%sの有限な端点と退化分布を保つ',(source,expected)=>{expect(number(source)).toBe(expected);});
  it.each(['binomialquantile(-1,1/2,0)','binomialquantile(1/2,1/2,0)','binomialquantile(2,-1,0)',
    'binomialquantile(0,2,0)','binomialquantile(0,0,-1)','binomialquantile(2,0,2)',
    'poissonquantile(-1,0)','poissonquantile(0,-1)','poissonquantile(0,2)','poissonquantile(2,1)',
    'poissonquantile(1/0,0)','poissonquantile(2,true)','binomialquantile(2,i,0)'])('%sの元の不正を端点・0倍・選択外でも隠さない',source=>{
      for(const formula of [source,`0*${source}`,`component([1,${source}],1)`])expect(evaluate(input(formula)).evaluation).toMatchObject({status:'invalid',reason:'domain'});
  });
  it.each(['binomialquantile(4,pi/4,0)','poissonquantile(sqrt(2),0)'])('%sの未対応の条件を丸めない',source=>{
    expect(evaluate(input(source)).evaluation).toMatchObject({status:'invalid',reason:'unsupported'});
  });
  it.each(['binomialquantile(10001,1/2,0.5)','binomialquantile(10,1e-1000,0.5)','poissonquantile(10001,0.5)'])('%sで計算資源を越えた途中結果を返さない',source=>{
    expect(evaluate(input(source)).evaluation).toMatchObject({status:'stopped',reason:'budget'});
  });
  it.each(['binomialquantile(4,1/2,11/16)','poissonquantile(2,3/4)'])('%sの原式・構造入力・JSON保存・角度を保持する',source=>{
    const request={...input(source),presentationNotation:'latex' as const}, result=evaluate(request);
    expect(result.evaluation).toMatchObject({status:'value',kind:'real'});
    if(!result.definition || !result.presentation)throw new Error(JSON.stringify(result));
    expect(result.definition.source).toBe(source);
    expect(sameMathMeaning(result.definition.expression,result.presentation.expression)).toBe(true);
    const saved:unknown=JSON.parse(JSON.stringify(createMathWorkEnvelope(2,{...request,definition:result.definition})));
    expect(executeMathWorkRequest(saved,backend).evaluation).toEqual(result.evaluation);
    expect(evaluate({...request,source:result.presentation.source,notation:'latex',definition:result.presentation,presentationNotation:'text'}).evaluation).toEqual(result.evaluation);
    expect(evaluate({...request,angleUnit:'radian'}).evaluation).toEqual(result.evaluation);
  });
  it('確率の係数を変えると分位点が更新され、元の式は残る',()=>{
    for(const [decimal,expected] of [['0.75',3],['0.99',6]] as const){
      const source='poissonquantile(2,coef("目標確率"))';
      const result=evaluate({...input(source),coefficients:[{id:'target',label:'目標確率',decimal}]});
      expect(result.definition?.source).toBe(source);
      expect(result.evaluation).toMatchObject({status:'value',kind:'real',coordinate:expected});
    }
  });
  it('計算中の中止を確認し、整数の途中候補を採用しない',()=>{
    const error=new MathInputProblem('budget','中止');let calls=0;
    expect(()=>poissonQuantile([exact(100n),exact(99n,100n)],()=>{if(++calls===30)throw error;})).toThrow(error);
    calls=0;
    expect(()=>binomialQuantile([exact(100n),exact(1n,2n),exact(99n,100n)],()=>{if(++calls===30)throw error;})).toThrow(error);
  });
});
