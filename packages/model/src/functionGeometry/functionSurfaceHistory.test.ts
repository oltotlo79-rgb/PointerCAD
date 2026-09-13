import { beforeAll, describe, expect, it, vi } from 'vitest';
import { expressionValueFromNumber as number, type ExpressionValue } from '@pointercad/expression';
import {
  createFunctionMathSource,
  createMathBackend,
  executeFunctionCurveWorkRequest,
  executeFunctionImplicitWorkRequest,
  executeFunctionSurfaceWorkRequest,
  executeMathWorkRequest,
  type MathExecutionBackend,
} from '@pointercad/expression/math/worker';


import {
  CANDIDATE_MATH_BY_ID,
  decodeFunctionImplicitWorkReply,
  decodeMathWorkReply,
} from '@pointercad/expression/math/contracts';





import { createKernelApi } from '@pointercad/kernel';
import { loadOcctForNode } from '../../../kernel/src/occt/loadOcct.node.js';
import { createDirectKernelBridge } from '../kernelBridge.js';
import { addSketch, createEmptyPartDocument, createSketchFor } from '../part/createPartDocument.js';
import { collectExpressionOwners, collectExpressionSources } from '../part/reevaluatePart.js';
import { renameDocumentMathParameter } from '../part/renameDocumentMathParameter.js';
import { recomputePart, type PartRecomputeOptions } from '../part/recomputePart.js';
import { shiftOrigin } from '../part/shiftOrigin.js';
import { resolvePart, type ResolvedPart } from '../part/resolvePart.js';
import { absoluteCoordinate, createPointFeature } from '../sketch/createSketchDocument.js';
import type { PartDocument } from '../part/types.js';
import { FUNCTION_DEFINITION_FORMAT, type FunctionDefinition } from './functionDefinitionTypes.js';
import { createFunctionSurface } from './functionSurfaceFeature.js';
import { FunctionSurfacePlanCache } from './functionSurfacePlanCache.js';

const createBridge = () => createDirectKernelBridge(createKernelApi(loadOcctForNode));
let backend: MathExecutionBackend, bridge: ReturnType<typeof createBridge>;
beforeAll(async () => {
  backend = createMathBackend(); await loadOcctForNode(); bridge = createBridge();
}, 180_000);
const expression = (source: string) => createFunctionMathSource(source, 'text', 'radian', {
  axes: ['X', 'Y'], parameters: [], coefficients: [{ id: 'coefficient:8', label: '傾き' }],
}, backend);
function definition(maxZ: ExpressionValue = number(0.5)): FunctionDefinition {
  return { format: FUNCTION_DEFINITION_FORMAT, bounds: {
    X: { min: number(-1), max: number(1) }, Y: { min: number(-1), max: number(1) }, Z: { min: number(-0.5), max: maxZ },
  }, tolerance: number(0.01), formula: { kind: 'coordinate-surface', output: 'Z', expression: expression('coef("傾き")*(X+Y)') } };
}
function fixture(input = definition()): PartDocument {
  const document = createEmptyPartDocument(), sketch = document.sketches[0];
  return { ...document, parameters: [{ name: '傾き', mathId: 'coefficient:8', unit: 'none', description: '', value: number(1) }],
    sketches: [{ ...sketch, features: [createPointFeature(sketch, absoluteCoordinate(10, 20, 30))] }],
    solids: [createFunctionSurface(document, input)] };
}
function options(document: PartDocument, current = () => true): PartRecomputeOptions {
  return { partId: document.id, measureAreas: true, math: { identity: { documentId: document.id, documentVersion: 1 }, isCurrent: current,
    client: { evaluate: request => Promise.resolve({ status: 'result', identity: request.identity,
      result: decodeMathWorkReply(executeMathWorkRequest({ kind: 'evaluate-math', serial: 1, request }, backend), request,
        { operationsById: CANDIDATE_MATH_BY_ID, coefficientIds: new Set(request.coefficients.map(value => value.id)), declaredIds: new Set() }).result }) } },
    functions: {
      curves: { evaluate: request => Promise.resolve({ status: 'result', identity: request.identity,
        result: executeFunctionCurveWorkRequest({ kind: 'sample-function-curve', serial: 1, request }, backend).result }) },
      surfaces: { evaluate: request => Promise.resolve({ status: 'result', identity: request.identity,
        result: executeFunctionSurfaceWorkRequest({ kind: 'sample-function-surface', serial: 1, request }, backend).result }) },
      implicitSurfaces: { evaluate: request => Promise.resolve({ status: 'result', identity: request.identity,
        result: decodeFunctionImplicitWorkReply(executeFunctionImplicitWorkRequest({ kind: 'sample-function-implicit-surface', serial: 1, request }, backend),request).result }) },
    } };
}
async function compute(document: PartDocument, config: PartRecomputeOptions = options(document)) {
  try { return await recomputePart(document, bridge, config); }
  finally { await bridge.releasePart(document.id); }
}

