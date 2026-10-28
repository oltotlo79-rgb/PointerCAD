import { beforeAll, describe, expect, it, vi } from 'vitest';
import { createMathBackend } from './createMathBackend.js';
import { createFunctionMathSource } from './functionMathSource.js';
import { createFunctionSurfaceEvaluator } from './functionSurfaceEvaluation.js';
import { sampleFunctionSurface, type FunctionSurfaceOptions, type FunctionSurfaceSamplingResult } from './adaptiveFunctionSurface.js';
import type { FunctionPoint } from './functionGeometryBounds.js';
import type { SurfaceParameter } from './surfaceParameterGrid.js';
import type { MathExecutionBackend } from './mathWorkExecution.js';

let backend: MathExecutionBackend;
beforeAll(() => { backend = createMathBackend(); });
const options: FunctionSurfaceOptions = { lower: [-1,-1], upper: [1,1], minimum: [-2,-2,-2], maximum: [2,2,2],
  tolerance: 0.01, maximumSamples: 20_000, maximumCells: 40_000, maximumTriangles: 40_000, maximumDepth: 12 };
function evaluator(outputs: readonly [string,string,string]) {
  const definitions = outputs.map(source => createFunctionMathSource(source, 'text', 'radian',
    { axes: [], parameters: ['U','V'], coefficients: [] }, backend));
  return createFunctionSurfaceEvaluator([definitions[0],definitions[1],definitions[2]], ['U','V'], [], { backend, shouldStop: () => undefined });
}
type Ready = Extract<FunctionSurfaceSamplingResult,{status:'ready'}>;
function ready(result: FunctionSurfaceSamplingResult): Ready {
  if (result.status !== 'ready') throw new Error(JSON.stringify(result)); return result;
}
function interiorResiduals(result: Ready, original: (parameters: SurfaceParameter) => FunctionPoint): void {
  let maximum = 0;
  const weights = [[1/3,1/3,1/3], [0.25,0.25,0.5], [0.5,0.5,0]] as const;
  for (const [i,j,k] of result.triangles) {
    const a = result.vertices[i], b = result.vertices[j], c = result.vertices[k];
    for (const [wa,wb,wc] of weights) {
      const u = a.parameters[0]*wa+b.parameters[0]*wb+c.parameters[0]*wc;
      const v = a.parameters[1]*wa+b.parameters[1]*wb+c.parameters[1]*wc;
      const point = original([u,v]);
      const dx = a.point[0]*wa+b.point[0]*wb+c.point[0]*wc-point[0];
      const dy = a.point[1]*wa+b.point[1]*wb+c.point[1]*wc-point[1];
      const dz = a.point[2]*wa+b.point[2]*wb+c.point[2]*wc-point[2];
      maximum = Math.max(maximum,Math.hypot(dx,dy,dz));
    }
  }
  expect(maximum).toBeLessThanOrEqual(options.tolerance);
}
function boundaryEdges(result: Ready): readonly (readonly [number,number])[] {
  const edges = new Map<string,{ a:number; b:number; orientations:number[] }>();
  for (const triangle of result.triangles) for (let index = 0; index < 3; index++) {
    const a = triangle[index], b = triangle[(index+1)%3], key = `${Math.min(a,b)},${Math.max(a,b)}`;
    const edge = edges.get(key) ?? { a,b,orientations:[] }; edge.orientations.push(a < b ? 1 : -1); edges.set(key,edge);
  }
  const boundary: [number,number][] = [];
  for (const edge of edges.values()) {
    expect(edge.orientations.length).toBeLessThanOrEqual(2);
    if (edge.orientations.length === 2) expect(edge.orientations[0]+edge.orientations[1]).toBe(0);
    else boundary.push([edge.a,edge.b]);
  }
  return boundary;
}
describe('XYZ範囲内の関数曲面を適応分割し、つながる三角形へする', () => {
  it('放物面で存在しない混合微分を作らず、正負の曲率でも内部誤差を過小評価しない',()=>{
    for(const source of ['U^2+V^2','-U^2-V^2','U^2-V^2']) {
      const bound=evaluator(['U','V',source]).interpolationErrorBound?.([-1,-1],[1,1]);
      expect(bound).toBeGreaterThanOrEqual(2);expect(bound).toBeLessThan(2.0000000001);
    }
  });
  it('平面は2枚・共有4点で生成し、XYZやUVの範囲を勝手に代用しない', () => {
    const result = ready(sampleFunctionSurface(evaluator(['U','V','0']), options));
    expect(result.vertices).toHaveLength(4); expect(result.triangles).toHaveLength(2);
    expect(result.maximumInterpolationErrorBound).toBe(0); expect(boundaryEdges(result)).toHaveLength(4);
    expect(sampleFunctionSurface(evaluator(['U','V','10']), options)).toMatchObject({status:'empty',stats:{samples:0}});
  });
  it('放物面の内部残差と不均一な隣接分割を確認し、外周以外に片側だけの辺を残さない', () => {
    const result = ready(sampleFunctionSurface(evaluator(['U','V','U^4/4+V^2/8']), options));
    expect(result.triangles.length).toBeGreaterThan(100); expect(result.triangles.length).toBeLessThan(5000);
    interiorResiduals(result, ([u,v]) => [u,v,u**4/4+v*v/8]);
    for (const [a,b] of boundaryEdges(result)) {
      const start = result.vertices[a].parameters, end = result.vertices[b].parameters;
      expect([0,1].some(axis => start[axis] === end[axis] && Math.abs(start[axis]) === 1)).toBe(true);
    }
  });
  it('混合二階微分を持つ双曲放物面で三角形内部の残差を満たす', () => {
    const result = ready(sampleFunctionSurface(evaluator(['U','V','U*V']), options));
    interiorResiduals(result,([u,v]) => [u,v,u*v]);
  });
  it('U/Vによるトーラスの全三角形内部を元の媒介式と独立に照合する', () => {
    const bounded = { ...options, lower:[0,0] as const, upper:[2*Math.PI,2*Math.PI] as const,
      minimum:[-3,-3,-1] as const, maximum:[3,3,1] as const,
      maximumSamples:100_000,maximumCells:100_000,maximumTriangles:200_000 };
    const started = performance.now();
    const surface = evaluator(['(1.5+0.5*cos(V))*cos(U)','(1.5+0.5*cos(V))*sin(U)','0.5*sin(V)']);
    const prepared = performance.now();
    const result = ready(sampleFunctionSurface(surface, bounded));
    const sampled = performance.now();
    interiorResiduals(result,([u,v]) => [(1.5+0.5*Math.cos(v))*Math.cos(u),(1.5+0.5*Math.cos(v))*Math.sin(u),0.5*Math.sin(v)]);
    console.log('[実測] トーラスの曲面検査', JSON.stringify({ prepareMs: prepared-started,
      sampleMs: sampled-prepared, verificationMs: performance.now()-sampled,
      vertices: result.vertices.length, triangles: result.triangles.length, stats: result.stats }));
    expect(result.maximumInterpolationErrorBound).toBeLessThanOrEqual(options.tolerance);
  });
  it('1/Uの無限面でXYZ外を除外し、極の左右を同じ三角形へ結ばない', () => {
    const result = ready(sampleFunctionSurface(evaluator(['U','V','1/U']), {...options, maximum:[2,2,3],minimum:[-2,-2,-3]}));
    interiorResiduals(result,([u,v]) => [u,v,1/u]);
    for (const triangle of result.triangles) {
      const values = triangle.map(index => result.vertices[index].parameters[0]);
      expect(values.every(value => value > 0) || values.every(value => value < 0)).toBe(true);
    }
  });
});

