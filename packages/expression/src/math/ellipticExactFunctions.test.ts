import { fileURLToPath } from 'node:url';
import { beforeAll,describe,expect,it } from 'vitest';
import { createMathBackend } from './createMathBackend.js';
import { executeExactMathWorkRequest } from './exactMathWorkExecution.js';
import type { MathExecutionBackend } from './mathWorkExecution.js';
import type { MathNode } from './mathInputContract.js';
import { decodeMathWorkReply } from './mathWorkReply.js';
import { CANDIDATE_MATH_BY_ID } from './mathOperations.js';
import { spawnExactRuntime } from './exactRuntimeTestSupport.js';

let backend:MathExecutionBackend;
beforeAll(()=>{backend=createMathBackend();});
const engine={evaluate(expression:MathNode,angleUnit:'degree'|'radian'):Promise<unknown>{
  const script=fileURLToPath(new URL('./exactRuntime/cas_derivatives_test.py',import.meta.url));
  const execution=spawnExactRuntime(['-B','-X','utf8',script,'--batch'],{
    input:JSON.stringify([{expression,angleUnit}]),encoding:'utf8',timeout:60_000,
    env:{...process.env,PYTHONDONTWRITEBYTECODE:'1',PYTHONNOUSERSITE:'1'},
  });
  if(execution.error!==undefined||execution.status!==0)throw new Error(execution.stderr||execution.error?.message);
  const replies:unknown=JSON.parse(execution.stdout);
  if(!Array.isArray(replies)||replies.length!==1)throw new Error('楕円積分の返信数が一致しません。');
  return Promise.resolve(replies[0]);
}};
describe('楕円積分の追加計算部を元の条件・微分・保存へ接続する',()=>{
  it('固定計算部の六種類・原点・独立微分・途中の極と元の境界を確認する',()=>{
    const script=fileURLToPath(new URL('./exactRuntime/cas_elliptic_functions_test.py',import.meta.url));
    const execution=spawnExactRuntime(['-B','-X','utf8',script],{encoding:'utf8',timeout:170_000,
      env:{...process.env,PYTHONDONTWRITEBYTECODE:'1',PYTHONNOUSERSITE:'1'}});
    expect(execution.error,execution.stderr).toBeUndefined();expect(execution.status,execution.stderr).toBe(0);
  },180_000);
  it.each([
    ['elliptick(x)',Math.PI/8],['elliptice(x)',-Math.PI/8],['ellipticpi(x,0)',Math.PI/4],
    ['ellipticf(x,0.5)',1],['ellipticeinc(x,0.5)',1],['ellipticpiinc(0.25,x,0.5)',1],
  ] as const)('%sの原点の微分を実返信と保存の往復へ通す',async(body,expected)=>{
    const source=`derivativeat(${body},x,0)`;
    const input={source,angleUnit:'radian' as const,notation:'text' as const,coefficients:[],
      identity:{documentId:'elliptic-exact',documentVersion:1,editorId:'coordinate',inputRevision:1}};
    const envelope={kind:'evaluate-math',serial:1,request:input};
    const raw=await executeExactMathWorkRequest(envelope,{backend,engine,shouldStop:()=>undefined});
    const result=decodeMathWorkReply(raw,input,{operationsById:CANDIDATE_MATH_BY_ID,coefficientIds:new Set(),declaredIds:new Set()}).result;
    if(result.evaluation.status!=='value'||result.evaluation.kind!=='real'||result.definition===null)throw new Error(JSON.stringify(result));
    expect(Math.abs(result.evaluation.coordinate/expected-1)).toBeLessThan(5e-12);
    expect(result.evaluation.exact).not.toBeNull();expect(result.definition.source).toBe(source);
    const saved:unknown=JSON.parse(JSON.stringify({...envelope,request:{...input,definition:result.definition}}));
    const reopened=await executeExactMathWorkRequest(saved,{backend,engine,shouldStop:()=>undefined});
    expect(reopened.source).toBe(source);expect(reopened.evaluation).toEqual(raw.evaluation);
  },90_000);
});
