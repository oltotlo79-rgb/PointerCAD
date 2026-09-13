import { beforeAll, describe, expect, it, vi } from 'vitest';
import { expressionValueFromNumber as number, type ExpressionValue } from '@pointercad/expression';
import {
  createFunctionMathSource,
  createMathBackend,
  executeFunctionCurveWorkRequest,
  executeFunctionImplicitCurveWorkRequest,
  executeFunctionPointContinuationWork,
  executeMathWorkRequest,
  type MathExecutionBackend,
} from '@pointercad/expression/math/worker';


import {
  CANDIDATE_MATH_BY_ID,
  decodeMathWorkReply,
} from '@pointercad/expression/math/contracts';




import { createKernelApi } from '@pointercad/kernel';
import { loadOcctForNode } from '../../../kernel/src/occt/loadOcct.node.js';
import { createDirectKernelBridge } from '../kernelBridge.js';
import { createEmptyPartDocument } from '../part/createPartDocument.js';
import { collectExpressionOwners } from '../part/reevaluatePart.js';
import { prepareDocumentMathIdentity } from '../part/documentMathIdentity.js';
import { renameDocumentMathParameter } from '../part/renameDocumentMathParameter.js';
import { recomputePart, type PartRecomputeOptions } from '../part/recomputePart.js';
import { absoluteCoordinate, createPointFeature } from '../sketch/createSketchDocument.js';
import { FREE_WORK_PLANE_ID } from '../sketch/planeMath.js';
import { shiftSketchFeature, worldShiftAxes } from '../sketch/shiftCoordinate.js';
import type { SketchFunctionCurveFeature } from '../sketch/types.js';
import type { PartDocument } from '../part/types.js';
import { FUNCTION_DEFINITION_FORMAT } from './functionDefinitionTypes.js';
import { sampleSpline } from '../sketch/splineMath.js';
import { resolveSketch } from '../sketch/resolveSketch.js';

let backend: MathExecutionBackend, bridge: ReturnType<typeof createDirectKernelBridge>;
beforeAll(async () => {
  backend = createMathBackend(); await loadOcctForNode(); bridge = createDirectKernelBridge(createKernelApi(loadOcctForNode));
}, 180_000);
function formula(source: string) {
  return createFunctionMathSource(source, 'text', 'radian', { axes: ['X'], parameters: [],
    coefficients: [{ id: 'coefficient:8', label: '幅' }] }, backend);
}
function feature(maxY: ExpressionValue = number(2)): SketchFunctionCurveFeature {
  return { id: 'function', name: '関数曲線', kind: 'functionCurve', planeId: FREE_WORK_PLANE_ID, construction: false,
    definition: { format: FUNCTION_DEFINITION_FORMAT, bounds: { X: { min: number(-2), max: number(2) },
      Y: { min: number(-1), max: maxY }, Z: { min: number(-1), max: number(1) } }, tolerance: number(0.001),
    formula: { kind: 'coordinate-curve', independent: 'X', outputs: { Y: formula('coef("幅")*X^2'), Z: formula('0') } } } };
}
function fixture(input = feature()): PartDocument {
  const base = createEmptyPartDocument(), sketch = base.sketches[0];
  return { ...base, parameters: [{ name: '幅', mathId: 'coefficient:8', unit: 'none', description: '', value: number(1) }],
    sketches: [{ ...sketch, features: [createPointFeature(sketch, absoluteCoordinate(10, 20, 30)), input] }] };
}
function options(document: PartDocument, isCurrent = () => true): PartRecomputeOptions {
  return { math: { identity: { documentId: document.id, documentVersion: 1 }, isCurrent,
    client: { evaluate: request => Promise.resolve({ status: 'result', identity: request.identity,
      result: decodeMathWorkReply(executeMathWorkRequest({ kind: 'evaluate-math', serial: 1, request }, backend), request,
        { operationsById: CANDIDATE_MATH_BY_ID, coefficientIds: new Set(request.coefficients.map(coefficient => coefficient.id)), declaredIds: new Set() }).result }) } },
    functions: { curves: { evaluate: request => Promise.resolve({ status: 'result', identity: request.identity,
      result: executeFunctionCurveWorkRequest({ kind: 'sample-function-curve', serial: 1, request }, backend).result }) },
      points:{evaluate:request=>Promise.resolve({status:'result',identity:request.identity,
        result:executeFunctionPointContinuationWork({kind:'continue-function-point',serial:1,request},backend).result})},
      implicitCurves:{evaluate:request=>Promise.resolve({status:'result',identity:request.identity,
        result:executeFunctionImplicitCurveWorkRequest({kind:'sample-function-implicit-curve',serial:1,request},backend).result})} } };
}

