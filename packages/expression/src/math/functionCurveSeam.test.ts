import { beforeAll, describe, expect, it } from 'vitest';
import { createMathBackend } from './createMathBackend.js';
import type { MathExecutionBackend } from './mathWorkExecution.js';
import { createFunctionMathSource } from './functionMathSource.js';
import { createFunctionCurveWorkEnvelope, decodeFunctionCurveWorkRequest, type FunctionCurveWorkRequest } from './functionCurveWorkRequest.js';
import { executeFunctionCurveWorkRequest } from './functionCurveWorkExecution.js';
import { decodeFunctionCurveWorkReply } from './functionCurveWorkReply.js';
import { decodeCurvePointWorkRequest } from './curvePointWorkRequest.js';
import type { FunctionCurveSample } from './adaptiveFunctionCurve.js';
import { smoothFunctionCurve, type FunctionCurveSpline } from './smoothFunctionCurve.js';

type Point = readonly [number, number, number];
let backend: MathExecutionBackend;
beforeAll(() => { backend = createMathBackend(); });
type Coefficients = FunctionCurveWorkRequest['coefficients'];
const base: Coefficients = [{ id: 'w', label: 'w', decimal: '1' }];
const curveSource = (text: string, unit: 'degree' | 'radian', coefficients: Coefficients) =>
  createFunctionMathSource(text, 'text', unit, { axes: [], parameters: ['T'], coefficients }, backend);
const boundSource = (text: string, coefficients: Coefficients) =>
  createFunctionMathSource(text, 'text', 'radian', { axes: [], parameters: [], coefficients }, backend);
interface Loop { readonly x?: string; readonly y?: string; readonly z?: string; readonly lower?: readonly [string, number]; readonly upper?: readonly [string, number];
  readonly unit?: 'degree' | 'radian'; readonly coefficients?: Coefficients; readonly minimum?: Point; readonly maximum?: Point }
function loop(options: Loop = {}): FunctionCurveWorkRequest {
  const coefficients = options.coefficients ?? base, unit = options.unit ?? 'radian';
  const [lowerText, lower] = options.lower ?? ['0', 0], [upperText, upper] = options.upper ?? ['2*pi', 2 * Math.PI];
  return decodeFunctionCurveWorkRequest({ identity: { documentId: 'seam', documentVersion: 1, editorId: 'function', inputRevision: 1 },
    independent: 'T', lower, upper, minimum: options.minimum ?? [-2, -2, -2], maximum: options.maximum ?? [2, 2, 2], tolerance: 0.001, coefficients,
    outputs: [curveSource(options.x ?? 'cos(T)', unit, coefficients), curveSource(options.y ?? 'sin(T)', unit, coefficients), curveSource(options.z ?? '0', unit, coefficients)],
    parameterSources: { lower: boundSource(lowerText, coefficients), upper: boundSource(upperText, coefficients) } });
}
function run(request: FunctionCurveWorkRequest) {
  const reply = executeFunctionCurveWorkRequest(createFunctionCurveWorkEnvelope(3, request), backend);
  const decoded = decodeFunctionCurveWorkReply(reply, request);
  if (decoded.result.status !== 'ready') throw new Error(JSON.stringify(decoded.result));
  return { raw: reply, result: decoded.result };
}
const sameBits = (a: readonly number[], b: readonly number[]) => a.every((value, axis) => Object.is(value, b[axis]));
/** Independent plain-float end derivatives of the actual returned controls. */
function endSlopes(spline: FunctionCurveSpline): { start: Point; end: Point } {
  const { knots, poles } = spline, last = poles.length - 1, n = knots.length;
  const slope = (from: Point, to: Point, h: number): Point => [3 * (to[0] - from[0]) / h, 3 * (to[1] - from[1]) / h, 3 * (to[2] - from[2]) / h];
  return { start: slope(poles[0], poles[1], knots[1] - knots[0]), end: slope(poles[last - 1], poles[last], knots[n - 1] - knots[n - 2]) };
}

