import { beforeAll,describe,expect,it } from 'vitest';
import { createMathBackend } from './createMathBackend.js';
import { createFunctionMathSource } from './functionMathSource.js';
import { decodeFunctionImplicitCurveWorkRequest,createFunctionImplicitCurveWorkEnvelope,type FunctionImplicitCurveWorkRequest } from './functionImplicitCurveWorkRequest.js';
import { executeFunctionImplicitCurveWorkRequest } from './functionImplicitCurveWorkExecution.js';
import { decodeFunctionImplicitCurveWorkReply } from './functionImplicitCurveWorkReply.js';
import { FunctionImplicitCurveWorkerClient } from './functionImplicitCurveWorkerClient.js';
import type { CalculationWorkerPort } from './boundedCalculationClient.js';
import type { MathExecutionBackend } from './mathWorkExecution.js';

let backend:MathExecutionBackend;
beforeAll(()=>{backend=createMathBackend();});
function request(source='X^2+Y^2-1',fixedAxis:'X'|'Y'|'Z'='Z',fixedCoordinate=0):FunctionImplicitCurveWorkRequest {
  return {identity:{documentId:'implicit-curve',documentVersion:1,editorId:'curve',inputRevision:1},
    expression:createFunctionMathSource(source,'text','radian',{axes:(['X','Y','Z'] as const).filter(axis=>axis!==fixedAxis),parameters:[],coefficients:[]},backend),
    fixedAxis,fixedCoordinate,minimum:[-2,-2,-2],maximum:[2,2,2],tolerance:0.1,coefficients:[],
    budget:{maximumSamples:100_000,maximumCells:400_000,maximumSegments:100_000,maximumDepth:12}};
}
function evaluate(input:FunctionImplicitCurveWorkRequest){
  const decoded=decodeFunctionImplicitCurveWorkRequest(input);
  return decodeFunctionImplicitCurveWorkReply(executeFunctionImplicitCurveWorkRequest(createFunctionImplicitCurveWorkEnvelope(1,decoded),backend),decoded);
}
class Port implements CalculationWorkerPort {
  onmessage:CalculationWorkerPort['onmessage']=null;onerror:CalculationWorkerPort['onerror']=null;onmessageerror:CalculationWorkerPort['onmessageerror']=null;
  input:unknown;terminated=false;
  postMessage(value:unknown):void{this.input=value;}terminate():void{this.terminated=true;}
  complete():void{this.onmessage?.({data:executeFunctionImplicitCurveWorkRequest(this.input,backend)});}
}
describe('平面等式も全XYZを必須にし、曲線の枝と指定平面を保つ',()=>{
  it.each(['X','Y','Z'] as const)('%s固定の円は1つの閉曲線で、実座標の残差と固定値が一致する',axis=>{
    const free=(['X','Y','Z'] as const).filter(value=>value!==axis),input=request(`${free[0]}^2+${free[1]}^2-1`,axis,0.123456789);
    const result=evaluate(input).result;if(result.status!=='ready') throw new Error(JSON.stringify(result));
    expect(result.components).toHaveLength(1);const curve=result.components[0];expect(curve[0]).toEqual(curve.at(-1));
    const fixed=['X','Y','Z'].indexOf(axis),slots=[0,1,2].filter(index=>index!==fixed);
    for(const point of curve){expect(point[fixed]).toBe(input.fixedCoordinate);expect(Math.abs(Math.hypot(point[slots[0]],point[slots[1]])-1)).toBeLessThan(input.tolerance);}
    expect(result.maximumDistanceBound).toBeLessThanOrEqual(input.tolerance);expect(Object.isFrozen(curve[0])).toBe(true);
  });
  it('双曲線の2枝を結ばず、XYZ境界の端点まで残す',()=>{
    const input=request('X*Y-1'),result=evaluate(input).result;if(result.status!=='ready') throw new Error(JSON.stringify(result));
    expect(result.components).toHaveLength(2);
    for(const curve of result.components){
      expect(curve.every(point=>Math.sign(point[0])===Math.sign(curve[0][0]))).toBe(true);
      for(const point of curve) expect(Math.abs(point[0]*point[1]-1)).toBeLessThan(input.tolerance);
      for(const point of [curve[0],curve[curve.length-1]]) expect(Math.max(Math.abs(point[0]),Math.abs(point[1]))).toBe(2);
    }
  });
  it('境界と一致する直線を消さず、固定平面がXYZ範囲外なら空になる',()=>{
    const input=request('X+2'),result=evaluate(input).result;if(result.status!=='ready') throw new Error(JSON.stringify(result));
    expect(result.components).toHaveLength(1);expect(result.components[0][0]).toEqual([-2,-2,0]);expect(result.components[0].at(-1)).toEqual([-2,2,0]);
    expect(evaluate({...input,fixedCoordinate:3}).result.status).toBe('empty');
  });
  it('孤立点・分岐・予算不足の途中の線を成功にしない',()=>{
    for(const source of ['X^2+Y^2','X*Y']){
      const result=evaluate(request(source)).result;expect(result.status,source).not.toBe('ready');expect(result).not.toHaveProperty('components');
    }
    const input=request();expect(()=>decodeFunctionImplicitCurveWorkRequest({...input,budget:{...input.budget,maximumSamples:2}})).toThrow();
    const result=evaluate({...input,budget:{...input.budget,maximumSamples:5}}).result;
    expect(result).toMatchObject({status:'stopped',reason:'samples'});expect(result).not.toHaveProperty('components');
  });
  it('1/X-Yは極をまたがず、有限範囲に実在する2枝を残す',()=>{
    const result=evaluate(request('1/X-Y')).result;if(result.status!=='ready') throw new Error(JSON.stringify(result));
    expect(result.components).toHaveLength(2);
    for(const curve of result.components) for(const point of curve){
      expect(Math.sign(point[0])).toBe(Math.sign(curve[0][0]));expect(Math.abs(point[0])).toBeGreaterThanOrEqual(0.5);
      expect(Math.abs(1/point[0]-point[1])).toBeLessThan(0.1);
    }
  });
  it.each([0,1,2])('固定軸を含めXYZ軸%sの欠落・非有限・逆順・同値を拒否する',axis=>{
    const input=request();
    for(const value of [undefined,NaN,Infinity,-Infinity,input.minimum[axis],input.minimum[axis]-1]){
      const maximum:unknown[]=[...input.maximum];maximum[axis]=value;expect(()=>decodeFunctionImplicitCurveWorkRequest({...input,maximum})).toThrow();
    }
    expect(()=>decodeFunctionImplicitCurveWorkRequest({...input,fixedCoordinate:Infinity})).toThrow();
  });
  it('別の固定平面・範囲外・別世代・水増し線分数の返信を採用しない',()=>{
    const input=request(),reply=evaluate(input);if(reply.result.status!=='ready') throw new Error(JSON.stringify(reply));const result=reply.result;
    for(const point of [[0,0,1],[3,0,0]]){
      expect(()=>decodeFunctionImplicitCurveWorkReply({...reply,result:{...result,components:[[point,...result.components[0].slice(1)]]}},input)).toThrow();
    }
    expect(()=>decodeFunctionImplicitCurveWorkReply({...reply,identity:{...reply.identity,inputRevision:2}},input)).toThrow();
    expect(()=>decodeFunctionImplicitCurveWorkReply({...reply,result:{...result,stats:{...result.stats,segments:result.stats.segments+1}}},input)).toThrow();
  });
  it('中止でWorkerを破棄し、次の依頼は新しいWorkerで完了する',async()=>{
    const ports:Port[]=[],client=new FunctionImplicitCurveWorkerClient({createWorker:()=>{const port=new Port();ports.push(port);return port;}});
    try{
      const abort=new AbortController(),first=client.evaluate(request(),1000,abort.signal);abort.abort();
      expect(await first).toMatchObject({status:'cancelled'});expect(ports[0].terminated).toBe(true);
      const second=client.evaluate(request(),1000);ports[1].complete();expect(await second).toMatchObject({status:'result',result:{status:'ready'}});
    }finally{client.dispose();}
  });
});
