import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { createMathBackend } from './createMathBackend.js';
import { executeExactMathWorkRequest } from './exactMathWorkExecution.js';
import type { MathExecutionBackend } from './mathWorkExecution.js';
import { decodeMathWorkReply } from './mathWorkReply.js';
import { CANDIDATE_MATH_BY_ID } from './mathOperations.js';
import { BESSEL_INTEGER_REFERENCES } from './besselIntegerReferences.js';
import { BESSEL_SECOND_REFERENCES } from './besselSecondKindReferences.js';
import { exactRuntimeBatch, sharedExactEngine, spawnExactRuntime } from './exactRuntimeTestSupport.js';

let backend: MathExecutionBackend;
beforeAll(() => { backend=createMathBackend(); });
const engine = sharedExactEngine(exactRuntimeBatch(fileURLToPath(new URL('./exactRuntime/cas_derivatives_test.py', import.meta.url)), 60_000), 'Besselの返信数が一致しません。');

describe('Besselの追加計算部と通常入力が原式と値を引き継ぐ',()=>{
  it('実際の固定計算部で四種類・元の穴・点と多変数の微分・級数を確認する',()=>{
    const script=fileURLToPath(new URL('./exactRuntime/cas_bessel_functions_test.py',import.meta.url));
    const execution=spawnExactRuntime(['-B','-X','utf8',script],{encoding:'utf8',timeout:90_000,
      env:{...process.env,PYTHONDONTWRITEBYTECODE:'1',PYTHONNOUSERSITE:'1'}});
    expect(execution.error,execution.stderr).toBeUndefined();expect(execution.status,execution.stderr).toBe(0);
  },90_000);
  it.each([...BESSEL_INTEGER_REFERENCES,...BESSEL_SECOND_REFERENCES].filter(([,n,x])=>n===0&&x==='1'))(
    '%sの実際の微分返信を独立値と照合し、原式の保存再開で同じ値を使う',async(kind,_n,_x,_value,d1,d2)=>{
      const calculated=await Promise.all(([[1,d1],[2,d2]] as const).map(async([order,expected])=>{
        const source=`derivativeat(bessel${kind.toLowerCase()}(0,x),x,1,${order})`;
        const input={source,angleUnit:'radian' as const,notation:'text' as const,coefficients:[],
          identity:{documentId:'bessel-exact',documentVersion:1,editorId:'coordinate',inputRevision:1}};
        const envelope={kind:'evaluate-math',serial:1,request:input};
        return {source,expected,input,envelope,raw:await executeExactMathWorkRequest(envelope,{backend,engine,shouldStop:()=>undefined})};
      }));
      const reopenedRuns=await Promise.all(calculated.map(async({source,expected,input,envelope,raw})=>{
        const result=decodeMathWorkReply(raw,input,{operationsById:CANDIDATE_MATH_BY_ID,coefficientIds:new Set(),declaredIds:new Set()}).result;
        if(result.evaluation.status!=='value'||result.evaluation.kind!=='real'||result.definition===null)throw new Error(JSON.stringify(result));
        expect(result.evaluation.coordinate).toBeCloseTo(Number(expected),12);expect(result.evaluation.exact).not.toBeNull();
        expect(result.definition.source).toBe(source);
        const saved:unknown=JSON.parse(JSON.stringify({...envelope,request:{...input,definition:result.definition}}));
        return {source,raw,reopened:await executeExactMathWorkRequest(saved,{backend,engine,shouldStop:()=>undefined})};
      }));
      for(const {source,raw,reopened} of reopenedRuns){expect(reopened.source).toBe(source);expect(reopened.evaluation).toEqual(raw.evaluation);}
    },90_000);
});
