import {beforeAll,describe,expect,it} from 'vitest';
import {createMathBackend} from './createMathBackend.js';
import {createFunctionMathSource} from './functionMathSource.js';
import {decodeCurvePointWorkRequest,saveCurvePointInput,type CurvePointWorkRequest} from './curvePointWorkRequest.js';
import {createCurvePointWorkEnvelope} from './curvePointWorkEnvelope.js';
import {executeCurvePointWorkRequest} from './curvePointWorkExecution.js';
import {decodeCurvePointWorkReply} from './curvePointWorkReply.js';
import {CurvePointWorkerClient,CurvePointContinuationWorkerClient} from './curvePointWorkerClient.js';
import {decodeCurvePointContinuationWorkRequest,decodeCurvePointContinuationWorkReply} from './curvePointContinuationWork.js';
import {executeCurvePointContinuationWork} from './curvePointContinuationWorkExecution.js';
import type {CalculationWorkerPort} from './boundedCalculationClient.js';
import type {MathExecutionBackend} from './mathWorkExecution.js';
import {PointCalculationWorkerClient} from './pointCalculationWorkerClient.js';
import {decodePointContinuationRequest} from './pointCalculationContract.js';
import {executeFunctionPointWorkRequest} from './functionPointWorkExecution.js';
import {decodeFunctionPointWorkRequest} from './functionPointWorkRequest.js';

let backend:MathExecutionBackend;beforeAll(()=>{backend=createMathBackend();});
function request():CurvePointWorkRequest {
  return decodeCurvePointWorkRequest({kind:'curve',identity:{documentId:'curve',documentVersion:2,editorId:'point',inputRevision:1},
    independent:'T',outputs:['T^2','T','0'].map(source=>createFunctionMathSource(source,'text','degree',{axes:[],parameters:['T'],coefficients:[]},backend)),
    lower:-4,upper:4,minimum:[-4,-4,-4],maximum:[4,4,4],tolerance:1e-7,coefficients:[],known:[{axis:'X',value:1}]});
}
function evaluate(input:CurvePointWorkRequest){return executeCurvePointWorkRequest(createCurvePointWorkEnvelope(1,input),backend);}
class Port implements CalculationWorkerPort {
  onmessage:CalculationWorkerPort['onmessage']=null;onerror:CalculationWorkerPort['onerror']=null;onmessageerror:CalculationWorkerPort['onmessageerror']=null;
  input:unknown;terminated=false;postMessage(value:unknown):void{this.input=value;}terminate():void{this.terminated=true;}
  constructor(readonly execute:(value:unknown)=>unknown=value=>executeCurvePointWorkRequest(value,backend)){}
  complete():void{this.onmessage?.({data:this.execute(this.input)});}
}

