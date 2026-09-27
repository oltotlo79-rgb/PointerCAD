import { beforeAll, describe, expect, it } from 'vitest';
import { createMathBackend } from './createMathBackend.js';
import { createFunctionMathSource } from './functionMathSource.js';
import { compileFunctionScalar } from './compileFunctionScalar.js';
import { createFunctionCurveEvaluator } from './functionCurveEvaluation.js';
import { createFunctionSurfaceEvaluator } from './functionSurfaceEvaluation.js';
import { sampleFunctionCurve, type FunctionCurveOptions, type FunctionCurveSamplingResult } from './adaptiveFunctionCurve.js';
import { sampleFunctionSurface, type FunctionSurfaceEvaluator, type FunctionSurfaceOptions,
  type FunctionSurfaceSamplingResult } from './adaptiveFunctionSurface.js';
import { executeFunctionSurfaceWorkRequest } from './functionSurfaceWorkExecution.js';
import { createFunctionSurfaceWorkEnvelope, decodeFunctionSurfaceWorkRequest } from './functionSurfaceWorkRequest.js';
import { MathInputProblem } from './mathInputContract.js';
import type { ScalarCondition, ScalarInput } from './scalarMathTape.js';
import type { MathExecutionBackend } from './mathWorkExecution.js';

let backend: MathExecutionBackend;
beforeAll(() => { backend = createMathBackend(); });
const context = () => ({ backend, shouldStop: () => undefined });
function definition(source: string, inputs: readonly ScalarInput[]) {
  return createFunctionMathSource(source, 'text', 'radian', {
    axes: inputs.filter(input => input === 'X' || input === 'Y' || input === 'Z'),
    parameters: inputs.filter(input => input === 'T' || input === 'U' || input === 'V'), coefficients: [],
  }, backend);
}
function surface(sources: readonly [string, string, string], inputs: readonly [ScalarInput, ScalarInput] = ['X', 'Y']) {
  return createFunctionSurfaceEvaluator([definition(sources[0], inputs), definition(sources[1], inputs), definition(sources[2], inputs)],
    inputs, [], context());
}
function curve(sources: readonly [string, string, string], input: ScalarInput = 'X') {
  return createFunctionCurveEvaluator([definition(sources[0], [input]), definition(sources[1], [input]), definition(sources[2], [input])],
    input, [], context());
}
/** The same compiler and constant evaluation as the plotted which conditions. */
function condition(source: string, inputs: readonly ScalarInput[]): ScalarCondition {
  const tape = compileFunctionScalar(definition(`which(${source},0)`, inputs), inputs, [], context());
  const selection = tape.instructions[tape.output];
  if (selection.kind !== 'piecewise') throw new Error(`条件をコンパイルできません: ${source}`);
  return selection.branches[0].condition;
}
const square = (half: number, z: number, tolerance: number): FunctionSurfaceOptions => ({
  lower: [-half, -half], upper: [half, half], minimum: [-half, -half, -z], maximum: [half, half, z], tolerance,
  maximumSamples: 200_000, maximumCells: 400_000, maximumTriangles: 200_000, maximumDepth: 16,
});
const line = (tolerance = 0.02): FunctionCurveOptions => ({ lower: -2, upper: 2, minimum: [-2, -3, -1], maximum: [2, 3, 1],
  tolerance, maximumSamples: 20_000, maximumCells: 40_000, maximumDepth: 40 });
