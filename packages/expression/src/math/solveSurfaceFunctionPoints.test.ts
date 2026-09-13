import {beforeAll,describe,expect,it} from 'vitest';
import {createMathBackend} from './createMathBackend.js';
import {createFunctionMathSource} from './functionMathSource.js';
import {decodeSurfacePointWorkRequest,type SurfacePointWorkRequest,type SurfacePointCandidates} from './surfacePointWorkRequest.js';
import {solveSurfaceFunctionPoints} from './solveSurfaceFunctionPoints.js';
import {FUNCTION_SURFACE_LIMITS} from './functionSurfaceLimits.js';
import type {MathExecutionBackend} from './mathWorkExecution.js';

let backend:MathExecutionBackend;beforeAll(()=>{backend=createMathBackend();});
function input(outputs:readonly [string,string,string],known:SurfacePointWorkRequest['known']):SurfacePointWorkRequest {
  return decodeSurfacePointWorkRequest({kind:'parametric-surface',identity:{documentId:'surface',documentVersion:0,editorId:'point',inputRevision:0},
    independent:['U','V'],outputs:outputs.map(source=>createFunctionMathSource(source,'text','degree',
      {axes:[],parameters:['U','V'],coefficients:[]},backend)),coefficients:[],lower:[-4,-4],upper:[4,4],
    minimum:[-10,-10,-10],maximum:[10,10,10],tolerance:1e-7,budget:FUNCTION_SURFACE_LIMITS,known});
}
function solve(request:SurfacePointWorkRequest){return solveSurfaceFunctionPoints(request,{backend,shouldStop:()=>undefined});}
function ready(result:SurfacePointCandidates,count:number){
  expect(result.status).toBe('ready');if(result.status!=='ready')throw new Error(JSON.stringify(result));
  expect(result.exhaustive).toBe(true);expect(result.unresolved).toEqual([]);expect(result.candidates).toHaveLength(count);return result.candidates;
}