describe('原式から証明した周期の時だけ、標本取りの前に終点を始点と同じ点にし、継ぎ目の上限を実際の制御点から出す', () => {
  it.each([
    ['0..2π', {}],
    ['π/2..5π/2', { lower: ['pi/2', Math.PI / 2], upper: ['5*pi/2', 5 * Math.PI / 2] }],
    ['度の 0..360', { unit: 'degree', upper: ['360', 360] }],
    ['2周の 0..4π', { upper: ['4*pi', 4 * Math.PI] }],
  ] as const)('実際の cos(T), sin(T) の %s は1成分で両端が同じ2進数の点になり、継ぎ目の上限を持つ', (_label, options: Loop) => {
    const request = loop(options), { result } = run(request);
    expect(result.periodicity).toMatchObject({ status: 'proved' });
    expect(result.components).toHaveLength(1);
    const samples = result.components[0];
    expect(sameBits(samples[0].point, samples[samples.length - 1].point)).toBe(true);
    if (result.smooth?.seam === undefined) throw new Error('Expected a seam');
    const spline = result.smooth.splines[0], poles = spline.poles;
    // No post-certification snap: the end pole is the certified end sample itself.
    expect(sameBits(poles[poles.length - 1], samples[samples.length - 1].point)).toBe(true);
    expect(result.smooth.errorBound).toBeLessThanOrEqual(request.tolerance);
    // The shared end tangent makes the actual end derivatives nearly equal, and the bound covers their difference.
    const { start, end } = endSlopes(spline);
    const difference = Math.abs(end[0] - start[0]) + Math.abs(end[1] - start[1]) + Math.abs(end[2] - start[2]);
    expect(difference).toBeLessThanOrEqual(result.smooth.seam.tangentMismatch);
    expect(result.smooth.seam.tangentMismatch).toBeLessThan(1e-9 * Math.max(1, Math.hypot(...start)));
  });

  it('らせん・半周・XYZ範囲で分かれた円は開いたまま、継ぎ目も端点の同一化も無い', () => {
    const cases = [
      { request: loop({ z: 'T/(2*pi)' }), components: 1 },
      { request: loop({ upper: ['pi', Math.PI] }), components: 1 },
      { request: loop({ minimum: [-2, -0.5, -2] }), components: 2 },
    ];
    for (const { request, components } of cases) {
      const { result } = run(request);
      expect(result.components).toHaveLength(components);
      expect(result.smooth?.seam).toBeUndefined();
    }
    // The half turn's end is cos(pi) = -1, never moved onto the start.
    const half = run(loop({ upper: ['pi', Math.PI] })).result.components[0];
    expect(half[half.length - 1].point[0]).toBeCloseTo(-1, 12);
  });

  it('係数を変えると古い周期の意図は使えず、端点もそのまま', () => {
    const proved = run(loop({ x: 'cos(coef("w")*T)', y: 'sin(coef("w")*T)' })).result;
    expect(proved.periodicity).toMatchObject({ status: 'proved', turns: 1 });
    const changed = run(loop({ x: 'cos(coef("w")*T)', y: 'sin(coef("w")*T)', coefficients: [{ id: 'w', label: 'w', decimal: '1.5' }] })).result;
    expect(changed.periodicity).toEqual({ status: 'unproved', reason: 'not-whole-period' });
    expect(changed.smooth?.seam).toBeUndefined();
    const samples = changed.components[0];
    expect(samples[samples.length - 1].point[0]).toBeCloseTo(-1, 9); // cos(1.5 * 2 pi) = cos(3 pi)
  });

  it('作り物の継ぎ目・継ぎ目の欠落・開いた曲線への継ぎ目・余分な鍵を断る', () => {
    const request = loop(), { raw } = run(request), result = raw.result;
    if (result.status !== 'ready' || result.smooth?.seam === undefined) throw new Error('Expected a seam fixture');
    const smooth = result.smooth, seam = smooth.seam;
    if (seam === undefined) throw new Error('Expected a seam');
    const { seam: removed, ...withoutSeam } = smooth;
    expect(removed).toBe(seam);
    for (const forged of [
      { ...smooth, seam: { tangentMismatch: seam.tangentMismatch / 2 } },
      { ...smooth, seam: { tangentMismatch: seam.tangentMismatch + 1 } },
      { ...smooth, seam: { tangentMismatch: seam.tangentMismatch, closed: true } },
      { ...smooth, seam: { tangentMismatch: Number.NaN } },
      withoutSeam,
    ]) expect(() => decodeFunctionCurveWorkReply({ ...raw, result: { ...result, smooth: forged } }, request)).toThrow();
    const helix = loop({ z: 'T/(2*pi)' }), helixRaw = run(helix).raw, helixResult = helixRaw.result;
    if (helixResult.status !== 'ready' || helixResult.smooth === undefined) throw new Error('Expected a smooth helix');
    const helixSmooth = helixResult.smooth;
    expect(() => decodeFunctionCurveWorkReply({ ...helixRaw, result: { ...helixResult, smooth: { ...helixSmooth, seam } } }, helix)).toThrow();
  });

  it('曲線上の点の依頼は従来の項目のままで、T の範囲の原式は受け取らない', () => {
    const request = loop(), { parameterSources, ...plain } = request;
    expect(parameterSources).toBeDefined();
    const point = decodeCurvePointWorkRequest({ ...plain, kind: 'curve', known: [{ axis: 'X', value: 0.5 }] });
    expect(point).not.toHaveProperty('parameterSources');
    expect(() => decodeCurvePointWorkRequest({ ...request, kind: 'curve', known: [{ axis: 'X', value: 0.5 }] })).toThrow();
  });
});