type ReadySurface = Extract<FunctionSurfaceSamplingResult, { status: 'ready' }>;
type ReadyCurve = Extract<FunctionCurveSamplingResult, { status: 'ready' }>;
function readySurface(result: FunctionSurfaceSamplingResult): ReadySurface {
  if (result.status !== 'ready') throw new Error(JSON.stringify(result));
  return result;
}
function readyCurve(result: FunctionCurveSamplingResult): ReadyCurve {
  if (result.status !== 'ready') throw new Error(JSON.stringify(result));
  return result;
}
type Planar = readonly [number, number];
function segmentDistance(p: Planar, a: Planar, b: Planar): number {
  const dx = b[0] - a[0], dy = b[1] - a[1], length = dx * dx + dy * dy;
  const t = length === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / length));
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
}
/** Planar distance from a point to a filled triangle. */
function triangleDistance(p: Planar, a: Planar, b: Planar, c: Planar): number {
  const side = (u: Planar, v: Planar) => (v[0] - u[0]) * (p[1] - u[1]) - (v[1] - u[1]) * (p[0] - u[0]);
  const s = [side(a, b), side(b, c), side(c, a)];
  if (s.every(value => value >= 0) || s.every(value => value <= 0)) return 0;
  return Math.min(segmentDistance(p, a, b), segmentDistance(p, b, c), segmentDistance(p, c, a));
}
function planarTriangles(result: ReadySurface, z?: number): (readonly [Planar, Planar, Planar])[] {
  return result.triangles.filter(face => z === undefined || result.vertices[face[0]].point[2] === z)
    .map(face => face.map(index => [result.vertices[index].point[0], result.vertices[index].point[1]] as const) as [Planar, Planar, Planar]);
}
function nearest(point: Planar, triangles: readonly (readonly [Planar, Planar, Planar])[]): number {
  return Math.min(...triangles.map(([a, b, c]) => triangleDistance(point, a, b, c)));
}
function discPoints(radii: readonly number[]): Planar[] {
  return radii.flatMap(radius => Array.from({ length: 48 }, (_, index) => {
    const angle = (index + 0.37) * Math.PI / 24;
    return [radius * Math.cos(angle), radius * Math.sin(angle)] as const;
  }));
}
function expectVerticesOnSurface(result: ReadySurface, evaluator: FunctionSurfaceEvaluator): void {
  for (const vertex of result.vertices) expect(evaluator.point(vertex.parameters)).toEqual(vertex.point);
}

