import { beforeAll, describe, expect, it } from 'vitest';
import { createMathBackend } from './createMathBackend.js';
import { createFunctionMathSource } from './functionMathSource.js';
import { compileFunctionScalar } from './compileFunctionScalar.js';
import { createFunctionCurveEvaluator } from './functionCurveEvaluation.js';
import { createFunctionSurfaceEvaluator } from './functionSurfaceEvaluation.js';
import { sampleFunctionCurve, type FunctionCurveEvaluator, type FunctionCurveOptions,
  type FunctionCurveSamplingResult } from './adaptiveFunctionCurve.js';
import { sampleFunctionSurface, type FunctionSurfaceEvaluator, type FunctionSurfaceOptions,
  type FunctionSurfaceSamplingResult } from './adaptiveFunctionSurface.js';
import { executeFunctionSurfaceWorkRequest } from './functionSurfaceWorkExecution.js';
import { createFunctionSurfaceWorkEnvelope, decodeFunctionSurfaceWorkRequest } from './functionSurfaceWorkRequest.js';
import { FUNCTION_SURFACE_LIMITS } from './functionSurfaceLimits.js';
import { FUNCTION_CURVE_LIMITS } from './functionCurveWorkRequest.js';
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
function curve(source: string): FunctionCurveEvaluator {
  return createFunctionCurveEvaluator([definition('X', ['X']), definition(source, ['X']), definition('0', ['X'])], 'X', [], context());
}
function surface(source: string): FunctionSurfaceEvaluator {
  return createFunctionSurfaceEvaluator([definition('X', ['X', 'Y']), definition('Y', ['X', 'Y']), definition(source, ['X', 'Y'])],
    ['X', 'Y'], [], context());
}
/** The same compiler and constant evaluation as the plotted which conditions. */
function condition(source: string, inputs: readonly ScalarInput[]): ScalarCondition {
  const tape = compileFunctionScalar(definition(`which(${source},0)`, inputs), inputs, [], context());
  const selection = tape.instructions[tape.output];
  if (selection.kind !== 'piecewise') throw new Error(`条件をコンパイルできません: ${source}`);
  return selection.branches[0].condition;
}
const line = (tolerance = 0.02): FunctionCurveOptions => ({ lower: -2, upper: 2, minimum: [-2, -3, -1], maximum: [2, 3, 1],
  tolerance, maximumSamples: 20_000, maximumCells: 40_000, maximumDepth: 40 });
const square = (tolerance: number, depth = 16): FunctionSurfaceOptions => ({ lower: [-1.5, -1.5], upper: [1.5, 1.5],
  minimum: [-1.5, -1.5, -3], maximum: [1.5, 1.5, 3], tolerance, maximumSamples: 200_000, maximumCells: 400_000,
  maximumTriangles: 200_000, maximumDepth: depth });
type ReadyCurve = Extract<FunctionCurveSamplingResult, { status: 'ready' }>;
type ReadySurface = Extract<FunctionSurfaceSamplingResult, { status: 'ready' }>;
function readyCurve(result: FunctionCurveSamplingResult): ReadyCurve {
  if (result.status !== 'ready') throw new Error(JSON.stringify(result));
  return result;
}
function readySurface(result: FunctionSurfaceSamplingResult): ReadySurface {
  if (result.status !== 'ready') throw new Error(JSON.stringify(result));
  return result;
}
type Point = readonly [number, number, number];
const minus = (a: Point, b: Point): Point => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: Point, b: Point): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Point, b: Point): Point => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
function segmentDistance(p: Point, a: Point, b: Point): number {
  const ab = minus(b, a), length = dot(ab, ab), t = length === 0 ? 0 : Math.max(0, Math.min(1, dot(minus(p, a), ab) / length));
  return Math.hypot(p[0] - a[0] - t * ab[0], p[1] - a[1] - t * ab[1], p[2] - a[2] - t * ab[2]);
}
/** Distance from a point to a filled triangle in space. */
function triangleDistance(p: Point, a: Point, b: Point, c: Point): number {
  const normal = cross(minus(b, a), minus(c, a)), area = dot(normal, normal);
  if (area > 0) {
    const t = dot(minus(p, a), normal) / area, q: Point = [p[0] - t * normal[0], p[1] - t * normal[1], p[2] - t * normal[2]];
    const edges: readonly (readonly [Point, Point])[] = [[a, b], [b, c], [c, a]];
    if (edges.every(([u, v]) => dot(cross(minus(v, u), minus(q, u)), normal) >= 0)) return Math.abs(t) * Math.sqrt(area);
  }
  return Math.min(segmentDistance(p, a, b), segmentDistance(p, b, c), segmentDistance(p, c, a));
}
function surfaceDistance(result: ReadySurface, point: Point): number {
  let best = Infinity;
  for (const [i, j, k] of result.triangles) {
    best = Math.min(best, triangleDistance(point, result.vertices[i].point, result.vertices[j].point, result.vertices[k].point));
  }
  return best;
}
function curveDistance(result: ReadyCurve, point: Point): number {
  let best = Infinity;
  for (const component of result.components) {
    for (let index = 1; index < component.length; index++) best = Math.min(best, segmentDistance(point, component[index - 1].point, component[index].point));
  }
  return best;
}
const semicircle = (radius: number, x: number): Point => [x, Math.sqrt(Math.max(0, radius * radius - x * x)), 0];

