import { beforeAll,describe,expect,it } from 'vitest';
import {
  createFunctionMathSource,
  createMathBackend,
  executeFunctionSurfaceWorkRequest,
  type MathExecutionBackend,
} from '@pointercad/expression/math/worker';



import { MAX_FUNCTION_SURFACE_FACES,MAX_FUNCTION_SURFACE_VERTICES } from '@pointercad/kernel';
import { functionSurfaceRequest } from './functionSurfaceRequest.js';
import { FunctionPlotBounds } from './functionPlotBounds.js';
import type { ResolvedFunctionRanges } from './resolveFunctionRanges.js';

let backend:MathExecutionBackend;
beforeAll(()=>{backend=createMathBackend();});
function ranges():ResolvedFunctionRanges {
  const result=FunctionPlotBounds.read({X:{min:-2,max:2},Y:{min:-2,max:2},Z:{min:-2,max:2}});
  if(!result.ok) throw new Error(JSON.stringify(result));
  return {bounds:result.bounds,tolerance:0.01,parameters:[],fixedCoordinate:null};
}
const context={identity:{documentId:'part',documentVersion:1,editorId:'surface',inputRevision:1},coefficients:[]};
describe('関数曲面の保存定義と現在の範囲をWorker依頼へ接続する',()=>{
  it.each(['X','Y','Z'] as const)('出力軸%s以外の2軸を恒等式にし、XYZ指定範囲とCAD予算を保持する',output=>{
    const source=output==='X'?'Y+Z':output==='Y'?'X+Z':'X+Y';
    const expression=createFunctionMathSource(source,'text','radian',{axes:['X','Y','Z'],parameters:[],coefficients:[]},backend);
    const request=functionSurfaceRequest({kind:'coordinate-surface',output,expression},ranges(),context);
    expect(request.independent).toEqual(output==='X'?['Y','Z']:output==='Y'?['X','Z']:['X','Y']);
    expect(request.budget.maximumSamples).toBeLessThanOrEqual(MAX_FUNCTION_SURFACE_VERTICES);
    expect(request.budget.maximumTriangles).toBeLessThanOrEqual(MAX_FUNCTION_SURFACE_FACES);
    const {result}=executeFunctionSurfaceWorkRequest({kind:'sample-function-surface',serial:1,request},backend);
    if(result.status!=='ready') throw new Error(JSON.stringify(result));
    const axis=output==='X'?0:output==='Y'?1:2;
    for(const vertex of result.vertices) expect(vertex.point[axis]).toBe(vertex.parameters[0]+vertex.parameters[1]);
  });
  it('媒介式のU/V欠落をXYZで補完せず、明示した現在値で原式を再計算する',()=>{
    const expression=(source:string)=>createFunctionMathSource(source,'text','radian',{axes:[],parameters:['U','V'],coefficients:[]},backend);
    const range={min:{source:'0',value:0,display:'0'},max:{source:'1',value:1,display:'1'}};
    const formula={kind:'parametric-surface' as const,outputs:{X:expression('U'),Y:expression('V'),Z:expression('U*V')},U:range,V:range};
    expect(()=>functionSurfaceRequest(formula,ranges(),context)).toThrow();
    const request=functionSurfaceRequest(formula,{...ranges(),parameters:[{parameter:'U',range:{min:0,max:3}},{parameter:'V',range:{min:0,max:4}}]},context);
    expect(request.upper).toEqual([3,4]); expect(request.maximum).toEqual([2,2,2]); expect(formula.U.max.value).toBe(1);
  });
});
