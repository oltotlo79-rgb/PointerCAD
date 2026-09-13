import {beforeAll,describe,expect,it} from 'vitest';
import {createMathBackend} from './createMathBackend.js';
import {createFunctionMathSource} from './functionMathSource.js';
import {decodeSurfacePointWorkRequest,saveSurfacePointInput,type SurfacePointWorkRequest} from './surfacePointWorkRequest.js';
import {createSurfacePointWorkEnvelope} from './surfacePointWorkEnvelope.js';
import {executeSurfacePointWorkRequest} from './surfacePointWorkExecution.js';
import {decodeSurfacePointWorkReply} from './surfacePointWorkReply.js';
import {SurfacePointWorkerClient} from './surfacePointWorkerClient.js';
import {FUNCTION_SURFACE_LIMITS} from './functionSurfaceLimits.js';
import type {CalculationWorkerPort} from './boundedCalculationClient.js';
import type {MathExecutionBackend} from './mathWorkExecution.js';

let backend:MathExecutionBackend;beforeAll(()=>{backend=createMathBackend();});
function request(outputs:readonly [string,string,string]=['U+V','U-V','U*V'],
  known:SurfacePointWorkRequest['known']=[{axis:'X',value:3},{axis:'Y',value:1}]):SurfacePointWorkRequest {
  return decodeSurfacePointWorkRequest({kind:'parametric-surface',identity:{documentId:'surface',documentVersion:2,editorId:'point',inputRevision:1},
    independent:['U','V'],outputs:outputs.map(source=>createFunctionMathSource(source,'text','degree',
      {axes:[],parameters:['U','V'],coefficients:[]},backend)),coefficients:[],lower:[-4,-4],upper:[4,4],
    minimum:[-10,-10,-10],maximum:[10,10,10],tolerance:1e-7,budget:FUNCTION_SURFACE_LIMITS,known});
}
function evaluate(input:SurfacePointWorkRequest){return executeSurfacePointWorkRequest(createSurfacePointWorkEnvelope(1,input),backend);}
class Port implements CalculationWorkerPort {
  onmessage:CalculationWorkerPort['onmessage']=null;onerror:CalculationWorkerPort['onerror']=null;onmessageerror:CalculationWorkerPort['onmessageerror']=null;
  input:unknown;terminated=false;postMessage(value:unknown):void{this.input=value;}terminate():void{this.terminated=true;}
  complete():void{this.onmessage?.({data:executeSurfacePointWorkRequest(this.input,backend)});}
}

