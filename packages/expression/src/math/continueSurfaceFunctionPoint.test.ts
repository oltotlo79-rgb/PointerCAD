import {beforeAll,describe,expect,it} from 'vitest';
import {createMathBackend} from './createMathBackend.js';
import {createFunctionMathSource} from './functionMathSource.js';
import {decodeSurfacePointWorkRequest,saveSurfacePointInput,type SurfacePointWorkRequest} from './surfacePointWorkRequest.js';
import {solveSurfaceFunctionPoints} from './solveSurfaceFunctionPoints.js';
import {continueSurfaceFunctionPoint} from './continueSurfaceFunctionPoint.js';
import {FUNCTION_SURFACE_LIMITS} from './functionSurfaceLimits.js';
import {createSurfacePointContinuationWorkEnvelope,decodeSurfacePointContinuationWorkReply} from './surfacePointContinuationWork.js';
import {executeSurfacePointContinuationWork} from './surfacePointContinuationWorkExecution.js';
import {decodePointContinuationRequest} from './pointCalculationContract.js';
import type {MathExecutionBackend} from './mathWorkExecution.js';

let backend:MathExecutionBackend;beforeAll(()=>{backend=createMathBackend();});
const context=()=>({backend,shouldStop:()=>undefined});
function input(decimal:string,outputs:readonly [string,string,string]=['U^2-coef("r")','V','U'],
  known:SurfacePointWorkRequest['known']=[{axis:'X',value:0},{axis:'Y',value:1}]) {
  const coefficients=[{id:'coefficient:r',label:'r',decimal}];
  return decodeSurfacePointWorkRequest({kind:'parametric-surface',identity:{documentId:'surface',documentVersion:1,editorId:'point',inputRevision:0},
    independent:['U','V'],outputs:outputs.map(source=>createFunctionMathSource(source,'text','degree',
      {axes:[],parameters:['U','V'],coefficients},backend)),coefficients,lower:[-4,-4],upper:[4,4],minimum:[-10,-10,-10],maximum:[10,10,10],
    tolerance:1e-7,budget:FUNCTION_SURFACE_LIMITS,known});
}
function anchor(request:SurfacePointWorkRequest,index:number){
  const result=solveSurfaceFunctionPoints(request,context());
  if(result.status!=='ready'||!result.exhaustive||!result.candidates[index])throw new Error(JSON.stringify(result));
  return result.candidates[index].location;
}

