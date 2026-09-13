import {beforeAll,describe,expect,it} from 'vitest';
import {createMathBackend} from './createMathBackend.js';
import {createFunctionMathSource} from './functionMathSource.js';
import {solveImplicitFunctionPoints,type ImplicitFunctionPointInput} from './solveImplicitFunctionPoints.js';
import type {FunctionPointCandidates,FunctionKnownCoordinate} from './functionPointCandidates.js';
import type {MathExecutionBackend} from './mathWorkExecution.js';

let backend:MathExecutionBackend;beforeAll(()=>{backend=createMathBackend();});
const context=()=>({backend,shouldStop:()=>undefined});
function input(source:string,known:readonly FunctionKnownCoordinate[],fixed?:FunctionKnownCoordinate):ImplicitFunctionPointInput {
  return {expression:createFunctionMathSource(source,'text','radian',{axes:(['X','Y','Z'] as const).filter(axis=>axis!==fixed?.axis),parameters:[],coefficients:[]},backend),
    known,...(fixed?{fixed}:{}),minimum:[-4,-4,-4],maximum:[4,4,4],tolerance:1e-6,coefficients:[]};
}
const sphere=(known:readonly FunctionKnownCoordinate[])=>input('X^2+Y^2+Z^2-1',known);
function ready(result:FunctionPointCandidates,count:number,exhaustive=true){
  expect(result.status).toBe('ready');if(result.status!=='ready') throw new Error(JSON.stringify(result));
  expect(result.exhaustive).toBe(exhaustive);expect(result.candidates).toHaveLength(count);return result.candidates;
}
describe('既知のXYZから親の範囲内にある陰関数上の点を探す',()=>{
  it('球のXYを指定すると正負Zの2候補を返し、指定座標はそのまま保つ',()=>{
    const result=ready(solveImplicitFunctionPoints(sphere([{axis:'X',value:0.6},{axis:'Y',value:0}]),context()),2);
    for(const [index,candidate] of result.entries()){
      expect(candidate.point[0]).toBe(0.6);expect(candidate.point[1]).toBe(0);expect(candidate.point[2]).toBeCloseTo(index===0?-0.8:0.8,6);
      expect(Math.abs(candidate.point.reduce((sum,x)=>sum+x*x,0)-1)).toBeLessThan(1e-6);
      expect(candidate.maximum[2]-candidate.minimum[2]).toBeLessThanOrEqual(2.5e-7);
    }
  });
  it.each(['X','Y','Z'] as const)('%sだけでも球の極を一意な点として特定できる',axis=>{
    const candidates=ready(solveImplicitFunctionPoints(sphere([{axis,value:1}]),context()),1);
    expect(candidates[0].point).toEqual((['X','Y','Z'] as const).map(name=>name===axis?1:0));
  });
  it('球の内部高さ1つは自由度不足、球の外の高さは無解として区別する',()=>{
    expect(solveImplicitFunctionPoints(sphere([{axis:'Z',value:0.5}]),context())).toEqual({status:'underconstrained',additionalCoordinates:1});
    ready(solveImplicitFunctionPoints(sphere([{axis:'Z',value:2}]),context()),0);
  });
  it('2座標指定の接点を重根のまま1候補として保つ',()=>{
    expect(ready(solveImplicitFunctionPoints(sphere([{axis:'X',value:1},{axis:'Y',value:0}]),context()),1)[0].point).toEqual([1,0,0]);
  });
  it('XYZの未知軸の範囲で候補を制限し、境界上の根を含める',()=>{
    const request=sphere([{axis:'X',value:0},{axis:'Y',value:0}]);
    expect(ready(solveImplicitFunctionPoints({...request,minimum:[-4,-4,0],maximum:[4,4,1]},context()),1)[0].point).toEqual([0,0,1]);
    ready(solveImplicitFunctionPoints({...request,minimum:[-4,-4,0],maximum:[4,4,0.5]},context()),0);
  });
  it('指定値の範囲外を親の範囲へクランプしない',()=>{
    expect(solveImplicitFunctionPoints(sphere([{axis:'X',value:5},{axis:'Y',value:0}]),context())).toEqual({status:'out-of-range',axes:['X']});
  });
  it('平面等式の固定軸を保ち、自由な座標1つから2候補を生成する',()=>{
    const request=input('X^2+Y^2-1',[{axis:'X',value:0}],{axis:'Z',value:0.123456789});
    const candidates=ready(solveImplicitFunctionPoints(request,context()),2);
    expect(candidates.map(point=>point.point)).toEqual([[0,-1,0.123456789],[0,1,0.123456789]]);
  });
  it('平面等式の固定軸だけでは自由度不足、矛盾する固定値は無解になる',()=>{
    const fixed={axis:'Z',value:0.5} as const;
    expect(solveImplicitFunctionPoints(input('X^2+Y^2-1',[fixed],fixed),context()).status).toBe('underconstrained');
    ready(solveImplicitFunctionPoints(input('X^2+Y^2-1',[{axis:'Z',value:0.75}],fixed),context()),0);
  });
  it('平面上の2座標を全て指定した点は元の式との一致で採否を決める',()=>{
    const fixed={axis:'Z',value:0.5} as const;
    expect(ready(solveImplicitFunctionPoints(input('X^2+Y^2-1',[{axis:'X',value:0},{axis:'Y',value:1}],fixed),context()),1)[0].point).toEqual([0,1,0.5]);
    ready(solveImplicitFunctionPoints(input('X^2+Y^2-1',[{axis:'X',value:0},{axis:'Y',value:0.99}],fixed),context()),0);
  });
  it('トーラスの4候補と接点を分離し、穴の中の点を採用しない',()=>{
    const source='(X^2+Y^2+Z^2+4-0.25)^2-16*(X^2+Y^2)';
    const candidates=ready(solveImplicitFunctionPoints(input(source,[{axis:'Y',value:0},{axis:'Z',value:0}]),context()),4);
    expect(candidates.map(candidate=>candidate.point[0])).toEqual([-2.5,-1.5,1.5,2.5]);
    ready(solveImplicitFunctionPoints(input(source,[{axis:'X',value:0},{axis:'Y',value:0}]),context()),0);
  });
  it('一般の周期関数でも親の有限範囲内の候補をすべて探す',()=>{
    const candidates=ready(solveImplicitFunctionPoints(input('sin(Y)',[{axis:'X',value:0},{axis:'Z',value:0}]),context()),3);
    candidates.forEach((candidate,index)=>expect(candidate.point[1]).toBeCloseTo((index-1)*Math.PI,6));
  });
  it('極や未解決領域がある場合、見つけた候補だけを全解と報告しない',()=>{
    const result=solveImplicitFunctionPoints(input('1/Y',[{axis:'X',value:0},{axis:'Z',value:0}]),context());
    ready(result,0,false);if(result.status!=='ready') throw new Error('Missing result');
    expect(result.unresolved.some(region=>region.interval.lower<=0 && region.interval.upper>=0)).toBe(true);
  });
  it('空・重複・非有限の既知座標と不正な全XYZを拒否する',()=>{
    for(const known of [[],[{axis:'X',value:0},{axis:'X',value:1}],[{axis:'Y',value:NaN}]] as const) expect(()=>solveImplicitFunctionPoints(sphere(known),context())).toThrow();
    const request=sphere([{axis:'X',value:0},{axis:'Y',value:0}]);
    for(const bounds of [{minimum:[-4,-4,NaN]},{maximum:[4,4,Infinity]},{minimum:[-4,-4,4]}] as const) {
      expect(()=>solveImplicitFunctionPoints({...request,...bounds},context())).toThrow();
    }
  });
  it.each(['cancelled','deadline'] as const)('%sでは候補を返さない',reason=>{
    const result=solveImplicitFunctionPoints(sphere([{axis:'X',value:0},{axis:'Y',value:0}]),{backend,shouldStop:()=>reason});
    expect(result).toEqual({status:'stopped',reason});
  });
});
