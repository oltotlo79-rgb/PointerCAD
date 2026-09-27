import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { createMathBackend } from './createMathBackend.js';
import { executeExactMathWorkRequest } from './exactMathWorkExecution.js';
import type { MathExecutionBackend } from './mathWorkExecution.js';
import { decodeMathWorkReply } from './mathWorkReply.js';
import { CANDIDATE_MATH_BY_ID } from './mathOperations.js';
import { LAMBERT_W_DERIVATIVES } from './lambertWDerivativeReferences.js';
import { exactRuntimeBatch, sharedExactEngine, spawnExactRuntime } from './exactRuntimeTestSupport.js';

let backend:MathExecutionBackend;
beforeAll(()=>{backend=createMathBackend();});
const engine=sharedExactEngine(exactRuntimeBatch(fileURLToPath(new URL('./exactRuntime/cas_derivatives_test.py',import.meta.url)),60_000),'Lambert Wの返信数が一致しません。');
describe('Lambert Wの追加計算部を原式・枝・数値の同じ入力へ接続する',()=>{
  it('実際の固定計算部で枝・境界・原点・四階微分・元の穴を確認する',()=>{
    const script=fileURLToPath(new URL('./exactRuntime/cas_lambert_functions_test.py',import.meta.url));
    const execution=spawnExactRuntime(['-B','-X','utf8',script],{encoding:'utf8',timeout:90_000,
      env:{...process.env,PYTHONDONTWRITEBYTECODE:'1',PYTHONNOUSERSITE:'1'}});
    expect(execution.error,execution.stderr).toBeUndefined();expect(execution.status,execution.stderr).toBe(0);
  },90_000);
  it.each(LAMBERT_W_DERIVATIVES.filter(([,x])=>x==='0'||x==='-0.125'))(
    '枝%s・入力%sの実際の微分返信を保存再開しても保持する',async(branch,x,_v,d1,d2)=>{
      const calculated=await Promise.all(([[1,d1],[2,d2]] as const).map(async([order,expected])=>{
        const source=`derivativeat(lambertw(${branch},x),x,${x},${order})`;
        const input={source,angleUnit:'radian' as const,notation:'text' as const,coefficients:[],
          identity:{documentId:'lambert-exact',documentVersion:1,editorId:'coordinate',inputRevision:1}};
        const envelope={kind:'evaluate-math',serial:1,request:input};
        return {source,expected,input,envelope,raw:await executeExactMathWorkRequest(envelope,{backend,engine,shouldStop:()=>undefined})};
      }));
      const reopenedRuns=await Promise.all(calculated.map(async({source,expected,input,envelope,raw})=>{
        const result=decodeMathWorkReply(raw,input,{operationsById:CANDIDATE_MATH_BY_ID,coefficientIds:new Set(),declaredIds:new Set()}).result;
        if(result.evaluation.status!=='value'||result.evaluation.kind!=='real'||result.definition===null)throw new Error(JSON.stringify(result));
        expect(Math.abs(result.evaluation.coordinate/Number(expected)-1)).toBeLessThan(5e-12);
        expect(result.evaluation.exact).not.toBeNull();expect(result.definition.source).toBe(source);
        const saved:unknown=JSON.parse(JSON.stringify({...envelope,request:{...input,definition:result.definition}}));
        return {source,raw,reopened:await executeExactMathWorkRequest(saved,{backend,engine,shouldStop:()=>undefined})};
      }));
      for(const {source,raw,reopened} of reopenedRuns){expect(reopened.source).toBe(source);expect(reopened.evaluation).toEqual(raw.evaluation);}
    },90_000);
});
