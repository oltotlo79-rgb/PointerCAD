import {beforeAll,describe,expect,it,vi} from 'vitest';
import {expressionValueFromNumber as number} from '@pointercad/expression';
import {createEmptyPartDocument,createFunctionSurface,createFunctionCurve,replaceSketch,appendSolid,FUNCTION_DEFINITION_FORMAT,type FunctionDefinition} from '@pointercad/model';
import {
  createFunctionMathSource,
  createMathBackend,
  executeFunctionPointWorkRequest,
  executeCurvePointWorkRequest,
  executeSurfacePointWorkRequest,
  executeMathWorkRequest,
  type MathExecutionBackend,
} from '@pointercad/expression/math/worker';


import {
  CANDIDATE_MATH_BY_ID,
  decodeMathWorkReply,
  isCurvePointInput,
  isSurfacePointInput,
} from '@pointercad/expression/math/contracts';

import type {
  PointCalculationWorkerClient,
  MathWorkerClient,
} from '@pointercad/expression/math/client';


import {searchFunctionPoints,applyFunctionPointChoice,type FunctionPointFields} from './functionPointDraft.js';

let backend:MathExecutionBackend;beforeAll(()=>{backend=createMathBackend();});
const client:Pick<MathWorkerClient,'evaluate'>={evaluate:request=>Promise.resolve({status:'result',identity:request.identity,
  result:decodeMathWorkReply(executeMathWorkRequest({kind:'evaluate-math',serial:1,request},backend),request,
    {operationsById:CANDIDATE_MATH_BY_ID,coefficientIds:new Set(request.coefficients.map(item=>item.id)),declaredIds:new Set()}).result})};
const points:Pick<PointCalculationWorkerClient,'evaluate'>={evaluate:request=>Promise.resolve({status:'result',identity:request.identity,
  result:isSurfacePointInput(request)?executeSurfacePointWorkRequest({kind:'solve-surface-points',serial:1,request},backend).result
    :isCurvePointInput(request)?executeCurvePointWorkRequest({kind:'solve-curve-points',serial:1,request},backend).result
    :executeFunctionPointWorkRequest({kind:'solve-function-points',serial:1,request},backend).result})};
