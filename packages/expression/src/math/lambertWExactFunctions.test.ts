import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { createMathBackend } from './createMathBackend.js';
import { executeExactMathWorkRequest } from './exactMathWorkExecution.js';
import type { MathExecutionBackend } from './mathWorkExecution.js';
import type { MathNode } from './mathInputContract.js';
import { decodeMathWorkReply } from './mathWorkReply.js';
import { CANDIDATE_MATH_BY_ID } from './mathOperations.js';
import { LAMBERT_W_DERIVATIVES } from './lambertWDerivativeReferences.js';

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
  if(!Array.isArray(replies)||replies.length!==1)throw new Error('Lambert Wの返信数が一致しません。');
  return Promise.resolve(replies[0]);
}};
describe('Lambert Wの追加計算部を原式・枝・数値の同じ入力へ接続する',()=>{
  it('実際の固定計算部で枝・境界・原点・四階微分・元の穴を確認する',()=>{
    const script=fileURLToPath(new URL('./exactRuntime/cas_lambert_functions_test.py',import.meta.url));
    const execution=spawnSync('python',['-B','-X','utf8',script],{encoding:'utf8',timeout:90_000,
      env:{...process.env,PYTHONDONTWRITEBYTECODE:'1',PYTHONNOUSERSITE:'1'}});
    expect(execution.error,execution.stderr).toBeUndefined();expect(execution.status,execution.stderr).toBe(0);
  },90_000);
  it.each(LAMBERT_W_DERIVATIVES.filter(([,x])=>x==='0'||x==='-0.125'))(
    '枝%s・入力%sの実際の微分返信を保存再開しても保持する',async(branch,x,_v,d1,d2)=>{
      for(const [order,expected] of [[1,d1],[2,d2]] as const){
        const source=`derivativeat(lambertw(${branch},x),x,${x},${order})`;
        const input={source,angleUnit:'radian' as const,notation:'text' as const,coefficients:[],
          identity:{documentId:'lambert-exact',documentVersion:1,editorId:'coordinate',inputRevision:1}};
        const envelope={kind:'evaluate-math',serial:1,request:input};
        const raw=await executeExactMathWorkRequest(envelope,{backend,engine,shouldStop:()=>undefined});
        const result=decodeMathWorkReply(raw,input,{operationsById:CANDIDATE_MATH_BY_ID,coefficientIds:new Set(),declaredIds:new Set()}).result;
        if(result.evaluation.status!=='value'||result.evaluation.kind!=='real'||result.definition===null)throw new Error(JSON.stringify(result));
        expect(Math.abs(result.evaluation.coordinate/Number(expected)-1)).toBeLessThan(5e-12);
        expect(result.evaluation.exact).not.toBeNull();expect(result.definition.source).toBe(source);
        const saved:unknown=JSON.parse(JSON.stringify({...envelope,request:{...input,definition:result.definition}}));
        const reopened=await executeExactMathWorkRequest(saved,{backend,engine,shouldStop:()=>undefined});
        expect(reopened.source).toBe(source);expect(reopened.evaluation).toEqual(raw.evaluation);
      }
    },90_000);
});
