import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { createMathBackend } from './createMathBackend.js';
import { executeExactMathWorkRequest } from './exactMathWorkExecution.js';
import type { MathExecutionBackend } from './mathWorkExecution.js';
import type { MathNode } from './mathInputContract.js';
import { decodeMathWorkReply } from './mathWorkReply.js';
import { CANDIDATE_MATH_BY_ID } from './mathOperations.js';
import { AIRY_REFERENCES } from './airyReferences.js';

let backend:MathExecutionBackend;
beforeAll(()=>{backend=createMathBackend();});
const engine={evaluate(expression:MathNode,angleUnit:'degree'|'radian'):Promise<unknown>{
  const script=fileURLToPath(new URL('./exactRuntime/cas_derivatives_test.py',import.meta.url));
  const execution=spawnSync('python',['-B','-X','utf8',script,'--batch'],{
    input:JSON.stringify([{expression,angleUnit}]),encoding:'utf8',timeout:60_000,
    env:{...process.env,PYTHONDONTWRITEBYTECODE:'1',PYTHONNOUSERSITE:'1'},
  });
  if(execution.error!==undefined||execution.status!==0)throw new Error(execution.stderr||execution.error?.message);
  const replies:unknown=JSON.parse(execution.stdout);
  if(!Array.isArray(replies)||replies.length!==1)throw new Error('Airy関数の返信数が一致しません。');
  return Promise.resolve(replies[0]);
}};
describe('Airyの追加計算部を原式と元の条件を保って接続する',()=>{
  it('固定した実計算部で四種類・原点・四階微分・元の穴を確認する',()=>{
    const script=fileURLToPath(new URL('./exactRuntime/cas_airy_functions_test.py',import.meta.url));
    const execution=spawnSync('python',['-B','-X','utf8',script],{encoding:'utf8',timeout:90_000,
      env:{...process.env,PYTHONDONTWRITEBYTECODE:'1',PYTHONNOUSERSITE:'1'}});
    expect(execution.error,execution.stderr).toBeUndefined();expect(execution.status,execution.stderr).toBe(0);
  },90_000);
  it.each(AIRY_REFERENCES.filter(([,x])=>['-1','0','1'].includes(x)))(
    '%s(%s)の微分返信と原式が保存往復する',async(kind,x,y,dy)=>{
      for(const [order,expected] of [[1,Number(dy)],[2,Number(x)*Number(y)]] as const) {
        const source=`derivativeat(airy${kind.toLowerCase()}(x),x,${x},${order})`;
        const input={source,angleUnit:'radian' as const,notation:'text' as const,coefficients:[],
          identity:{documentId:'airy-exact',documentVersion:1,editorId:'coordinate',inputRevision:1}};
        const envelope={kind:'evaluate-math',serial:1,request:input};
        const raw=await executeExactMathWorkRequest(envelope,{backend,engine,shouldStop:()=>undefined});
        const result=decodeMathWorkReply(raw,input,{operationsById:CANDIDATE_MATH_BY_ID,coefficientIds:new Set(),declaredIds:new Set()}).result;
        if(result.evaluation.status!=='value'||result.evaluation.kind!=='real'||result.definition===null)throw new Error(JSON.stringify(result));
        if(expected===0)expect(result.evaluation.coordinate).toBe(0);
        else expect(Math.abs(result.evaluation.coordinate/expected-1)).toBeLessThan(5e-12);
        expect(result.evaluation.exact).not.toBeNull();expect(result.definition.source).toBe(source);
        const saved:unknown=JSON.parse(JSON.stringify({...envelope,request:{...input,definition:result.definition}}));
        const reopened=await executeExactMathWorkRequest(saved,{backend,engine,shouldStop:()=>undefined});
        expect(reopened.source).toBe(source);expect(reopened.evaluation).toEqual(raw.evaluation);
      }
    },90_000);
});