const scalar=(source:string)=>({source,angleUnit:'degree' as const});
const fields:FunctionPointFields={X:scalar('0'),Y:scalar('0'),Z:null};
function fixture(maxZ=2) {
  const base=createEmptyPartDocument(),definition:FunctionDefinition={format:FUNCTION_DEFINITION_FORMAT,
    bounds:{X:{min:number(-2),max:number(2)},Y:{min:number(-2),max:number(2)},Z:{min:number(-2),max:number(maxZ)}},tolerance:number(1e-6),
    formula:{kind:'implicit-surface',expression:createFunctionMathSource('X^2+Y^2+Z^2-1','text','radian',{axes:['X','Y','Z'],parameters:[],coefficients:[]},backend)}};
  const feature=createFunctionSurface(base,definition);return {document:appendSolid(base,feature),parent:{kind:'surface' as const,featureId:feature.id}};
}
const search=(input=fixture(),values=fields,pointClient=points)=>searchFunctionPoints(input.document,1,input.parent,values,client,pointClient,new AbortController().signal,()=>true);
function coordinateFixture(output:'X'|'Y'|'Z'='Z',notation:'text'|'latex'='text'){
  const input=fixture(),axes=(['X','Y','Z']as const).filter(axis=>axis!==output);
  const expression=createFunctionMathSource(`${axes[0]}^2+${axes[1]}^2`,notation,'radian',{axes,parameters:[],coefficients:[]},backend);
  return {...input,document:{...input.document,solids:input.document.solids.map(item=>item.kind==='functionSurface'
    ?{...item,definition:{...item.definition,formula:{kind:'coordinate-surface' as const,output,expression}}}:item)}};
}
describe('関数上の点を既知座標から選んで作る',()=>{
  it.each([false,true])('媒介曲面の2座標と縮退点（1座標=%s）をU/VとXYZの別々の範囲で保存する',async collapsed=>{
    const original=fixture(),source=original.document.solids[0];if(source.kind!=='functionSurface')throw new Error('Missing surface');
    const expression=(text:string)=>createFunctionMathSource(text,'text','degree',{axes:[],parameters:['U','V'],coefficients:[]},backend);
    const formula:FunctionDefinition['formula']={kind:'parametric-surface',U:{min:number(-4),max:number(4)},V:{min:number(-3),max:number(3)},
      outputs:collapsed?{X:expression('U*V'),Y:expression('U*V^2'),Z:expression('V')}
        :{X:expression('U+V'),Y:expression('U-V'),Z:expression('U*V')}};
    const document={...original.document,solids:[{...source,definition:{...source.definition,formula}}]};
    const result=await search({...original,document},collapsed?{X:null,Y:null,Z:scalar('0')}:{X:scalar('2'),Y:scalar('0'),Z:null});
    if(result.status!=='ready')throw new Error(JSON.stringify(result));
    expect(result.search.exhaustive).toBe(true);expect(result.search.candidates).toHaveLength(1);
    const candidate=result.search.candidates[0];expect(candidate.point[2]).toBeCloseTo(collapsed?0:1,7);
    expect(result.search.request).toMatchObject({kind:'parametric-surface',lower:[-4,-3],upper:[4,3],minimum:[-2,-2,-2],maximum:[2,2,2]});
    const applied=applyFunctionPointChoice(result.search,candidate),point=applied.sketches[0].features.at(-1);
    if(point?.kind!=='point'||point.at.mode==='absolute'||point.at.base.kind!=='functionPoint')throw new Error('Missing point');
    expect(point.at.base.choice.input).toMatchObject({kind:'parametric-surface',known:collapsed?[{axis:'Z',value:0}]:[{axis:'X',value:2},{axis:'Y',value:0}]});
    expect(point.at.base.choice.location).toEqual(candidate.location);
  });
  it.each(['coordinate-curve','parametric-curve'] as const)('%sの元の式と全XYZを使い、選んだ曲線上の位置を保存する',async kind=>{
    const base=fixture().document,sketch=base.sketches[0];
    const expression=(source:string)=>createFunctionMathSource(source,'text','degree',
      {axes:kind==='coordinate-curve'?['Y']:[],parameters:kind==='parametric-curve'?['T']:[],coefficients:[]},backend);
    const formula:FunctionDefinition['formula']=kind==='coordinate-curve'
      ?{kind,independent:'Y',outputs:{X:expression('Y^2'),Z:expression('Y+1')}}
      :{kind,T:{min:number(-2),max:number(2)},outputs:{X:expression('T^2'),Y:expression('T'),Z:expression('0')}};
    const feature=createFunctionCurve(sketch,{format:FUNCTION_DEFINITION_FORMAT,formula,tolerance:number(0.1),
      bounds:{X:{min:number(-2),max:number(2)},Y:{min:number(-2),max:number(2)},Z:{min:number(-2),max:number(2)}}});
    const document=replaceSketch({...base,solids:[]},{...sketch,features:[feature]});
    const parent={kind:'curve' as const,sketchId:sketch.id,featureId:feature.id};
    const values:FunctionPointFields=kind==='coordinate-curve'?{X:null,Y:scalar('1'),Z:null}:{X:scalar('1'),Y:null,Z:null};
    const result=await searchFunctionPoints(document,1,parent,values,client,points,new AbortController().signal,()=>true);
    if(result.status!=='ready')throw new Error(JSON.stringify(result));
    expect(result.search.exhaustive).toBe(true);expect(result.search.request.tolerance).toBe(1e-7);
    expect(result.search.candidates.map(item=>item.point)).toEqual(kind==='coordinate-curve'?[[1,1,2]]:[[1,-1,0],[1,1,0]]);
    const chosen=result.search.candidates.at(-1);if(!chosen)throw new Error('Missing curve point');
    const saved=applyFunctionPointChoice(result.search,chosen).sketches[0].features.at(-1);
    expect(saved).toMatchObject({kind:'point',at:{base:{parent,choice:{input:{kind:'curve'},location:{kind:'curve',independent:kind==='coordinate-curve'?'Y':'T'}}}}});
  });
  it.each(['X','Y','Z']as const)('出力軸%sの放物面を2座標から求め、軸の役割を取り違えない',async output=>{
    const axes=['X','Y','Z']as const,values:FunctionPointFields={X:output==='X'?null:scalar('0.5'),Y:output==='Y'?null:scalar('0.5'),Z:output==='Z'?null:scalar('0.5')};
    const result=await search(coordinateFixture(output),values);if(result.status!=='ready')throw new Error(JSON.stringify(result));
    expect(result.search.candidates).toHaveLength(1);expect(result.search.candidates[0].point).toEqual([0.5,0.5,0.5]);
    expect(result.search.known.map(item=>item.axis)).toEqual(axes.filter(axis=>axis!==output));
  });
  it('構造入力の放物面で逆方向にも2候補を探し、自由度不足と範囲外を区別する',async()=>{
    const input=coordinateFixture('Z','latex'),result=await search(input,{X:scalar('0'),Y:null,Z:scalar('1')});
    if(result.status!=='ready')throw new Error(JSON.stringify(result));
    expect(result.search.candidates.map(item=>item.point)).toEqual([[0,-1,1],[0,1,1]]);
    expect(await search(input,{X:scalar('0'),Y:null,Z:null})).toMatchObject({status:'failed'});
    expect(await search(input,{X:scalar('2'),Y:scalar('2'),Z:null})).toMatchObject({status:'ready',search:{candidates:[]}});
  });
  it('XYの2値で正負2候補を出し、選んだ枝だけを通常の点として保存する',async()=>{
    const input=fixture(),before=JSON.stringify(input.document),result=await search(input);
    if(result.status!=='ready') throw new Error(JSON.stringify(result));expect(result.search.candidates).toHaveLength(2);
    expect(result.search.candidates.map(item=>item.point)).toEqual([[0,0,-1],[0,0,1]]);
    const document=applyFunctionPointChoice(result.search,result.search.candidates[1]),point=document.sketches[0].features.at(-1);
    expect(point).toMatchObject({kind:'point',planeId:'free',at:{mode:'relative',base:{kind:'functionPoint',parent:input.parent,
      choice:{location:{kind:'implicit',axis:'Z',interval:{lower:1,upper:1}}}}}});
    expect(JSON.stringify(input.document)).toBe(before);
    expect(()=>applyFunctionPointChoice(result.search,{...result.search.candidates[0]})).toThrow();
  });
  it('親のXYZ範囲で正の候補を除外し、範囲外の座標指定を断る',async()=>{
    const result=await search(fixture(0));if(result.status!=='ready')throw new Error(JSON.stringify(result));
    expect(result.search.candidates.map(item=>item.point)).toEqual([[0,0,-1]]);
    expect(await search(fixture(),{...fields,X:scalar('3')})).toMatchObject({status:'failed'});
  });
  it('未解決の範囲がある候補は保存後に無効になる点として作らず、元の文書を保つ',async()=>{
    const result=await search();if(result.status!=='ready')throw new Error(JSON.stringify(result));
    const before=JSON.stringify(result.search.document),candidate=result.search.candidates[0];
    for(const state of [{exhaustive:false,unresolved:1},{exhaustive:false,unresolved:0},{exhaustive:true,unresolved:1}]) {
      expect(()=>applyFunctionPointChoice({...result.search,...state},candidate)).toThrow('まだ点を作成・変更できません');
    }
    expect(JSON.stringify(result.search.document)).toBe(before);
    expect(applyFunctionPointChoice(result.search,candidate).sketches[0].features.at(-1)).toMatchObject({kind:'point'});
  });
  it('親の粗い表示精度によらず、無理数の点の座標をCADの参照精度まで絞る',async()=>{
    const input=fixture(),document={...input.document,solids:input.document.solids.map(item=>item.kind==='functionSurface'
      ?{...item,definition:{...item.definition,tolerance:number(0.1)}}:item)};
    const result=await search({...input,document},{...fields,X:scalar('0.5')});
    if(result.status!=='ready')throw new Error(JSON.stringify(result));
    expect(result.search.candidates).toHaveLength(2);
    for(const candidate of result.search.candidates){
      expect(Math.abs(Math.abs(candidate.point[2])-Math.sqrt(3)/2)).toBeLessThan(1e-7);
      expect(candidate.maximum[2]-candidate.minimum[2]).toBeLessThanOrEqual(1e-7);
    }
  });
  it('保存済みの関数基準点を編集しても既存のオフセットと作業平面を消さない',async()=>{
    const result=await search();if(result.status!=='ready')throw new Error(JSON.stringify(result));
    const created=applyFunctionPointChoice(result.search,result.search.candidates[1]),sketch=created.sketches[0],point=sketch.features.at(-1);
    if(point?.kind!=='point'||point.at.mode!=='relative')throw new Error('Missing point');
    const offset={...point,at:{...point.at,dx:number(3)},planeId:'xy'},document={...created,sketches:[{...sketch,features:[offset]}]};
    const changed=applyFunctionPointChoice({...result.search,document},result.search.candidates[0],point.id);
    expect(changed.sketches[0].features[0]).toMatchObject({id:point.id,planeId:'xy',at:{dx:{source:'3'},base:{choice:{location:{interval:{lower:-1,upper:-1}}}}}});
  });
  it('1座標で球の極を特定し、自由度が残る値には追加の座標を求める',async()=>{
    const result=await search(fixture(),{X:null,Y:null,Z:scalar('1')});if(result.status!=='ready')throw new Error(JSON.stringify(result));
    expect(result.search.candidates.map(item=>item.point)).toEqual([[0,0,1]]);
    expect(await search(fixture(),{X:null,Y:null,Z:scalar('0')})).toMatchObject({status:'failed'});
  });
  it.each(['','1/0','sqrt(-1)','X'])('実数座標にならない%sは点のWorkerへ送らない',async source=>{
    const evaluate=vi.fn(points.evaluate),result=await search(fixture(),{...fields,X:scalar(source)},{evaluate});
    expect(result.status).toBe('failed');expect(evaluate).not.toHaveBeenCalled();
  });
  it('πと座標軸を混同せず数式を評価し、保存された表示値を信頼しない',async()=>{
    const result=await search(fixture(),{...fields,X:{...scalar('sin(π)'),angleUnit:'radian',accepted:{source:'sin(π)',value:100,display:'100'}}});
    if(result.status!=='ready')throw new Error(JSON.stringify(result));
    expect(Math.abs(result.search.known[0].value.value)).toBeLessThan(1e-12);expect(result.search.candidates).toHaveLength(2);
  });
  it('文書が変わったときは計算を開始しない',async()=>{
    const input=fixture(),evaluate=vi.fn(points.evaluate);
    expect(await searchFunctionPoints(input.document,1,input.parent,fields,client,{evaluate},new AbortController().signal,()=>false)).toEqual({status:'cancelled'});
    expect(evaluate).not.toHaveBeenCalled();
  });
});
