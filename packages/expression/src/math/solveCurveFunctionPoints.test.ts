import {beforeAll,describe,expect,it} from 'vitest';
import {createMathBackend} from './createMathBackend.js';
import {createFunctionMathSource} from './functionMathSource.js';
import {solveCurveFunctionPoints} from './solveCurveFunctionPoints.js';
import {decodeCurvePointWorkRequest,type CurvePointWorkRequest,type CurvePointCandidates} from './curvePointWorkRequest.js';
import type {MathExecutionBackend} from './mathWorkExecution.js';

let backend:MathExecutionBackend;beforeAll(()=>{backend=createMathBackend();});
function request(outputs:readonly [string,string,string],known:CurvePointWorkRequest['known'],independent:CurvePointWorkRequest['independent']='T',
  angleUnit:'degree'|'radian'='degree'):CurvePointWorkRequest {
  const scope={axes:independent==='T'?[]:[independent],parameters:independent==='T'?['T' as const]:[],coefficients:[]};
  return decodeCurvePointWorkRequest({kind:'curve',identity:{documentId:'curve',documentVersion:1,editorId:'point',inputRevision:0},
    outputs:outputs.map(source=>createFunctionMathSource(source,'text',angleUnit,scope,backend)),independent,coefficients:[],
    lower:-4,upper:4,minimum:[-4,-4,-4],maximum:[4,4,4],tolerance:1e-7,known});
}
function solve(input:CurvePointWorkRequest){return solveCurveFunctionPoints(input,{backend,shouldStop:()=>undefined});}
function ready(result:CurvePointCandidates,count:number){
  expect(result.status).toBe('ready');if(result.status!=='ready') throw new Error(JSON.stringify(result));
  expect(result.exhaustive).toBe(true);expect(result.unresolved).toEqual([]);expect(result.candidates).toHaveLength(count);return result.candidates;
}