describe('元のU/V曲面を有限領域で調べて作る点',()=>{
  it.each(['U^4+V^4','-(2*U^4+3*U^2*V^2+V^4)'])('四次式%sの1座標から唯一の点を求める',equation=>{
    const request=input(['U','V',equation],[{axis:'Z',value:0}]);
    const [point]=ready(solve(request),1);expect(point.point).toEqual([0,0,0]);
    expect(point.location.box).toEqual([{lower:0,upper:0},{lower:0,upper:0}]);
    ready(solve({...request,lower:[1,-4]}),0);
  });
  it('四次式でも二本の軸や曲線が残る等高線は点として確定しない',()=>{
    for(const equation of ['U^2*V^2','U^4-V^4']){
      const result=solve(input(['U','V',equation],[{axis:'Z',value:0}]));
      expect(result).toMatchObject({status:'ready',candidates:[],exhaustive:false});
    }
  });
  it('回転した媒介平面のX/YからU/Vを同時に解き、未知のZも原式から求める',()=>{
    const [point]=ready(solve(input(['U+V','U-V','U*V'],[{axis:'X',value:3},{axis:'Y',value:1}])),1);
    expect(point.point[0]).toBe(3);expect(point.point[1]).toBe(1);expect(point.point[2]).toBeCloseTo(2,7);
    expect(point.location.box[0].lower).toBeLessThanOrEqual(2);expect(point.location.box[0].upper).toBeGreaterThanOrEqual(2);
    expect(point.location.box[1].lower).toBeLessThanOrEqual(1);expect(point.location.box[1].upper).toBeGreaterThanOrEqual(1);
  });
  it('2つの二乗から生じる4枝を全て探し、近さを理由に1点へまとめない',()=>{
    const points=ready(solve(input(['U^2','V^2','U+2*V'],[{axis:'X',value:1},{axis:'Y',value:1}])),4);
    expect(points.map(point=>Math.round(point.point[2])).sort((a,b)=>a-b)).toEqual([-3,-1,1,3]);
    for(const point of points)for(const index of [0,1,2])expect(point.maximum[index]-point.minimum[index]).toBeLessThanOrEqual(1e-7);
  });
  it('U/Vの角にある根も範囲を勝手に広げず、正確な式から拾う',()=>{
    const request=input(['U','V','U+V'],[{axis:'X',value:-4},{axis:'Y',value:4}]);
    const [point]=ready(solve(request),1);expect(point.point).toEqual([-4,4,0]);
    expect(point.location.box).toEqual([{lower:-4,upper:-4},{lower:4,upper:4}]);
  });
  it('XYZの既知値が箱の外なら探索を始めない',()=>{
    expect(solve(input(['U','V','0'],[{axis:'X',value:11},{axis:'Y',value:0}])))
      .toEqual({status:'out-of-range',axes:['X']});
  });
  it('U/Vでは存在しても、未知のZが描画範囲外なら点を作らない',()=>{
    ready(solve(input(['U','V','20'],[{axis:'X',value:1},{axis:'Y',value:2}])),0);
  });
  it('XYZが許す値でも元のU/V領域に存在しなければ候補はない',()=>{
    ready(solve(input(['U','V','0'],[{axis:'X',value:5},{axis:'Y',value:2}])),0);
  });
  it('1条件や同一の2条件で自由度が残る領域を一意な点として返さない',()=>{
    expect(solve(input(['U','V','0'],[{axis:'X',value:1}]))).toEqual({status:'underconstrained'});
    const result=solve(input(['U','U','V'],[{axis:'X',value:1},{axis:'Y',value:1}]));
    if(result.status==='ready'){expect(result.exhaustive).toBe(false);expect(result.candidates).toEqual([]);}
    else expect(result.status).toBe('stopped');
  });
  it('1つのZ指定でU方向の全体が同じ点へ縮退する場合は、勝手なU選択をせず点を作る',()=>{
    const [point]=ready(solve(input(['U*V','U*V^2','V'],[{axis:'Z',value:0}])),1);
    expect(point.point).toEqual([0,0,0]);
    expect(point.location.box).toEqual([{lower:-4,upper:4},{lower:0,upper:0}]);
    expect(solve(input(['U*V','U*V^2','V'],[{axis:'Z',value:1}]))).toEqual({status:'underconstrained'});
  });
  it('使用しないVを固定したふりをせず、Uの1座標から異なる2枝を保持する',()=>{
    const points=ready(solve(input(['U^2','U','0'],[{axis:'X',value:1}])),2);
    expect(points.map(point=>Math.round(point.point[1])).sort((a,b)=>a-b)).toEqual([-1,1]);
    for(const point of points)expect(point.location.box[1]).toEqual({lower:-4,upper:4});
  });
  it('三角関数を使う円錐の頂点も、自由方向の微分が全域0であることから証明する',()=>{
    expect(ready(solve(input(['V*cos(U)','V*sin(U)','V'],[{axis:'Z',value:0}])),1)[0].point).toEqual([0,0,0]);
  });
  it('全域が同じ点の場合は1点だけを返し、指定値が一致しなければ作らない',()=>{
    expect(ready(solve(input(['1','2','3'],[{axis:'X',value:1}])),1)[0].point).toEqual([1,2,3]);
    ready(solve(input(['1','2','3'],[{axis:'X',value:2}])),0);
  });
  it('1座標で選べた縮退点にも未知のXYZ範囲を適用する',()=>{
    ready(solve(input(['U*V','20','V'],[{axis:'Z',value:0}])),0);
  });
  it('1座標の指定が放物面の極値なら、原式の二次形式から唯一の点を証明する',()=>{
    expect(ready(solve(input(['U','V','(U-1)^2+(U-1)*(V-2)+(V-2)^2'],[{axis:'Z',value:0}])),1)[0].point).toEqual([1,2,0]);
    expect(ready(solve(input(['U','V','5-(U-1)^2-2*(V+1)^2'],[{axis:'Z',value:5}])),1)[0].point).toEqual([1,-1,5]);
  });
  it('U/V範囲での最小値が角にあっても、範囲を広げず1点を証明する',()=>{
    expect(ready(solve(input(['U','V','(U+5)^2+(V+5)^2'],[{axis:'Z',value:2}])),1)[0].point).toEqual([-4,-4,2]);
  });
  it('有理数の臨界点を丸めて別の点とみなさず、位置の上下界を保持する',()=>{
    const [point]=ready(solve(input(['U','V','(U-1/3)^2+(V+1/7)^2'],[{axis:'Z',value:0}])),1);
    expect(point.point[0]).toBeCloseTo(1/3,7);expect(point.point[1]).toBeCloseTo(-1/7,7);
    expect(point.maximum[0]-point.minimum[0]).toBeLessThanOrEqual(1e-7);
  });
  it('有限なU/V範囲の最大値で4つの角だけが解になる場合も全候補を保持する',()=>{
    const request={...input(['U','V','U^2+V^2'],[{axis:'Z',value:32}]),maximum:[10,10,40] as const};
    const points=ready(solve(request),4);
    expect(points.map(point=>point.point).sort((a,b)=>a[0]-b[0]||a[1]-b[1])).toEqual([[-4,-4,32],[-4,4,32],[4,-4,32],[4,4,32]]);
  });
  it('二次式の有限領域全体が指定値より上か下なら、存在しないことを証明する',()=>{
    ready(solve(input(['U','V','U^2+V^2+1'],[{axis:'Z',value:0}])),0);
    ready(solve(input(['U','V','U^2+V^2-40'],[{axis:'Z',value:0}])),0);
  });
  it('同符号の偶数乗の和の孤立点は四次式でも一意性を確認できる',()=>{
    const points=ready(solve(input(['U','V','(U^2+V^2)^2'],[{axis:'Z',value:0}])),1);
    expect(points[0].point).toEqual([0,0,0]);
  });
  it('混合符号を含む高次の臨界値は任意の一点を返したり、全域探索済みとしない',()=>{
    const result=solve(input(['U','V','(U^2+V^2-1)^2'],[{axis:'Z',value:0}]));
    expect(result.status).toBe('ready');if(result.status!=='ready')throw new Error(JSON.stringify(result));
    expect(result.exhaustive).toBe(false);expect(result.candidates).toEqual([]);
    expect(result.unresolved).toEqual([{box:[{lower:-4,upper:4},{lower:-4,upper:4}],reason:'two-parameter-coordinate'}]);
  });
  it('原式の定義されない点を座標の条件だけで採用しない',()=>{
    ready(solve(input(['U','V','sqrt(U)'],[{axis:'X',value:-1},{axis:'Y',value:2}])),0);
  });
  it('大きな傾きのZにも最終XYZ精度を適用する',()=>{
    const request=input(['U^2','V','1000*(U^2-2)+V'],[{axis:'X',value:2},{axis:'Y',value:1}]);
    for(const point of ready(solve(request),2)){
      expect(point.point[2]).toBeCloseTo(1,7);expect(point.maximum[2]-point.minimum[2]).toBeLessThanOrEqual(1e-7);
    }
  });
  it('中止や途中の期限切れは探索成功ではない',()=>{
    const request=input(['U^2','V^2','0'],[{axis:'X',value:2},{axis:'Y',value:2}]);
    expect(solveSurfaceFunctionPoints(request,{backend,shouldStop:()=> 'cancelled'})).toEqual({status:'stopped',reason:'cancelled'});
    let count=0;
    expect(solveSurfaceFunctionPoints(request,{backend,shouldStop:()=>++count>100?'deadline':undefined})).toEqual({status:'stopped',reason:'deadline'});
  });
  it('親の式・XYZ・U/V・既知座標を読み取った後に元の入力を書き換えても所有した条件は変わらない',()=>{
    const request=JSON.parse(JSON.stringify(input(['U','V','U+V'],[{axis:'X',value:1},{axis:'Y',value:2}]))) as SurfacePointWorkRequest;
    const owned=decodeSurfacePointWorkRequest(request),mutable=request as unknown as {lower:number[];minimum:number[];known:{value:number}[];outputs:{source:string}[]};
    mutable.lower[0]=-100;mutable.minimum[2]=-100;mutable.known[0].value=4;mutable.outputs[2].source='0';
    expect(owned.lower[0]).toBe(-4);expect(owned.minimum[2]).toBe(-10);expect(owned.known[0].value).toBe(1);expect(owned.outputs[2].source).toBe('U+V');
    const {maximum:_maximum,...missing}=request;void _maximum;
    expect(()=>decodeSurfacePointWorkRequest(missing)).toThrow();
  });
});