describe('媒介曲面上の点の独立した計算通信',()=>{
  it('実計算でX/YからU/Vを解いた結果を照合し、元のXYZと選択領域を不変にする',()=>{
    const input=request(),reply=decodeSurfacePointWorkReply(evaluate(input),input);
    if(reply.result.status!=='ready')throw new Error(JSON.stringify(reply));
    expect(reply.result.exhaustive).toBe(true);expect(reply.result.candidates).toHaveLength(1);
    const candidate=reply.result.candidates[0];expect(candidate.point.slice(0,2)).toEqual([3,1]);
    expect(candidate.point[2]).toBeCloseTo(2,7);expect(candidate.minimum[2]).toBeLessThanOrEqual(2);expect(candidate.maximum[2]).toBeGreaterThanOrEqual(2);
    expect(Object.isFrozen(candidate.point)).toBe(true);expect(Object.isFrozen(candidate.location.box)).toBe(true);
    expect(Object.isFrozen(candidate.location.box[0])).toBe(true);
  });
  it('1座標で決まる頂点では自由なU領域を失わず、架空のU値を保存しない',()=>{
    const input=request(['V*cos(U)','V*sin(U)','V'],[{axis:'Z',value:0}]);
    const reply=decodeSurfacePointWorkReply(evaluate(input),input);if(reply.result.status!=='ready')throw new Error(JSON.stringify(reply));
    expect(reply.result.candidates[0].point).toEqual([0,0,0]);
    expect(reply.result.candidates[0].location.box[0]).toEqual({lower:-4,upper:4});
    const saved=saveSurfacePointInput(input);expect(Object.hasOwn(saved,'identity')).toBe(false);
    expect(saved.lower).toEqual([-4,-4]);expect(saved.minimum).toEqual([-10,-10,-10]);
    const {maximum:_maximum,...missing}=input;void _maximum;
    expect(()=>saveSurfacePointInput(missing)).toThrow();
  });
  it('別形式の返信・古い文書/入力世代・無効な依頼番号を拒否する',()=>{
    const input=request(),reply=evaluate(input);
    for(const value of [{...reply,kind:'curve-points-result'},{...reply,serial:0},
      {...reply,identity:{...reply.identity,documentVersion:1}},{...reply,identity:{...reply.identity,inputRevision:0}}]){
      expect(()=>decodeSurfacePointWorkReply(value,input)).toThrow();
    }
  });
  it('表示原式と保存した式の不一致を計算側でも拒否する',()=>{
    const input=request();expect(evaluate({...input,outputs:[{...input.outputs[0],source:'0'},input.outputs[1],input.outputs[2]]}).result.status).toBe('invalid');
  });
  it('非有限値・精度超過・既知座標の改変・U/V範囲外・余分な選択情報を拒否する',()=>{
    const input=request(),reply=evaluate(input);if(reply.result.status!=='ready')throw new Error(JSON.stringify(reply));
    const first=reply.result.candidates[0];
    for(const candidate of [{...first,point:[3,1,Infinity]},{...first,maximum:[3,1,3]},
      {...first,point:[4,1,2],minimum:[4,1,2],maximum:[4,1,2]},
      {...first,location:{...first.location,box:[{lower:-5,upper:-5},{lower:1,upper:1}]}},
      {...first,location:{...first.location,box:[{lower:-4,upper:4},{lower:1,upper:1}]}},
      {...first,location:{...first.location,selectedU:2}},{...first,location:{...first.location,kind:'curve'}}]){
      expect(()=>decodeSurfacePointWorkReply({...reply,result:{...reply.result,candidates:[candidate]}},input)).toThrow();
    }
  });
  it('未解決領域を隠す完了報告と、根拠のない範囲外報告を拒否する',()=>{
    const input=request(),reply=evaluate(input),box=[{lower:-1,upper:1},{lower:-1,upper:1}];
    for(const result of [{status:'ready',candidates:[],exhaustive:true,unresolved:[{box,reason:'singular'}]},
      {status:'ready',candidates:[],exhaustive:false,unresolved:[]},{status:'out-of-range',axes:['X']},
      {status:'ready',candidates:[],exhaustive:false,unresolved:[{box:[{lower:-5,upper:0},box[1]],reason:'domain'}]}]){
      expect(()=>decodeSurfacePointWorkReply({...reply,result},input)).toThrow();
    }
  });
  it('取消後の遅い返信が、新しい座標指定の候補へ入り込まない',async()=>{
    const ports:Port[]=[],client=new SurfacePointWorkerClient({createWorker:()=>{const port=new Port();ports.push(port);return port;}});
    try {
      const input=request(),abort=new AbortController(),old=client.evaluate(input,5000,abort.signal),stale=ports[0].onmessage;
      const reply=executeSurfacePointWorkRequest(ports[0].input,backend);abort.abort();expect((await old).status).toBe('cancelled');
      const changed={...input,identity:{...input.identity,inputRevision:2},known:[{axis:'X' as const,value:2},{axis:'Y' as const,value:0}]};
      const next=client.evaluate(changed,5000);stale?.({data:reply});expect(ports[0].terminated).toBe(true);
      ports[1].complete();const done=await next;
      expect(done.status).toBe('result');if(done.status!=='result'||done.result.status!=='ready')throw new Error(JSON.stringify(done));
      expect(done.identity.inputRevision).toBe(2);expect(done.result.candidates[0].point.slice(0,2)).toEqual([2,0]);
      expect(done.result.candidates[0].point[2]).toBeCloseTo(1,7);
    }finally{client.dispose();}
  });
});
