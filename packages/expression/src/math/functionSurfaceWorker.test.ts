import { beforeAll, describe, expect, it } from 'vitest';
import { createMathBackend } from './createMathBackend.js';
import type { MathExecutionBackend } from './mathWorkExecution.js';
import { createFunctionMathSource } from './functionMathSource.js';
import { decodeFunctionSurfaceWorkRequest, createFunctionSurfaceWorkEnvelope, type FunctionSurfaceWorkRequest } from './functionSurfaceWorkRequest.js';
import { executeFunctionSurfaceWorkRequest } from './functionSurfaceWorkExecution.js';
import { decodeFunctionSurfaceWorkReply } from './functionSurfaceWorkReply.js';
import { FunctionSurfaceWorkerClient } from './functionSurfaceWorkerClient.js';
import type { CalculationWorkerPort } from './boundedCalculationClient.js';

let backend: MathExecutionBackend;
beforeAll(()=>{backend=createMathBackend();});
function request(): FunctionSurfaceWorkRequest {
  const source = (source:string)=>createFunctionMathSource(source,'text','radian',{axes:[],parameters:['U','V'],coefficients:[]},backend);
  return {identity:{documentId:'surface',documentVersion:3,editorId:'plot',inputRevision:1},independent:['U','V'],
    outputs:[source('U'),source('V'),source('U+V')],lower:[-2,-2],upper:[2,2],minimum:[-1,-1,-1],maximum:[1,1,1],
    tolerance:0.01,coefficients:[],budget:{maximumSamples:10000,maximumCells:10000,maximumTriangles:10000,maximumDepth:10}};
}
class Port implements CalculationWorkerPort {
  onmessage:CalculationWorkerPort['onmessage']=null;
  onerror:CalculationWorkerPort['onerror']=null;
  onmessageerror:CalculationWorkerPort['onmessageerror']=null;
  readonly requests:unknown[]=[]; terminated=false;
  postMessage(value:unknown):void {this.requests.push(value);}
  terminate():void {this.terminated=true;}
  complete():void {this.onmessage?.({data:executeFunctionSurfaceWorkRequest(this.requests[0],backend)});}
}
describe('曲面の有限XYZと中止可能なWorker通信',()=>{
  it('XYZより広いUV範囲を別に保持し、原式・予算・結果を深く固定する',()=>{
    const input=request(), decoded=decodeFunctionSurfaceWorkRequest(input), reply=executeFunctionSurfaceWorkRequest(createFunctionSurfaceWorkEnvelope(1,decoded),backend);
    const checked=decodeFunctionSurfaceWorkReply(reply,decoded);
    if(checked.result.status!=='ready') throw new Error(JSON.stringify(checked));
    expect(checked.result.vertices.some(value=>Math.abs(value.point[0])>1)).toBe(true); // CAD clips next.
    expect(Object.isFrozen(decoded.budget)).toBe(true); expect(Object.isFrozen(decoded.outputs[0].expression)).toBe(true);
    expect(Object.isFrozen(checked.result.vertices[0].point)).toBe(true); expect(Object.isFrozen(checked.result.triangles[0])).toBe(true);
  });
  it.each([0,1,2])('軸%sの全不正値・欠落をUV範囲があっても拒否する',axis=>{
    const input=request();
    for(const invalid of [undefined,NaN,Infinity,-Infinity,input.minimum[axis],input.minimum[axis]-1]) {
      const maximum:unknown[]=[...input.maximum]; maximum[axis]=invalid;
      expect(()=>decodeFunctionSurfaceWorkRequest({...input,maximum})).toThrow();
    }
    expect(()=>decodeFunctionSurfaceWorkRequest({...input,minimum:input.minimum.slice(0,2)})).toThrow();
  });
  it('座標軸の範囲相違、重複変数、過大予算、保存AST差替えを拒否する',()=>{
    const input=request();
    expect(()=>decodeFunctionSurfaceWorkRequest({...input,independent:['X','Y']})).toThrow();
    expect(()=>decodeFunctionSurfaceWorkRequest({...input,independent:['U','U']})).toThrow();
    expect(()=>decodeFunctionSurfaceWorkRequest({...input,budget:{...input.budget,maximumTriangles:200001}})).toThrow();
    const reply=executeFunctionSurfaceWorkRequest({kind:'sample-function-surface',serial:1,request:{...input,
      outputs:[{...input.outputs[0],expression:input.outputs[1].expression},input.outputs[1],input.outputs[2]]}},backend);
    expect(reply.result.status).toBe('invalid'); expect(reply.result).not.toHaveProperty('vertices');
  });
  it('精度超過・不正頂点番号・非有限座標・範囲外UV・停止結果に付けたメッシュを拒否する',()=>{
    const input=request(), reply=executeFunctionSurfaceWorkRequest(createFunctionSurfaceWorkEnvelope(2,input),backend);
    if(reply.result.status!=='ready') throw new Error(JSON.stringify(reply));
    const result=reply.result;
    for(const invalid of [
      {...result,maximumInterpolationErrorBound:0.02}, {...result,triangles:[[0,1,1000000]],stats:{...result.stats,triangles:1}},
      {...result,vertices:result.vertices.map((v,i)=>i===0?{...v,point:[NaN,0,0]}:v)},
      {...result,vertices:result.vertices.map((v,i)=>i===0?{...v,parameters:[-3,0]}:v)},
      {...result,status:'stopped',reason:'deadline'}, {...result,stats:{...result.stats,samples:10001}},
    ]) expect(()=>decodeFunctionSurfaceWorkReply({...reply,result:invalid},input)).toThrow();
    expect(()=>decodeFunctionSurfaceWorkReply({...reply,identity:{...reply.identity,documentVersion:2}},input)).toThrow();
  });
  it('中止すると共通クライアントがWorkerを交換し、古い曲面を次の依頼へ適用しない',async()=>{
    const ports:Port[]=[], client=new FunctionSurfaceWorkerClient({createWorker:()=>{const port=new Port();ports.push(port);return port;}});
    try {
      const abort=new AbortController(), first=client.evaluate(request(),5000,abort.signal), oldReply=ports[0].onmessage;
      const input=request(), next=client.evaluate({...input,identity:{...input.identity,documentVersion:4}},5000);
      abort.abort(); expect(await first).toMatchObject({status:'cancelled'}); expect(ports[0].terminated).toBe(true);
      oldReply?.({data:executeFunctionSurfaceWorkRequest(ports[0].requests[0],backend)});
      ports[1].complete(); expect(await next).toMatchObject({status:'result',identity:{documentVersion:4}});
    } finally {client.dispose();}
  });
});
