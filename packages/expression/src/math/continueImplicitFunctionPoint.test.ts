import {beforeAll,describe,expect,it} from 'vitest';
import {createMathBackend} from './createMathBackend.js';
import {createFunctionMathSource} from './functionMathSource.js';
import {solveImplicitFunctionPoints} from './solveImplicitFunctionPoints.js';
import {continueImplicitFunctionPoint} from './continueImplicitFunctionPoint.js';
import type {FunctionPointWorkRequest} from './functionPointWorkRequest.js';
import type {MathExecutionBackend} from './mathWorkExecution.js';
import type {FunctionKnownCoordinate,FunctionPointCandidate} from './functionPointCandidates.js';

let backend:MathExecutionBackend;beforeAll(()=>{backend=createMathBackend();});
const context=()=>({backend,shouldStop:()=>undefined});
function request(source:string,decimal='1',known:readonly FunctionKnownCoordinate[]=[{axis:'X',value:0},{axis:'Y',value:0}],label='r'):FunctionPointWorkRequest {
  const coefficients=[{id:'coef:1',label,decimal}];
  return {identity:{documentId:'part',documentVersion:1,editorId:'point',inputRevision:1},coefficients,
    expression:createFunctionMathSource(source,'text','radian',{axes:['X','Y','Z'],parameters:[],coefficients},backend),
    minimum:[-4,-4,-4],maximum:[4,4,4],tolerance:1e-7,known};
}
const sphere=(radius:string,known?:readonly FunctionKnownCoordinate[])=>request('X^2+Y^2+Z^2-coef("r")^2',radius,known);
function select(input:FunctionPointWorkRequest,index:number):FunctionPointCandidate['location'] {
  const result=solveImplicitFunctionPoints(input,context());if(result.status!=='ready' || !result.exhaustive || !result.candidates[index]) throw new Error(JSON.stringify(result));
  return result.candidates[index].location;
}
function point(previous:FunctionPointWorkRequest,current:FunctionPointWorkRequest,index:number){
  const result=continueImplicitFunctionPoint(previous,current,select(previous,index),context());
  expect(result.status).toBe('ready');if(result.status!=='ready') throw new Error(JSON.stringify(result));return result.candidate.point;
}
describe('親の変更時に関数上の点を別枝へ移さない',()=>{
  it.each([0,1])('球の半径1→2で選択した枝%sの符号を保つ',index=>{
    expect(point(sphere('1'),sphere('2'),index)).toEqual([0,0,index===0?-2:2]);
  });
  it('XYZの指定値が変わっても正負の枝を維持する',()=>{
    const current=sphere('1',[{axis:'X',value:0.6},{axis:'Y',value:0}]);
    expect(point(sphere('1'),current,1)[2]).toBeCloseTo(0.8,6);
    expect(point(sphere('1'),current,0)[2]).toBeCloseTo(-0.8,6);
  });
  it('二分の境界にない根では誤差区間が真の座標を含むことを確認する',()=>{
    const bounds={minimum:[-5,-5,-5] as const,maximum:[5,5,5] as const};
    const before={...sphere('1'),...bounds},after={...sphere('2'),...bounds};
    const result=continueImplicitFunctionPoint(before,after,select(before,1),context());
    expect(result.status).toBe('ready');if(result.status!=='ready') throw new Error(JSON.stringify(result));
    const candidate=result.candidate;expect(candidate.point.slice(0,2)).toEqual([0,0]);
    expect(candidate.minimum[2]).toBeLessThanOrEqual(2);expect(candidate.maximum[2]).toBeGreaterThanOrEqual(2);
    expect(candidate.maximum[2]-candidate.minimum[2]).toBeLessThanOrEqual(after.tolerance/4);
    expect(Math.abs(candidate.point[2]-2)).toBeLessThanOrEqual(after.tolerance/4);
  });
  it('係数の改名と十進表記の違いは同じIDの枝を保つ',()=>{
    expect(point(sphere('1'),request('X^2+Y^2+Z^2-coef("半径")^2','2.0',undefined,'半径'),1)).toEqual([0,0,2]);
    expect(point(sphere('1'),sphere('1.00'),0)).toEqual([0,0,-1]);
  });
  it('範囲変更で反対の枝が消えても候補番号に依存しない',()=>{
    const before=sphere('1'),after={...before,minimum:[-5,-5,0] as const};
    expect(point(before,after,1)).toEqual([0,0,1]);
    expect(continueImplicitFunctionPoint(before,after,select(before,0),context()).status).toBe('unresolved');
  });
  it('選んだ2枝が消えて別の根だけ残っても、近い根へ飛ばない',()=>{
    const previous=request('(Z^2-coef("r"))*(Z-3)','1'),current=request('(Z^2-coef("r"))*(Z-3)','-1');
    for(const index of [0,1]) expect(continueImplicitFunctionPoint(previous,current,select(previous,index),context()).status).toBe('unresolved');
    expect(point(previous,current,2)).toEqual([0,0,3]);
  });
  it('端点では同じ形でも係数の途中で枝が合流する場合は追従を断る',()=>{
    const before=sphere('1'),after=sphere('-1');
    for(const index of [0,1]) expect(continueImplicitFunctionPoint(before,after,select(before,index),context()).status).toBe('unresolved');
  });
  it('重根が2候補に分かれる場合は再選択を必要とする',()=>{
    const before=request('Z^2-coef("r")','0'),after=request('Z^2-coef("r")','1');
    expect(continueImplicitFunctionPoint(before,after,select(before,0),context()).status).toBe('unresolved');
  });
  it('値が変わらない重根と単独の極は、再計算でも失わない',()=>{
    const tangent=request('Z^2-coef("r")','0');expect(point(tangent,tangent,0)).toEqual([0,0,0]);
    const pole=sphere('1',[{axis:'Z',value:1}]);expect(point(pole,pole,0)).toEqual([0,0,1]);
    expect(continueImplicitFunctionPoint(pole,sphere('1',[{axis:'Z',value:0}]),select(pole,0),context()).status).toBe('unresolved');
  });
  it('異なる原式・既知軸・改竄した選択領域を追従に使わない',()=>{
    const before=sphere('1'),anchor=select(before,1);
    for(const after of [request('X^2+Y^2+Z^2-4'),sphere('1',[{axis:'X',value:0},{axis:'Z',value:0}])]) {
      expect(continueImplicitFunctionPoint(before,after,anchor,context())).toEqual({status:'unresolved',reason:'formula-changed'});
    }
    for(const range of [{lower:0,upper:0},{lower:NaN,upper:1},{lower:-2,upper:2}]){
      expect(continueImplicitFunctionPoint(before,before,{kind:'implicit',axis:'Z',interval:range},context()))
        .toEqual({status:'unresolved',reason:'invalid-anchor'});
    }
  });
  it.each(['cancelled','deadline'] as const)('%sの途中結果を点として返さない',reason=>{
    const before=sphere('1');expect(continueImplicitFunctionPoint(before,sphere('2'),select(before,1),{backend,shouldStop:()=>reason}))
      .toEqual({status:'stopped',reason});
  });
});
