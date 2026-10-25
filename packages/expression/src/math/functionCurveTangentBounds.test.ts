import { beforeAll, describe, expect, it } from 'vitest';
import { createMathBackend } from './createMathBackend.js';
import type { MathExecutionBackend } from './mathWorkExecution.js';
import { createFunctionMathSource } from './functionMathSource.js';
import { createFunctionCurveEvaluator } from './functionCurveEvaluation.js';
import type { FunctionCurveSample, FunctionCurveSamplingResult } from './adaptiveFunctionCurve.js';
import { attachSmoothFunctionCurve, smoothFunctionCurve, type FunctionCurveSpline, type SmoothFunctionCurve } from './smoothFunctionCurve.js';
import { certifyFunctionCurveTangents, finiteDerivativeEnclosure, type FunctionCurveDerivative,
  type FunctionCurveDerivativeEnclosure, type FunctionCurveTangents } from './functionCurveTangentBounds.js';
import { createFunctionCurveWorkEnvelope, type FunctionCurveWorkRequest } from './functionCurveWorkRequest.js';
import { executeFunctionCurveWorkRequest } from './functionCurveWorkExecution.js';
import { decodeFunctionCurveWorkReply } from './functionCurveWorkReply.js';

type Point = readonly [number, number, number];
let backend: MathExecutionBackend;
beforeAll(() => { backend = createMathBackend(); });
const coefficients = [{ id: 'scale', label: 'pi', decimal: '3' }];
const source = (text: string) => createFunctionMathSource(text, 'text', 'radian', { axes: ['X'], parameters: [], coefficients }, backend);
function curve(x: string, y: string, z: string) {
  return createFunctionCurveEvaluator([source(x), source(y), source(z)], 'X', coefficients, { backend, shouldStop: () => undefined });
}
function samples(parameters: readonly number[], at: (t: number) => Point): FunctionCurveSample[] {
  return parameters.map(parameter => ({ parameter, point: at(parameter) }));
}
function smoothed(parts: readonly (readonly FunctionCurveSample[])[], chord: number, tolerance: number, derivative: FunctionCurveDerivative) {
  const result = smoothFunctionCurve(parts, chord, tolerance, () => false, derivative);
  if (result === null || result.tangents === undefined) throw new Error('Expected a certified smooth curve');
  return { curve: result, tangents: result.tangents };
}
function enclosuresOf(spline: FunctionCurveSpline, derivative: FunctionCurveDerivative): (FunctionCurveDerivativeEnclosure | null)[] {
  return spline.knots.slice(1).map((upper, n) => finiteDerivativeEnclosure(derivative(spline.knots[n], upper)));
}
function certify(spline: FunctionCurveSpline, derivative: FunctionCurveDerivative): FunctionCurveTangents {
  const result = certifyFunctionCurveTangents([spline], [enclosuresOf(spline, derivative)]);
  if (result === null) throw new Error('Expected a certificate');
  return result;
}
/** Independent derivative of a span: the documented pole layout, then the derivative of the cubic Bezier. */
function slopeAt(spline: FunctionCurveSpline, span: number, u: number): Point {
  const { knots, poles } = spline;
  const junction = (node: number): Point => {
    if (node === 0) return poles[0];
    if (node === knots.length - 1) return poles[poles.length - 1];
    const share = (knots[node] - knots[node - 1]) / (knots[node + 1] - knots[node - 1]), a = poles[2 * node], b = poles[2 * node + 1];
    return [a[0] + (b[0] - a[0]) * share, a[1] + (b[1] - a[1]) * share, a[2] + (b[2] - a[2]) * share];
  };
  const q = [junction(span), poles[2 * span + 1], poles[2 * span + 2], junction(span + 1)];
  const h = knots[span + 1] - knots[span], w = [(1 - u) ** 2, 2 * u * (1 - u), u * u];
  const axis = (k: number) => 3 * (w[0] * (q[1][k] - q[0][k]) + w[1] * (q[2][k] - q[1][k]) + w[2] * (q[3][k] - q[2][k])) / h;
  return [axis(0), axis(1), axis(2)];
}
const norm = (v: Point) => Math.hypot(v[0], v[1], v[2]);
const unit = (v: Point): Point => [v[0] / norm(v), v[1] / norm(v), v[2] / norm(v)];
const gap = (a: Point, b: Point) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