describe('条件が成り立つ範囲だけの曲面（MC-22b）', () => {
  it('円の内側だけの面を作り、各頂点が条件を満たす', () => {
    const evaluator = surface(['X', 'Y', 'which(X^2+Y^2<1,X^2-Y^2)']);
    const result = readySurface(sampleFunctionSurface(evaluator, square(1.5, 3, 0.05)));
    expect(result.triangles.length).toBeGreaterThan(100);
    for (const vertex of result.vertices) expect(vertex.parameters[0] ** 2 + vertex.parameters[1] ** 2).toBeLessThan(1);
    expectVerticesOnSurface(result, evaluator);
    expect(result.maximumInterpolationErrorBound).toBeGreaterThan(0);
    expect(result.maximumInterpolationErrorBound).toBeLessThanOrEqual(0.05);
  });

  it('境界の近似の誤差を精度の上限に含め、円の内側の全点がその距離内にある', () => {
    const result = readySurface(sampleFunctionSurface(surface(['X', 'Y', 'which(X^2+Y^2<1,0.5)']), square(1.5, 3, 0.05)));
    // A plane has no interpolation error, so the reported bound is the omitted boundary strip.
    const bound = result.maximumInterpolationErrorBound;
    expect(bound).toBeGreaterThan(0);
    expect(bound).toBeLessThanOrEqual(0.05);
    expect(result.vertices.every(vertex => vertex.point[2] === 0.5)).toBe(true);
    const triangles = planarTriangles(result);
    for (const point of discPoints([0, 0.4, 0.8, 0.95, 0.99, 0.999, 0.99999])) {
      expect(nearest(point, triangles)).toBeLessThanOrEqual(bound);
    }
  });

  it('精度を細かくすると境界の誤差の上限も小さくなる', () => {
    const coarse = readySurface(sampleFunctionSurface(surface(['X', 'Y', 'which(X^2+Y^2<1,0.5)']), square(1.5, 3, 0.08)));
    const fine = readySurface(sampleFunctionSurface(surface(['X', 'Y', 'which(X^2+Y^2<1,0.5)']), square(1.5, 3, 0.02)));
    expect(fine.maximumInterpolationErrorBound).toBeLessThanOrEqual(0.02);
    expect(fine.maximumInterpolationErrorBound).toBeLessThan(coarse.maximumInterpolationErrorBound);
    expect(fine.triangles.length).toBeGreaterThan(coarse.triangles.length);
  });

  it('かつの先の項が未確定でも後の項が偽なら、存在しない枝を作図や被覆の対象にしない', () => {
    // Along the lower arc X^2+Y^2<1 is undecided, but Y>0 is false there: the half disc has no branch below Y=0.
    const evaluator = surface(['X', 'Y', 'which(and(X^2+Y^2<1,Y>0),0.5)']);
    const result = readySurface(sampleFunctionSurface(evaluator, square(1.5, 3, 0.05)));
    for (const vertex of result.vertices) {
      expect(vertex.parameters[0] ** 2 + vertex.parameters[1] ** 2).toBeLessThan(1);
      expect(vertex.parameters[1]).toBeGreaterThan(0);
    }
    const bound = result.maximumInterpolationErrorBound, triangles = planarTriangles(result);
    expect(bound).toBeLessThanOrEqual(0.05);
    for (const point of discPoints([0.3, 0.9, 0.999]).filter(([, y]) => y > 0)) expect(nearest(point, triangles)).toBeLessThanOrEqual(bound);
    expect(result.stats.cells).toBeLessThan(20_000);
  });

  it('値が跳ぶ円の境界をまたいで三角形を作らない', () => {
    const evaluator = surface(['X', 'Y', 'which(X^2+Y^2<1,0,true,1)']);
    const result = readySurface(sampleFunctionSurface(evaluator, square(1.5, 3, 0.05)));
    for (const face of result.triangles) {
      const vertices = face.map(index => result.vertices[index]);
      expect(new Set(vertices.map(vertex => vertex.point[2])).size).toBe(1);
      const inside = vertices[0].point[2] === 0;
      for (const vertex of vertices) expect(vertex.parameters[0] ** 2 + vertex.parameters[1] ** 2 < 1).toBe(inside);
    }
    // No triangle of the outer branch reaches into the open disc.
    for (const triangle of planarTriangles(result, 1)) expect(triangleDistance([0, 0], ...triangle)).toBeGreaterThanOrEqual(1 - 1e-12);
    const bound = result.maximumInterpolationErrorBound;
    expect(bound).toBeLessThanOrEqual(0.05);
    const inner = planarTriangles(result, 0), outer = planarTriangles(result, 1);
    for (const point of discPoints([0.5, 0.97, 0.999])) expect(nearest(point, inner)).toBeLessThanOrEqual(bound);
    for (const point of discPoints([1.001, 1.03, 1.4])) expect(nearest(point, outer)).toBeLessThanOrEqual(bound);
    expectVerticesOnSurface(result, evaluator);
  });

  it('明示した条件付きの範囲は同じ条件の場合分けと同じ面になる', () => {
    const options = square(1.5, 3, 0.05);
    const ranged = readySurface(sampleFunctionSurface(surface(['X', 'Y', 'X^2-Y^2']),
      { ...options, domain: condition('X^2+Y^2<=1', ['X', 'Y']) }));
    const which = readySurface(sampleFunctionSurface(surface(['X', 'Y', 'which(X^2+Y^2<=1,X^2-Y^2)']), options));
    expect(ranged.vertices).toEqual(which.vertices);
    expect(ranged.triangles).toEqual(which.triangles);
    expect(ranged.maximumInterpolationErrorBound).toBe(which.maximumInterpolationErrorBound);
    for (const vertex of ranged.vertices) expect(vertex.parameters[0] ** 2 + vertex.parameters[1] ** 2).toBeLessThanOrEqual(1);
  });

  it('全体で成り立つ条件付きの範囲は条件のない面と同じ結果を返す', () => {
    const options = square(1, 3, 0.05), evaluator = surface(['X', 'Y', 'X^2+Y^2']);
    expect(sampleFunctionSurface(evaluator, { ...options, domain: condition('X^2+Y^2<9', ['X', 'Y']) }))
      .toEqual(sampleFunctionSurface(evaluator, options));
  });

  it('複数の出力に同じ条件がある媒介変数の曲面を、条件の組合せを取り違えずに作る', () => {
    const evaluator = surface(['which(U^2+V^2<1,U)', 'which(U^2+V^2<1,V)', 'which(U^2+V^2<1,U*V)'], ['U', 'V']);
    const options: FunctionSurfaceOptions = { ...square(1.5, 3, 0.05), minimum: [-2, -2, -2], maximum: [2, 2, 2] };
    const result = readySurface(sampleFunctionSurface(evaluator, options));
    for (const vertex of result.vertices) expect(vertex.parameters[0] ** 2 + vertex.parameters[1] ** 2).toBeLessThan(1);
    expectVerticesOnSurface(result, evaluator);
    expect(result.maximumInterpolationErrorBound).toBeLessThanOrEqual(0.05);
  });

  it('かつ・または・入れ子と変数と定数の境界を含む場合分けでも各三角形が一つの枝に属する', () => {
    const evaluator = surface(['X', 'Y', 'which(X<0,which(and(X^2+Y^2<1,Y>X^2-0.5),1,true,2),or(Y>1,Y< -1),3,true,4)']);
    const result = readySurface(sampleFunctionSurface(evaluator, square(1.5, 5, 0.05)));
    const branch = ([x, y]: readonly [number, number]): number => x < 0 ? (x * x + y * y < 1 && y > x * x - 0.5 ? 1 : 2)
      : y > 1 || y < -1 ? 3 : 4;
    const seen = new Set<number>();
    for (const face of result.triangles) {
      const vertices = face.map(index => result.vertices[index]);
      expect(new Set(vertices.map(vertex => vertex.point[2])).size).toBe(1);
      for (const vertex of vertices) expect(branch(vertex.parameters)).toBe(vertex.point[2]);
      seen.add(vertices[0].point[2]);
    }
    expect([...seen].sort()).toEqual([1, 2, 3, 4]);
    expect(result.maximumInterpolationErrorBound).toBeLessThanOrEqual(0.05);
  });

  it.each([
    ['等式だけで成り立つ場合分け', 'which(X^2+Y^2=1,0.5)', undefined],
    ['等式の枝の値が離れている場合分け', 'which(X^2+Y^2=1,2,true,0)', undefined],
    ['等式の条件付きの範囲', '0.5', 'X^2+Y^2=1'],
  ] as const)('%sを近似せず理由付きで断る', (_, source, range) => {
    const options = square(1.5, 3, 0.05);
    const run = () => sampleFunctionSurface(surface(['X', 'Y', source]),
      range === undefined ? options : { ...options, domain: condition(range, ['X', 'Y']) });
    expect(run).toThrow(MathInputProblem);
    expect(run).toThrow('条件を満たす範囲の境界');
  });

  it('等式の枝の値が隣の枝と精度内で等しければ、その境界も覆われる', () => {
    const result = readySurface(sampleFunctionSurface(surface(['X', 'Y', 'which(X^2+Y^2<1,0,X^2+Y^2=1,0,true,1)']),
      square(1.5, 3, 0.05)));
    expect(result.maximumInterpolationErrorBound).toBeLessThanOrEqual(0.05);
  });

  it('作図の計算部の応答でも判定できない条件を理由付きの不成立にし、円の内側は作図する', () => {
    const request = (source: string) => {
      const input = (text: string) => definition(text, ['X', 'Y']);
      return decodeFunctionSurfaceWorkRequest({ identity: { documentId: 'domain', documentVersion: 1, editorId: 'surface', inputRevision: 1 },
        independent: ['X', 'Y'], outputs: [input('X'), input('Y'), input(source)], lower: [-1.5, -1.5], upper: [1.5, 1.5],
        minimum: [-1.5, -1.5, -1], maximum: [1.5, 1.5, 1], tolerance: 0.05, coefficients: [],
        budget: { maximumSamples: 200_000, maximumCells: 400_000, maximumTriangles: 200_000, maximumDepth: 16 } });
    };
    const ready = executeFunctionSurfaceWorkRequest(createFunctionSurfaceWorkEnvelope(1, request('which(X^2+Y^2<1,0.5)')), backend);
    expect(ready.result.status).toBe('ready');
    const rejected = executeFunctionSurfaceWorkRequest(createFunctionSurfaceWorkEnvelope(2, request('which(X^2+Y^2=1,0.5)')), backend);
    expect(rejected.result).toMatchObject({ status: 'invalid' });
    if (rejected.result.status === 'invalid') expect(rejected.result.message).toContain('条件を満たす範囲の境界');
  });

  it('条件付きの作図の中止では途中の面を返さない', () => {
    const evaluator = surface(['X', 'Y', 'which(X^2+Y^2<1,X^2-Y^2)']);
    for (const limit of [1, 2, 50, 500]) {
      let calls = 0;
      const result = sampleFunctionSurface(evaluator, { ...square(1.5, 3, 0.05), shouldStop: () => ++calls >= limit ? 'cancelled' : undefined });
      expect(result).toMatchObject({ status: 'stopped', reason: 'cancelled' });
      expect(result).not.toHaveProperty('triangles');
    }
  });
});