describe('条件が根号の中を保証する半円の曲線（MC-22d）', () => {
  it.each([
    ['which(X^2<1,sqrt(1-X^2))'], ['which(X^2<=1,sqrt(1-X^2))'], ['which(X^2<1,(1-X^2)^(1/2))'],
  ])('%s を作図し、端点を含む半円の全点が誤差の上限の距離内にある', source => {
    const evaluator = curve(source), result = readyCurve(sampleFunctionCurve(evaluator, line()));
    const bound = result.maximumChordErrorBound;
    expect(bound).toBeGreaterThan(0);
    expect(bound).toBeLessThanOrEqual(0.02);
    for (const component of result.components) for (const sample of component) {
      expect(sample.parameter ** 2).toBeLessThanOrEqual(1);
      expect(sample.point).toEqual(evaluator.point(sample.parameter));
    }
    for (const x of [-1, -0.99999, -0.999, -0.9, -0.5, 0, 0.5, 0.9, 0.999, 0.99999, 1]) {
      expect(curveDistance(result, semicircle(1, x))).toBeLessThanOrEqual(bound);
    }
  });

  it('半径10・精度0.01の半円も上限内の距離で作図する', () => {
    const options: FunctionCurveOptions = { lower: -12, upper: 12, minimum: [-12, -1, -1], maximum: [12, 12, 1], tolerance: 0.01,
      ...FUNCTION_CURVE_LIMITS };
    const result = readyCurve(sampleFunctionCurve(curve('which(X^2<100,sqrt(100-X^2))'), options));
    expect(result.maximumChordErrorBound).toBeLessThanOrEqual(0.01);
    for (const x of [-10, -9.99999, -9, 0, 9, 9.99999, 10]) {
      expect(curveDistance(result, semicircle(10, x))).toBeLessThanOrEqual(result.maximumChordErrorBound);
    }
  });

  it.each([
    ['比較の向きが逆', 'which(1-X^2>0,sqrt(1-X^2))'],
    ['正の倍数', 'which(X^2<1,sqrt(2-2*X^2))'],
    ['否定', 'which(not(X^2>=1),sqrt(1-X^2))'],
    ['前の枝が偽', 'which(X^2>=1,0,true,sqrt(1-X^2))'],
    ['かつで二つの根号を保証', 'which(and(X^2<1,X>-1),sqrt(1-X^2)+sqrt(X+1))'],
    ['2進で表せない定数', 'which(X^2<0.3,sqrt(0.3-X^2))'],
  ])('%sの保証でも作図する', (_, source) => {
    expect(readyCurve(sampleFunctionCurve(curve(source), line())).maximumChordErrorBound).toBeLessThanOrEqual(0.02);
  });
});

