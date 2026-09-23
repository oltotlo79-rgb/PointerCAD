import Decimal from 'decimal.js';
import { beforeAll, describe, expect, it } from 'vitest';
import { createMathBackend } from './createMathBackend.js';
import { executeMathWorkRequest, type MathExecutionBackend } from './mathWorkExecution.js';
import { decodeMathWorkReply } from './mathWorkReply.js';
import { CANDIDATE_MATH_BY_ID } from './mathOperations.js';
import { sameMathMeaning } from './mathNotationConversion.js';
import { LAMBERT_W_REFERENCES } from './lambertWReferences.js';

const D=Decimal.clone({precision:260,rounding:Decimal.ROUND_HALF_EVEN});
let backend:MathExecutionBackend;
beforeAll(()=>{backend=createMathBackend();});
function request(source:string,angleUnit:'degree'|'radian'='radian') {
  return {source,angleUnit,notation:'text' as const,coefficients:[],
    identity:{documentId:'lambert-functions',documentVersion:1,editorId:'coordinate',inputRevision:1}};
}
function evaluate(source:string,angleUnit:'degree'|'radian'='radian') {
  const input=request(source,angleUnit),raw=executeMathWorkRequest({kind:'evaluate-math',serial:1,request:input},backend);
  return decodeMathWorkReply(raw,input,{operationsById:CANDIDATE_MATH_BY_ID,coefficientIds:new Set(),declaredIds:new Set()}).result;
}
function value(source:string,angleUnit:'degree'|'radian'='radian'):number {
  const result=evaluate(source,angleUnit).evaluation;
  if(result.status!=='value'||result.kind!=='real')throw new Error(source+': '+JSON.stringify(result));
  return result.coordinate;
}
const references=LAMBERT_W_REFERENCES.filter(([,x,text])=>Number(x)!==0&&Number(text)!==0&&Number.isFinite(Number(x)));

describe('Lambert Wの元の実数領域と選んだ枝を通常入力でも保持する',()=>{
  it.each(references)('枝%sの入力%sを独立した確認値へ渡す',(branch,x,expected)=>{
    const started=performance.now();
    const result=evaluate(`lambertw(${branch},${x})`).evaluation;
    console.log('[Lambert W入力]',JSON.stringify({branch,x,elapsedMs:performance.now()-started,status:result.status}));
    expect(result).toMatchObject({status:'value',kind:'real'});
    if(result.status!=='value'||result.kind!=='real')throw new Error(JSON.stringify(result));
    const expectedDecimal=new D(expected).toSignificantDigits(40);
    expect(new D(result.decimal).eq(expectedDecimal)).toBe(true);
    // The public result is also the UI text: preserve every digit in the usual spelling.
    expect(result.decimal).toBe(expectedDecimal.toString());
    expect(Math.abs(result.coordinate/Number(expected)-1)).toBeLessThan(5e-14);
  });
  it('0とeと合流点の正確な値を保ち、角度指定を混ぜない',()=>{
    expect(value('lambertw(0,0)')).toBe(0);
    expect(value('lambertw(0,e)')).toBe(1);
    for(const branch of [0,-1])for(const x of ['-1/e','-exp(-1)','-e^(-1)'])expect(value(`lambertw(${branch},${x})`)).toBe(-1);
    expect(value('lambertw(0,sin(30))','degree')).toBe(value('lambertw(0,0.5)'));
    expect(evaluate('lambertw(0,1)','degree').evaluation).toEqual(evaluate('lambertw(0,1)','radian').evaluation);
  });
  it.each([0,-1] as const)('枝%sの構造表示・原式・保存した定義が往復する',branch=>{
    const source=`2*lambertw(${branch},-0.1)`,input={...request(source),presentationNotation:'latex' as const};
    const raw=executeMathWorkRequest({kind:'evaluate-math',serial:1,request:input},backend);
    const result=decodeMathWorkReply(raw,input,{operationsById:CANDIDATE_MATH_BY_ID,coefficientIds:new Set(),declaredIds:new Set()}).result;
    if(raw.expression===null||raw.presentation===undefined||raw.presentation===null||result.definition===null)throw new Error(JSON.stringify(raw));
    expect(sameMathMeaning(raw.expression,raw.presentation.expression)).toBe(true);
    expect(result.definition.source).toBe(source);
    const back=executeMathWorkRequest({kind:'evaluate-math',serial:2,request:{...input,
      notation:'latex',source:raw.presentation.source,definition:raw.presentation,presentationNotation:'text'}},backend);
    if(back.presentation===undefined||back.presentation===null)throw new Error(JSON.stringify(back));
    expect(sameMathMeaning(raw.expression,back.presentation.expression)).toBe(true);expect(back.evaluation).toEqual(raw.evaluation);
    const saved:unknown=JSON.parse(JSON.stringify({kind:'evaluate-math',serial:3,request:{...input,definition:result.definition}}));
    const reopened=executeMathWorkRequest(saved,backend);
    expect(reopened.source).toBe(source);expect(reopened.evaluation).toEqual(raw.evaluation);
  });
  it.each(['lambertw(-1,0)','lambertw(-1,1e-1000)','lambertw(0,-0.368)','lambertw(-1,-0.368)',
    'lambertw(1,1)','lambertw(0.5,1)','lambertw(0,1/0)','lambertw(0,[1])','lambertw(0,true)',
    'lambertw(0,∞)','lambertw(0,i)','lambertw(0,sqrt(-1))','lambertw(0,-1/e-1e-100)'])(
    '%sの不成立を0倍や成分選択で消さない',source=>{
      for(const formula of [source,`0*${source}`,`component([7,${source}],1)`])expect(evaluate(formula).evaluation.status,formula).not.toBe('value');
    });
  it('表示限界より小さい非零を座標の0へ置き換えない',()=>{
    for(const x of ['1e-1000','-1e-1000'])expect(evaluate(`lambertw(0,${x})`).evaluation).toMatchObject({status:'invalid',reason:'non-finite'});
  });
});
