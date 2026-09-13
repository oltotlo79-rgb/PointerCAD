import { beforeAll, describe, expect, it } from 'vitest';
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
