import Decimal from 'decimal.js';
import { beforeAll,describe,expect,it } from 'vitest';
import { createMathBackend } from './createMathBackend.js';
import { executeMathWorkRequest,type MathExecutionBackend } from './mathWorkExecution.js';
import { decodeMathWorkReply } from './mathWorkReply.js';
import { CANDIDATE_MATH_BY_ID } from './mathOperations.js';
import { sameMathMeaning } from './mathNotationConversion.js';
import { ZETA_REFERENCES } from './zetaReferences.js';
const D=Decimal.clone({precision:330,rounding:Decimal.ROUND_HALF_EVEN});
let backend:MathExecutionBackend;
beforeAll(()=>{backend=createMathBackend();});
function request(source:string,angleUnit:'degree'|'radian'='radian') {
  return {source,angleUnit,notation:'text' as const,coefficients:[],
    identity:{documentId:'zeta-functions',documentVersion:1,editorId:'coordinate',inputRevision:1}};
}
function evaluate(source:string,angleUnit:'degree'|'radian'='radian') {
  const input=request(source,angleUnit),raw=executeMathWorkRequest({kind:'evaluate-math',serial:1,request:input},backend);
  return decodeMathWorkReply(raw,input,{operationsById:CANDIDATE_MATH_BY_ID,coefficientIds:new Set(),declaredIds:new Set()}).result;
}
describe('ゼータ関数を元の式と40桁の値のまま通常入力する',()=>{
  it.each(ZETA_REFERENCES)('zeta(%s)の値と座標を独立基準と照合する',(x,reference)=>{
    const result=evaluate(`zeta(${x})`).evaluation;
    if(result.status!=='value'||result.kind!=='real')throw new Error(JSON.stringify(result));
    expect(result.decimal).toBe(new D(reference).toSignificantDigits(40).toString());
    expect(Math.abs(result.coordinate/Number(reference)-1)).toBeLessThan(5e-14);
  },30_000);
  it.each(['zeta(-2)','2*zeta(0.5)','zeta(2.5)'])('%sの表示切替・保存往復が原式と値を保つ',source=>{
    const input={...request(source),presentationNotation:'latex' as const};
    const raw=executeMathWorkRequest({kind:'evaluate-math',serial:1,request:input},backend);
    const result=decodeMathWorkReply(raw,input,{operationsById:CANDIDATE_MATH_BY_ID,coefficientIds:new Set(),declaredIds:new Set()}).result;
    if(raw.expression===null||raw.presentation==null||result.definition===null)throw new Error(JSON.stringify(raw));
    expect(sameMathMeaning(raw.expression,raw.presentation.expression)).toBe(true);expect(result.definition.source).toBe(source);
    const back=executeMathWorkRequest({kind:'evaluate-math',serial:2,request:{...input,notation:'latex',source:raw.presentation.source,definition:raw.presentation,presentationNotation:'text'}},backend);
    if(back.presentation==null)throw new Error(JSON.stringify(back));
    expect(sameMathMeaning(raw.expression,back.presentation.expression)).toBe(true);expect(back.evaluation).toEqual(raw.evaluation);
    const saved:unknown=JSON.parse(JSON.stringify({kind:'evaluate-math',serial:3,request:{...input,definition:result.definition}}));
    const reopened=executeMathWorkRequest(saved,backend);expect(reopened.source).toBe(source);expect(reopened.evaluation).toEqual(raw.evaluation);
  });
  it('角度を内側の三角関数だけに適用し、元の式を同じ文字列へ書き換えない',()=>{
    const a=evaluate('zeta(2+sin(30))','degree'),b=evaluate('zeta(2.5)');
    if(a.evaluation.status!=='value'||a.evaluation.kind!=='real'||b.evaluation.status!=='value'||b.evaluation.kind!=='real')throw new Error('Missing zeta values');
    expect(a.evaluation.decimal).toBe(b.evaluation.decimal);expect(a.definition?.source).toBe('zeta(2+sin(30))');
  });
  it.each(['zeta(1)','zeta(1-sin(0))','zeta(129)','zeta(-33)','zeta(1/0)','zeta(∞)',
    'zeta(i)','zeta(sqrt(-1))','zeta([2])','zeta(true)'])('%sの元の不成立を整理で隠さない',source=>{
      for(const formula of [source,`0*${source}`,`component([7,${source}],1)`])expect(evaluate(formula).evaluation.status,formula).not.toBe('value');
    });
});