describe('平滑化は、閉じた1成分だけ両端の接線と縮めの段を結ぶ', () => {
  const turns = [0, 0.3, 0.75, 1.2, 1.6, 2.1, 2.5, 3.0, 3.5, 3.9, 4.4, 4.8, 5.3, 5.8, 2 * Math.PI];
  const closed: FunctionCurveSample[] = turns.map((t, n) => ({ parameter: t, point: n === turns.length - 1 ? [1, 0, 0] : [Math.cos(t), Math.sin(t), 0] }));
  const chord = Math.max(...turns.slice(1).map((t, n) => (t - turns[n]) ** 2 / 8));

  it('periodicSeam では両端の実際の微分がほぼ一致し、無いときは片側の推定で食い違う', () => {
    const coupled = smoothFunctionCurve([closed], chord, 0.08, () => false, undefined, true);
    const open = smoothFunctionCurve([closed], chord, 0.08);
    if (coupled === null || open === null) throw new Error('Expected smooth curves');
    const gap = (spline: FunctionCurveSpline) => {
      const { start, end } = endSlopes(spline);
      return Math.hypot(end[0] - start[0], end[1] - start[1], end[2] - start[2]);
    };
    expect(gap(coupled.splines[0])).toBeLessThan(1e-12);
    expect(gap(open.splines[0])).toBeGreaterThan(1e-6);
    // The coupling never moves a sample or a pole that the position proof relies on.
    expect(coupled.splines[0].poles[0]).toEqual(closed[0].point);
    expect(coupled.errorBound).toBeLessThanOrEqual(0.08);
  });

  it('端点が同じ2進数の点でない・成分が2つなら、periodicSeam でも結ばない', () => {
    const shifted = closed.map((sample, n): FunctionCurveSample => (n === closed.length - 1 ? { ...sample, point: [1, -2.4492935982947064e-16, 0] } : sample));
    const unequal = smoothFunctionCurve([shifted], chord, 0.08, () => false, undefined, true);
    const plain = smoothFunctionCurve([shifted], chord, 0.08);
    expect(unequal).toEqual(plain);
    const halves = [closed.slice(0, 8), closed.slice(7)];
    expect(smoothFunctionCurve(halves, chord, 0.08, () => false, undefined, true)).toEqual(smoothFunctionCurve(halves, chord, 0.08));
  });
});
