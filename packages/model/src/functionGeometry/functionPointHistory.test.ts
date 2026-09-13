import {beforeAll,describe,expect,it} from 'vitest';
import {expressionValueFromNumber as number} from '@pointercad/expression';
import {
  createFunctionMathSource,
  createMathBackend,
  executeFunctionPointContinuationWork,
  executeCurvePointContinuationWork,
  executeSurfacePointContinuationWork,
  executeMathWorkRequest,
  type MathExecutionBackend,
} from '@pointercad/expression/math/worker';


import {
  CANDIDATE_MATH_BY_ID,
  decodeMathWorkReply,
  isCurvePointContinuation,
  isSurfacePointContinuation,
  FUNCTION_SURFACE_LIMITS,
} from '@pointercad/expression/math/contracts';


import {createEmptyPartDocument,createPrimitiveFeature} from '../part/createPartDocument.js';
import {evaluateDocumentMath,type DocumentMathContext} from '../part/evaluateDocumentMath.js';
import type {PartDocument,ReferenceFeature,SolidFeature} from '../part/types.js';
import {resolvePart} from '../part/resolvePart.js';
import {createReferenceResolver} from '../part/resolveReferences.js';
import {createPointFeature} from '../sketch/createSketchDocument.js';
import {FREE_WORK_PLANE_ID} from '../sketch/planeMath.js';
import {isLiteralCoordinate} from '../sketch/constraints/variables.js';
import type {SketchFunctionCurveFeature,SketchLineFeature} from '../sketch/types.js';
import {FUNCTION_DEFINITION_FORMAT} from './functionDefinitionTypes.js';
import {recomputeFunctionPoints} from './recomputeFunctionPoints.js';
import type {FunctionRecomputeContext} from './recomputeFunctionCurves.js';
import {readFunctionPointChoice,type FunctionPointReference} from './functionPointReference.js';
import {createFunctionSurface} from './functionSurfaceFeature.js';

let backend:MathExecutionBackend;beforeAll(()=>{backend=createMathBackend();});
function fixture(radius=1) {
  const document=createEmptyPartDocument(),sketch=document.sketches[0];
  const expression=createFunctionMathSource('X^2+Y^2-coef("r")^2','text','radian',
    {axes:['X','Y'],parameters:[],coefficients:[{id:'coefficient:1',label:'r'}]},backend);
  const curve:SketchFunctionCurveFeature={id:'curve',kind:'functionCurve',name:'circle',planeId:FREE_WORK_PLANE_ID,construction:false,
    definition:{format:FUNCTION_DEFINITION_FORMAT,bounds:{X:{min:number(-4),max:number(4)},Y:{min:number(-4),max:number(4)},Z:{min:number(-4),max:number(4)}},
      tolerance:number(1e-6),formula:{kind:'implicit-curve',expression,fixedAxis:'Z',fixedCoordinate:number(0)}}};
  const reference:FunctionPointReference={kind:'functionPoint',parent:{kind:'curve',sketchId:sketch.id,featureId:curve.id},
    known:[{axis:'X',value:{source:'0',display:'999',value:999}}],choice:readFunctionPointChoice({input:{expression,
      minimum:[-4,-4,-4],maximum:[4,4,4],tolerance:1e-6,coefficients:[{id:'coefficient:1',label:'r',decimal:'1'}],
      known:[{axis:'X',value:0}],fixed:{axis:'Z',value:0}},location:{kind:'implicit',axis:'Y',interval:{lower:1,upper:1}}})};
  const point={...createPointFeature(sketch,{mode:'relative',base:reference,dx:number(0),dy:number(0),dz:number(0)}),id:'chosen',planeId:FREE_WORK_PLANE_ID};
  const input:PartDocument={...document,parameters:[{name:'r',mathId:'coefficient:1',unit:'none',description:'',value:number(radius)}],
    sketches:[{...sketch,features:[curve,point]}]};
  return {input,reference,curve,point};
}
function math(document:PartDocument):DocumentMathContext {
  return {identity:{documentId:document.id,documentVersion:1},isCurrent:()=>true,client:{evaluate:request=>Promise.resolve({status:'result',identity:request.identity,
    result:decodeMathWorkReply(executeMathWorkRequest({kind:'evaluate-math',serial:1,request},backend),request,
      {operationsById:CANDIDATE_MATH_BY_ID,coefficientIds:new Set(request.coefficients.map(item=>item.id)),declaredIds:new Set()}).result})}};
}
const context:FunctionRecomputeContext={curves:{evaluate:()=>{throw new Error('Point recalculation must not sample parent curves');}},
  points:{evaluate:request=>Promise.resolve({status:'result',identity:request.identity,
    result:isSurfacePointContinuation(request)?executeSurfacePointContinuationWork({kind:'continue-surface-point',serial:1,request},backend).result
      :isCurvePointContinuation(request)?executeCurvePointContinuationWork({kind:'continue-curve-point',serial:1,request},backend).result
      :executeFunctionPointContinuationWork({kind:'continue-function-point',serial:1,request},backend).result})}};
