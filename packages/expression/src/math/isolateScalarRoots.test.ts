import { beforeAll, describe, expect, it } from 'vitest';
import { createMathBackend } from './createMathBackend.js';
import { createFunctionMathSource } from './functionMathSource.js';
import { createFunctionImplicitEvaluator } from './functionImplicitEvaluation.js';
import { isolateScalarRoots, type ScalarRootOptions, type ScalarRootResult } from './isolateScalarRoots.js';
import type { MathExecutionBackend } from './mathWorkExecution.js';

let backend: MathExecutionBackend;
beforeAll(() => { backend = createMathBackend(); });
const options: ScalarRootOptions = { lower:-2, upper:2, tolerance:1e-7, maximumEvaluations:50_000, maximumRegions:1024, maximumDepth:64 };
function solve(source: string, changes: Partial<ScalarRootOptions> = {}): ScalarRootResult {
  const definition = createFunctionMathSource(source,'text','radian',{ axes:['X','Y','Z'],parameters:[],coefficients:[] },backend);
  const f = createFunctionImplicitEvaluator(definition,[],{backend,shouldStop:()=>undefined}), derivative = f.along([1,0,0]);
  return isolateScalarRoots({ enclosure:(lower,upper)=>f.enclosure([lower,0,0],[upper,0,0]),
    derivative:(lower,upper)=>derivative([lower,0,0],[upper,0,0]) },{...options,...changes});
}
function complete(result: ScalarRootResult, expected: readonly number[]): void {
  expect(result.status).toBe('complete');
  if (result.status !== 'complete') throw new Error(JSON.stringify(result));
  expect(result.roots).toHaveLength(expected.length);
  result.roots.forEach((root,index) => {
    expect(root.lower).toBeLessThanOrEqual(expected[index]); expect(root.upper).toBeGreaterThanOrEqual(expected[index]);
    expect(root.upper-root.lower).toBeLessThanOrEqual(options.tolerance);
  });
}
describe('有限区間内の解を、未解決領域と区別して探索する', () => {
  it('両端が同じ符号でも2つの根を見つけ、内部の分割境界で重複しない', () => complete(solve('X^2-1'),[-1,1]));
  it('座標のちょうど0と領域端の解を1件に保つ', () => {
    complete(solve('X'),[0]); complete(solve('X',{lower:0,upper:2}),[0]);
  });
  it('近接する2解を1つへ溶接しない', () => complete(solve('(X-0.001)*(X+0.001)'),[-0.001,0.001]));
  it('周期関数の全候補を保持する', () => complete(solve('sin(X)',{lower:-7,upper:7}),[-2*Math.PI,-Math.PI,0,Math.PI,2*Math.PI]));
  it('無解は区間で除外し、同符号の標本だけで判定しない', () => complete(solve('X^2+1'),[]));
  it('接する重根を解なしや唯一の単根と報告しない', () => {
    const result = solve('X^2'); expect(result.status).toBe('unresolved');
    if (result.status !== 'unresolved') throw new Error(JSON.stringify(result));
    expect(result.roots).toHaveLength(0);
    expect(result.unresolved.some(region=>region.lower <= 0 && region.upper >= 0 && region.reason==='stationary')).toBe(true);
  });
  it('恒等0では無数の解がある領域を区別し、極を零点にしない', () => {
    expect(solve('0')).toMatchObject({status:'unresolved',roots:[],unresolved:[{reason:'continuum'}]});
    const result = solve('1/X'); expect(result.status).toBe('unresolved');
    if (result.status !== 'unresolved') throw new Error(JSON.stringify(result));
    expect(result.roots).toEqual([]); expect(result.unresolved.every(region=>region.reason==='domain')).toBe(true);
  });
  it.each(['cancelled','deadline'] as const)('%sでは部分的な候補を成功として返さない', status => {
    expect(solve('X^2-1',{shouldStop:()=>status})).toMatchObject({status});
    expect(solve('X^2-1',{shouldStop:()=>status})).not.toHaveProperty('roots');
  });
  it('個数上限と有限範囲を検証し、入力不足を無限範囲へ補完しない', () => {
    expect(solve('sin(X)',{maximumEvaluations:1})).toMatchObject({status:'budget'});
    for (const changes of [{lower:-Infinity}, {upper:NaN}, {lower:2}, {tolerance:0}, {maximumRegions:4097}]) {
      expect(()=>solve('X',changes)).toThrow();
    }
  });
});
