import { fileURLToPath } from 'node:url';
import Decimal from 'decimal.js';
import { beforeAll,describe,expect,it } from 'vitest';
import { createMathBackend } from './createMathBackend.js';
import { executeExactMathWorkRequest } from './exactMathWorkExecution.js';
import type { MathExecutionBackend } from './mathWorkExecution.js';
import { decodeMathWorkReply } from './mathWorkReply.js';
import { CANDIDATE_MATH_BY_ID } from './mathOperations.js';
import { ZETA_DERIVATIVE_REFERENCES } from './zetaDerivativeReferences.js';
import { exactRuntimeBatch, sharedExactEngine, spawnExactRuntime } from './exactRuntimeTestSupport.js';
let backend:MathExecutionBackend;
beforeAll(()=>{backend=createMathBackend();});
const D=Decimal.clone({precision:330,rounding:Decimal.ROUND_HALF_EVEN});
const engine=sharedExactEngine(exactRuntimeBatch(fileURLToPath(new URL('./exactRuntime/cas_derivatives_test.py',import.meta.url)),60_000),'ゼータ関数の返信数が一致しません。');
function request(source:string) {
  return {source,angleUnit:'radian' as const,notation:'text' as const,coefficients:[],
    identity:{documentId:'zeta-exact',documentVersion:1,editorId:'coordinate',inputRevision:1}};
}
describe('ゼータ関数の追加計算部は微分の次数と原式を保つ',()=>{
  it('固定した実計算部から元の極・複合式・高階微分と返信を確認する',()=>{
    const script=fileURLToPath(new URL('./exactRuntime/cas_zeta_functions_test.py',import.meta.url));
    const execution=spawnExactRuntime(['-B','-X','utf8',script],{encoding:'utf8',timeout:90_000,
      env:{...process.env,PYTHONDONTWRITEBYTECODE:'1',PYTHONNOUSERSITE:'1'}});
    expect(execution.error,execution.stderr).toBeUndefined();expect(execution.status,execution.stderr).toBe(0);
  },90_000);
  it.each(ZETA_DERIVATIVE_REFERENCES.filter(([x,refs])=>x==='-2'||x==='0.5'||x==='4'||x==='2'&&refs.length===16))(
    '引数%sの実返信から独立した値を求め、原式を保存し直せる',async(x,refs)=>{
      const calculated=await Promise.all([1,2,Math.min(15,refs.length-1)].map(async order=>{
        const source=`derivativeat(zeta(x),x,${x},${String(order)})`,input=request(source);
        const envelope={kind:'evaluate-math',serial:1,request:input};
        return {order,source,input,envelope,raw:await executeExactMathWorkRequest(envelope,{backend,engine,shouldStop:()=>undefined})};
      }));
      const reopenedRuns=await Promise.all(calculated.map(async({order,source,input,envelope,raw})=>{
        const result=decodeMathWorkReply(raw,input,{operationsById:CANDIDATE_MATH_BY_ID,coefficientIds:new Set(),declaredIds:new Set()}).result;
        if(result.evaluation.status!=='value'||result.evaluation.kind!=='real'||result.definition===null)throw new Error(JSON.stringify(result));
        expect(result.evaluation.decimal).toBe(new D(refs[order]).toSignificantDigits(40).toString());
        expect(result.evaluation.exact).not.toBeNull();expect(result.definition.source).toBe(source);
        const saved:unknown=JSON.parse(JSON.stringify({...envelope,request:{...input,definition:result.definition}}));
        return {source,raw,reopened:await executeExactMathWorkRequest(saved,{backend,engine,shouldStop:()=>undefined})};
      }));
      for(const {source,raw,reopened} of reopenedRuns){expect(reopened.source).toBe(source);expect(reopened.evaluation).toEqual(raw.evaluation);}
    },90_000);
  it.each(['derivativeat(zeta(x),x,1)','0*derivativeat(zeta(x),x,1)',
    'derivativeat(0*zeta(x),x,1)','derivativeat(zeta(abs(x)),x,0)',
    'zetaderivative(18,2)','zetaderivative(0,1)'])('%sを値へ変えない',async source=>{
    const raw=await executeExactMathWorkRequest({kind:'evaluate-math',serial:1,request:request(source)},{backend,engine,shouldStop:()=>undefined});
    expect(raw.evaluation.status).not.toBe('value');
  },90_000);
});
