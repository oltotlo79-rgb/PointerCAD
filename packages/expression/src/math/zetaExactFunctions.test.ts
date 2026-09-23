import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import Decimal from 'decimal.js';
import { beforeAll,describe,expect,it } from 'vitest';
import { createMathBackend } from './createMathBackend.js';
import { executeExactMathWorkRequest } from './exactMathWorkExecution.js';
import type { MathExecutionBackend } from './mathWorkExecution.js';
import type { MathNode } from './mathInputContract.js';
import { decodeMathWorkReply } from './mathWorkReply.js';
import { CANDIDATE_MATH_BY_ID } from './mathOperations.js';
import { ZETA_DERIVATIVE_REFERENCES } from './zetaDerivativeReferences.js';
let backend:MathExecutionBackend;
beforeAll(()=>{backend=createMathBackend();});
const D=Decimal.clone({precision:330,rounding:Decimal.ROUND_HALF_EVEN});
const engine={evaluate(expression:MathNode,angleUnit:'degree'|'radian'):Promise<unknown>{
  const script=fileURLToPath(new URL('./exactRuntime/cas_derivatives_test.py',import.meta.url));
  const execution=spawnSync('python',['-B','-X','utf8',script,'--batch'],{
    input:JSON.stringify([{expression,angleUnit}]),encoding:'utf8',timeout:60_000,
    env:{...process.env,PYTHONDONTWRITEBYTECODE:'1',PYTHONNOUSERSITE:'1'},
  });
  if(execution.error!==undefined||execution.status!==0)throw new Error(execution.stderr||execution.error?.message);
  const replies:unknown=JSON.parse(execution.stdout);
  if(!Array.isArray(replies)||replies.length!==1)throw new Error('ゼータ関数の返信数が一致しません。');
  return Promise.resolve(replies[0]);
}};
function request(source:string) {
  return {source,angleUnit:'radian' as const,notation:'text' as const,coefficients:[],
    identity:{documentId:'zeta-exact',documentVersion:1,editorId:'coordinate',inputRevision:1}};
}
describe('ゼータ関数の追加計算部は微分の次数と原式を保つ',()=>{
  it('固定した実計算部から元の極・複合式・高階微分と返信を確認する',()=>{
    const script=fileURLToPath(new URL('./exactRuntime/cas_zeta_functions_test.py',import.meta.url));
    const execution=spawnSync('python',['-B','-X','utf8',script],{encoding:'utf8',timeout:90_000,
      env:{...process.env,PYTHONDONTWRITEBYTECODE:'1',PYTHONNOUSERSITE:'1'}});
    expect(execution.error,execution.stderr).toBeUndefined();expect(execution.status,execution.stderr).toBe(0);
  },90_000);
  it.each(ZETA_DERIVATIVE_REFERENCES.filter(([x,refs])=>x==='-2'||x==='0.5'||x==='4'||x==='2'&&refs.length===16))(
    '引数%sの実返信から独立した値を求め、原式を保存し直せる',async(x,refs)=>{
      for(const order of [1,2,Math.min(15,refs.length-1)]) {
        const source=`derivativeat(zeta(x),x,${x},${String(order)})`,input=request(source);
        const envelope={kind:'evaluate-math',serial:1,request:input};
        const raw=await executeExactMathWorkRequest(envelope,{backend,engine,shouldStop:()=>undefined});
        const result=decodeMathWorkReply(raw,input,{operationsById:CANDIDATE_MATH_BY_ID,coefficientIds:new Set(),declaredIds:new Set()}).result;
        if(result.evaluation.status!=='value'||result.evaluation.kind!=='real'||result.definition===null)throw new Error(JSON.stringify(result));
        expect(result.evaluation.decimal).toBe(new D(refs[order]).toSignificantDigits(40).toString());
        expect(result.evaluation.exact).not.toBeNull();expect(result.definition.source).toBe(source);
        const saved:unknown=JSON.parse(JSON.stringify({...envelope,request:{...input,definition:result.definition}}));
        const reopened=await executeExactMathWorkRequest(saved,{backend,engine,shouldStop:()=>undefined});
        expect(reopened.source).toBe(source);expect(reopened.evaluation).toEqual(raw.evaluation);
      }
    },90_000);
  it.each(['derivativeat(zeta(x),x,1)','0*derivativeat(zeta(x),x,1)',
    'derivativeat(0*zeta(x),x,1)','derivativeat(zeta(abs(x)),x,0)',
    'zetaderivative(18,2)','zetaderivative(0,1)'])('%sを値へ変えない',async source=>{
    const raw=await executeExactMathWorkRequest({kind:'evaluate-math',serial:1,request:request(source)},{backend,engine,shouldStop:()=>undefined});
    expect(raw.evaluation.status).not.toBe('value');
  },90_000);
});