async function calculate(input:PartDocument,functions:FunctionRecomputeContext|undefined=context,invalid=new Map<string,string>(),cancel=()=>false) {
  const evaluation=math(input),evaluated=await evaluateDocumentMath(input,evaluation);
  if(!evaluated.ok) throw new Error(JSON.stringify(evaluated));
  const result=await recomputeFunctionPoints(evaluated.document,evaluated.analysis,evaluation,functions,invalid,cancel);
  const point=evaluated.document.sketches[0].features.find(item=>item.id==='chosen');
  if(point?.kind!=='point' || point.at.mode==='absolute' || point.at.base.kind!=='functionPoint') throw new Error('Missing point');
  return {...result,document:evaluated.document,point:result.resolve(point.at.base,point.id)};
}
describe('関数上の点を親の現在値から解決する',()=>{
  it.each([false,true])('法線の起点と終点が半径と長さの原式へ追従する（反転=%s）',async reverse=>{
    const old=fixture(2),sketch=old.input.sketches[0];
    const base:FunctionPointReference={...old.reference,direction:{kind:'normal',length:{source:'r*3',display:'999',value:999},reverse,sourcePointId:'chosen'}};
    const line:SketchLineFeature={id:'direction-line',name:'法線',kind:'line',planeId:FREE_WORK_PLANE_ID,construction:false,
      from:{mode:'relative',base:{kind:'point',pointId:'chosen'},dx:number(0),dy:number(0),dz:number(0)},
      to:{mode:'relative',base,dx:number(0),dy:number(0),dz:number(0)}};
    const input={...old.input,sketches:[{...sketch,features:[...sketch.features,line]}]},before=JSON.stringify(input),result=await calculate(input);
    expect([...result.invalidInputs]).toEqual([]);expect(result.point).toEqual([0,2,0]);
    const saved=result.document.sketches[0].features.find(item=>item.id===line.id);
    if(saved?.kind!=='line'||saved.to.mode!=='relative'||saved.to.base.kind!=='functionPoint')throw new Error('Missing direction');
    expect(saved.to.base.direction?.length.value).toBe(6);
    const endpoint=result.resolve(saved.to.base,line.id);expect(endpoint?.[0]).toBeCloseTo(0,7);expect(endpoint?.[1]).toBeCloseTo(reverse?-4:8,7);
    expect(endpoint?.[2]).toBeCloseTo(0,7);expect(JSON.stringify(input)).toBe(before);
  });
  it('起点の候補を正から負へ選び直すと、方向も古い候補から切り替わる',async()=>{
    const old=fixture(1),sketch=old.input.sketches[0];
    const selected:FunctionPointReference={...old.reference,choice:{...old.reference.choice,location:{kind:'implicit',axis:'Y',interval:{lower:-1,upper:-1}}}};
    const point={...old.point,at:{mode:'relative' as const,base:selected,dx:number(0),dy:number(0),dz:number(0)}};
    const base:FunctionPointReference={...old.reference,direction:{kind:'normal',length:number(2),reverse:false,sourcePointId:point.id}};
    const endpoint={...old.point,id:'direction-end',at:{mode:'relative' as const,base,dx:number(0),dy:number(0),dz:number(0)}};
    const result=await calculate({...old.input,sketches:[{...sketch,features:[old.curve,point,endpoint]}]});
    expect([...result.invalidInputs]).toEqual([]);expect(result.point).toEqual([0,-1,0]);
    expect(result.resolve({...base,known:[{axis:'X',value:number(0)}]},endpoint.id)?.[1]).toBeCloseTo(-3,7);
  });
  it.each(['missing','later','moved','self']as const)('方向の起点が%sなら過去の候補で代用しない',async issue=>{
    const old=fixture(),sketch=old.input.sketches[0];
    const base:FunctionPointReference={...old.reference,direction:{kind:'normal',length:number(2),reverse:false,sourcePointId:issue==='missing'?'absent':issue==='self'?'direction-end':'chosen'}};
    const endpoint={...old.point,id:'direction-end',at:{mode:'relative' as const,base,dx:number(0),dy:number(0),dz:number(0)}};
    const point=issue==='moved'?{...old.point,at:{...old.point.at,dx:number(1)}}:old.point;
    const features=issue==='later'?[old.curve,endpoint,point]:[old.curve,point,endpoint];
    const result=await calculate({...old.input,sketches:[{...sketch,features}]});
    expect(result.invalidInputs.has(endpoint.id)).toBe(true);expect(result.resolve(base,endpoint.id)).toBeNull();
  });
  it('1座標で特定した二次曲面の頂点を保存条件から親の現在係数へ追従させる',async()=>{
    const old=fixture(2),sketch=old.input.sketches[0];
    const expression=(source:string)=>createFunctionMathSource(source,'text','degree',
      {axes:[],parameters:['U','V'],coefficients:[{id:'coefficient:1',label:'r'}]},backend);
    const outputs={X:expression('U'),Y:expression('V'),Z:expression('(U-coef("r"))^2+V^2')};
    const surface=createFunctionSurface(old.input,{...old.curve.definition,formula:{kind:'parametric-surface',
      U:{min:number(-4),max:number(4)},V:{min:number(-4),max:number(4)},outputs}});
    const reference:FunctionPointReference={kind:'functionPoint',parent:{kind:'surface',featureId:surface.id},known:[{axis:'Z',value:number(0)}],
      choice:readFunctionPointChoice({input:{kind:'parametric-surface',independent:['U','V'],outputs:[outputs.X,outputs.Y,outputs.Z],
        lower:[-4,-4],upper:[4,4],minimum:[-4,-4,-4],maximum:[4,4,4],tolerance:1e-7,budget:FUNCTION_SURFACE_LIMITS,
        coefficients:[{id:'coefficient:1',label:'r',decimal:'1'}],known:[{axis:'Z',value:0}]},
        location:{kind:'parametric-surface',box:[{lower:1,upper:1},{lower:0,upper:0}]}})};
    const point={...old.point,at:{mode:'relative' as const,base:reference,dx:number(0),dy:number(0),dz:number(0)}};
    const input={...old.input,solids:[surface],sketches:[{...sketch,features:[point]}]},before=JSON.stringify(input);
    const result=await calculate(input);expect([...result.invalidInputs]).toEqual([]);expect(result.point).toEqual([2,0,0]);
    expect(JSON.stringify(input)).toBe(before);
  });
  it.each([1,4])('媒介曲面の係数r=%sで保存した正のUの枝を再計算する',async radius=>{
    const old=fixture(radius),sketch=old.input.sketches[0];
    const expression=(source:string)=>createFunctionMathSource(source,'text','degree',
      {axes:[],parameters:['U','V'],coefficients:[{id:'coefficient:1',label:'r'}]},backend);
    const outputs={X:expression('U^2-coef("r")'),Y:expression('V'),Z:expression('U')};
    const surface=createFunctionSurface(old.input,{...old.curve.definition,formula:{kind:'parametric-surface',
      U:{min:number(-4),max:number(4)},V:{min:number(-4),max:number(4)},outputs}});
    const reference:FunctionPointReference={kind:'functionPoint',parent:{kind:'surface',featureId:surface.id},
      known:[{axis:'X',value:number(0)},{axis:'Y',value:number(1)}],choice:readFunctionPointChoice({
        input:{kind:'parametric-surface',independent:['U','V'],outputs:[outputs.X,outputs.Y,outputs.Z],lower:[-4,-4],upper:[4,4],
          minimum:[-4,-4,-4],maximum:[4,4,4],tolerance:1e-7,budget:FUNCTION_SURFACE_LIMITS,
          coefficients:[{id:'coefficient:1',label:'r',decimal:'1'}],known:[{axis:'X',value:0},{axis:'Y',value:1}]},
        location:{kind:'parametric-surface',box:[{lower:1,upper:1},{lower:1,upper:1}]}})};
    const point={...old.point,at:{mode:'relative' as const,base:reference,dx:number(0),dy:number(0),dz:number(0)}};
    const result=await calculate({...old.input,solids:[surface],sketches:[{...sketch,features:[point]}]});
    expect([...result.invalidInputs]).toEqual([]);expect(result.point?.slice(0,2)).toEqual([0,1]);
    expect(result.point?.[2]).toBeCloseTo(Math.sqrt(radius),7);
  });
  it.each([1,4])('媒介曲線の保存条件からX=%sの正のTを再計算し、係数で動くYにも追従する',async x=>{
    const old=fixture(2),sketch=old.input.sketches[0];
    const expression=(source:string)=>createFunctionMathSource(source,'text','degree',
      {axes:[],parameters:['T'],coefficients:[{id:'coefficient:1',label:'r'}]},backend);
    const outputs={X:expression('T^2'),Y:expression('coef("r")*T'),Z:expression('0')};
    const curve:SketchFunctionCurveFeature={...old.curve,definition:{...old.curve.definition,
      formula:{kind:'parametric-curve',T:{min:number(-4),max:number(4)},outputs}}};
    const reference:FunctionPointReference={...old.reference,known:[{axis:'X',value:number(x)}],choice:readFunctionPointChoice({
      input:{kind:'curve',independent:'T',outputs:[outputs.X,outputs.Y,outputs.Z],lower:-4,upper:4,
        minimum:[-4,-4,-4],maximum:[4,4,4],tolerance:1e-7,coefficients:[{id:'coefficient:1',label:'r',decimal:'1'}],known:[{axis:'X',value:1}]},
      location:{kind:'curve',independent:'T',interval:{lower:1,upper:1},direct:false}})};
    const point={...old.point,at:{mode:'relative' as const,base:reference,dx:number(0),dy:number(0),dz:number(0)}};
    const input={...old.input,sketches:[{...sketch,features:[curve,point]}]},before=JSON.stringify(input),result=await calculate(input);
    expect(result.invalidInputs.size).toBe(0);expect(result.point).toEqual([x,2*Math.sqrt(x),0]);expect(JSON.stringify(input)).toBe(before);
  });
  it('オフセットが数値0でもドラッグによって関数から離せない',()=>{
    expect(isLiteralCoordinate(fixture().point.at)).toBe(false);
  });
  it.each([1,2])('半径%sの現在値と既知座標の原式を再評価し、正の枝を維持する',async radius=>{
    const {input}=fixture(radius),before=JSON.stringify(input),result=await calculate(input);
    expect(result.invalidInputs.size).toBe(0);expect(result.point).toEqual([0,radius,0]);expect(JSON.stringify(input)).toBe(before);
  });
  it('親変更の途中で合流する枝を他の解へ移さない',async()=>{
    const result=await calculate(fixture(-1).input);expect(result.point).toBeNull();expect(result.invalidInputs.has('chosen')).toBe(true);
  });
  it('同じスケッチで後ろの関数を参照できない',async()=>{
    const {input,curve,point}=fixture(),result=await calculate({...input,sketches:[{...input.sketches[0],features:[point,curve]}]});
    expect(result.point).toBeNull();expect(result.invalidInputs.get('chosen')).toContain('前');
  });
  it('親の計算失敗時に過去の座標を残さない',async()=>{
    const result=await calculate(fixture().input,context,new Map([['curve','Invalid parent']]));
    expect(result.point).toBeNull();expect(result.invalidInputs.has('chosen')).toBe(true);
  });
  it('点用Workerのない場合も成功にせず、理由を付ける',async()=>{
    const result=await calculate(fixture().input,{curves:context.curves});expect(result.point).toBeNull();expect(result.invalidInputs.get('chosen')).toContain('計算部');
  });
  it('取消時にはこの世代の解決済み点も公開しない',async()=>{
    const result=await calculate(fixture().input,context,new Map(),()=>true);expect(result.cancelled).toBe(true);expect(result.point).toBeNull();
  });
  it.each(['point','plane','axis','coordinateSystem'] as const)('基準%s内の関数点も現在の半径から解き、実際の基準ジオメトリへ渡す',async kind=>{
    const {input,reference}=fixture(2);
    const common={id:'reference-owner',name:'関数を使う基準',visible:true};
    const feature:ReferenceFeature=kind==='point'
      ?{...common,kind:'referencePoint',definition:{kind:'coordinate',at:{mode:'relative',base:reference,dx:number(0),dy:number(0),dz:number(0)}}}
      :kind==='plane'?{...common,kind:'referencePlane',plane:{kind:'pointAndAxis',point:reference,axis:{kind:'world',axis:'z'},tilt:number(0),azimuth:number(0)}}
      :kind==='axis'?{...common,kind:'referenceAxis',definition:{kind:'twoPoints',from:{kind:'origin'},to:reference}}
      :{...common,kind:'referenceCoordinateSystem',origin:reference,xAxis:{kind:'world',axis:'x'},yAxis:{kind:'world',axis:'y'}};
    const before=JSON.stringify(feature),result=await calculate({...input,references:[feature]});
    expect(result.invalidInputs.size).toBe(0);
    expect(result.resolve({...reference,known:[{axis:'X',value:number(0)}]},feature.id)).toEqual([0,2,0]);
    const resolved=createReferenceResolver(result.document,{sketch:()=>null,functionPoint:result.resolve,invalidInputs:result.invalidInputs}).resolveAll();
    expect(resolved.errors).toEqual([]);
    expect([...resolved.points,...resolved.planes,...resolved.axes,...resolved.coordinateSystems]).toHaveLength(1);
    if(kind==='point') expect(resolved.points[0].position).toEqual([0,2,0]);
    if(kind==='plane') expect(resolved.planes[0].plane.origin).toEqual([0,2,0]);
    if(kind==='coordinateSystem') expect(resolved.coordinateSystems[0].origin).toEqual([0,2,0]);
    expect(JSON.stringify(feature)).toBe(before);
  });
  it('基準点の親が壊れた場合は基準点自身の失敗となり、他の所有者の結果を借用しない',async()=>{
    const {input,reference}=fixture();
    const point:ReferenceFeature={kind:'referencePoint',id:'reference-owner',name:'関数点',visible:true,
      definition:{kind:'coordinate',at:{mode:'relative',base:reference,dx:number(0),dy:number(0),dz:number(0)}}};
    const result=await calculate({...input,references:[point]},context,new Map([['curve','Invalid parent']]));
    expect(result.invalidInputs.has(point.id)).toBe(true);
    expect(result.resolve(reference,point.id)).toBeNull();
    expect(result.resolve(reference,'unknown-owner')).toBeNull();
  });
  it.each(['primitive','scale','cut'] as const)('立体の%sも関数点を自分の所有者IDで解き、形状依頼へ現在の座標を渡す',async kind=>{
    const {input,reference}=fixture(2);
    const box=createPrimitiveFeature(input,'box');
    const common={id:'solid-owner',name:'関数点を使う操作',suppressed:false};
    const feature:SolidFeature=kind==='primitive'
      ?{...box,...common,origin:{kind:'coordinate',value:{mode:'relative',base:reference,dx:number(0),dy:number(0),dz:number(0)}}}
      :kind==='scale'?{...common,kind:'scale',targetFeatureId:box.id,origin:reference,factor:{kind:'uniform',value:number(2)}}
      :{...common,kind:'cut',targetFeatureId:box.id,keep:'positive',pairedWith:null,
        plane:{kind:'pointAndAxis',point:reference,axis:{kind:'world',axis:'z'},tilt:number(0),azimuth:number(0)}};
    const result=await calculate({...input,solids:kind==='primitive'?[feature]:[box,feature]});
    expect(result.invalidInputs.size).toBe(0);
    const resolved=resolvePart(result.document,{functionPoint:result.resolve,invalidInputs:result.invalidInputs});
    expect(resolved.errors.filter(error=>error.featureId===feature.id)).toEqual([]);
    const plan=resolved.steps.find(step=>step.featureId===feature.id)?.plan;
    expect(plan?.kind).toBe(kind);
    if(plan?.kind==='primitive'||plan?.kind==='scale'||plan?.kind==='cut') expect(plan.origin).toEqual([0,2,0]);
    expect(result.resolve({...reference,known:[{axis:'X',value:number(0)}]},'not-the-owner')).toBeNull();
  });
  it('立体が自分より後ろの関数曲面を参照する場合は座標を公開しない',async()=>{
    const {input,reference,curve}=fixture();
    if(curve.definition.formula.kind!=='implicit-curve') throw new Error('Missing implicit fixture');
    const parent:SolidFeature={id:'later-surface',name:'後ろの関数',kind:'functionSurface',suppressed:false,
      definition:{...curve.definition,formula:{kind:'implicit-surface',expression:curve.definition.formula.expression}}};
    const future:FunctionPointReference={...reference,parent:{kind:'surface',featureId:parent.id}};
    const box={...createPrimitiveFeature(input,'box',{kind:'coordinate',value:{mode:'relative',base:future,dx:number(0),dy:number(0),dz:number(0)}}),id:'solid-owner'};
    const result=await calculate({...input,solids:[box,parent]});
    expect(result.invalidInputs.get(box.id)).toContain('前');
    expect(result.resolve(future,box.id)).toBeNull();
  });
});