describe('元の座標式・媒介式から証明して求める曲線上の点',()=>{
  it.each(['X','Y','Z'] as const)('独立軸%sの指定で残り2式を評価し、全座標の誤差を保持する',axis=>{
    const outputs=['2','3','sqrt(2)'] as [string,string,string],index=['X','Y','Z'].indexOf(axis);outputs[index]=axis;
    const [point]=ready(solve(request(outputs,[{axis,value:1}],axis)),1);
    expect(point.point[index]).toBe(1);expect(point.location).toEqual({kind:'curve',independent:axis,interval:{lower:1,upper:1},direct:true});
    for(const [slot,value] of point.point.entries()){
      expect(value).toBeGreaterThanOrEqual(point.minimum[slot]);expect(value).toBeLessThanOrEqual(point.maximum[slot]);
      expect(point.maximum[slot]-point.minimum[slot]).toBeLessThanOrEqual(1e-7);
    }
  });
  it('独立座標に追加した条件は一致時のみ点を作り、近いだけの座標を受け入れない',()=>{
    ready(solve(request(['X','X^2','X+1'],[{axis:'X',value:1},{axis:'Y',value:1}],'X')),1);
    ready(solve(request(['X','X^2','X+1'],[{axis:'X',value:1},{axis:'Y',value:1.000000001}],'X')),0);
  });
  it('従属座標から独立軸の正負2解を得て、それぞれの3D座標を計算する',()=>{
    const points=ready(solve(request(['X','X^2','X+1'],[{axis:'Y',value:2}],'X')),2);
    expect(points[0].point[0]).toBeCloseTo(-Math.SQRT2,7);expect(points[1].point[0]).toBeCloseTo(Math.SQRT2,7);
    expect(points.every(point=>point.point[1]===2 && !point.location.direct)).toBe(true);
  });
  it('2軸の指定で双方を満たす共通根だけを採用する',()=>{
    const points=ready(solve(request(['T^2','T','T+1'],[{axis:'X',value:1},{axis:'Y',value:1}])),1);
    expect(points[0].point).toEqual([1,1,2]);
    ready(solve(request(['T^2','T','0'],[{axis:'X',value:1},{axis:'Y',value:2}])),0);
  });
  it('同じ3D座標に戻る曲線でも異なる媒介変数の枝を区別する',()=>{
    const points=ready(solve(request(['T^2','0','T^2'],[{axis:'X',value:1}])),2);
    expect(points.map(point=>point.point)).toEqual([[1,0,1],[1,0,1]]);
    expect(points[0].location.interval.upper).toBeLessThan(points[1].location.interval.lower);
  });
  it('符号が変化しない接点も元の多項式から拾う',()=>{
    const [point]=ready(solve(request(['(T-1)^2','T','0'],[{axis:'X',value:0}])),1);
    expect(point.point).toEqual([0,1,0]);
  });
  it('一方が常に一致する条件でも、もう一方の有限個の解を探索する',()=>{
    const [point]=ready(solve(request(['1','T','0'],[{axis:'X',value:1},{axis:'Y',value:2}])),1);
    expect(point.point).toEqual([1,2,0]);
  });
  it('指定した条件が曲線全体に成り立つ場合に1点へ勝手に決めない',()=>{
    const result=solve(request(['1','T','0'],[{axis:'X',value:1}]));
    expect(result).toMatchObject({status:'ready',exhaustive:false,candidates:[]});
  });
  it('三角関数の定数条件も、丸め区間を何度も分割せず自由な曲線として残す',()=>{
    const result=solve(request(['sin(0)','T','0'],[{axis:'X',value:0}]));
    expect(result).toEqual({status:'ready',candidates:[],exhaustive:false,
      unresolved:[{interval:{lower:-4,upper:4},reason:'continuum'}]});
  });
  it.each(['X','Y','Z'] as const)('%s範囲外の既知座標を探索前に断る',axis=>{
    expect(solve(request(['T','T','T'],[{axis,value:5}]))).toEqual({status:'out-of-range',axes:[axis]});
  });
  it('未知の座標も親のXYZ範囲を越えたら点を作らない',()=>{
    ready(solve(request(['T','10','0'],[{axis:'X',value:1}])),0);
  });
  it('正確な多項式で決まる範囲の境界点を、丸め幅だけを理由に失わない',()=>{
    const input=request(['X','X+1','0'],[{axis:'X',value:1}],'X');
    const [point]=ready(solve({...input,maximum:[4,2,4]}),1);
    expect(point.point).toEqual([1,2,0]);expect(point.maximum[1]).toBe(2);
  });
  it('同じ条件に合う根でも残りの式が定義されない枝には点を作らない',()=>{
    const [point]=ready(solve(request(['T^2','sqrt(T)','T'],[{axis:'X',value:1}])),1);
    expect(point.point[2]).toBe(1);
  });
  it('急な曲線でも独立変数の幅だけで合格せず、XYZが要求精度内になるまで細分する',()=>{
    const input=request(['T^2','1000*(T^2-2)+1','0'],[{axis:'X',value:2}]);
    const points=ready(solve(input),2);
    for(const point of points){expect(point.point[1]).toBeCloseTo(1,7);expect(point.maximum[1]-point.minimum[1]).toBeLessThanOrEqual(1e-7);}
  });
  it('度とラジアンを各式の指定どおり評価する',()=>{
    const degree=request(['X','sin(X)','cos(X)'],[{axis:'X',value:0}],'X','degree');
    expect(ready(solve(degree),1)[0].point).toEqual([0,0,1]);
    const radian=request(['X','sin(X)','cos(X)'],[{axis:'X',value:1}],'X','radian');
    const point=ready(solve(radian),1)[0];expect(point.point[1]).toBeCloseTo(Math.sin(1),7);expect(point.point[2]).toBeCloseTo(Math.cos(1),7);
  });
  it('周期関数の複数解をTの有限範囲内で全て分ける',()=>{
    const input=request(['sin(T)','cos(T)','T/100'],[{axis:'X',value:0}]);
    const points=ready(solve({...input,lower:-400,upper:400}),5);
    for(const [index,point] of points.entries()) expect(point.point[2]).toBeCloseTo([-3.6,-1.8,0,1.8,3.6][index],7);
  });
  it('指数関数の曲線に指定したX座標から、要求精度内のY座標を証明して作る',()=>{
    const [point]=ready(solve(request(['X','exp(X)','exp(1)'],[{axis:'X',value:1}],'X')),1);
    expect(point.point[1]).toBeCloseTo(Math.E,7);expect(point.point[2]).toBeCloseTo(Math.E,7);
    expect(point.maximum[1]-point.minimum[1]).toBeLessThanOrEqual(1e-7);
  });
  it('独立軸X・同名の係数X・π定数・同名の係数を区別したまま点を求める',()=>{
    const input=request(['X','0','0'],[{axis:'X',value:0}],'X'),coefficients=[{id:'coefficient:x',label:'X',decimal:'2'},
      {id:'coefficient:pi',label:'pi',decimal:'3'}],scope={axes:['X' as const],parameters:[],coefficients};
    const outputs=['X','coef("X")*X+coef("pi")','pi'].map(source=>createFunctionMathSource(source,'text','degree',scope,backend));
    const [point]=ready(solve(decodeCurvePointWorkRequest({...input,outputs,coefficients})),1);
    expect(point.point[0]).toBe(0);expect(point.point[1]).toBe(3);expect(point.point[2]).toBeCloseTo(Math.PI,7);
  });
  it('極の不連続を根と解釈せず、証明できない領域を隠さない',()=>{
    const result=solve(request(['1/T','T','0'],[{axis:'X',value:0}]));
    if(result.status==='ready'){expect(result.candidates).toEqual([]);}else expect(result.status).toBe('stopped');
  });
  it('中止された依頼は候補を返さない',()=>{
    expect(solveCurveFunctionPoints(request(['T','T','0'],[{axis:'X',value:1}]),{backend,shouldStop:()=> 'cancelled'}))
      .toEqual({status:'stopped',reason:'cancelled'});
  });
  it('探索途中の期限切れを全解の取得成功として返さない',()=>{
    let checks=0;
    const input=request(['sin(100000*T)','cos(T)','0'],[{axis:'X',value:0}]);
    expect(solveCurveFunctionPoints(input,{backend,shouldStop:()=> ++checks>200?'deadline':undefined})).toEqual({status:'stopped',reason:'deadline'});
  });
});