describe('実際の3次の制御点と区間の微分から、外向きの演算で接線を証明する', () => {
  it('解析的な直線: 不等間隔の節点でも全区間が正則で、E は丸めだけ、m は f′=(1,2,−1) の最大成分 2', () => {
    const line = curve('X', '2*X+1', '-X');
    const { tangents } = smoothed([samples([-1, -0.3, 0.4, 2], t => [t, 2 * t + 1, -t])], 0, 1e-6, line.derivative);
    expect(tangents).toMatchObject({ regularSpans: 3, unresolvedSpans: 0, refinableSpans: 0 });
    expect(tangents.maximumError ?? Infinity).toBeLessThanOrEqual(1e-12);
    expect(tangents.minimumLower ?? 0).toBeGreaterThan(2 - 1e-12); expect(tangents.minimumLower ?? Infinity).toBeLessThanOrEqual(2);
    expect(tangents.maximumUnitTangent ?? Infinity).toBeLessThanOrEqual(1e-12);
  });

  it('実際の制御点から計算する: 内側の極を δ 動かすと、E は少なくとも 3δ/h になる', () => {
    const line = curve('X', '2*X+1', '-X');
    const { curve: result } = smoothed([samples([-1, -0.3, 0.4, 2], t => [t, 2 * t + 1, -t])], 0, 1e-6, line.derivative);
    const spline = result.splines[0], delta = 1e-3;
    const moved: FunctionCurveSpline = { knots: spline.knots, poles: spline.poles.map((pole, n): Point => (n === 1 ? [pole[0], pole[1] + delta, pole[2]] : pole)) };
    expect(certify(moved, line.derivative).maximumError ?? 0).toBeGreaterThanOrEqual(3 * delta / 0.7 - 1e-12);
  });

  it('不等間隔の円弧: 全区間が正則で、密な点で測った接線と単位接線の差は証明した上限以下', () => {
    const arc = curve('cos(X)', 'sin(X)', '0');
    const parameters = [0, 0.05, 0.12, 0.2, 0.27, 0.35, 0.42, 0.5];
    const chord = Math.max(...parameters.slice(1).map((t, n) => (t - parameters[n]) ** 2 / 8));
    const { curve: result, tangents } = smoothed([samples(parameters, t => [Math.cos(t), Math.sin(t), 0])], chord, 0.01, arc.derivative);
    expect(tangents).toMatchObject({ regularSpans: parameters.length - 1, unresolvedSpans: 0, refinableSpans: 0 });
    const spline = result.splines[0];
    let slopeGap = 0, unitGap = 0;
    for (let span = 0; span < parameters.length - 1; span++) for (let step = 0; step <= 32; step++) {
      const u = step / 32, t = parameters[span] + (parameters[span + 1] - parameters[span]) * u;
      const s = slopeAt(spline, span, u), f: Point = [-Math.sin(t), Math.cos(t), 0];
      slopeGap = Math.max(slopeGap, gap(s, f)); unitGap = Math.max(unitGap, gap(unit(s), unit(f)));
    }
    expect(slopeGap).toBeLessThanOrEqual(tangents.maximumError ?? -1);
    expect(unitGap).toBeLessThanOrEqual(tangents.maximumUnitTangent ?? -1);
  });

  it('尖点 (t³, t²): f′(0)=0 なので 0 を含む区間は正則にも細分の候補にもならず、G1 を主張しない', () => {
    const cusp = curve('X^3', 'X^2', '0');
    const { tangents } = smoothed([samples([-0.25, 0, 0.25], t => [t ** 3, t ** 2, 0])], 0, 10, cusp.derivative);
    expect(tangents).toMatchObject({ regularSpans: 0, unresolvedSpans: 2, refinableSpans: 0, maximumError: null, maximumUnitTangent: null });
  });

  it('不連続 floor(X) をまたぐ区間は微分が未解決で、正則にも細分の候補にもならない', () => {
    const step = curve('X', 'floor(X)', '0');
    expect(step.derivative(-0.2, 0.3)[1]).toBeNull();
    const { tangents } = smoothed([samples([-0.2, 0.3], t => [t, Math.floor(t), 0])], 0, 10, step.derivative);
    expect(tangents).toMatchObject({ regularSpans: 0, unresolvedSpans: 1, refinableSpans: 0 });
  });

  it('標本の折り返し: 0, 1/2, 1 で位置も微分も一致しても、区間全体の上限は実際の最大 0.01π 以上', () => {
    // f(t) = (t, 0.01 sin^2(pi t), 0) and the straight cubic S(t) = (t, 0, 0) on [0, 1].
    const wave = curve('X', '0.01*sin(pi*X)^2', '0');
    const straight: FunctionCurveSpline = { knots: [0, 1], poles: [[0, 0, 0], [1 / 3, 0, 0], [2 / 3, 0, 0], [1, 0, 0]] };
    const slope = (t: number): Point => [1, 0.01 * Math.PI * Math.sin(2 * Math.PI * t), 0];
    for (const t of [0, 0.5, 1]) expect(gap(slopeAt(straight, 0, t), slope(t))).toBeLessThanOrEqual(1e-15);
    const tangents = certify(straight, wave.derivative);
    expect(tangents).toMatchObject({ regularSpans: 1, unresolvedSpans: 0 });
    expect(tangents.maximumError ?? 0).toBeGreaterThanOrEqual(0.01 * Math.PI);
    expect(tangents.maximumUnitTangent ?? 0).toBeGreaterThanOrEqual(gap(unit(slopeAt(straight, 0, 0.25)), unit(slope(0.25))));
  });

  it('区間数・成分数の食い違いは確保前に断る', () => {
    const line = curve('X', '2*X+1', '-X');
    const spline: FunctionCurveSpline = { knots: [0, 1], poles: [[0, 1, 0], [1 / 3, 5 / 3, -1 / 3], [2 / 3, 7 / 3, -2 / 3], [1, 3, -1]] };
    expect(() => certifyFunctionCurveTangents([spline], [])).toThrow(RangeError);
    expect(() => certifyFunctionCurveTangents([spline], [[...enclosuresOf(spline, line.derivative), null]])).toThrow(RangeError);
    expect(certifyFunctionCurveTangents([spline], [enclosuresOf(spline, line.derivative)], () => true)).toBeNull();
  });
});