describe('条件が成り立つ範囲だけの曲線（MC-22b）', () => {
  it('一般の条件の境界で曲線を分け、値の跳びを線で結ばない', () => {
    const result = readyCurve(sampleFunctionCurve(curve(['X', 'which(X^2<0.5,1,true,-1)', '0']), line()));
    const edge = Math.sqrt(0.5), bound = result.maximumChordErrorBound;
    expect(result.components).toHaveLength(3);
    expect(result.components.map(component => component[0].point[1])).toEqual([-1, 1, -1]);
    for (const component of result.components) expect(new Set(component.map(sample => sample.point[1])).size).toBe(1);
    const [left, middle, right] = result.components;
    expect(left.at(-1)?.parameter).toBeLessThan(-edge);
    expect(middle[0].parameter).toBeGreaterThan(-edge);
    expect(middle.at(-1)?.parameter).toBeLessThan(edge);
    expect(right[0].parameter).toBeGreaterThan(edge);
    // Every omitted boundary point is within the reported bound of a drawn endpoint of its branch.
    expect(-edge - (left.at(-1)?.parameter ?? -Infinity)).toBeLessThanOrEqual(bound);
    expect(middle[0].parameter + edge).toBeLessThanOrEqual(bound);
    expect(bound).toBeLessThanOrEqual(0.02);
  });

  it('明示した条件付きの範囲だけに曲線を作り、範囲の端の誤差を上限に含める', () => {
    const evaluator = curve(['X', 'X^2', '0']);
    const result = readyCurve(sampleFunctionCurve(evaluator, { ...line(), domain: condition('X^2<2', ['X']) }));
    expect(result.components).toHaveLength(1);
    const [component] = result.components, edge = Math.SQRT2, bound = result.maximumChordErrorBound;
    for (const sample of component) {
      expect(Math.abs(sample.parameter)).toBeLessThan(edge);
      expect(sample.point).toEqual(evaluator.point(sample.parameter));
    }
    expect(Math.hypot(component[0].parameter + edge, component[0].point[1] - 2)).toBeLessThanOrEqual(bound);
    expect(Math.hypot(edge - (component.at(-1)?.parameter ?? Infinity), (component.at(-1)?.point[1] ?? Infinity) - 2)).toBeLessThanOrEqual(bound);
    expect(bound).toBeLessThanOrEqual(0.02);
  });

  it('かつ・またはの評価順で決まる範囲だけに曲線を作る', () => {
    const result = readyCurve(sampleFunctionCurve(curve(['X', 'which(and(X^2<1,X>0),1,or(X< -1.5,X^2>3),2)', '0']), line()));
    for (const component of result.components) for (const sample of component) {
      const x = sample.parameter;
      expect(sample.point[1]).toBe(x * x < 1 && x > 0 ? 1 : 2);
      expect(x * x < 1 && x > 0 || x < -1.5 || x * x > 3).toBe(true);
    }
    expect(result.components.map(component => component[0].point[1])).toEqual([2, 1, 2]);
    expect(result.maximumChordErrorBound).toBeLessThanOrEqual(0.02);
  });

  it('値がつながる場合分けも境界の近くの誤差を含めて精度内で作る', () => {
    const result = readyCurve(sampleFunctionCurve(curve(['X', 'which(X^2<1,X^2,true,1)', '0']), line()));
    expect(result.components.length).toBeGreaterThanOrEqual(1);
    for (const component of result.components) for (let index = 1; index < component.length; index++) {
      const a = component[index - 1], b = component[index], x = (a.parameter + b.parameter) / 2;
      expect(Math.abs((a.point[1] + b.point[1]) / 2 - (x * x < 1 ? x * x : 1))).toBeLessThanOrEqual(result.maximumChordErrorBound);
    }
    expect(result.maximumChordErrorBound).toBeLessThanOrEqual(0.02);
  });

  it.each([
    ['孤立した点で成り立つ等式の枝', 'which(X^2=1,2,true,0)'],
    // A root that its condition keeps defined (the semicircle) is drawn since MC-22d; functionBoundaryRoots.test.ts checks it.
    ['条件が根号の中を保証しない枝', 'which(X^2<1,sqrt(X^2-1))'],
  ])('%sを近似せず理由付きで断る', (_, source) => {
    expect(() => sampleFunctionCurve(curve(['X', source, '0']), line())).toThrow(MathInputProblem);
  });
});