describe('媒介曲面上の点が編集の途中も同じ枝を保つ',()=>{
  it.each(['U^2+V^2','U^4+V^4'])('一条件の同じU/Vでも途中でXYZ範囲を離れる点を拒否する: %s',formula=>{
    const outputs=['U+coef("r")^2','V',formula]as const,known=[{axis:'Z'as const,value:0}];
    const first=input('-1',outputs,known),last=input('1',outputs,known);
    const before={...first,minimum:[0.5,-10,-10]as const},after={...last,minimum:before.minimum};
    expect(continueSurfaceFunctionPoint(before,after,anchor(before,0),context())).toEqual({status:'unresolved',reason:'branch-unproved'});
  });
  it.each([false,true])('二座標の枝は残りの座標が途中で範囲を離れると拒否する（U移動=%s）',moving=>{
    const outputs=[moving?'U-coef("r")':'U','V','coef("r")^2']as const;
    const first=input('-1',outputs),last=input('1',outputs);
    const before={...first,minimum:[-10,-10,0.5]as const},after={...last,minimum:before.minimum};
    expect(continueSurfaceFunctionPoint(before,after,anchor(before,0),context())).toEqual({status:'unresolved',reason:'branch-unproved'});
  });
  it('移動する二次曲面の極値が途中でXYZ範囲を離れると拒否する',()=>{
    const outputs=['U^2','V','(U-coef("r"))^2+V^2'] as const,known=[{axis:'Z' as const,value:0}];
    const first=input('-1',outputs,known),last=input('1',outputs,known);
    const before={...first,minimum:[0.5,-10,-10]as const},after={...last,minimum:before.minimum};
    expect(continueSurfaceFunctionPoint(before,after,anchor(before,0),context())).toEqual({status:'unresolved',reason:'branch-unproved'});
  });
  it('四次式の孤立したU/Vを保ったまま、他の出力の係数と法線をWorker越しに更新する',()=>{
    const outputs=['U+coef("r")','V','U^4+V^4'] as const,known=[{axis:'Z' as const,value:0}];
    const before=input('1',outputs,known),after=input('2',outputs,known),location=anchor(before,0);
    const envelope=createSurfacePointContinuationWorkEnvelope(1,{identity:after.identity,previous:saveSurfacePointInput(before),current:saveSurfacePointInput(after),anchor:location,
      direction:{kind:'normal',length:3,reverse:false}});
    const reply=decodeSurfacePointContinuationWorkReply(executeSurfacePointContinuationWork(envelope,backend),envelope.request);
    expect(reply.result.status).toBe('ready');if(reply.result.status!=='ready')throw new Error(JSON.stringify(reply));
    expect(reply.result.candidate.point).toEqual([2,0,0]);expect(reply.result.endpoint?.point[0]).toBeCloseTo(2,7);expect(reply.result.endpoint?.point[2]).toBeCloseTo(3,7);
  });
  it.each([[0,-2],[1,2]])('正負の枝%sを係数変更後のZ=%sまで追う',(index,expected)=>{
    const before=input('1'),after=input('4'),result=continueSurfaceFunctionPoint(before,after,anchor(before,index),context());
    expect(result.status).toBe('ready');if(result.status!=='ready')throw new Error(JSON.stringify(result));
    expect(result.candidate.point.slice(0,2)).toEqual([0,1]);expect(result.candidate.point[2]).toBeCloseTo(expected,7);
  });
  it('U/Vと出力X/Y/Zを編集進行の変数と取り違えず、結合した平面を追う',()=>{
    const outputs=['U+V','U-V','U*V'] as const;
    const before=input('1',outputs,[{axis:'X',value:0},{axis:'Y',value:0}]),after=input('1',outputs,[{axis:'X',value:3},{axis:'Y',value:1}]);
    const result=continueSurfaceFunctionPoint(before,after,anchor(before,0),context());
    expect(result.status).toBe('ready');if(result.status==='ready')expect(result.candidate.point[2]).toBeCloseTo(2,7);
  });
  it('厳密な保存U/Vは原式で復元するが、根の近くにあるだけの点は拒否する',()=>{
    const before=input('1'),choice={kind:'parametric-surface' as const,box:[{lower:1,upper:1},{lower:1,upper:1}] as const};
    expect(continueSurfaceFunctionPoint(before,input('4'),choice,context()).status).toBe('ready');
    expect(continueSurfaceFunctionPoint(before,before,{...choice,box:[{lower:1+1e-12,upper:1+1e-12},choice.box[1]]},context()))
      .toEqual({status:'unresolved',reason:'invalid-anchor'});
  });
  it('両端に同じ候補があっても途中で二枝が合流する編集は拒否する',()=>{
    const outputs=['U^2-coef("r")^2','V','U'] as const,before=input('-1',outputs),after=input('1',outputs);
    expect(continueSurfaceFunctionPoint(before,after,anchor(before,1),context())).toEqual({status:'unresolved',reason:'branch-unproved'});
  });
  it('解の消失・原式の差替え・不正な保存領域では古い座標を返さない',()=>{
    const before=input('1'),choice=anchor(before,1);
    expect(continueSurfaceFunctionPoint(before,input('-1'),choice,context())).toEqual({status:'unresolved',reason:'branch-missing'});
    expect(continueSurfaceFunctionPoint(before,input('1',['U^3','V','U']),choice,context())).toEqual({status:'unresolved',reason:'formula-changed'});
    expect(continueSurfaceFunctionPoint(before,before,{...choice,box:[{lower:5,upper:5},choice.box[1]]},context()))
      .toEqual({status:'unresolved',reason:'invalid-anchor'});
  });
  it('1座標で確定した円錐頂点は自由なUを保存しても同じ入力で復元できる',()=>{
    const before=input('1',['V*cos(U)','V*sin(U)','V'],[{axis:'Z',value:0}]);
    const result=continueSurfaceFunctionPoint(before,before,anchor(before,0),context());
    expect(result).toMatchObject({status:'ready',candidate:{point:[0,0,0],location:{box:[{lower:-4,upper:4},{lower:0,upper:0}]}}});
  });
  it.each(['(U-coef("r"))^2+V^2','-(U-coef("r"))^2-V^2','2*(U-coef("r"))^2+2*(U-coef("r"))*V+3*V^2'])(
    'Zだけで定まる二次曲面の極値を係数変更後も同じ1点として追う: %s',formula=>{
      const outputs=['U','V',formula] as const,known=[{axis:'Z' as const,value:0}];
      const before=input('1',outputs,known),after=input('2',outputs,known);
      const result=continueSurfaceFunctionPoint(before,after,anchor(before,0),context());
      expect(result.status,JSON.stringify(result)).toBe('ready');
      if(result.status==='ready'){expect(result.candidate.point[0]).toBeCloseTo(2,7);expect(result.candidate.point.slice(1)).toEqual([0,0]);}
    });
  it('極値の高さも既知座標の編集と一緒に変わる場合は原式の全途中で一致を証明する',()=>{
    const outputs=['U','V','(U-coef("r"))^2+V^2+coef("r")'] as const;
    const before=input('1',outputs,[{axis:'Z',value:1}]),after=input('2',outputs,[{axis:'Z',value:2}]);
    expect(continueSurfaceFunctionPoint(before,after,anchor(before,0),context())).toMatchObject({status:'ready',candidate:{point:[2,0,2]}});
  });
  it.each(['(U-coef("r"))^2+V^2+coef("r")^2-1','coef("r")^2*U^2+V^2'])(
    '両端が一意でも途中で等高線や自由な線になる1条件の変更は拒否する: %s',formula=>{
      const outputs=['U','V',formula] as const,known=[{axis:'Z' as const,value:0}];
      const before=input('-1',outputs,known),after=input('1',outputs,known);
      expect(continueSurfaceFunctionPoint(before,after,anchor(before,0),context())).toEqual({status:'unresolved',reason:'branch-unproved'});
    });
  it('既知座標が同じでも自由な媒介変数が途中で異なるXYZになる編集を拒否する',()=>{
    const outputs=['U*(coef("r")^2-1)','V','0'] as const,known=[{axis:'Y' as const,value:0}];
    const before=input('-1',outputs,known),after=input('1',outputs,known);
    expect(continueSurfaceFunctionPoint(before,after,anchor(before,0),context())).toEqual({status:'unresolved',reason:'branch-unproved'});
  });
  it('編集の前後が同じ頂点でも途中でUの指定範囲を出る変更は拒否する',()=>{
    const outputs=['U','V','(U-coef("r")^2)^2+V^2'] as const,known=[{axis:'Z' as const,value:0}];
    const before=decodeSurfacePointWorkRequest({...input('-1',outputs,known),lower:[0.5,-4]});
    const after=decodeSurfacePointWorkRequest({...input('1',outputs,known),lower:[0.5,-4]});
    expect(continueSurfaceFunctionPoint(before,after,anchor(before,0),context())).toEqual({status:'unresolved',reason:'branch-unproved'});
  });
  it('保存JSONをWorkerで復元・編集し、古い返信や別形式の枝を拒否する',()=>{
    const before=input('1'),after=input('4');
    const request={identity:after.identity,previous:saveSurfacePointInput(before),current:saveSurfacePointInput(after),anchor:anchor(before,1)};
    expect(decodePointContinuationRequest(JSON.parse(JSON.stringify(request)))).toEqual(request);
    const reply=executeSurfacePointContinuationWork(createSurfacePointContinuationWorkEnvelope(3,request),backend);
    const checked=decodeSurfacePointContinuationWorkReply(reply,request);expect(checked.result.status).toBe('ready');
    expect(()=>decodeSurfacePointContinuationWorkReply({...reply,kind:'curve-point-continuation-result'},request)).toThrow();
    expect(()=>decodeSurfacePointContinuationWorkReply({...reply,identity:{...reply.identity,documentVersion:0}},request)).toThrow();
    expect(()=>decodePointContinuationRequest({...request,current:{...request.current,kind:'curve'}})).toThrow();
  });
  it('追従の取消を成功や前の座標に置き換えない',()=>{
    const before=input('1'),choice=anchor(before,1);
    expect(continueSurfaceFunctionPoint(before,input('4'),choice,{backend,shouldStop:()=> 'cancelled'})).toEqual({status:'stopped',reason:'cancelled'});
  });
});