describe('曲線上の点の入力を所有する境界',()=>{
  it('XYZの範囲欠落・非有限値・3軸・重複軸・不正な独立軸出力を拒否する',()=>{
    const input=request(['X','X^2','0'],[{axis:'X',value:1}],'X');
    const {maximum:_maximum,...missing}=input;void _maximum;
    for(const broken of [missing,{...input,minimum:[-4,NaN,-4]},{...input,known:[...input.known,...input.known]},
      {...input,known:[{axis:'X',value:1},{axis:'Y',value:1},{axis:'Z',value:0}]},
      {...input,outputs:[input.outputs[1],input.outputs[1],input.outputs[2]]}]) expect(()=>decodeCurvePointWorkRequest(broken)).toThrow();
  });
  it('呼び出し元が範囲・式・既知座標を書き換えても計算依頼は変わらない',()=>{
    const input=JSON.parse(JSON.stringify(request(['T','T^2','0'],[{axis:'X',value:1}]))) as CurvePointWorkRequest;
    const owned=decodeCurvePointWorkRequest(input),mutable=input as unknown as {minimum:number[];outputs:{source:string}[];known:{value:number}[]};
    mutable.minimum[0]=-100;mutable.outputs[0].source='100';mutable.known[0].value=3;
    expect(owned.minimum[0]).toBe(-4);expect(owned.outputs[0].source).toBe('T');expect(owned.known[0].value).toBe(1);
  });
});