describe('曲面の二階微分で値域だけを共有する', () => {
  it('枝の境界・方向の所有・別入力の結果を混ぜず、未知の曲率を零にしない', async () => {
    const { compileFunctionScalar } = await import('./compileFunctionScalar.js');
    const { createScalarDirectionalJet, createScalarDirectionalJets } = await import('./scalarCurveCurvature.js');
    const definition = createFunctionMathSource('which(U<0,3*U^2+5*U*V+7*V^2,true,U^3)','text','radian',
      {axes:[],parameters:['U','V'],coefficients:[]},backend);
    const tape = compileFunctionScalar(definition,['U','V'],[],{backend,shouldStop:()=>undefined});
    const directions = [[1,0],[0,1],[1,1]], evaluate = createScalarDirectionalJets(tape,directions);
    const reference = directions.map(direction=>createScalarDirectionalJet(tape,direction));
    directions[0][0] = 100;
    const boxes = [[{lower:-2,upper:-1},{lower:1,upper:2}], [{lower:-1,upper:1},{lower:1,upper:2}],
      [{lower:1,upper:2},{lower:1,upper:2}]];
    const original = evaluate(boxes[0]), snapshot = structuredClone(original);
    for (let direction = 0; direction < 3; direction++) {
      const second = original[direction].second, exact = [6,14,30][direction];
      expect(second?.lower).toBeLessThanOrEqual(exact); expect(second?.upper).toBeGreaterThanOrEqual(exact);
    }
    for (const box of boxes) expect(evaluate(box)).toEqual(reference.map(value=>value(box)));
    expect(evaluate(boxes[1])).toEqual(Array.from({length:3},()=>({first:null,second:null,reason:'piecewise-boundary'})));
    expect(original).toEqual(snapshot); expect(evaluate(boxes[0])).toEqual(original);
    expect(()=>createScalarDirectionalJets(tape,[])).toThrow(RangeError);
    expect(()=>createScalarDirectionalJets(tape,[[1,0],[0,1],[1,1],[1,-1]])).toThrow(RangeError);
    expect(()=>createScalarDirectionalJets(tape,[[NaN,0]])).toThrow(RangeError);
    expect(()=>createScalarDirectionalJets(tape,[[1]])).toThrow(RangeError);
  });

  it('区間端点・無効領域・再評価は独立した3方向評価と一致し、値域は座標ごとに1回だけ評価する', async () => {
    const { compileFunctionScalar } = await import('./compileFunctionScalar.js');
    const { createScalarDirectionalJet, createScalarDirectionalJets } = await import('./scalarCurveCurvature.js');
    const intervals = await import('./scalarMathIntervals.js');
    const { vi } = await import('vitest');
    const original = intervals.createScalarIntervalEvaluation;
    let calls = 0;
    const spy = vi.spyOn(intervals, 'createScalarIntervalEvaluation').mockImplementation((...args) => {
      const value = original(...args);
      return { ...value, evaluate: inputs => { calls++; return value.evaluate(inputs); } };
    });
    const directions = [[1,0],[0,1],[1,1]];
    const boxes = [[{lower:-1,upper:1},{lower:-1,upper:1}], [{lower:0.2,upper:0.8},{lower:1,upper:2}],
      [{lower:0,upper:NaN},{lower:1,upper:1}], [{lower:-2,upper:-1},{lower:-1,upper:0}]];
    try {
      for (const source of ['1','U','-V','U+V','U-V','U*V','U/(V+3)','(U+3)^-3','(U^2+V^2)/10',
        'U^4+V^3','sqrt(U)','abs(U)','sin(U+V)','cos(U)','tan(U)','ln(U)','exp(V)','floor(U)','min(U,V)','1/U']) {
        const definition = createFunctionMathSource(source,'text','radian',{axes:[],parameters:['U','V'],coefficients:[]},backend);
        const tape = compileFunctionScalar(definition,['U','V'],[],{backend,shouldStop:()=>undefined});
        const shared = createScalarDirectionalJets(tape,directions), reference = directions.map(direction=>createScalarDirectionalJet(tape,direction));
        for (const box of boxes) {
          const expected = reference.map(evaluate=>evaluate(box));
          calls = 0;
          const actual = shared(box), snapshot = structuredClone(actual);
          expect(actual).toEqual(expected); expect(calls).toBe(1);
          shared(boxes[1]); expect(actual).toEqual(snapshot);
        }
      }
      const surface = evaluator(['U','V','(U^2+V^2)/10']); calls = 0;
      const bound = surface.interpolationErrorBound?.([-1,-1],[1,1]);
      expect(calls).toBe(3); expect(bound).toBeGreaterThanOrEqual(0.2); expect(bound).toBeLessThan(0.20000000001);
    } finally { spy.mockRestore(); }
  });

  it('時計を注入した実入力の放物面で平滑面の完成・独立解析値・全数値予算を検査する', async () => {
    const { executeFunctionSurfaceWorkRequest } = await import('./functionSurfaceWorkExecution.js');
    const { decodeFunctionSurfaceWorkRequest, createFunctionSurfaceWorkEnvelope } = await import('./functionSurfaceWorkRequest.js');
    const { warmMathBackend } = await import('./createMathBackend.js');
    const { GEOMETRY_CALCULATION_MS } = await import('./mathWorkExecution.js');
    const { pacedCalculationMs } = await import('./mathInputContract.js');
    warmMathBackend(backend);
    const source = (text: string) => createFunctionMathSource(text,'text','radian',{axes:['X','Y'],parameters:[],coefficients:[]},backend);
    const input = decodeFunctionSurfaceWorkRequest({identity:{documentId:'surface-deadline',documentVersion:1,editorId:'surface',inputRevision:1},
      independent:['X','Y'],outputs:[source('X'),source('Y'),source('(X^2+Y^2)/10')],lower:[-4,-4],upper:[4,4],
      minimum:[-4,-4,-1],maximum:[4,4,4],tolerance:0.001,coefficients:[],
      budget:{maximumSamples:100_000,maximumCells:400_000,maximumTriangles:100_000,maximumDepth:24}});
    // Deterministic geometry proof, not a claim that this input completes within the real product deadline.
    // geometryCalculationDeadline.test.ts retains the real clock consumer's stop/budget boundary tests.
    const realNow = performance.now.bind(performance), started = realNow();
    const result = (() => {
      const clock = vi.spyOn(performance, 'now').mockReturnValue(0);
      try { return executeFunctionSurfaceWorkRequest(createFunctionSurfaceWorkEnvelope(1,input),backend).result; }
      finally { clock.mockRestore(); }
    })();
    const elapsedMs = realNow()-started, limitMs = pacedCalculationMs(GEOMETRY_CALCULATION_MS);
    process.stdout.write('[pcad:surface-functional-geometry] '+JSON.stringify({clock:'injected-frozen',
      performanceQualified:false,elapsedMs,referenceLimitMs:limitMs,withinReference:elapsedMs<=limitMs,
      status:result.status,stats:'stats' in result?result.stats:null,reason:'reason' in result?result.reason:null})+String.fromCharCode(10));
    expect(GEOMETRY_CALCULATION_MS).toBe(2000); expect(Number.isFinite(elapsedMs) && elapsedMs >= 0).toBe(true);
    if (result.status !== 'ready') throw new Error(JSON.stringify(result));
    expect(result.spline).toBeDefined(); expect(result.stats).toEqual({samples:49666,cells:38229,triangles:32768});
    expect(result.maximumInterpolationErrorBound).toBeLessThanOrEqual(0.0005);
    expect(result.spline?.errorBound).toBeLessThanOrEqual(0.001);
    let residual = 0;
    for (const [a,b,c] of result.triangles) {
      const vertices = [result.vertices[a],result.vertices[b],result.vertices[c]];
      const x = vertices.reduce((sum,vertex)=>sum+vertex.point[0]/3,0), y = vertices.reduce((sum,vertex)=>sum+vertex.point[1]/3,0);
      const z = vertices.reduce((sum,vertex)=>sum+vertex.point[2]/3,0);
      residual = Math.max(residual,Math.abs(z-(x*x+y*y)/10));
    }
    expect(residual).toBeLessThanOrEqual(result.maximumInterpolationErrorBound);
  }, 30_000);
});
