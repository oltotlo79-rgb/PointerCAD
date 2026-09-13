import {beforeAll,describe,expect,it} from 'vitest';
import {createMathBackend} from './createMathBackend.js';
import {createFunctionMathSource} from './functionMathSource.js';
import {solveImplicitFunctionPoints} from './solveImplicitFunctionPoints.js';
import {FunctionPointContinuationWorkerClient} from './functionPointWorkerClient.js';
import {executeFunctionPointContinuationWork} from './functionPointContinuationWorkExecution.js';
import {saveFunctionPointInput} from './functionPointWorkRequest.js';
import {decodeFunctionPointContinuationWorkRequest,createFunctionPointContinuationWorkEnvelope,
  decodeFunctionPointContinuationWorkReply,type FunctionPointContinuationWorkRequest,type FunctionPointSavedInput} from './functionPointContinuationWork.js';
import type {CalculationWorkerPort} from './boundedCalculationClient.js';
import type {MathExecutionBackend} from './mathWorkExecution.js';

let backend:MathExecutionBackend;beforeAll(()=>{backend=createMathBackend();});
function geometry(radius:string):FunctionPointSavedInput {
  const coefficients=[{id:'coef:1',label:'半径',decimal:radius}];
  return {expression:createFunctionMathSource('X^2+Y^2+Z^2-coef("半径")^2','text','radian',
    {axes:['X','Y','Z'],parameters:[],coefficients},backend),coefficients,
    minimum:[-2,-2,-2],maximum:[2,2,2],tolerance:1e-6,known:[{axis:'X',value:0},{axis:'Y',value:0}]};
}
function request():FunctionPointContinuationWorkRequest {
  const previous=geometry('1'),result=solveImplicitFunctionPoints(previous,{backend,shouldStop:()=>undefined});
  if(result.status!=='ready') throw new Error(JSON.stringify(result));
  return {identity:{documentId:'part',documentVersion:4,editorId:'point',inputRevision:2},previous,current:geometry('1.5'),anchor:result.candidates[1].location};
}
function evaluate(input:FunctionPointContinuationWorkRequest){
  return decodeFunctionPointContinuationWorkReply(executeFunctionPointContinuationWork(createFunctionPointContinuationWorkEnvelope(1,input),backend),input);
}
class Port implements CalculationWorkerPort {
  onmessage:CalculationWorkerPort['onmessage']=null;onerror:CalculationWorkerPort['onerror']=null;onmessageerror:CalculationWorkerPort['onmessageerror']=null;
  input:unknown;terminated=false;postMessage(value:unknown):void{this.input=value;}terminate():void{this.terminated=true;}
  complete():void{this.onmessage?.({data:executeFunctionPointContinuationWork(this.input,backend)});}
}
describe('同一枝の再計算をWorker越しに受け取る',()=>{
  it('枝を再検証した後に法線の終点を返し、欠落や別の長さの返信を拒否する',()=>{
    const input={...request(),direction:{kind:'normal' as const,length:2,reverse:true}},reply=evaluate(input);
    if(reply.result.status!=='ready')throw new Error(JSON.stringify(reply));
    const {candidate}=reply.result;
    expect(reply.result.candidate.point).toEqual([0,0,1.5]);expect(reply.result.endpoint?.point[2]).toBeCloseTo(-0.5,7);
    expect(Object.isFrozen(reply.result.endpoint?.point)).toBe(true);
    expect(()=>decodeFunctionPointContinuationWorkReply({...reply,result:{status:'ready',candidate}},input)).toThrow();
    expect(()=>decodeFunctionPointContinuationWorkReply(reply,{...input,direction:{...input.direction,length:3}})).toThrow();
    expect(()=>decodeFunctionPointContinuationWorkReply(reply,request())).toThrow();
    expect(evaluate({...input,current:geometry('-1')}).result.status).toBe('unresolved');
  });
  it('保存用の原式・係数・XYZは元の入力を書き換えても変わらず、実行世代を混入しない',()=>{
    const original=structuredClone({...geometry('1'),identity:request().identity});
    const saved=saveFunctionPointInput(original);
    const expected=structuredClone(saved);
    Reflect.set(original.minimum,0,-100);
    Reflect.set(original.known[0],'value',100);
    Reflect.set(original.coefficients[0],'decimal','10');
    Reflect.set(original.expression,'source','0');
    expect(saved).toEqual(expected);
    expect(Object.hasOwn(saved,'identity')).toBe(false);
    for(const value of [saved,saved.minimum,saved.known,saved.known[0],saved.coefficients[0],saved.expression]) {
      expect(Object.isFrozen(value)).toBe(true);
    }
  });
  it.each(['minimum','maximum','expression','tolerance'])('保存時にも必須の%sの欠落を拒否する',key=>{
    const original={...geometry('1'),identity:request().identity};
    Reflect.deleteProperty(original,key);
    expect(()=>saveFunctionPointInput(original)).toThrow();
  });
  it('保存した正Zの枝から半径変更後の正Zへ追従する',()=>{
    const reply=evaluate(request());expect(reply.result).toMatchObject({status:'ready',candidate:{point:[0,0,1.5]}});
    if(reply.result.status!=='ready') throw new Error(JSON.stringify(reply));
    expect(Object.isFrozen(reply.result.candidate.point)).toBe(true);
  });
  it('枝が途中で合流すると成功した別候補を返さず再選択を要求する',()=>{
    expect(evaluate({...request(),current:geometry('-1')}).result).toEqual({status:'unresolved',reason:'branch-unproved'});
  });
  it('前後のXYZ・既知値・原式・選択区間を深く不変にする',()=>{
    const decoded=decodeFunctionPointContinuationWorkRequest(request());
    for(const value of [decoded.previous.minimum,decoded.current.maximum,decoded.previous.known[0],decoded.current.coefficients[0],
      decoded.current.expression.expression,decoded.anchor]) expect(Object.isFrozen(value)).toBe(true);
  });
  it('過去入力への別世代や再帰的な追従条件の混入、範囲外・非有限の区間を拒否する',()=>{
    const input=request();
    for(const previous of [{...input.previous,identity:input.identity},{...input.previous,previous:input.previous},
      {...input.previous,minimum:[-2,-2,Infinity]}]) expect(()=>decodeFunctionPointContinuationWorkRequest({...input,previous})).toThrow();
    for(const interval of [{lower:-3,upper:-3},{lower:0,upper:1},{lower:NaN,upper:1}]) {
      expect(()=>decodeFunctionPointContinuationWorkRequest({...input,anchor:{kind:'implicit',axis:'Z',interval}})).toThrow();
    }
  });
  it('書き換えた前の原式をキャッシュとして信頼しない',()=>{
    const input=request(),previous={...input.previous,expression:{...input.previous.expression,source:'X^2+Y^2+Z^2-4'}};
    expect(evaluate({...input,previous}).result.status).toBe('invalid');
  });
  it('古い世代・ずらされた既知値・過大な誤差の返信を拒否する',()=>{
    const input=request(),reply=evaluate(input);if(reply.result.status!=='ready') throw new Error('Missing result');
    expect(()=>decodeFunctionPointContinuationWorkReply({...reply,identity:{...reply.identity,inputRevision:3}},input)).toThrow();
    const candidate=reply.result.candidate;
    for(const changed of [{...candidate,point:[1,0,1.5]},{...candidate,minimum:[0,0,1]}]){
      expect(()=>decodeFunctionPointContinuationWorkReply({...reply,result:{status:'ready',candidate:changed}},input)).toThrow();
    }
  });
  it('取消時はWorkerを破棄し、次の再計算を新Workerで行う',async()=>{
    const ports:Port[]=[],client=new FunctionPointContinuationWorkerClient({createWorker:()=>{const port=new Port();ports.push(port);return port;}});
    try{
      const abort=new AbortController(),first=client.evaluate(request(),1000,abort.signal);abort.abort();
      expect((await first).status).toBe('cancelled');expect(ports[0].terminated).toBe(true);
      const second=client.evaluate(request(),1000);ports[1].complete();expect(await second).toMatchObject({status:'result',result:{status:'ready'}});
    }finally{client.dispose();}
  });
});
