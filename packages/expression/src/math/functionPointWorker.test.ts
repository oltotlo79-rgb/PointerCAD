import {beforeAll,describe,expect,it,vi} from 'vitest';
import {createMathBackend} from './createMathBackend.js';
import {createFunctionMathSource} from './functionMathSource.js';
import {decodeFunctionPointWorkRequest,createFunctionPointWorkEnvelope,type FunctionPointWorkRequest} from './functionPointWorkRequest.js';
import {executeFunctionPointWorkRequest} from './functionPointWorkExecution.js';
import {decodeFunctionPointWorkReply} from './functionPointWorkReply.js';
import {FunctionPointWorkerClient} from './functionPointWorkerClient.js';
import type {CalculationWorkerPort} from './boundedCalculationClient.js';
import type {MathExecutionBackend} from './mathWorkExecution.js';

let backend:MathExecutionBackend;beforeAll(()=>{backend=createMathBackend();});
function request():FunctionPointWorkRequest {
  return {identity:{documentId:'part',documentVersion:4,editorId:'function-point',inputRevision:2},
    expression:createFunctionMathSource('X^2+Y^2+Z^2-1','text','radian',{axes:['X','Y','Z'],parameters:[],coefficients:[]},backend),
    coefficients:[],minimum:[-2,-2,-2],maximum:[2,2,2],tolerance:1e-6,known:[{axis:'X',value:0},{axis:'Y',value:0}]};
}
function evaluate(input:FunctionPointWorkRequest){
  return executeFunctionPointWorkRequest(createFunctionPointWorkEnvelope(1,input),backend);
}
class Port implements CalculationWorkerPort {
  onmessage:CalculationWorkerPort['onmessage']=null;onerror:CalculationWorkerPort['onerror']=null;onmessageerror:CalculationWorkerPort['onmessageerror']=null;
  input:unknown;terminated=false;postMessage(value:unknown):void{this.input=value;}terminate():void{this.terminated=true;}
  complete():void{this.onmessage?.({data:executeFunctionPointWorkRequest(this.input,backend)});}
}
describe('関数上の点のWorker境界',()=>{
  it('原式とXYZ範囲から球の2枝を返し、返信の全座標を不変にする',()=>{
    const input=request(),reply=decodeFunctionPointWorkReply(evaluate(input),input);
    if(reply.result.status!=='ready') throw new Error(JSON.stringify(reply));
    expect(reply.result.candidates.map(item=>item.point)).toEqual([[0,0,-1],[0,0,1]]);
    expect(reply.result.exhaustive).toBe(true);
    expect(Object.isFrozen(reply.result.candidates[0].point)).toBe(true);
  });
  it.each([0,1,2])('XYZ軸%sの欠落・非有限・同値・逆転を処理前に拒否する',axis=>{
    const input=request();
    for(const value of [undefined,NaN,Infinity,-Infinity,input.minimum[axis],input.minimum[axis]-1]){
      const maximum:unknown[]=[...input.maximum];maximum[axis]=value;
      expect(()=>decodeFunctionPointWorkRequest({...input,maximum})).toThrow();
    }
  });
  it('既知の座標・式・世代を呼出元の再書換から保護する',()=>{
    const original=request(),known=[{axis:'X',value:0} as const],minimum=[-2,-2,-2];
    const mutable={...original,known,minimum,identity:{...original.identity}},owned=decodeFunctionPointWorkRequest(mutable);
    known.pop();minimum[0]=999;mutable.identity.inputRevision=999;
    expect(owned.known).toEqual([{axis:'X',value:0}]);expect(owned.minimum[0]).toBe(-2);expect(owned.identity.inputRevision).toBe(2);
    expect(Object.isFrozen(owned.expression.expression)).toBe(true);
    for(const known of [[],[{axis:'X',value:0},{axis:'X',value:1}],[{axis:'T',value:0}],[{axis:'Y',value:Infinity}]]) {
      expect(()=>decodeFunctionPointWorkRequest({...original,known})).toThrow();
    }
  });
  it('原式と食い違うASTを再解析で拒否する',()=>{
    const input=request(),expression={...input.expression,source:'X^2+Y^2+Z^2-4'};
    expect(evaluate({...input,expression}).result.status).toBe('invalid');
  });
  it('一意な極・自由度不足・範囲外・未解決領域を区別して受け取る',()=>{
    for(const [value,status] of [[1,'ready'],[0,'underconstrained'],[3,'out-of-range']] as const){
      const input={...request(),known:[{axis:'Z',value} as const]};
      expect(decodeFunctionPointWorkReply(evaluate(input),input).result.status).toBe(status);
    }
    const original=request(),input={...original,expression:createFunctionMathSource('1/Z','text','radian',
      {axes:['X','Y','Z'],parameters:[],coefficients:[]},backend)};
    const reply=decodeFunctionPointWorkReply(evaluate(input),input);expect(reply.result.status).toBe('ready');
    if(reply.result.status!=='ready') throw new Error('Missing result');
    expect(reply.result.exhaustive).toBe(false);expect(reply.result.unresolved.length).toBeGreaterThan(0);
    expect(()=>decodeFunctionPointWorkReply({...reply,result:{...reply.result,exhaustive:true}},input)).toThrow();
  });
  it('既知値変更・範囲外・巨大誤差・NaN・枝情報の改変を採用しない',()=>{
    const input=request(),reply=evaluate(input);if(reply.result.status!=='ready') throw new Error('Missing result');
    const original=reply.result.candidates[0];
    for(const item of [{...original,point:[1,0,-1]},{...original,minimum:[0,0,-3]},
      {...original,minimum:[0,0,-1.01]},{...original,point:[0,0,NaN]},
      {...original,location:{kind:'implicit',axis:'X',interval:{lower:0,upper:0}}}]){
      expect(()=>decodeFunctionPointWorkReply({...reply,result:{...reply.result,candidates:[item]}},input)).toThrow();
    }
    expect(()=>decodeFunctionPointWorkReply({...reply,identity:{...reply.identity,documentVersion:5}},input)).toThrow();
  });
  it('取消・時間切れ後の古い返信を捨て、新Workerで次の点を求める',async()=>{
    vi.useFakeTimers();const ports:Port[]=[],client=new FunctionPointWorkerClient({createWorker:()=>{const port=new Port();ports.push(port);return port;}});
    try{
      const abort=new AbortController(),first=client.evaluate(request(),1000,abort.signal),stale=ports[0].onmessage;
      abort.abort();expect((await first).status).toBe('cancelled');expect(ports[0].terminated).toBe(true);
      const second=client.evaluate(request(),1000);await vi.advanceTimersByTimeAsync(1000);
      expect((await second).status).toBe('deadline');expect(ports[1].terminated).toBe(true);
      const third=client.evaluate(request(),1000);stale?.({data:evaluate(request())});ports[2].complete();
      expect(await third).toMatchObject({status:'result',result:{status:'ready',exhaustive:true}});
    }finally{client.dispose();vi.useRealTimers();}
  });
});
