import {beforeAll,describe,expect,it} from 'vitest';
import {createMathBackend} from './createMathBackend.js';
import {createFunctionMathSource} from './functionMathSource.js';
import {decodeCurvePointWorkRequest,type CurvePointCandidate} from './curvePointWorkRequest.js';
import {decodeSurfacePointWorkRequest,type SurfacePointCandidate} from './surfacePointWorkRequest.js';
import {FUNCTION_SURFACE_LIMITS} from './functionSurfaceWorkRequest.js';
import {decodeFunctionPointWorkRequest} from './functionPointWorkRequest.js';
import {functionPointFrame,functionDirectionEndpoint} from './functionPointFrame.js';
import {decodeFunctionDirection,decodeFunctionDirectionEndpoint} from './functionDirectionContract.js';
import type {MathExecutionBackend} from './mathWorkExecution.js';

let backend:MathExecutionBackend;beforeAll(()=>{backend=createMathBackend();});
const identity={documentId:'directions',documentVersion:0,editorId:'direction',inputRevision:0};
const context=()=>({backend,shouldStop:()=>undefined});
const origin={point:[0,0,0] as const,minimum:[0,0,0] as const,maximum:[0,0,0] as const};
function curve(outputs:readonly [string,string,string],parameter=0,point:readonly [number,number,number]=[0,0,0]) {
  const request=decodeCurvePointWorkRequest({kind:'curve',identity,
    outputs:outputs.map(source=>createFunctionMathSource(source,'text','degree',{axes:[],parameters:['T'],coefficients:[]},backend)),
    independent:'T',coefficients:[],known:[{axis:'X',value:point[0]}],lower:-10,upper:10,minimum:[-20,-20,-20],maximum:[20,20,20],tolerance:1e-7});
  const candidate:CurvePointCandidate={point,minimum:point,maximum:point,location:{kind:'curve',independent:'T',interval:{lower:parameter,upper:parameter},direct:false}};
  return {request,candidate};
}
function surface(outputs:readonly [string,string,string]) {
  const request=decodeSurfacePointWorkRequest({kind:'parametric-surface',identity,
    outputs:outputs.map(source=>createFunctionMathSource(source,'text','degree',{axes:[],parameters:['U','V'],coefficients:[]},backend)),
    independent:['U','V'],coefficients:[],known:[{axis:'X',value:0},{axis:'Y',value:0}],
    lower:[-2,-2],upper:[2,2],budget:FUNCTION_SURFACE_LIMITS,minimum:[-20,-20,-20],maximum:[20,20,20],tolerance:1e-7});
  const candidate:SurfacePointCandidate={...origin,location:{kind:'parametric-surface',box:[{lower:0,upper:0},{lower:0,upper:0}]}};
  return {request,candidate};
}
function encloses(actual:ReturnType<typeof functionPointFrame>,values:readonly number[]) {
  expect(actual).not.toBeNull();if(actual===null)throw new Error('Missing direction');
  values.forEach((value,axis)=>{expect(actual[axis].lower).toBeLessThanOrEqual(value);expect(actual[axis].upper).toBeGreaterThanOrEqual(value);});
}
describe('関数上の点の微分方向と指定長さの精度',()=>{
  it('放物線の接線と主法線を原式の微分から得る',()=>{
    const {request,candidate}=curve(['T','T^2','0']);
    encloses(functionPointFrame(request,candidate,'tangent',context()),[1,0,0]);
    encloses(functionPointFrame(request,candidate,'normal',context()),[0,1,0]);
  });
  it('度を既定にした円の接線と内側の主法線を混同しない',()=>{
    const {request,candidate}=curve(['cos(T)','sin(T)','0'],0,[1,0,0]);
    encloses(functionPointFrame(request,candidate,'tangent',context()),[0,1,0]);
    encloses(functionPointFrame(request,candidate,'normal',context()),[-1,0,0]);
  });
  it.each([['T','0','0'],['T','T^3','0'],['T^2','T^3','0']])('一意でない主法線を作らない: %s,%s,%s',(x,y,z)=>{
    const {request,candidate}=curve([x,y,z]);expect(functionPointFrame(request,candidate,'normal',context())).toBeNull();
  });
  it.each([['T','abs(T)','0'],['T','floor(T)','0'],['T^2','T^3','0']])('尖点・不連続・零速度で接線を作らない: %s,%s,%s',(x,y,z)=>{
    const {request,candidate}=curve([x,y,z]);expect(functionPointFrame(request,candidate,'tangent',context())).toBeNull();
  });
  it('曲面はU/V接線と向きを持つ法線を区別する',()=>{
    const {request,candidate}=surface(['U','V','U^2+V^2']);
    encloses(functionPointFrame(request,candidate,'tangent-u',context()),[1,0,0]);
    encloses(functionPointFrame(request,candidate,'tangent-v',context()),[0,1,0]);
    encloses(functionPointFrame(request,candidate,'normal',context()),[0,0,1]);
    expect(functionPointFrame(request,candidate,'tangent',context())).toBeNull();
  });
  it('傾いた曲面の法線を全XYZの微分から求める',()=>{
    const {request,candidate}=surface(['2*U','V','3*U+4*V']);
    encloses(functionPointFrame(request,candidate,'normal',context()),[-3/Math.sqrt(77),-8/Math.sqrt(77),2/Math.sqrt(77)]);
  });
  it('曲面の潰れた媒介変数と絶対値の折れを拒否する',()=>{
    for(const outputs of [['U','0','0'],['U','V','abs(U)']] as const){
      const {request,candidate}=surface(outputs);expect(functionPointFrame(request,candidate,'normal',context())).toBeNull();
    }
  });
  it('陰曲面の法線と固定平面内の曲線の接線を区別する',()=>{
    const request=decodeFunctionPointWorkRequest({identity,
      expression:createFunctionMathSource('X^2+Y^2+Z^2-1','text','degree',{axes:['X','Y','Z'],parameters:[],coefficients:[]},backend),
      coefficients:[],known:[{axis:'Y',value:0},{axis:'Z',value:0}],minimum:[-2,-2,-2],maximum:[2,2,2],tolerance:1e-7});
    const candidate={point:[1,0,0] as const,minimum:[1,0,0] as const,maximum:[1,0,0] as const,
      location:{kind:'implicit' as const,axis:'X' as const,interval:{lower:1,upper:1}}};
    encloses(functionPointFrame(request,candidate,'normal',context()),[1,0,0]);
    expect(functionPointFrame(request,candidate,'tangent',context())).toBeNull();
    const planar=decodeFunctionPointWorkRequest({...request,known:[{axis:'Y',value:0}],fixed:{axis:'Z',value:0}});
    encloses(functionPointFrame(planar,candidate,'tangent',context()),[0,1,0]);
  });
  it('長さと反転を使った終点を包み、長さによる誤差拡大も拒否する',()=>{
    const {request,candidate}=curve(['T','T^2','0']),frame=functionPointFrame(request,candidate,'tangent',context());
    if(frame===null)throw new Error('Missing tangent');
    const forward=functionDirectionEndpoint(candidate,frame,5,1e-7),reverse=functionDirectionEndpoint(candidate,frame,5,1e-7,true);
    expect(forward?.point[0]).toBeCloseTo(5,8);expect(reverse?.point[0]).toBeCloseTo(-5,8);
    const uncertain=[{lower:0.99999999,upper:1.00000001},{lower:0,upper:0},{lower:0,upper:0}] as const;
    expect(functionDirectionEndpoint(candidate,uncertain,1e9,1e-7)).toBeNull();
    for(const invalid of [0,-1,Infinity,NaN])expect(functionDirectionEndpoint(candidate,frame,invalid,1e-7)).toBeNull();
  });
  it('計算返信の欠落、別の長さ、非有限値と不正な指定を拒否する',()=>{
    const option=decodeFunctionDirection({kind:'tangent',length:5,reverse:false});
    expect(decodeFunctionDirectionEndpoint({...origin,point:[5,0,0],minimum:[5,0,0],maximum:[5,0,0]},origin,option,1e-7)?.point).toEqual([5,0,0]);
    for(const value of [undefined,origin,{...origin,point:[NaN,0,0]}])expect(()=>decodeFunctionDirectionEndpoint(value,origin,option,1e-7)).toThrow();
    for(const value of [{...option,length:0},{...option,reverse:1},{...option,kind:'unknown'},{...option,extra:true}])expect(()=>decodeFunctionDirection(value)).toThrow();
  });
});
