import { beforeAll, describe, expect, it } from 'vitest';
import { createMathBackend } from './createMathBackend.js';
import { createFunctionMathSource } from './functionMathSource.js';
import { proveFunctionSurfaceBoundary } from './functionSurfaceBoundary.js';
import { executeFunctionSurfaceWorkRequest } from './functionSurfaceWorkExecution.js';
import { decodeFunctionSurfaceWorkReply } from './functionSurfaceWorkReply.js';
import { createFunctionSurfaceWorkEnvelope, type FunctionSurfaceWorkRequest } from './functionSurfaceWorkRequest.js';
import type { MathExecutionBackend } from './mathWorkExecution.js';

let backend: MathExecutionBackend;
beforeAll(() => { backend = createMathBackend(); });
function request(unit: 'degree'|'radian' = 'radian', torus = false): FunctionSurfaceWorkRequest {
  const formula = (source: string) => createFunctionMathSource(source,'text',unit,{axes:[],parameters:['U','V'],coefficients:[]},backend);
  const scalar = (source: string) => createFunctionMathSource(source,'text',unit,{axes:[],parameters:[],coefficients:[]},backend);
  const full = unit === 'degree' ? '360' : '2*pi', half = unit === 'degree' ? '180' : 'pi';
  return {identity:{documentId:'periodic',documentVersion:1,editorId:'surface',inputRevision:1},independent:['U','V'],
    outputs: torus ? [formula('(2+cos(V))*cos(U)'),formula('(2+cos(V))*sin(U)'),formula('sin(V)')]
      : [formula('sin(V)*cos(U)'),formula('sin(V)*sin(U)'),formula('cos(V)')],
    lower:[0,0],upper:[unit === 'degree' ? 360 : 2*Math.PI,unit === 'degree' ? torus ? 360 : 180 : torus ? 2*Math.PI : Math.PI],
    minimum:[-4,-4,-4],maximum:[4,4,4],tolerance:0.5,coefficients:[],
    parameterBounds:{lower:[scalar('0'),scalar('0')],upper:[scalar(full),scalar(torus ? full : half)]},
    budget:{maximumSamples:20000,maximumCells:20000,maximumTriangles:40000,maximumDepth:12}};
}
function prove(input: FunctionSurfaceWorkRequest) {
  return proveFunctionSurfaceBoundary(input,{backend,shouldStop:()=>undefined});
}
function ready(input: FunctionSurfaceWorkRequest) {
  const result = decodeFunctionSurfaceWorkReply(executeFunctionSurfaceWorkRequest(createFunctionSurfaceWorkEnvelope(1,input),backend),input).result;
  if (result.status !== 'ready') throw new Error(JSON.stringify(result)); return result;
}
function checkClosed(triangles: readonly (readonly number[])[]) {
  const edges = new Map<string,number[]>();
  for (const triangle of triangles) for (let i=0;i<3;i++) {
    const a=triangle[i],b=triangle[(i+1)%3],key=`${Math.min(a,b)},${Math.max(a,b)}`;
    const uses=edges.get(key) ?? []; uses.push(a < b ? 1 : -1); edges.set(key,uses);
  }
  for (const uses of edges.values()) { expect(uses).toHaveLength(2); expect(uses[0]+uses[1]).toBe(0); }
}
describe('原式と現在の境界値が一致した周期と極だけを共有する', () => {
  it.each(['degree','radian'] as const)('%sの球は極と継ぎ目を共有し、全辺が2面に属する', unit => {
    const input=request(unit);
    expect(prove(input)).toEqual({periodic:[true,false],poles:[[false,false],[true,true]]});
    const result=ready(input); checkClosed(result.triangles);
    for (const vertex of result.vertices) expect(Math.hypot(...vertex.point)).toBeCloseTo(1,12);
    expect(result.maximumInterpolationErrorBound).toBeLessThanOrEqual(input.tolerance);
  });
  it('トーラスは両方向を共有し、近い別の点をまとめない', () => {
    const input=request('radian',true);
    expect(prove(input)).toEqual({periodic:[true,true],poles:[[false,false],[false,false]]});
    const result=ready(input); checkClosed(result.triangles);
    for (const {point:[x,y,z]} of result.vertices) expect((Math.hypot(x,y)-2)**2+z*z).toBeCloseTo(1,11);
  });
  it('境界の元式が無ければ数値2piの近さから周期と推測しない', () => {
    const {parameterBounds: _unused,...input}=request();
    void _unused; expect(prove(input)).toBeUndefined();
  });
  it('境界式と送られた値が違う、範囲式に自由変数がある、ASTだけを書換えた依頼を拒否する', () => {
    const input=request();
    expect(()=>prove({...input,upper:[6,Math.PI]})).toThrow('一致');
    const axis=createFunctionMathSource('U','text','radian',{axes:[],parameters:['U'],coefficients:[]},backend);
    const bounds=input.parameterBounds; if (!bounds) throw new Error('Missing fixture');
    expect(()=>prove({...input,parameterBounds:{...bounds,lower:[axis,bounds.lower[1]]}})).toThrow();
    const changed={...bounds.upper[0],expression:{kind:'number' as const,decimal:'6'}};
    expect(()=>prove({...input,parameterBounds:{...bounds,upper:[changed,bounds.upper[1]]}})).toThrow();
  });
  it('浮動座標が同じでも元の範囲に微小なずれがあれば周期にしない', () => {
    const input=request(); if (!input.parameterBounds) throw new Error('Missing fixture');
    const upper=createFunctionMathSource('2*pi+1e-100','text','radian',{axes:[],parameters:[],coefficients:[]},backend);
    const result=prove({...input,parameterBounds:{...input.parameterBounds,upper:[upper,input.parameterBounds.upper[1]]}});
    expect(result?.periodic[0]).toBe(false);
  });
  it('中止は周期の途中結果を返さない', () => {
    expect(()=>proveFunctionSurfaceBoundary(request(),{backend,shouldStop:()=> 'cancelled'})).toThrow('中止');
  });
});