describe('証明できない正則な区間は1回だけ細かくし、だめなら正直に印を付けて残す', () => {
  // f(t) = (t, (1 - cos(pi t)) / 2, 0) through (0,0), (1,1), (2,0), (3,1): x' = 1, |f''| <= pi^2/2, chord h^2 (pi^2/2) / 8 <= 0.62.
  const wave = (t: number): Point => [t, (1 - Math.cos(Math.PI * t)) / 2, 0];
  const stats = { samples: 4, cells: 4 };
  const coarse = samples([0, 1, 2, 3], wave);
  const tight: FunctionCurveSamplingResult = { status: 'ready', components: [coarse], maximumChordErrorBound: 0.62, stats };
  const fine = samples(Array.from({ length: 31 }, (_, n) => n / 10), wave);
  const finer: FunctionCurveSamplingResult = { status: 'ready', components: [fine], maximumChordErrorBound: 0.0062, stats };
  const tangentsOf = (curve: SmoothFunctionCurve | undefined) => {
    if (curve?.tangents === undefined) throw new Error('Expected a tangent certificate');
    return curve.tangents;
  };

  it('角のある粗い曲線は細分の候補になり、細かい結果が全区間を証明すればそれを採用する', () => {
    const derivative = curve('X', '(1-cos(pi*X))/2', '0').derivative;
    const first = smoothFunctionCurve([coarse], 0.62, 0.63, () => false, derivative);
    expect(first?.cornerNodes ?? 0).toBeGreaterThan(0);
    expect(tangentsOf(first ?? undefined).refinableSpans).toBeGreaterThan(0);
    let calls = 0;
    const result = attachSmoothFunctionCurve(tight, 0.63, tolerance => { calls++; expect(tolerance).toBe(0.315); return finer; },
      { stop: () => undefined, derivative });
    expect(calls).toBe(1);
    if (result.status !== 'ready') throw new Error('Expected ready');
    expect(result.components).toEqual([fine]);
    expect(tangentsOf(result.smooth)).toMatchObject({ refinableSpans: 0, unresolvedSpans: 0, regularSpans: fine.length - 1 });
  });

  it('細かくできなければ緩い許容差の曲線を断らず、証明できない区間を明示したまま返す', () => {
    const derivative = curve('X', '(1-cos(pi*X))/2', '0').derivative;
    const result = attachSmoothFunctionCurve(tight, 0.63, () => ({ status: 'stopped', reason: 'samples', stats }), { stop: () => undefined, derivative });
    if (result.status !== 'ready') throw new Error('Expected ready');
    expect(result.components).toEqual([coarse]);
    const tangents = tangentsOf(result.smooth);
    expect(tangents.refinableSpans).toBeGreaterThan(0); expect(tangents.regularSpans).toBeLessThan(coarse.length - 1);
  });

  it('全区間が証明できた結果は取り直さない', () => {
    const line = curve('X', '2*X+1', '-X');
    const ready: FunctionCurveSamplingResult = { status: 'ready', components: [samples([-1, -0.3, 0.4, 2], t => [t, 2 * t + 1, -t])],
      maximumChordErrorBound: 0, stats };
    let calls = 0;
    const result = attachSmoothFunctionCurve(ready, 1e-6, () => { calls++; return finer; }, { stop: () => undefined, derivative: line.derivative });
    expect(calls).toBe(0);
    if (result.status !== 'ready') throw new Error('Expected ready');
    expect(tangentsOf(result.smooth)).toMatchObject({ regularSpans: 3, refinableSpans: 0 });
  });
});