describe('条件が根号の中を保証する半球の曲面（MC-22d）', () => {
  it('粗い精度の半球を作図し、縁を含む半球の全点が誤差の上限の距離内にある', () => {
    const evaluator = surface('which(X^2+Y^2<1,sqrt(1-X^2-Y^2))'), result = readySurface(sampleFunctionSurface(evaluator, square(0.2)));
    const bound = result.maximumInterpolationErrorBound;
    expect(bound).toBeGreaterThan(0);
    expect(bound).toBeLessThanOrEqual(0.2);
    for (const vertex of result.vertices) {
      expect(vertex.parameters[0] ** 2 + vertex.parameters[1] ** 2).toBeLessThan(1);
      expect(evaluator.point(vertex.parameters)).toEqual(vertex.point);
    }
    for (const radius of [0, 0.5, 0.9, 0.99, 0.999, 1]) for (let index = 0; index < 24; index++) {
      const angle = (index + 0.37) * Math.PI / 12;
      const point: Point = [radius * Math.cos(angle), radius * Math.sin(angle), Math.sqrt(Math.max(0, 1 - radius * radius))];
      expect(surfaceDistance(result, point)).toBeLessThanOrEqual(bound);
    }
  });

  it('作図の計算部の応答でも粗い精度の半球を期限内に返す', () => {
    const input = (text: string) => definition(text, ['X', 'Y']);
    const request = decodeFunctionSurfaceWorkRequest({ identity: { documentId: 'roots', documentVersion: 1, editorId: 'surface', inputRevision: 1 },
      independent: ['X', 'Y'], outputs: [input('X'), input('Y'), input('which(X^2+Y^2<1,sqrt(1-X^2-Y^2))')], lower: [-1.5, -1.5], upper: [1.5, 1.5],
      minimum: [-1.5, -1.5, -1], maximum: [1.5, 1.5, 1.5], tolerance: 0.2, coefficients: [], budget: { ...FUNCTION_SURFACE_LIMITS } });
    const reply = executeFunctionSurfaceWorkRequest(createFunctionSurfaceWorkEnvelope(1, request), backend);
    expect(reply.result.status).toBe('ready');
    if (reply.result.status === 'ready') expect(reply.result.maximumInterpolationErrorBound).toBeLessThanOrEqual(0.2);
  });
});

describe('明示した条件付きの範囲が根号の中を保証する場合（MC-22d）', () => {
  it('範囲 X^2<1 の sqrt(1-X^2) は同じ条件の場合分けと同じ半円になる', () => {
    const ranged = readyCurve(sampleFunctionCurve(curve('sqrt(1-X^2)'), { ...line(), domain: condition('X^2<1', ['X']) }));
    const which = readyCurve(sampleFunctionCurve(curve('which(X^2<1,sqrt(1-X^2))'), line()));
    expect(ranged.components).toEqual(which.components);
    expect(ranged.maximumChordErrorBound).toBe(which.maximumChordErrorBound);
  });

  it('範囲 X^2+Y^2<1 の sqrt(1-X^2-Y^2) は同じ条件の場合分けと同じ半球になる', () => {
    const options = square(0.2);
    const ranged = readySurface(sampleFunctionSurface(surface('sqrt(1-X^2-Y^2)'), { ...options, domain: condition('X^2+Y^2<1', ['X', 'Y']) }));
    const which = readySurface(sampleFunctionSurface(surface('which(X^2+Y^2<1,sqrt(1-X^2-Y^2))'), options));
    expect(ranged.vertices).toEqual(which.vertices);
    expect(ranged.triangles).toEqual(which.triangles);
    expect(ranged.maximumInterpolationErrorBound).toBe(which.maximumInterpolationErrorBound);
  });

  it('範囲が根号の中を保証しない場合は今どおり理由付きで断る', () => {
    const run = () => sampleFunctionCurve(curve('sqrt(X^2-1)'), { ...line(), domain: condition('X^2<1', ['X']) });
    expect(run).toThrow(MathInputProblem);
    expect(run).toThrow('条件を満たす範囲の境界');
  });
});

