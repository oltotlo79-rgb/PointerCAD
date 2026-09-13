import { beforeAll, describe, expect, it } from 'vitest';
import { createMathBackend } from './createMathBackend.js';
import { createFunctionMathSource } from './functionMathSource.js';
import { decodeFunctionImplicitWorkRequest, createFunctionImplicitWorkEnvelope, type FunctionImplicitWorkRequest } from './functionImplicitWorkRequest.js';
import { executeFunctionImplicitWorkRequest } from './functionImplicitWorkExecution.js';
import { decodeFunctionImplicitWorkReply } from './functionImplicitWorkReply.js';
import { FunctionImplicitWorkerClient } from './functionImplicitWorkerClient.js';
import type { CalculationWorkerPort } from './boundedCalculationClient.js';
import type { MathExecutionBackend } from './mathWorkExecution.js';

let backend:MathExecutionBackend;
beforeAll(()=>{backend=createMathBackend();});
function request():FunctionImplicitWorkRequest {
  return {identity:{documentId:'implicit',documentVersion:1,editorId:'surface',inputRevision:1},
    expression:createFunctionMathSource('X^2+Y^2+Z^2-1','text','radian',{axes:['X','Y','Z'],parameters:[],coefficients:[]},backend),
    minimum:[-2,-2,-2],maximum:[2,2,2],tolerance:1,coefficients:[],
    budget:{maximumSamples:100_000,maximumCells:400_000,maximumTriangles:100_000,maximumDepth:12}};
}
class Port implements CalculationWorkerPort {
  onmessage:CalculationWorkerPort['onmessage']=null;onerror:CalculationWorkerPort['onerror']=null;onmessageerror:CalculationWorkerPort['onmessageerror']=null;
  input:unknown;terminated=false;
  postMessage(input:unknown):void{this.input=input;} terminate():void{this.terminated=true;}
  complete():void{this.onmessage?.({data:executeFunctionImplicitWorkRequest(this.input,backend)});}
}
describe('陰関数Workerも全XYZと世代・精度・実形状の範囲を検証する',()=>{
  it('CAD受信側だけに既定0.01mmの解析球を返し、通常のメッシュ依頼は変更しない',()=>{
    const input=decodeFunctionImplicitWorkRequest({...request(),tolerance:0.01,nativePrimitives:true});
    const reply=executeFunctionImplicitWorkRequest(createFunctionImplicitWorkEnvelope(1,input),backend),result=decodeFunctionImplicitWorkReply(reply,input).result;
    expect(result.status).toBe('analytic');if(result.status!=='analytic') throw new Error(JSON.stringify(result));
    expect(result.primitive.kind).toBe('sphere');expect(result.maximumParameterError).toBeLessThan(input.tolerance/4);
    expect(()=>decodeFunctionImplicitWorkReply(reply,request())).toThrow();
    expect(()=>decodeFunctionImplicitWorkReply({...reply,result:{...result,maximumParameterError:1}},input)).toThrow();
    expect(()=>decodeFunctionImplicitWorkReply({...reply,result:{...result,primitive:{kind:'sphere',center:[0,0,Infinity],radius:1}}},input)).toThrow();
    expect(()=>decodeFunctionImplicitWorkRequest({...input,nativePrimitives:'true'})).toThrow();
  });
  it('解析形状の依頼でも原式を照合し、不正な半径や余分な欄の返信を拒否する',()=>{
    const input=decodeFunctionImplicitWorkRequest({...request(),nativePrimitives:true});
    const tampered=executeFunctionImplicitWorkRequest({kind:'sample-function-implicit-surface',serial:1,request:{...input,expression:{...input.expression,source:'X+Y'}}},backend);
    expect(tampered.result.status).toBe('invalid');
    const reply=executeFunctionImplicitWorkRequest(createFunctionImplicitWorkEnvelope(1,input),backend);
    for(const primitive of [{kind:'sphere',center:[0,0,0],radius:-1},{kind:'torus',axis:3,majorRadius:2,minorRadius:1},
      {kind:'torus',axis:0,majorRadius:1,minorRadius:2},{kind:'sphere',center:[0,0,0],radius:1,clip:false}]){
      expect(()=>decodeFunctionImplicitWorkReply({...reply,result:{status:'analytic',primitive,maximumParameterError:0}},input)).toThrow();
    }
  });
  it('原式を再検証して閉面のメッシュを返し、往復データを深く固定する',()=>{
    const input=decodeFunctionImplicitWorkRequest(request()),reply=executeFunctionImplicitWorkRequest(createFunctionImplicitWorkEnvelope(1,input),backend);
    const result=decodeFunctionImplicitWorkReply(reply,input).result;
    expect(result.status).toBe('ready'); if(result.status!=='ready') throw new Error(JSON.stringify(result));
    expect(Object.isFrozen(input.expression.expression)).toBe(true);expect(Object.isFrozen(result.mesh.vertices[0])).toBe(true);
    expect(Object.isFrozen(result.mesh.triangles[0])).toBe(true);expect(result.maximumDistanceBound).toBeLessThanOrEqual(input.tolerance);
  });
  it.each([0,1,2])('XYZの軸%sが欠けた・非有限・同値・逆順の依頼を拒否する',axis=>{
    const input=request();
    for(const value of [undefined,NaN,Infinity,-Infinity,input.minimum[axis],input.minimum[axis]-1]){
      const maximum:unknown[]=[...input.maximum];maximum[axis]=value;expect(()=>decodeFunctionImplicitWorkRequest({...input,maximum})).toThrow();
    }
    expect(()=>decodeFunctionImplicitWorkRequest({...input,minimum:input.minimum.slice(0,2)})).toThrow();
  });
  it('表示式とASTの違い、不明な追加欄、予算超過を拒否する',()=>{
    const input=request();expect(()=>decodeFunctionImplicitWorkRequest({...input,periodic:true})).toThrow();
    expect(()=>decodeFunctionImplicitWorkRequest({...input,budget:{...input.budget,maximumSamples:200001}})).toThrow();
    const reply=executeFunctionImplicitWorkRequest({kind:'sample-function-implicit-surface',serial:1,request:{...input,
      expression:{...input.expression,source:'X+Y'}}},backend);
    expect(reply.result.status).toBe('invalid');expect(reply.result).not.toHaveProperty('mesh');
  });
  it('範囲外の点・精度超過・不正な三角形・別世代の返信を採用しない',()=>{
    const input=request(),reply=executeFunctionImplicitWorkRequest(createFunctionImplicitWorkEnvelope(1,input),backend);
    if(reply.result.status!=='ready') throw new Error(JSON.stringify(reply));
    const result=reply.result;
    for(const change of [{maximumDistanceBound:2},{mesh:{...result.mesh,vertices:[[3,0,0],...result.mesh.vertices.slice(1)]}},
      {mesh:{...result.mesh,triangles:[[0,0,1],...result.mesh.triangles.slice(1)]}}]){
      expect(()=>decodeFunctionImplicitWorkReply({...reply,result:{...result,...change}},input)).toThrow();
    }
    expect(()=>decodeFunctionImplicitWorkReply({...reply,identity:{...reply.identity,inputRevision:2}},input)).toThrow();
  });
  it('中止でWorkerを破棄し、次の計算を新しいWorkerで完了できる',async()=>{
    const ports:Port[]=[],client=new FunctionImplicitWorkerClient({createWorker:()=>{const port=new Port();ports.push(port);return port;}});
    try{
      const abort=new AbortController(),first=client.evaluate(request(),1000,abort.signal);abort.abort();
      expect(await first).toMatchObject({status:'cancelled'});expect(ports[0].terminated).toBe(true);
      const second=client.evaluate(request(),1000);ports[1].complete();expect(await second).toMatchObject({status:'result',result:{status:'ready'}});
    }finally{client.dispose();}
  });
});