describe('計算部の返事で接線の証明を運び、復号が計算し直して照合する', () => {
  function request(): FunctionCurveWorkRequest {
    return { identity: { documentId: 'part', documentVersion: 7, editorId: 'function', inputRevision: 2 }, independent: 'X',
      outputs: [source('X'), source('sin(3*X)'), source('0')], lower: -1, upper: 1,
      minimum: [-1, -2, -1], maximum: [1, 2, 1], tolerance: 0.01, coefficients };
  }

  it('実際の Worker の返事は証明を持ち、復号した証明は区間の数と一致する', () => {
    const input = request();
    const reply = decodeFunctionCurveWorkReply(executeFunctionCurveWorkRequest(createFunctionCurveWorkEnvelope(5, input), backend), input);
    if (reply.result.status !== 'ready' || reply.result.smooth === undefined) throw new Error(JSON.stringify(reply.result));
    const { smooth } = reply.result, spans = smooth.splines.reduce((sum, spline) => sum + spline.knots.length - 1, 0);
    expect(smooth.tangents).toBeDefined();
    expect((smooth.tangents?.regularSpans ?? -1) + (smooth.tangents?.unresolvedSpans ?? -1)).toBe(spans);
  });

  it('作り物・非有限・食い違い・余分な鍵の証明を断る', () => {
    const input = request(), reply = executeFunctionCurveWorkRequest(createFunctionCurveWorkEnvelope(6, input), backend);
    const result = reply.result;
    if (result.status !== 'ready' || result.smooth?.tangents === undefined) throw new Error('Expected a certified smooth fixture');
    const smooth = result.smooth, tangents = smooth.tangents;
    if (tangents === undefined) throw new Error('Expected tangents');
    const firstSpan = tangents.enclosures[0].findIndex(entry => entry !== null);
    const widened = tangents.enclosures.map((spans, index) => index !== 0 ? spans : spans.map((entry, n) => (n !== firstSpan || entry === null ? entry
      : [{ lower: entry[0].lower - 1, upper: entry[0].upper }, entry[1], entry[2]])));
    const bad = [
      { ...tangents, maximumError: tangents.maximumError === null ? 1 : tangents.maximumError / 2 },
      { ...tangents, regularSpans: tangents.regularSpans + 1 },
      { ...tangents, refinableSpans: tangents.refinableSpans + 1 },
      { ...tangents, maximumUnitTangent: Number.NaN },
      { ...tangents, minimumLower: Infinity },
      { ...tangents, enclosures: widened },
      { ...tangents, enclosures: [] },
      { ...tangents, enclosures: [[...tangents.enclosures[0], null]] },
      { ...tangents, enclosures: [tangents.enclosures[0].map(entry => entry === null ? null : [{ lower: 1, upper: 0 }, entry[1], entry[2]])] },
      { ...tangents, angleTolerance: 0.1 },
    ];
    for (const certificate of bad) {
      expect(() => decodeFunctionCurveWorkReply({ ...reply, result: { ...result, smooth: { ...smooth, tangents: certificate } } }, input)).toThrow();
    }
    // Without a certificate the reply stays valid: the field is additive and makes no claim when absent.
    const { tangents: _omitted, ...withoutTangents } = smooth;
    expect(_omitted).toBe(tangents);
    expect(decodeFunctionCurveWorkReply({ ...reply, result: { ...result, smooth: withoutTangents } }, input).result).toMatchObject({ status: 'ready' });
    expect(decodeFunctionCurveWorkReply(reply, input).result).toMatchObject({ status: 'ready' });
  });
});