describe('曲線上の点の独立した計算通信',()=>{
  it('1つの待機列で曲線から等式へ切り替えても、違う形式の返信を採用しない',async()=>{
    const port=new Port(),client=new PointCalculationWorkerClient({createWorker:()=>port}),curve=request();
    const implicit=decodeFunctionPointWorkRequest({identity:{...curve.identity,inputRevision:2},
      expression:createFunctionMathSource('X^2+Y^2-1','text','degree',{axes:['X','Y'],parameters:[],coefficients:[]},backend),
      minimum:curve.minimum,maximum:curve.maximum,tolerance:curve.tolerance,coefficients:[],known:[{axis:'X',value:0}],fixed:{axis:'Z',value:0}});
    try {
      const first=client.evaluate(curve,5000),second=client.evaluate(implicit,5000);
      port.complete();expect((await first).status).toBe('result');
      const envelope=port.input,reply=executeFunctionPointWorkRequest(envelope,backend);port.onmessage?.({data:reply});
      const done=await second;expect(done.status).toBe('result');
      if(done.status!=='result'||done.result.status!=='ready')throw new Error(JSON.stringify(done));
      expect(done.result.candidates.map(item=>item.point)).toEqual([[0,-1,0],[0,1,0]]);
    }finally{client.dispose();}
    const wrongPort=new Port(),wrongClient=new PointCalculationWorkerClient({createWorker:()=>wrongPort});
    try {
      const pending=wrongClient.evaluate(curve,5000),reply=executeFunctionPointWorkRequest({kind:'solve-function-points',serial:1,request:implicit},backend);
      wrongPort.onmessage?.({data:{...reply,identity:curve.identity}});expect((await pending).status).toBe('worker-error');
    }finally{wrongClient.dispose();}
    const {identity:_identity,...savedImplicit}=implicit;void _identity;
    expect(()=>decodePointContinuationRequest({identity:curve.identity,previous:saveCurvePointInput(curve),current:savedImplicit,
      anchor:{kind:'curve',independent:'T',interval:{lower:1,upper:1},direct:false}})).toThrow();
  });
  it('正負の媒介変数とXYZの範囲を保持し、返信の座標と選択区間を不変にする',()=>{
    const input=request(),reply=decodeCurvePointWorkReply(evaluate(input),input);
    if(reply.result.status!=='ready') throw new Error(JSON.stringify(reply));
    expect(reply.result.exhaustive).toBe(true);expect(reply.result.candidates.map(item=>item.point)).toEqual([[1,-1,0],[1,1,0]]);
    for(const item of reply.result.candidates){expect(Object.isFrozen(item.point)).toBe(true);expect(Object.isFrozen(item.location.interval)).toBe(true);}
  });
  it('古い文書世代・入力世代・誤った依頼番号・別種の返信を拒否する',()=>{
    const input=request(),reply=evaluate(input);
    for(const value of [{...reply,identity:{...reply.identity,documentVersion:1}},
      {...reply,identity:{...reply.identity,inputRevision:0}},{...reply,serial:0},{...reply,kind:'function-points-result'}]) {
      expect(()=>decodeCurvePointWorkReply(value,input)).toThrow();
    }
  });
  it('表示する原式と保存された数式の内容が違えば候補を返さない',()=>{
    const original=request(),input={...original,outputs:[{...original.outputs[0],source:'0'},original.outputs[1],original.outputs[2]] as const};
    expect(evaluate(input).result.status).toBe('invalid');
  });
  it('改変された座標・精度・範囲・既知座標・媒介変数の位置を拒否する',()=>{
    const input=request(),reply=evaluate(input);if(reply.result.status!=='ready') throw new Error(JSON.stringify(reply));
    const first=reply.result.candidates[0];
    for(const candidate of [{...first,point:[1,Infinity,0]}, {...first,maximum:[1,1,0]},
      {...first,point:[2,-1,0],minimum:[2,-1,0],maximum:[2,-1,0]},
      {...first,location:{...first.location,interval:{lower:-5,upper:-5}}},
      {...first,location:{...first.location,independent:'X'}}, {...first,location:{...first.location,direct:true}},
      {...first,location:{...first.location,parameter:123}}]) {
      expect(()=>decodeCurvePointWorkReply({...reply,result:{...reply.result,candidates:[candidate]}},input)).toThrow();
    }
  });
  it('未解決領域を残した完了報告と、根拠のない範囲外の報告を拒否する',()=>{
    const input=request(),reply=evaluate(input);
    for(const result of [{status:'ready',candidates:[],exhaustive:true,unresolved:[{interval:{lower:-1,upper:1},reason:'precision'}]},
      {status:'ready',candidates:[],exhaustive:false,unresolved:[]}, {status:'out-of-range',axes:['X']},
      {status:'ready',candidates:[],exhaustive:false,unresolved:[{interval:{lower:-5,upper:1},reason:'domain'}]}]) {
      expect(()=>decodeCurvePointWorkReply({...reply,result},input)).toThrow();
    }
  });
  it('中止した計算の遅い返信が次の入力の候補を上書きしない',async()=>{
    const ports:Port[]=[],client=new CurvePointWorkerClient({createWorker:()=>{const port=new Port();ports.push(port);return port;}});
    try {
      const input=request(),abort=new AbortController(),old=client.evaluate(input,5000,abort.signal),stale=ports[0].onmessage;
      const oldReply=executeCurvePointWorkRequest(ports[0].input,backend);abort.abort();expect((await old).status).toBe('cancelled');
      const changed={...input,known:[{axis:'X' as const,value:4}],identity:{...input.identity,inputRevision:2}};
      const next=client.evaluate(changed,5000);stale?.({data:oldReply});expect(ports[0].terminated).toBe(true);
      ports[1].complete();const completed=await next;
      expect(completed.status).toBe('result');if(completed.status!=='result' || completed.result.status!=='ready') throw new Error(JSON.stringify(completed));
      expect(completed.identity.inputRevision).toBe(2);expect(completed.result.candidates.map(item=>item.point[0])).toEqual([4,4]);
    } finally {client.dispose();}
  });
  it('保存入力に実行世代を残さず、原式・3出力・全XYZ・T範囲を再検証する',()=>{
    const input=request(),previous=saveCurvePointInput(input),reply=decodeCurvePointWorkReply(evaluate(input),input);
    if(reply.result.status!=='ready') throw new Error(JSON.stringify(reply));
    expect(Object.hasOwn(previous,'identity')).toBe(false);
    const value={identity:input.identity,previous,current:previous,anchor:reply.result.candidates[1].location};
    expect(decodeCurvePointContinuationWorkRequest(value).previous).toEqual(previous);
    const {maximum:_maximum,...missing}=previous;void _maximum;
    for(const broken of [{...value,previous:missing},{...value,current:{...previous,identity:input.identity}},
      {...value,anchor:{...value.anchor,interval:{lower:-5,upper:-5}}}]) expect(()=>decodeCurvePointContinuationWorkRequest(broken)).toThrow();
  });
  it('保存した正の枝の追従を独立した計算として実行し、現在のXYZ条件を照合する',async()=>{
    const input=request(),initial=decodeCurvePointWorkReply(evaluate(input),input);if(initial.result.status!=='ready') throw new Error(JSON.stringify(initial));
    const work={identity:input.identity,previous:saveCurvePointInput(input),
      current:saveCurvePointInput({...input,known:[{axis:'X',value:4}]}),anchor:initial.result.candidates[1].location};
    const port=new Port(value=>executeCurvePointContinuationWork(value,backend)),client=new CurvePointContinuationWorkerClient({createWorker:()=>port});
    try {
      const pending=client.evaluate(work,5000);const reply=executeCurvePointContinuationWork(port.input,backend);
      expect(decodeCurvePointContinuationWorkReply(reply,work).result).toMatchObject({status:'ready',candidate:{point:[4,2,0]}});
      expect(()=>decodeCurvePointContinuationWorkReply({...reply,identity:{...reply.identity,inputRevision:999}},work)).toThrow();
      port.onmessage?.({data:reply});const result=await pending;expect(result.status).toBe('result');
    } finally {client.dispose();}
    expect(port.terminated).toBe(true);
  });
});
