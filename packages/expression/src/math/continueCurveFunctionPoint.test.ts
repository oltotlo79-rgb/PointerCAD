import {beforeAll,describe,expect,it} from 'vitest';
import {createMathBackend} from './createMathBackend.js';
import {createFunctionMathSource} from './functionMathSource.js';
import {decodeCurvePointWorkRequest,type CurvePointWorkRequest,type CurvePointCandidate} from './curvePointWorkRequest.js';
import {solveCurveFunctionPoints} from './solveCurveFunctionPoints.js';
import {continueCurveFunctionPoint} from './continueCurveFunctionPoint.js';
import type {MathExecutionBackend} from './mathWorkExecution.js';

let backend:MathExecutionBackend;beforeAll(()=>{backend=createMathBackend();});
const context=()=>({backend,shouldStop:()=>undefined});
function input(decimal:string,outputs:readonly [string,string,string]=['T^2-coef("r")','T','0'],
  known:CurvePointWorkRequest['known']=[{axis:'X',value:0}],independent:CurvePointWorkRequest['independent']='T') {
  const coefficients=[{id:'coefficient:r',label:'r',decimal}],scope={axes:independent==='T'?[]:[independent],
    parameters:independent==='T'?['T' as const]:[],coefficients};
  return decodeCurvePointWorkRequest({kind:'curve',identity:{documentId:'curve',documentVersion:1,editorId:'point',inputRevision:0},
    outputs:outputs.map(source=>createFunctionMathSource(source,'text','degree',scope,backend)),independent,coefficients,known,
    lower:-4,upper:4,minimum:[-4,-4,-4],maximum:[4,4,4],tolerance:1e-7});
}
function anchor(request:CurvePointWorkRequest,index:number):CurvePointCandidate['location'] {
  const result=solveCurveFunctionPoints(request,context());
  if(result.status!=='ready' || !result.exhaustive || !result.candidates[index]) throw new Error(JSON.stringify(result));
  return result.candidates[index].location;
}

describe('保存した曲線上の点を同じ解へ追従させる',()=>{
  it.each([[0,-2],[1,2]])('枝%sは係数の変更でY=%sへ追い、候補の近さを使わない',(index,expected)=>{
    const before=input('1'),after=input('4'),result=continueCurveFunctionPoint(before,after,anchor(before,index),context());
    expect(result.status).toBe('ready');if(result.status!=='ready') throw new Error(JSON.stringify(result));
    expect(result.candidate.point[1]).toBeCloseTo(expected,7);
  });
  it('保存した入力と選択区間をJSONで読み直しても同じ点を得る',()=>{
    const before=input('2'),choice=anchor(before,1),copy=JSON.parse(JSON.stringify(before)) as unknown;
    const result=continueCurveFunctionPoint(copy,copy,JSON.parse(JSON.stringify(choice)) as CurvePointCandidate['location'],context());
    expect(result.status).toBe('ready');if(result.status==='ready') expect(result.candidate.point[1]).toBeCloseTo(Math.SQRT2,7);
  });
  it('独立座標で直接決まる点は式の係数を変えても同じ指定座標に留まる',()=>{
    const outputs=['X','coef("r")*X','0'] as const,known=[{axis:'X' as const,value:1}];
    const before=input('1',outputs,known,'X'),after=input('2',outputs,known,'X');
    expect(continueCurveFunctionPoint(before,after,anchor(before,0),context())).toMatchObject({status:'ready',candidate:{point:[1,2,0]}});
  });
  it('解が消えたときに別の点や古い保存座標を採用しない',()=>{
    const before=input('1');expect(continueCurveFunctionPoint(before,input('-1'),anchor(before,1),context()))
      .toEqual({status:'unresolved',reason:'branch-missing'});
  });
  it('編集の両端だけ同じでも、途中で2枝が合流すると追従を断る',()=>{
    const outputs=['T^2-coef("r")^2','T','0'] as const,before=input('-1',outputs),after=input('1',outputs);
    expect(continueCurveFunctionPoint(before,after,anchor(before,1),context())).toEqual({status:'unresolved',reason:'branch-unproved'});
  });
  it('原式が別の形に変わったら点の選び直しを求める',()=>{
    const before=input('1');expect(continueCurveFunctionPoint(before,input('1',['T^3-coef("r")','T','0']),anchor(before,1),context()))
      .toEqual({status:'unresolved',reason:'formula-changed'});
  });
  it('改変された選択区間と異なる独立変数の選択を断る',()=>{
    const before=input('1'),choice=anchor(before,1);
    for(const broken of [{...choice,interval:{lower:3,upper:3}},{...choice,independent:'X' as const},
      {...choice,interval:{lower:-Infinity,upper:Infinity}}]) {
      expect(continueCurveFunctionPoint(before,before,broken,context())).toEqual({status:'unresolved',reason:'invalid-anchor'});
    }
  });
  it('2座標の条件が同じ根を定義し続ける場合は両方の条件を保つ',()=>{
    const outputs=['T^2-coef("r")','2*(T^2-coef("r"))','T'] as const,known=[{axis:'X' as const,value:0},{axis:'Y' as const,value:0}];
    const before=input('1',outputs,known),after=input('4',outputs,known),result=continueCurveFunctionPoint(before,after,anchor(before,1),context());
    expect(result.status).toBe('ready');if(result.status==='ready') expect(result.candidate.point).toEqual([0,0,2]);
  });
  it('2座標の両端が合うだけでは、途中に共通解がない編集を追従済みにしない',()=>{
    const outputs=['T^2','T','0'] as const,before=input('1',outputs,[{axis:'X',value:1},{axis:'Y',value:1}]);
    const after=input('1',outputs,[{axis:'X',value:4},{axis:'Y',value:2}]);
    expect(continueCurveFunctionPoint(before,after,anchor(before,0),context())).toEqual({status:'unresolved',reason:'branch-unproved'});
  });
  it('独立なY座標と編集の進み具合の変数を混同しない',()=>{
    const outputs=['Y^2-coef("r")','Y','0'] as const,before=input('1',outputs,undefined,'Y'),after=input('4',outputs,undefined,'Y');
    const result=continueCurveFunctionPoint(before,after,anchor(before,1),context());
    expect(result.status).toBe('ready');if(result.status==='ready') expect(result.candidate.point[1]).toBeCloseTo(2,7);
  });
  it('追従中の中止は前の成功として扱わない',()=>{
    const before=input('1');expect(continueCurveFunctionPoint(before,input('4'),anchor(before,1),{backend,shouldStop:()=> 'cancelled'}))
      .toEqual({status:'stopped',reason:'cancelled'});
  });
});