/** Recorded with the samplers before MC-22b on the same inputs (stats and enclosure evaluations). */
const BASELINE_UNCONDITIONAL = { curve: { samples: 17, cells: 31 }, curveCalls: 46,
  surface: { samples: 545, cells: 341, triangles: 512 }, surfaceCalls: 886 };
const nextAfterZero = Number.MIN_VALUE;

describe('条件を含まない式と変数と定数の境界（MC-22b の不変）', () => {
  it('条件のない曲線・曲面の結果と計算回数を変えない', () => {
    let curveCalls = 0, surfaceCalls = 0;
    const plain = curve(['X', 'X^2', '0']);
    const counted = { ...plain, enclosure: (lower: number, upper: number) => { curveCalls++; return plain.enclosure(lower, upper); } };
    const curveResult = readyCurve(sampleFunctionCurve(counted, line()));
    const flat = surface(['X', 'Y', 'X^2+Y^2']);
    const countedSurface: FunctionSurfaceEvaluator = { ...flat, enclosure: (lower, upper) => { surfaceCalls++; return flat.enclosure(lower, upper); } };
    const surfaceResult = readySurface(sampleFunctionSurface(countedSurface, square(1, 3, 0.05)));
    expect({ curve: curveResult.stats, curveCalls, surface: surfaceResult.stats, surfaceCalls }).toEqual(BASELINE_UNCONDITIONAL);
  });

  it('変数と定数の比較だけの場合分けは従来の境界の分割を使う', () => {
    const result = readyCurve(sampleFunctionCurve(curve(['X', 'which(X<=0,-2,true,3)', '0']), line()));
    expect(result.components.map(component => [component[0].parameter, component[0].point[1]])).toEqual([[-2, -2], [nextAfterZero, 3]]);
  });
});