describe('関数を通常の履歴として再計算する', () => {
  it.each(['missing', 'empty'] as const)('曲線の計算結果が%sなら直前参照を古い点へ付け替えない', state => {
    const document = fixture(), sketch = document.sketches[0];
    const dependent = { ...createPointFeature(sketch, { mode: 'relative', base: { kind: 'previous' },
      dx: number(1), dy: number(0), dz: number(0) }), id: 'dependent', planeId: FREE_WORK_PLANE_ID };
    const independent = { ...createPointFeature(sketch, absoluteCoordinate(80, 0, 0)), id: 'independent' };
    const result = resolveSketch({ ...sketch, features: [...sketch.features, dependent, independent] },
      { functionCurves: () => state === 'missing' ? null : [] });
    expect(result.points.map(point => point.featureId)).toEqual([sketch.features[0].id, 'independent']);
    expect(result.errors.map(error => error.featureId)).toEqual(['function', 'dependent']);
  });
  it('全範囲内の多項式は通常再計算で三次曲線になり、係数変更後も原式上にある',async()=>{
    const original=feature(number(5)),curve={...original,definition:{...original.definition,
      bounds:{...original.definition.bounds,Y:{min:number(-2),max:number(5)}}}};
    for(const coefficient of [1,0.5]) {
      const base=fixture(curve),document={...base,parameters:base.parameters.map(parameter=>({...parameter,value:number(coefficient)}))};
      const result=await recomputePart(document,bridge,options(document));
      expect(result.errors).toEqual([]);expect(result.cancelled).toBe(false);
      const curves=result.sketches[0].resolved.splines;expect(curves).toHaveLength(1);
      expect(curves[0].points).toHaveLength(4);expect(curves[0]).not.toHaveProperty('degree');
      for(const [x,y,z] of sampleSpline(curves[0],100)) {
        expect(Math.abs(y-coefficient*x*x)).toBeLessThan(1e-12);expect(z).toBe(0);
      }
    }
  });
  it('関数上の点を通常再計算と実CADの曲線へ接続し、親の半径変更に追従する',async()=>{
    const expression=createFunctionMathSource('X^2+Y^2-coef("幅")^2','text','radian',
      {axes:['X','Y'],parameters:[],coefficients:[{id:'coefficient:8',label:'幅'}]},backend),base=feature();
    const curve:SketchFunctionCurveFeature={...base,definition:{...base.definition,tolerance:number(0.05),
      bounds:{X:{min:number(-4),max:number(4)},Y:{min:number(-4),max:number(4)},Z:{min:number(-1),max:number(1)}},
      formula:{kind:'implicit-curve',fixedAxis:'Z',fixedCoordinate:number(0),expression}}};
    const document=fixture(curve),sketch=document.sketches[0],point={...createPointFeature(sketch,{mode:'relative',
      base:{kind:'functionPoint',parent:{kind:'curve',sketchId:sketch.id,featureId:curve.id},known:[{axis:'X',value:number(0)}],choice:{
        input:{expression,minimum:[-4,-4,-1],maximum:[4,4,1],tolerance:0.05,coefficients:[{id:'coefficient:8',label:'幅',decimal:'1'}],known:[{axis:'X',value:0}],fixed:{axis:'Z',value:0}},
        location:{kind:'implicit',axis:'Y',interval:{lower:1,upper:1}}}},dx:number(0),dy:number(0),dz:number(0)}),planeId:FREE_WORK_PLANE_ID};
    const input={...document,parameters:document.parameters.map(parameter=>({...parameter,value:number(2)})),sketches:[{...sketch,features:[...sketch.features,point]}]};
    const result=await recomputePart(input,bridge,options(input));expect(result.cancelled).toBe(false);expect(result.errors).toEqual([]);
    expect(result.sketches[0].resolved.points.find(item=>item.featureId===point.id)?.position).toEqual([0,2,0]);
    expect(result.sketches[0].resolved.splines).toHaveLength(1);
  },30_000);
  it.each(['Z','X'] as const)('平面等式の円を%s固定で実CADへ渡し、閉曲線と現在の固定座標を保持する',async fixedAxis=>{
    const free=(['X','Y','Z'] as const).filter(axis=>axis!==fixedAxis),base=feature();
    const curve:SketchFunctionCurveFeature={...base,definition:{...base.definition,tolerance:number(0.05),
      bounds:{X:{min:number(-2),max:number(2)},Y:{min:number(-2),max:number(2)},Z:{min:number(-2),max:number(2)}},
      formula:{kind:'implicit-curve',fixedAxis,fixedCoordinate:{source:'0.5',value:99,display:'99'},
        expression:createFunctionMathSource(`${free[0]}^2+${free[1]}^2-coef("幅")^2`,'text','radian',
          {axes:free,parameters:[],coefficients:[{id:'coefficient:8',label:'幅'}]},backend)}}};
    const document=fixture(curve),before=JSON.stringify(document),result=await recomputePart(document,bridge,options(document));
    expect(result.errors).toEqual([]);expect(result.cancelled).toBe(false);
    const splines=result.sketches[0].resolved.splines;expect(splines).toHaveLength(1);expect(splines[0].closed).toBe(true);
    const fixed=['X','Y','Z'].indexOf(fixedAxis),slots=[0,1,2].filter(axis=>axis!==fixed);
    for(const point of splines[0].points){expect(point[fixed]).toBeCloseTo(0.5,10);expect(Math.abs(Math.hypot(point[slots[0]],point[slots[1]])-1)).toBeLessThan(0.05);}
    expect(JSON.stringify(document)).toBe(before);expect(result.parameterAnalysis?.unused).not.toContain('幅');
  },30_000);
  it('平面等式の円をXYZで切ると開いた弧になり、分離した双曲線は別の実CAD曲線になる',async()=>{
    for(const source of ['X^2+Y^2-1','X*Y-1']){
      const base=feature(),circle=source.startsWith('X^2');
      const curve:SketchFunctionCurveFeature={...base,definition:{...base.definition,tolerance:number(0.05),
        bounds:{X:{min:number(-2),max:number(circle?0:2)},Y:{min:number(-2),max:number(2)},Z:{min:number(-2),max:number(2)}},
        formula:{kind:'implicit-curve',fixedAxis:'Z',fixedCoordinate:number(0),
          expression:createFunctionMathSource(source,'text','radian',{axes:['X','Y'],parameters:[],coefficients:[]},backend)}}};
      const document=fixture(curve),result=await recomputePart(document,bridge,options(document));expect(result.errors).toEqual([]);
      const splines=result.sketches[0].resolved.splines;expect(splines).toHaveLength(circle?1:2);
      for(const spline of splines){expect(spline.closed).toBe(false);for(const point of spline.points){
        expect(point[0]).toBeLessThanOrEqual((circle?0:2)+1e-6);expect(point[0]).toBeGreaterThanOrEqual(-2-1e-6);
        expect(Math.abs(circle?Math.hypot(point[0],point[1])-1:point[0]*point[1]-1)).toBeLessThan(0.05);
      }}
    }
  },30_000);
  it('原式からCADまで接続し、全ての点がXYZ範囲と放物線の精度を満たす', async () => {
    const document = fixture(), before = JSON.stringify(document);
    const result = await recomputePart(document, bridge, options(document));
    expect(result.errors).toEqual([]); expect(result.cancelled).toBe(false);
    const curves = result.sketches[0].resolved.splines;
    expect(curves).toHaveLength(1); expect(curves[0].featureId).toBe('function');
    expect(curves[0].points.length).toBeGreaterThan(10);
    for (const [x, y, z] of curves[0].points) {
      expect(x).toBeGreaterThanOrEqual(-2); expect(x).toBeLessThanOrEqual(2);
      expect(y).toBeGreaterThanOrEqual(-1-1e-6); expect(y).toBeLessThanOrEqual(2+1e-6);
      expect(Math.abs(y-x*x)).toBeLessThanOrEqual(0.001); expect(z).toBeCloseTo(0, 10);
    }
    expect(result.parameterAnalysis?.unused).not.toContain('幅');
    expect(JSON.stringify(document)).toBe(before);
  });
  it('範囲の古いキャッシュを使わず、係数と範囲の原式を変更すると曲線が追従する', async () => {
    const source = fixture(feature({ source: '0.5', value: 99, display: '99' }));
    const document = { ...source, parameters: [{ ...source.parameters[0], value: number(2) }] };
    const result = await recomputePart(document, bridge, options(document));
    expect(result.errors).toEqual([]);
    for (const [x, y] of result.sketches[0].resolved.splines[0].points) {
      expect(y).toBeLessThanOrEqual(0.5+1e-6); expect(Math.abs(y-2*x*x)).toBeLessThanOrEqual(0.001);
    }
  });
  it.each(['1/0', '-2'])('範囲の原式%sが不正なら曲線を残さず、独立した点は表示する', async source => {
    const document = fixture(feature({ source, value: 2, display: '2' }));
    const result = await recomputePart(document, bridge, options(document));
    expect(result.sketches[0].resolved.splines).toEqual([]);
    expect(result.sketches[0].resolved.points).toHaveLength(1);
    expect(result.errors.map(error => error.featureId)).toContain('function');
  });
  it('有効な範囲内に関数がなくなると直前参照と拘束先を除外し、範囲を戻すと元の関数へ再接続する', async () => {
    const original = fixture(), sketch = original.sketches[0], curve = sketch.features[1];
    if (curve.kind !== 'functionCurve') throw new Error('Expected function curve');
    const relative = { ...createPointFeature(sketch, { mode: 'relative', base: { kind: 'previous' },
      dx: number(1), dy: number(0), dz: number(0) }), id: 'relative', planeId: FREE_WORK_PLANE_ID };
    const linked = { ...createPointFeature(sketch, absoluteCoordinate(50, 0, 0)), id: 'linked' };
    const independent = { ...createPointFeature(sketch, absoluteCoordinate(80, 0, 0)), id: 'independent' };
    const emptyCurve = { ...curve, definition: { ...curve.definition, bounds: { ...curve.definition.bounds,
      Y: { min: number(10), max: number(20) } } } };
    const document: PartDocument = { ...original, sketches: [{ ...sketch,
      features: [sketch.features[0], emptyCurve, relative, linked, independent], constraints: [
        { id: 'connection', name: 'connection', kind: 'coincident',
          a: { kind: 'point', pointId: relative.id }, b: { kind: 'point', pointId: linked.id } },
      ] }] };
    const before = JSON.stringify(document), generate = vi.spyOn(bridge, 'functionSketchCurves');
    try {
      const result = await recomputePart(document, bridge, options(document));
      expect(result.cancelled).toBe(false);
      expect(result.sketches[0].resolved.splines).toEqual([]);
      expect(result.sketches[0].resolved.points.map(point => point.featureId)).toEqual([sketch.features[0].id, 'independent']);
      expect(result.errors.map(error => error.featureId)).toEqual(expect.arrayContaining(['function', 'relative', 'linked', 'connection']));
      expect(generate).not.toHaveBeenCalled();
      expect(JSON.stringify(document)).toBe(before);
    } finally { generate.mockRestore(); }
    const restored: PartDocument = { ...document, sketches: [{ ...sketch, features: [sketch.features[0], curve, relative, independent] }] };
    const result = await recomputePart(restored, bridge, options(restored));
    expect(result.errors).toEqual([]);
    const generated = result.sketches[0].resolved.splines.at(-1);
    if (!generated) throw new Error('Expected restored function curve');
    const endpoint = generated.points.at(-1);
    if (!endpoint) throw new Error('Expected curve endpoint');
    expect(result.sketches[0].resolved.points.find(point => point.featureId === relative.id)?.position)
      .toEqual([endpoint[0] + 1, endpoint[1], endpoint[2]]);
  });
  it('数学計算後に文書が変わればCAD生成を呼ばず、旧曲線を採用しない', async () => {
    const document = fixture(); let current = true;
    const config = options(document, () => current), original = config.functions;
    if (!original) throw new Error('Expected function evaluator');
    const generate = vi.spyOn(bridge, 'functionSketchCurves');
    try {
      const result = await recomputePart(document, bridge, { ...config, functions: { curves: { evaluate: async (...args) => {
        const calculated = await original.curves.evaluate(...args); current = false; return calculated;
      } } } });
      expect(result.cancelled).toBe(true); expect(result.sketches).toEqual([]); expect(generate).not.toHaveBeenCalled();
    } finally { generate.mockRestore(); }
  });
  it('関数の係数も削除確認とID予約に含め、改名で原式・参照・形を保つ', async () => {
    const document = fixture();
    expect(collectExpressionOwners(document).filter(owner => owner.mathDefinition).map(owner => owner.ownerId)).toContain('function');
    const reserved = prepareDocumentMathIdentity({ ...document, parameters: [{ ...document.parameters[0], mathId: undefined }] });
    expect(reserved.parameters[0].mathId).toBe('coefficient:9');
    const math = options(document).math;
    if (!math) throw new Error('Expected math evaluator');
    const renamed = await renameDocumentMathParameter(document, '幅', '係数幅', math);
    if (!renamed.ok) throw new Error(renamed.message);
    const result = await recomputePart(renamed.document, bridge, options(renamed.document));
    expect(result.errors).toEqual([]); expect(result.sketches[0].resolved.splines).toHaveLength(1);
    expect(JSON.stringify(renamed.document.sketches)).toContain('係数幅');
  });
  it('原点を移すと関数の入力軸・出力軸・全XYZ範囲が同じ量だけ移動する', async () => {
    const moved = shiftSketchFeature(feature(), { axes: worldShiftAxes({ x: number(1), y: number(2), z: number(3) }), plane: null });
    if (moved.kind !== 'functionCurve') throw new Error('Expected function curve');
    const document = fixture(moved), result = await recomputePart(document, bridge, options(document));
    expect(result.errors).toEqual([]);
    expect(moved.definition.bounds.Z.min.value).toBe(-4); expect(moved.definition.bounds.Z.max.value).toBe(-2);
    for (const [x, y, z] of result.sketches[0].resolved.splines[0].points) {
      expect(x).toBeGreaterThanOrEqual(-3); expect(x).toBeLessThanOrEqual(1);
      expect(y).toBeLessThanOrEqual(1e-6); expect(Math.abs(y-((x+1)**2-2))).toBeLessThanOrEqual(0.001);
      expect(z).toBeCloseTo(-3, 10);
    }
  });
});