describe('関数曲面の原式を通常履歴から実CADまで再計算する', () => {
  it.each(['X', 'Y', 'Z'] as const)('%s=0.25の断面はXYZ範囲内にあり、元の係数変更にも追従する', async axis => {
    const input = fixture(), index = axis === 'X' ? 0 : axis === 'Y' ? 1 : 2;
    const planeId = 'coordinate-section-plane', sectionId = 'coordinate-section';
    const sectionSketch = createSketchFor(input);
    const document = addSketch({ ...input, references: [...input.references,
      { id: planeId, name: '断面の平面', kind: 'referencePlane', visible: false,
        plane: { kind: 'workPlane', planeId: axis === 'X' ? 'yz' : axis === 'Y' ? 'xz' : 'xy', offset: number(axis === 'Y' ? -0.25 : 0.25) } }] },
    { ...sectionSketch, features: [{ id: sectionId, name: '断面', kind: 'planeSection', planeId,
      targetFeatureId: input.solids[0].id, construction: false }] });
    const verify = async (source: PartDocument, coefficient: number) => {
      const result = await compute(source);
      expect(result.errors).toEqual([]); expect(result.bodies).toHaveLength(1);
      const curves = result.sketches.find(sketch => sketch.sketchId === sectionSketch.id)?.resolved.curvesByFeature.get(sectionId) ?? [];
      expect(curves.length).toBeGreaterThan(0);
      for (const curve of curves) {
        expect(curve.kind).toBe('segment');
        if (curve.kind !== 'segment') throw new Error('平面の断面に直線以外が含まれます');
        for (const point of [curve.from, curve.to]) {
          expect(point[index]).toBeCloseTo(0.25, 7);
          expect(point[2]).toBeCloseTo(coefficient * (point[0] + point[1]), 7);
          expect(Math.abs(point[0])).toBeLessThanOrEqual(1 + 1e-7);
          expect(Math.abs(point[1])).toBeLessThanOrEqual(1 + 1e-7);
          expect(Math.abs(point[2])).toBeLessThanOrEqual(0.5 + 1e-7);
        }
      }
    };
    await verify(document, 1);
    await verify({ ...document, parameters: document.parameters.map(parameter => ({ ...parameter, value: number(2) })) }, 2);
  });
  it('別の点の編集では親の標本を再利用し、係数の微小変更・XYZ・精度の変更では作り直す', async () => {
    const input = fixture(), initial = options(input), surfacePlans = new FunctionSurfacePlanCache();
    const functions = initial.functions;
    if (functions?.surfaces === undefined) throw new Error('Missing surface evaluator');
    const evaluate = vi.fn(functions.surfaces.evaluate);
    const config: PartRecomputeOptions = { ...initial, functions: { ...functions, surfaces: { evaluate }, surfacePlans } };
    const first = await compute(input, config);
    expect(first.errors).toEqual([]); expect(evaluate).toHaveBeenCalledTimes(1);
    const unrelated: PartDocument = { ...input, sketches: input.sketches.map(sketch => ({ ...sketch,
      features: [createPointFeature(sketch, absoluteCoordinate(40, 20, 30))] })) };
    const second = await compute(unrelated, config);
    expect(second.errors).toEqual([]); expect(evaluate).toHaveBeenCalledTimes(1);
    expect(second.bodies[0].mesh.positions).toEqual(first.bodies[0].mesh.positions);
    const parameter = input.parameters[0];
    const changed: PartDocument = { ...input, parameters: [{ ...parameter, value: number(1.0000000001) }] };
    expect((await compute(changed, config)).errors).toEqual([]); expect(evaluate).toHaveBeenCalledTimes(2);
    const bounded = fixture(definition(number(0.4)));
    expect((await compute(bounded, config)).errors).toEqual([]); expect(evaluate).toHaveBeenCalledTimes(3);
    const refined = fixture({ ...definition(), tolerance: number(0.005) });
    expect((await compute(refined, config)).errors).toEqual([]); expect(evaluate).toHaveBeenCalledTimes(4);
    expect((await compute(input, config)).errors).toEqual([]); expect(evaluate).toHaveBeenCalledTimes(4);
  });
  it.each([2,8])('0.01mmの放物面をZ上限%sで作り、指定範囲と原式を保つ',async maxZ=>{
    const base=definition(number(maxZ)),input:FunctionDefinition={...base,bounds:{
      X:{min:number(-2),max:number(2)},Y:{min:number(-2),max:number(2)},Z:{min:number(-2),max:number(maxZ)}},
      formula:{kind:'coordinate-surface',output:'Z',expression:expression('X^2+Y^2')}};
    const document=fixture(input),started=performance.now();
    console.log(`[実測] 放物面の通常履歴開始: Z上限${maxZ}、精度0.01mm`);
    const result=await compute(document);
    console.log(`[実測] 放物面の通常履歴完了: Z上限${maxZ}、${(performance.now()-started).toFixed(1)}ms`);
    expect(result.errors).toEqual([]);expect(result.bodies).toHaveLength(1);expect(result.bodies[0].isValid).toBe(true);
    const positions=result.bodies[0].mesh.positions;
    for(let index=0;index<positions.length;index+=3){
      const [x,y,z]=positions.slice(index,index+3);
      expect(Math.abs(x)).toBeLessThanOrEqual(2+1e-6);expect(Math.abs(y)).toBeLessThanOrEqual(2+1e-6);
      expect(z).toBeLessThanOrEqual(maxZ+1e-6);expect(Math.abs(z-x*x-y*y)).toBeLessThanOrEqual(0.01);
    }
  },30_000);
  it.each(['sphere','torus','clipped-sphere'] as const)('既定0.01mmの%sを原式から解析CADへ接続し、体積と全XYZを保つ',async kind=>{
    const source=kind==='torus'?'(X^2+Y^2+Z^2+4-0.25)^2-16*(X^2+Y^2)':'X^2+Y^2+Z^2-1';
    const expression=createFunctionMathSource(source,'text','radian',{axes:['X','Y','Z'],parameters:[],coefficients:[]},backend);
    const input:FunctionDefinition={format:FUNCTION_DEFINITION_FORMAT,bounds:{X:{min:number(-3),max:number(3)},Y:{min:number(-3),max:number(3)},
      Z:{min:number(kind==='clipped-sphere'?0:-3),max:number(3)}},tolerance:number(0.01),formula:{kind:'implicit-surface',expression}};
    const document=fixture(input),before=JSON.stringify(document),started=performance.now(),result=await compute(document);
    console.log(`[実測] 関数${kind}の0.01mm指定から実CADまで: ${(performance.now()-started).toFixed(1)}ms`);
    expect(result.errors).toEqual([]);expect(result.bodies).toHaveLength(1);expect(result.bodies[0].isValid).toBe(true);
    expect(result.bodies[0].bodyKind).toBe(kind==='clipped-sphere'?'shell':'solid');
    expect(result.bodies[0].volume).toBeCloseTo(kind==='clipped-sphere'?0:kind==='torus'?Math.PI**2:4*Math.PI/3,7);
    expect(JSON.stringify(document)).toBe(before);
  },30_000);
  it.each(['sphere','clipped-sphere','plane'] as const)('空間等式%sを実CADの通常履歴へ接続し、閉立体と開面を区別する',async kind=>{
    const expression=createFunctionMathSource(kind==='plane'?'Z':'X^2+Y^2+Z^2-1','text','radian',{axes:['X','Y','Z'],parameters:[],coefficients:[]},backend);
    const input:FunctionDefinition={format:FUNCTION_DEFINITION_FORMAT,bounds:{X:{min:number(-2),max:number(2)},Y:{min:number(-2),max:number(2)},
      Z:{min:number(kind==='clipped-sphere'?0:-2),max:number(2)}},tolerance:number(1),formula:{kind:'implicit-surface',expression}};
    const document=fixture(input),result=await compute(document); expect(result.errors).toEqual([]); expect(result.bodies).toHaveLength(1);
    const body=result.bodies[0]; expect(body.isValid).toBe(true);
    expect(body.bodyKind).toBe(kind==='sphere'?'solid':'shell');
    if(kind==='sphere') {expect(body.volume).toBeGreaterThan(4*Math.PI/3*0.95);expect(body.volume).toBeLessThan(4*Math.PI/3*1.001);}
    else expect(body.volume).toBe(0);
    if(kind==='plane') expect(body.area).toBeCloseTo(16,6);
    for(let i=0;i<body.mesh.positions.length;i++) {
      const axis=i%3; expect(body.mesh.positions[i]).toBeGreaterThanOrEqual((kind==='clipped-sphere' && axis===2?0:-2)-1e-6);
      expect(body.mesh.positions[i]).toBeLessThanOrEqual(2+1e-6);
    }
  },30_000);
  it('全XYZ境界で切った斜面の実面積と内部頂点が元の式に一致する', async () => {
    const document = fixture(), before = JSON.stringify(document), result = await compute(document);
    expect(result.errors).toEqual([]); expect(result.bodies).toHaveLength(1);
    const body = result.bodies[0]; expect(body.bodyKind).toBe('shell'); expect(body.volume).toBe(0);
    expect(body.isValid).toBe(true);
    // |X+Y| <= 0.5 cuts two triangles of area 1.125 from the square of area 4.
    expect(body.area).toBeCloseTo(1.75 * Math.sqrt(3), 7);
    for (let index = 0; index < body.mesh.positions.length; index += 3) {
      const [x, y, z] = body.mesh.positions.slice(index, index + 3);
      expect(Math.abs(x)).toBeLessThanOrEqual(1 + 1e-6); expect(Math.abs(y)).toBeLessThanOrEqual(1 + 1e-6);
      expect(Math.abs(z)).toBeLessThanOrEqual(0.5 + 1e-6); expect(Math.abs(z - x - y)).toBeLessThan(1e-6);
    }
    expect(result.parameterAnalysis?.unused).not.toContain('傾き'); expect(JSON.stringify(document)).toBe(before);
  });
  it('同じ原式は世代を変えてもCADを再利用し、係数や精度の変更では鍵が変わる', async () => {
    const document = fixture(), keys: string[] = [];
    const capture = (resolved: ResolvedPart) => { keys.push(resolved.steps[0].key); };
    try {
      const first = await recomputePart(document, bridge, { ...options(document), onResolved: capture });
      expect(first.errors).toEqual([]);
      const second = await recomputePart(document, bridge, { ...options(document), generation: 2, onResolved: capture });
      expect(second.errors).toEqual([]); expect(second.cacheHits).toBeGreaterThanOrEqual(1); expect(keys[1]).toBe(keys[0]);
      const changed = { ...document, parameters: [{ ...document.parameters[0], value: number(2) }] };
      const third = await recomputePart(changed, bridge, { ...options(changed), generation: 3, onResolved: capture });
      expect(third.errors).toEqual([]); expect(keys[2]).not.toBe(keys[1]); expect(third.bodies[0].area).toBeCloseTo(2.8125, 7);
      const original = document.solids[0]; if (original.kind !== 'functionSurface') throw new Error('Expected function surface');
      const refined = { ...document, solids: [{ ...original, definition: { ...original.definition, tolerance: number(0.005) } }] };
      const fourth = await recomputePart(refined, bridge, { ...options(refined), generation: 4, onResolved: capture });
      expect(fourth.errors).toEqual([]); expect(keys[3]).not.toBe(keys[0]);
      const precise = { ...document, parameters: [{ ...document.parameters[0], value: {
        source: '1.00000000000000000001', value: 1, display: '1',
      } }] };
      const fifth = await recomputePart(precise, bridge, { ...options(precise), generation: 5, onResolved: capture });
      expect(fifth.errors).toEqual([]); expect(keys[4]).not.toBe(keys[0]);
    } finally { await bridge.releasePart(document.id); }
  });
  it('境界の保存キャッシュを無視して原式を評価し、範囲を狭めると面を切り直す', async () => {
    const document = fixture(definition({ source: '0.25', value: 99, display: '99' })), result = await compute(document);
    expect(result.errors).toEqual([]); expect(result.bodies).toHaveLength(1);
    for (let index = 2; index < result.bodies[0].mesh.positions.length; index += 3) {
      expect(result.bodies[0].mesh.positions[index]).toBeLessThanOrEqual(0.25 + 1e-6);
    }
  });
  it.each(['1/0', '-0.5', '-1'])('無効な境界%sでは前回の面を残さず、独立した点は表示する', async source => {
    const document = fixture(definition({ source, value: 1, display: '1' })), result = await compute(document);
    expect(result.bodies).toEqual([]); expect(result.sketches[0].resolved.points).toHaveLength(1);
    expect(result.errors.map(error => error.featureId)).toContain(document.solids[0].id);
  });
  it('改名は型付き係数だけを追従させ、依存確認と原式一覧にも関数を含める', async () => {
    const document = fixture(); expect(collectExpressionSources(document)).toContain('coef("傾き")*(X+Y)');
    expect(collectExpressionOwners(document).some(owner => owner.ownerId === document.solids[0].id && owner.mathDefinition)).toBe(true);
    const math = options(document).math; if (!math) throw new Error('Expected math context');
    const changed = await renameDocumentMathParameter(document, '傾き', '勾配', math);
    if (!changed.ok) throw new Error(changed.message);
    const result = await compute(changed.document); expect(result.errors).toEqual([]);
    expect(result.bodies[0].area).toBeCloseTo(1.75 * Math.sqrt(3), 7);
    expect(JSON.stringify(changed.document.solids)).toContain('勾配');
  });
  it('原点変更では式の入力・出力・全6境界が一緒に動き、面積は変わらない', async () => {
    const document = shiftOrigin(fixture(), { x: number(1), y: number(2), z: number(3) }), result = await compute(document);
    expect(result.errors).toEqual([]); expect(result.bodies).toHaveLength(1);
    expect(result.bodies[0].area).toBeCloseTo(1.75 * Math.sqrt(3), 7);
    for (let index = 0; index < result.bodies[0].mesh.positions.length; index += 3) {
      const [x, y, z] = result.bodies[0].mesh.positions.slice(index, index + 3);
      expect(x).toBeGreaterThanOrEqual(-2 - 1e-6); expect(x).toBeLessThanOrEqual(1e-6);
      expect(y).toBeGreaterThanOrEqual(-3 - 1e-6); expect(y).toBeLessThanOrEqual(-1 + 1e-6);
      expect(z).toBeGreaterThanOrEqual(-3.5 - 1e-6); expect(z).toBeLessThanOrEqual(-2.5 + 1e-6);
      expect(Math.abs(z - x - y)).toBeLessThan(1e-6);
    }
  });
  it('世代が変わった数学結果をCADへ渡さず、抑制中は標本計算も呼ばない', async () => {
    const document = fixture(); let current = true;
    const config = options(document, () => current), functions = config.functions;
    if (!functions?.surfaces) throw new Error('Expected surface evaluator');
    const original = functions.surfaces;
    const sampling = vi.fn(async (...args: Parameters<typeof original.evaluate>) => {
      const result = await original.evaluate(...args); current = false; return result;
    });
    const result = await compute(document, { ...config, functions: { ...functions, surfaces: { evaluate: sampling } } });
    expect(result.cancelled).toBe(true); expect(result.bodies).toEqual([]);
    current = true; sampling.mockClear();
    const suppressed = { ...document, solids: document.solids.map(feature => ({ ...feature, suppressed: true })) };
    const hidden = await compute(suppressed, { ...config, functions: { ...functions, surfaces: { evaluate: sampling } } });
    expect(hidden.errors).toEqual([]); expect(hidden.bodies).toEqual([]); expect(sampling).not.toHaveBeenCalled();
  });
  it('数学計算の無い純粋な解決では保存キャッシュから面を捏造しない', () => {
    const document = fixture(), resolved = resolvePart(document);
    expect(resolved.steps).toEqual([]); expect(resolved.errors.map(error => error.featureId)).toContain(document.solids[0].id);
  });
  it.each(['sphere','torus','clipped-sphere'] as const)('媒介式%sを実CADへ接続し、閉面だけが正の体積を持つ', async kind => {
    const scalar = (source: string, value: number): ExpressionValue => ({...number(value),source,
      mathDefinition:createFunctionMathSource(source,'text','radian',{axes:[],parameters:[],coefficients:[]},backend)});
    const output = (source: string) => createFunctionMathSource(source,'text','radian',{axes:[],parameters:['U','V'],coefficients:[]},backend);
    const torus=kind === 'torus', clipped=kind === 'clipped-sphere';
    const input: FunctionDefinition = {format:FUNCTION_DEFINITION_FORMAT,tolerance:number(0.5),bounds:{
      X:{min:number(-4),max:number(4)},Y:{min:number(-4),max:number(4)},Z:{min:number(clipped ? 0 : -4),max:number(4)}},
      formula:{kind:'parametric-surface',U:{min:scalar('0',0),max:scalar('2*pi',2*Math.PI)},
        V:{min:scalar('0',0),max:scalar(torus ? '2*pi' : 'pi',torus ? 2*Math.PI : Math.PI)},
        outputs:torus ? {X:output('(2+cos(V))*cos(U)'),Y:output('(2+cos(V))*sin(U)'),Z:output('sin(V)')}
          : {X:output('sin(V)*cos(U)'),Y:output('sin(V)*sin(U)'),Z:output('cos(V)')}}};
    const document=fixture(input), started=performance.now(), result=await compute(document);
    expect(result.errors).toEqual([]); expect(result.bodies).toHaveLength(1);
    const body=result.bodies[0], exactVolume=torus ? 4*Math.PI**2 : 4*Math.PI/3;
    console.log(`関数${kind}: ${body.mesh.triangleCount}三角形 / ${(performance.now()-started).toFixed(1)}ms / 体積${body.volume} / 面積${body.area}`);
    expect(body.isValid).toBe(true); expect(body.bodyKind).toBe(clipped ? 'shell' : 'solid');
    if (clipped) {
      expect(body.volume).toBe(0);
      expect(body.area).toBeGreaterThan(2*Math.PI*0.95); expect(body.area).toBeLessThan(2*Math.PI*1.01);
      for(let i=2;i<body.mesh.positions.length;i+=3) expect(body.mesh.positions[i]).toBeGreaterThanOrEqual(-1e-6);
    } else expect(Math.abs(body.volume/exactVolume-1)).toBeLessThan(0.05);
  },30_000);
});
