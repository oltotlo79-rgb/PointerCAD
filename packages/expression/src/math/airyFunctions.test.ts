import Decimal from 'decimal.js';
import { beforeAll, describe, expect, it } from 'vitest';
import { createMathBackend } from './createMathBackend.js';
import { executeMathWorkRequest, type MathExecutionBackend } from './mathWorkExecution.js';
import { decodeMathWorkReply } from './mathWorkReply.js';
import { CANDIDATE_MATH_BY_ID } from './mathOperations.js';
import { sameMathMeaning } from './mathNotationConversion.js';
import { AIRY_REFERENCES } from './airyReferences.js';

const D=Decimal.clone({precision:310,rounding:Decimal.ROUND_HALF_EVEN});
let backend:MathExecutionBackend;
beforeAll(()=>{backend=createMathBackend();});
function request(source:string,angleUnit:'degree'|'radian'='radian') {
  return {source,angleUnit,notation:'text' as const,coefficients:[],
    identity:{documentId:'airy-functions',documentVersion:1,editorId:'coordinate',inputRevision:1}};
}
function evaluate(source:string,angleUnit:'degree'|'radian'='radian') {
  const input=request(source,angleUnit),raw=executeMathWorkRequest({kind:'evaluate-math',serial:1,request:input},backend);
  return decodeMathWorkReply(raw,input,{operationsById:CANDIDATE_MATH_BY_ID,coefficientIds:new Set(),declaredIds:new Set()}).result;
}
describe('Airy関数を原式と40桁の値を保って通常入力する',()=>{
  it.each(AIRY_REFERENCES)('%s(%s)の値と傾きを独立基準と同じ表示にする',(kind,x,y,dy)=>{
    for(const [suffix,expected] of [['',y],['prime',dy]]) {
      const source=`airy${kind.toLowerCase()}${suffix}(${x})`,result=evaluate(source).evaluation;
      if(result.status!=='value'||result.kind!=='real')throw new Error(source+': '+JSON.stringify(result));
      expect(result.decimal).toBe(new D(expected).toSignificantDigits(40).toString());
      expect(Math.abs(result.coordinate/Number(expected)-1)).toBeLessThan(5e-14);
    }
  });
  it.each(['airyai','airybi','airyaiprime','airybiprime'])('%sの表示切替・原式・保存往復で値が変わらない',operation=>{
    const source=`2*${operation}(-1)`,input={...request(source),presentationNotation:'latex' as const};
    const raw=executeMathWorkRequest({kind:'evaluate-math',serial:1,request:input},backend);
    const result=decodeMathWorkReply(raw,input,{operationsById:CANDIDATE_MATH_BY_ID,coefficientIds:new Set(),declaredIds:new Set()}).result;
    if(raw.expression===null||raw.presentation===undefined||raw.presentation===null||result.definition===null)throw new Error(JSON.stringify(raw));
    expect(sameMathMeaning(raw.expression,raw.presentation.expression)).toBe(true);expect(result.definition.source).toBe(source);
    const back=executeMathWorkRequest({kind:'evaluate-math',serial:2,request:{...input,notation:'latex',source:raw.presentation.source,definition:raw.presentation,presentationNotation:'text'}},backend);
    if(back.presentation===undefined||back.presentation===null)throw new Error(JSON.stringify(back));
    expect(sameMathMeaning(raw.expression,back.presentation.expression)).toBe(true);expect(back.evaluation).toEqual(raw.evaluation);
    const saved:unknown=JSON.parse(JSON.stringify({kind:'evaluate-math',serial:3,request:{...input,definition:result.definition}}));
    const reopened=executeMathWorkRequest(saved,backend);expect(reopened.source).toBe(source);expect(reopened.evaluation).toEqual(raw.evaluation);
    const degreeSource=`${operation}(sin(30))`,literalSource=`${operation}(0.5)`;
    const degree=evaluate(degreeSource,'degree'),literal=evaluate(literalSource);
    // Equal values need not have identical symbolic trees (1/2 versus 0.5).
    expect(degree.definition?.source).toBe(degreeSource);expect(literal.definition?.source).toBe(literalSource);
    if(degree.evaluation.status!=='value'||degree.evaluation.kind!=='real'||literal.evaluation.status!=='value'||literal.evaluation.kind!=='real')throw new Error('Expected real Airy values');
    expect(degree.evaluation.decimal).toBe(literal.evaluation.decimal);
    expect(degree.evaluation.coordinate).toBe(literal.evaluation.coordinate);
    expect(degree.evaluation.exact).not.toEqual(literal.evaluation.exact);
  });
  it.each(['airyai(33)','airybi(-33)','airyaiprime(1/0)','airybiprime(∞)','airyai(i)','airybi(sqrt(-1))','airyai([1])','airybi(true)'])(
    '%sの不成立を0倍や成分の選択で隠さない',source=>{
      for(const formula of [source,`0*${source}`,`component([7,${source}],1)`])expect(evaluate(formula).evaluation.status,formula).not.toBe('value');
    });
});