describe('条件が保証しない一部未定義の式は今どおり断る（MC-22d）', () => {
  it.each([
    ['条件の内側で根号の中が負になる', 'which(X^2<1,sqrt(0.5-X^2))'],
    ['条件の内側の薄い帯で根号の中が負になる', 'which(X^2<1,sqrt(0.9999999999-X^2))'],
    ['条件の外側だけで定義される', 'which(X^2<1,sqrt(X))'],
  ])('曲線: %s式は変更前と同じく分割しきれずに止まる', (_, source) => {
    expect(sampleFunctionCurve(curve(source), line())).toMatchObject({ status: 'stopped', reason: 'subdivision' });
  });
  it.each([
    ['根号の中が条件の内側で負', 'which(X^2<1,sqrt(X^2-1))', 'curve'],
    ['条件の内側の薄い帯で根号の中が負', 'which(X^2+Y^2<1,sqrt(0.9999999999-X^2-Y^2))', 'surface'],
    ['条件の外側だけで定義される', 'which(X^2+Y^2<1,sqrt(X))', 'surface'],
  ] as const)('%sの式は変更前と同じく理由付きで断る', (_, source, kind) => {
    const run = () => kind === 'curve' ? sampleFunctionCurve(curve(source), line()) : sampleFunctionSurface(surface(source), square(0.05));
    expect(run).toThrow(MathInputProblem);
    expect(run).toThrow('条件を満たす範囲の境界');
  });
});

/** Recorded with the samplers before MC-22d on the same inputs: status, stats and enclosure evaluations. */
describe('条件のない式と既存の経路の結果・評価の回数を変えない（MC-22d）', () => {
  function countedCurve(source: string) {
    const evaluator = curve(source), counts = { enclosure: 0 };
    const counted: FunctionCurveEvaluator = { ...evaluator, enclosure: (lower, upper) => { counts.enclosure++; return evaluator.enclosure(lower, upper); } };
    return { counts, counted };
  }
  function countedSurface(source: string) {
    const evaluator = surface(source), counts = { enclosure: 0 };
    const counted: FunctionSurfaceEvaluator = { ...evaluator, enclosure: (lower, upper) => { counts.enclosure++; return evaluator.enclosure(lower, upper); } };
    return { counts, counted };
  }
  it.each([
    ['sqrt(1-X^2)', { status: 'stopped', reason: 'subdivision', stats: { samples: 0, cells: 79 } }, 79],
    ['which(X<0,sqrt(-X),true,sqrt(X))', { status: 'stopped', reason: 'subdivision', stats: { samples: 42, cells: 84 } }, 166],
    ['which(X^2<1,sqrt(0.5-X^2))', { status: 'stopped', reason: 'subdivision', stats: { samples: 0, cells: 59 } }, 101],
    ['which(X^2<0.25,sqrt(1-X^2))', { status: 'ready', stats: { samples: 13, cells: 63 } }, 152],
    ['which(X^2<1,ln(1-X^2))', { status: 'ready', stats: { samples: 35, cells: 75 } }, 124],
  ] as const)('曲線 %s', (source, expected, enclosures) => {
    const { counts, counted } = countedCurve(source);
    expect(sampleFunctionCurve(counted, line())).toMatchObject(expected);
    expect(counts.enclosure).toBe(enclosures);
  });
  it.each([
    ['sqrt(X^2+Y^2+1)', { ...square(0.05), lower: [-1, -1], upper: [1, 1], minimum: [-1, -1, -3], maximum: [1, 1, 3] },
      { status: 'ready', stats: { samples: 145, cells: 85, triangles: 128 } }, 230],
    ['sqrt(1-X^2-Y^2)', square(0.05, 8), { status: 'stopped', reason: 'subdivision', stats: { samples: 0, cells: 16, triangles: 0 } }, 16],
    ['which(X^2+Y^2<1,X^2-Y^2)', square(0.05), { status: 'ready', stats: { samples: 4109, cells: 5493, triangles: 5170 } }, 12327],
    ['which(X^2+Y^2<1,sqrt(0.5-X^2-Y^2))', square(0.05), { status: 'stopped', reason: 'subdivision', stats: { samples: 0, cells: 38, triangles: 0 } }, 55],
  ] as const)('曲面 %s', (source, options, expected, enclosures) => {
    const { counts, counted } = countedSurface(source);
    expect(sampleFunctionSurface(counted, options)).toMatchObject(expected);
    expect(counts.enclosure).toBe(enclosures);
  });
});
