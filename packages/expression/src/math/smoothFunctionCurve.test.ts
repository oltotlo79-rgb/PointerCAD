import { describe, expect, it } from 'vitest';
import { intervalUnion, unionMap } from './mathIntervalUnion.js';
import { trigonometricInterval } from './trigonometricIntervals.js';
import { sampleFunctionCurve, type FunctionCurveEvaluator, type FunctionCurveSample } from './adaptiveFunctionCurve.js';
import { attachSmoothFunctionCurve, cubicChordDeviation, FUNCTION_CURVE_SPLINE_POLE_LIMIT, junctionDiscrepancy, smoothFunctionCurve,
  type FunctionCurveSpline, type SmoothSamplingControl } from './smoothFunctionCurve.js';
import type { FunctionCurveSamplingResult } from './adaptiveFunctionCurve.js';
import { MathInputProblem } from './mathInputContract.js';
import { MathDeadlineExceeded } from './mathWorkExecution.js';

type Point = readonly [number, number, number];

/** Independent evaluation: Bezier form of span `index` from the documented pole layout, then de Casteljau. */
function spanPoint(spline: FunctionCurveSpline, index: number, u: number): Point {
  const { knots, poles } = spline;
  const junction = (node: number): Point => {
    if (node === 0) return poles[0];
    if (node === knots.length - 1) return poles[poles.length - 1];
    const left = knots[node] - knots[node - 1], right = knots[node + 1] - knots[node], share = left / (left + right);
    const a = poles[2 * node], b = poles[2 * node + 1];
    return [a[0] + (b[0] - a[0]) * share, a[1] + (b[1] - a[1]) * share, a[2] + (b[2] - a[2]) * share];
  };
  const b = [junction(index), poles[2 * index + 1], poles[2 * index + 2], junction(index + 1)];
  const weights = [(1 - u) ** 3, 3 * u * (1 - u) ** 2, 3 * u * u * (1 - u), u ** 3];
  const coordinate = (axis: number) => b.reduce((sum, pole, k) => sum + pole[axis] * weights[k], 0);
  return [coordinate(0), coordinate(1), coordinate(2)];
}
/** Distance from a point to the unit helix by Newton's method on (c(t) - p) . c'(t) = 0, started at t = z. */
function helixDistance(point: Point): number {
  let t = point[2];
  for (let iteration = 0; iteration < 12; iteration++) {
    const dx = Math.cos(t) - point[0], dy = Math.sin(t) - point[1], dz = t - point[2];
    const g = -dx * Math.sin(t) + dy * Math.cos(t) + dz;
    const slope = 2 + (-dx * Math.cos(t) - dy * Math.sin(t));
    t -= g / slope;
  }
  return Math.hypot(point[0] - Math.cos(t), point[1] - Math.sin(t), point[2] - t);
}
function denseSmooth(spline: FunctionCurveSpline, steps = 24): Point[] {
  const points: Point[] = [];
  for (let span = 0; span < spline.knots.length - 1; span++) for (let step = 0; step <= steps; step++) points.push(spanPoint(spline, span, step / steps));
  return points;
}
const options = { lower: 0, upper: 2 * Math.PI, minimum: [-2, -2, -1] as Point, maximum: [2, 2, 7] as Point, tolerance: 1e-3,
  maximumSamples: 20_000, maximumCells: 40_000, maximumDepth: 40 };
/** Helix with a proved chord bound |c''| h^2 / 8, |c''| = 1 (unit radius). */
const helix: FunctionCurveEvaluator = {
  point: t => [Math.cos(t), Math.sin(t), t],
  enclosure: (a, b) => {
    const parameter = intervalUnion(a, b);
    // Directed Taylor bounds include extrema and roundoff, and shrink at singleton parameters.
    return [unionMap(parameter, range => trigonometricInterval(range, true, false)),
      unionMap(parameter, range => trigonometricInterval(range, false, false)), parameter];
  },
  chordErrorBound: (a, b) => (b - a) ** 2 / 8,
};
function ready(result: ReturnType<typeof sampleFunctionCurve>) {
  if (result.status !== 'ready') throw new Error(JSON.stringify(result));
  return result;
}

describe('証明付きの滑らかな関数曲線（C1の3次、不等間隔の媒介変数）', () => {
  it('螺旋の区間は負の媒介変数・端点・極値を含み、単一点では評価誤差だけに縮む', () => {
    const intervals = [[0, 0], [-0.3, -0.3], [2 * Math.PI, 2 * Math.PI], [-0.2, 0.3],
      [-Math.PI - 0.1, -Math.PI + 0.1], [-Math.PI / 2 - 0.1, -Math.PI / 2 + 0.1],
      [Math.PI / 2 - 0.1, Math.PI / 2 + 0.1], [0, 2 * Math.PI]];
    for (const [a, b] of intervals) {
      const enclosed = helix.enclosure(a, b);
      for (let axis = 0; axis < 3; axis++) {
        const value = enclosed[axis];
        expect(value.continuous).toBe(true); expect(value.ranges).toHaveLength(1);
        const [range] = value.ranges;
        for (let step = 0; step <= 32; step++) {
          const t = step === 32 ? b : a + (b - a) * step / 32;
          const point = [Math.cos(t), Math.sin(t), t];
          expect(point[axis]).toBeGreaterThanOrEqual(range.lower);
          expect(point[axis]).toBeLessThanOrEqual(range.upper);
        }
        if (a === b) expect(range.upper - range.lower).toBeLessThan(1e-10);
      }
    }
    // Independent exact extrema, rather than relying on floating-point samples to land on them.
    const extrema = [
      { a: -0.1, b: 0.1, axis: 0, value: 1 },
      { a: -Math.PI - 0.1, b: -Math.PI + 0.1, axis: 0, value: -1 },
      { a: -Math.PI / 2 - 0.1, b: -Math.PI / 2 + 0.1, axis: 1, value: -1 },
      { a: Math.PI / 2 - 0.1, b: Math.PI / 2 + 0.1, axis: 1, value: 1 },
    ];
    for (const { a, b, axis, value } of extrema) {
      const [range] = helix.enclosure(a, b)[axis].ranges;
      expect(value).toBeGreaterThanOrEqual(range.lower); expect(value).toBeLessThanOrEqual(range.upper);
    }
  });

  it('螺旋は全標本を通る1本のC1曲線になり、密な点の半径と高さの誤差が証明した上限以内', () => {
    const sampled = ready(sampleFunctionCurve(helix, { ...options, tolerance: options.tolerance / 2 }));
    const smooth = smoothFunctionCurve(sampled.components, sampled.maximumChordErrorBound, options.tolerance);
    if (smooth === null) throw new Error('Expected a smooth curve');
    expect(smooth.splines).toHaveLength(1);
    const [spline] = smooth.splines, samples = sampled.components[0];
    expect(spline.knots).toEqual(samples.map(sample => sample.parameter));
    expect(spline.poles).toHaveLength(2 * samples.length);
    expect(smooth.errorBound).toBeLessThanOrEqual(options.tolerance);
    expect(smooth.cornerNodes).toBe(0);
    // Nonuniform: the adaptive parameters are not equally spaced in general; the curve must still pass every sample.
    for (let node = 0; node < samples.length - 1; node++) {
      const start = spanPoint(spline, node, 0);
      start.forEach((value, axis) => expect(Math.abs(value - samples[node].point[axis])).toBeLessThanOrEqual(1e-12));
    }
    // Sampled numerical check (not the proof): the distance to the analytic helix at dense points stays within the bound.
    for (const point of denseSmooth(spline)) {
      expect(Math.abs(Math.hypot(point[0], point[1]) - 1)).toBeLessThanOrEqual(smooth.errorBound);
      expect(helixDistance(point)).toBeLessThanOrEqual(smooth.errorBound);
    }
  });

  it('C1は節点の左右の微分（極の差÷区間幅）が一致することで確かめ、C2は主張しない', () => {
    const sampled = ready(sampleFunctionCurve(helix, { ...options, tolerance: options.tolerance / 2 }));
    const smooth = smoothFunctionCurve(sampled.components, sampled.maximumChordErrorBound, options.tolerance);
    if (smooth === null) throw new Error('Expected a smooth curve');
    const { knots, poles } = smooth.splines[0];
    let secondJump = 0;
    for (let node = 1; node < knots.length - 1; node++) {
      const left = knots[node] - knots[node - 1], right = knots[node + 1] - knots[node];
      const junction = spanPoint(smooth.splines[0], node, 0);
      for (let axis = 0; axis < 3; axis++) {
        const before = 3 * (junction[axis] - poles[2 * node][axis]) / left, after = 3 * (poles[2 * node + 1][axis] - junction[axis]) / right;
        expect(Math.abs(before - after)).toBeLessThanOrEqual(1e-8 * Math.max(1, Math.abs(before)));
        const secondBefore = 6 * (junction[axis] - 2 * poles[2 * node][axis] + poles[2 * node - 1][axis]) / left ** 2;
        const secondAfter = 6 * (junction[axis] - 2 * poles[2 * node + 1][axis] + poles[2 * node + 2][axis]) / right ** 2;
        secondJump = Math.max(secondJump, Math.abs(secondBefore - secondAfter));
      }
    }
    // The construction is C1 only; the second derivative generally jumps at nodes.
    expect(secondJump).toBeGreaterThan(0);
  });

  /**
   * Parabola c(t) = (t, t^2, 0): |c''| = 2, so each chord is within h^2/4 of its arc (h^2 |c''| / 8). The largest
   * gap is 0.65, so the independent chord bound is 0.65^2/4. Each full-tangent span is within h^2/4 of its chord too.
   */
  const parabolaParameters = [-1, -0.7, -0.05, 0.1, 0.55, 1];
  const parabolaSamples: FunctionCurveSample[] = parabolaParameters.map(t => ({ parameter: t, point: [t, t * t, 0] }));
  const parabolaChord = Math.max(...parabolaParameters.slice(1).map((t, n) => (t - parabolaParameters[n]) ** 2 / 4));

  it('不等間隔の放物線は、正しい弦の上限と足りる精度なら3点の接線が厳密で、曲線そのものを再現する', () => {
    // Needs chord bound + span bound <= tolerance: 2 * 0.65^2/4 = 0.21125 <= 0.25.
    const smooth = smoothFunctionCurve([parabolaSamples], parabolaChord, 0.25);
    if (smooth === null) throw new Error('Expected a smooth curve');
    expect(smooth.reducedNodes + smooth.cornerNodes).toBe(0);
    expect(smooth.errorBound).toBeLessThanOrEqual(0.25);
    for (const point of denseSmooth(smooth.splines[0])) expect(Math.abs(point[1] - point[0] * point[0])).toBeLessThanOrEqual(1e-12);
  });

  it('同じ標本でも精度の余裕が足りなければ接線を縮め、証明した上限を精度以内に保つ', () => {
    const tolerance = parabolaChord + 0.02;
    const smooth = smoothFunctionCurve([parabolaSamples], parabolaChord, tolerance);
    if (smooth === null) throw new Error('Expected a bounded curve');
    expect(smooth.reducedNodes + smooth.cornerNodes).toBeGreaterThan(0);
    expect(smooth.errorBound).toBeLessThanOrEqual(tolerance);
    // Sampled check, not the proof: every dense point is within the bound of the analytic parabola.
    for (const point of denseSmooth(smooth.splines[0])) {
      let t = point[0];
      for (let iteration = 0; iteration < 20; iteration++) {
        const gap = t * t - point[1];
        t -= ((t - point[0]) + 2 * t * gap) / (1 + 4 * t * t + 2 * gap);
      }
      expect(Math.hypot(t - point[0], t * t - point[1])).toBeLessThanOrEqual(smooth.errorBound);
    }
  });

  it('内部の接合点が標本からずれた極の組は、別の曲線として断る（不等間隔）', () => {
    const smooth = smoothFunctionCurve([parabolaSamples], parabolaChord, 0.25);
    if (smooth === null) throw new Error('Expected a smooth curve');
    const { knots, poles } = smooth.splines[0], points = parabolaSamples.map(sample => sample.point);
    expect(junctionDiscrepancy(knots, poles, points)).not.toBeNull();
    const moved = poles.map((pole, n): Point => (n === 5 ? [pole[0], pole[1] + 1e-9, pole[2]] : pole));
    expect(junctionDiscrepancy(knots, moved, points)).toBeNull();
  });

  it('成分を結ばず、成分ごとに独立した節点範囲の曲線を返す', () => {
    const left: FunctionCurveSample[] = [-2, -1.5, -1].map(t => ({ parameter: t, point: [t, 1 / t, 0] }));
    const right: FunctionCurveSample[] = [1, 1.5, 2].map(t => ({ parameter: t, point: [t, 1 / t, 0] }));
    const smooth = smoothFunctionCurve([left, right], 0, 0.5);
    if (smooth === null) throw new Error('Expected a smooth curve');
    expect(smooth.splines.map(spline => [spline.knots[0], spline.knots.at(-1)])).toEqual([[-2, -1], [1, 2]]);
    expect(smooth.splines[0].poles.at(-1)).toEqual(left[2].point); expect(smooth.splines[1].poles[0]).toEqual(right[0].point);
  });

  it('余裕が無い区間は接線を縮め、0なら節点に角を残して上限を守る（G1は主張しない）', () => {
    const samples: FunctionCurveSample[] = [0, 1, 2, 3].map(t => ({ parameter: t, point: [t, t % 2, 0] }));
    const smooth = smoothFunctionCurve([samples], 0.009, 0.01);
    if (smooth === null) throw new Error('Expected a bounded curve');
    expect(smooth.errorBound).toBeLessThanOrEqual(0.01);
    expect(smooth.cornerNodes).toBeGreaterThan(0);
    // At a corner node both neighbouring poles equal the sample itself.
    const { poles } = smooth.splines[0];
    expect(poles[2]).toEqual(samples[1].point); expect(poles[3]).toEqual(samples[1].point);
  });

  it('凸包と媒介の2つの上限は、密な点で測った実際のずれ以上になる', () => {
    const cases: Point[][] = [[[0, 0, 0], [1 / 3, 0.2, 0], [2 / 3, 0.2, 0], [1, 0, 0]], [[0, 0, 0], [0.9, 0.3, 0.1], [0.1, -0.4, 0], [1, 0, 0]],
      [[0, 0, 0], [-0.5, 0.1, 0], [1.5, 0.1, 0], [1, 0, 0]]];
    for (const [p0, p1, p2, p3] of cases) {
      let worst = 0;
      for (let step = 0; step <= 2000; step++) {
        const u = step / 2000, w = [(1 - u) ** 3, 3 * u * (1 - u) ** 2, 3 * u * u * (1 - u), u ** 3];
        const point = [0, 1, 2].map(axis => w[0] * p0[axis] + w[1] * p1[axis] + w[2] * p2[axis] + w[3] * p3[axis]);
        const along = Math.min(1, Math.max(0, point[0]));
        worst = Math.max(worst, Math.hypot(point[0] - along, point[1], point[2]));
      }
      expect(cubicChordDeviation(p0, p1, p2, p3)).toBeGreaterThanOrEqual(worst);
    }
  });

  it('制御点の上限・中止・不正な誤差を断り、折れ線へ戻せる（nullを返す）', () => {
    const samples: FunctionCurveSample[] = [0, 1, 2].map(t => ({ parameter: t, point: [t, 0, 0] }));
    expect(smoothFunctionCurve([samples], 0, 0.1, () => true)).toBeNull();
    expect(smoothFunctionCurve([samples], 0.2, 0.1)).toBeNull();
    const many = Array.from({ length: FUNCTION_CURVE_SPLINE_POLE_LIMIT / 2 + 1 }, (_, n): FunctionCurveSample => ({ parameter: n, point: [n, 0, 0] }));
    expect(smoothFunctionCurve([many], 0, 0.1)).toBeNull();
  });
});

describe('成功した曲線は計算速度によらず同じ形状になり、共通期限と中止を守る', () => {
  const stats = { samples: 4, cells: 4 };
  const zigzag: FunctionCurveSample[] = [0, 1, 2, 3].map(t => ({ parameter: t, point: [t, t % 2, 0] }));
  /** Full run with no slack: smoothing must shorten tangents, so a finer run would be considered. */
  const tight: FunctionCurveSamplingResult = { status: 'ready', components: [zigzag], maximumChordErrorBound: 0.01, stats };
  const arc: FunctionCurveSample[] = [0, 0.1, 0.2, 0.3].map(t => ({ parameter: t, point: [Math.cos(t), Math.sin(t), 0] }));
  const roomy: FunctionCurveSamplingResult = { status: 'ready', components: [arc], maximumChordErrorBound: 0.0013, stats };
  // Keep the old clock fields in the test input: the old implementation must fail because it chooses
  // geometry by fullRunMs, not because a missing legacy field produces NaN. Production uses only stop.
  type Clock = SmoothSamplingControl & {
    readonly now: () => number; readonly startedAt: number; readonly totalCapMs: number; readonly fullRunMs: number;
  };
  function control(overrides: Partial<Clock> = {}): Clock {
    const timing = { now: () => 0, startedAt: 0, totalCapMs: 2000, fullRunMs: 10, ...overrides };
    return { ...timing, stop: () => overrides.stop?.()
      ?? (timing.now() - timing.startedAt >= timing.totalCapMs ? 'deadline' : undefined) };
  }

  it('余裕のある結果には再標本を行わない', () => {
    let calls = 0;
    const result = attachSmoothFunctionCurve(roomy, 0.01, () => { calls++; return tight; }, control());
    expect(calls).toBe(0); expect(result).toMatchObject({ status: 'ready', components: roomy.components });
    expect(result).toHaveProperty('smooth');
  });

  it('細かい再標本が予算切れ・入力の問題なら元の結果をそのまま返し、それ以外の例外は隠さない', () => {
    const tolerances: number[] = [];
    const exhausted = attachSmoothFunctionCurve(tight, 0.01, tolerance => {
      tolerances.push(tolerance); return { status: 'stopped', reason: 'samples', stats };
    }, control());
    expect(tolerances).toEqual([0.005]);
    expect(exhausted).toMatchObject({ status: 'ready', components: tight.components, maximumChordErrorBound: 0.01 });
    const problem = attachSmoothFunctionCurve(tight, 0.01, () => { throw new MathInputProblem('domain', 'boundary'); }, control());
    expect(problem).toMatchObject({ status: 'ready', components: tight.components });
    expect(() => attachSmoothFunctionCurve(tight, 0.01, () => { throw new Error('defect'); }, control())).toThrow('defect');
  });

  it('中止中・共通期限に達した時は再標本を始めず、readyへの降格をしない', () => {
    let calls = 0;
    const counted = () => { calls++; return tight; };
    expect(attachSmoothFunctionCurve(tight, 0.01, counted, control({ stop: () => 'cancelled' })))
      .toMatchObject({ status: 'stopped', reason: 'cancelled', stats });
    expect(attachSmoothFunctionCurve(tight, 0.01, counted, control({ now: () => 2000 })))
      .toMatchObject({ status: 'stopped', reason: 'deadline', stats });
    expect(calls).toBe(0);
    let clock = 1998;
    const result = attachSmoothFunctionCurve(tight, 0.01, (_tolerance, stop) => {
      while (stop() === undefined) clock += 1;
      return { status: 'stopped', reason: 'deadline', stats };
    }, control({ now: () => clock }));
    expect(clock).toBe(2000);
    expect(result).toMatchObject({ status: 'stopped', reason: 'deadline', stats });
    expect(result).not.toHaveProperty('components');
  });

  it('細かい再標本が角を減らした時だけ採用し、その弦の証明と滑らかさの証明を返す', () => {
    const finer: FunctionCurveSamplingResult = { status: 'ready', components: [arc], maximumChordErrorBound: 0.0013, stats };
    const result = attachSmoothFunctionCurve(tight, 0.01, () => finer, control());
    if (result.status !== 'ready' || result.smooth === undefined) throw new Error('Expected the finer smooth result');
    expect(result.components).toEqual([arc]); expect(result.smooth.cornerNodes).toBe(0);
    expect(result.smooth.errorBound).toBeLessThanOrEqual(0.01);
  });

  it('同じ定義の成功結果は、初回の速さや残り時間で節点・極・証明を変えない', () => {
    const results = [0, 100, 1999].map(elapsed => {
      let calls = 0;
      const result = attachSmoothFunctionCurve(tight, 0.01, tolerance => {
        calls++;
        expect(tolerance).toBe(0.005);
        return roomy;
      }, control({ now: () => elapsed }));
      expect(calls).toBe(1);
      expect(result).toHaveProperty('smooth');
      expect(result).toMatchObject({ status: 'ready', components: roomy.components });
      return result;
    });
    expect(results[1]).toEqual(results[0]);
    expect(results[2]).toEqual(results[0]);
  });

  it('元の速度補正済み時計だけに従い、3143msを別の2秒時計で拒否しない', () => {
    let elapsed = 3143;
    const paced = control({ now: () => elapsed, totalCapMs: 5000 });
    const result = attachSmoothFunctionCurve(tight, 0.01, () => roomy, paced);
    expect(result).toMatchObject({ status: 'ready', components: roomy.components });
    elapsed = 5000;
    expect(attachSmoothFunctionCurve(tight, 0.01, () => { throw new Error('must not start'); }, paced))
      .toMatchObject({ status: 'stopped', reason: 'deadline', stats });
  });

  it('細かい結果の平滑化で共通期限を越えたら途中形状を成功として返さない', () => {
    let after = false, reads = 0;
    const now = () => after ? (reads++ === 0 ? 1999 : 2000) : 0;
    const result = attachSmoothFunctionCurve(tight, 0.01, () => { after = true; return roomy; }, control({ now }));
    expect(result).toMatchObject({ status: 'stopped', reason: 'deadline', stats });
    expect(result).not.toHaveProperty('smooth');
    expect(reads).toBeGreaterThan(1);
  });

  it('backendの時間切れや再標本の中止も、その理由を保って返す', () => {
    let backendExpired = false;
    const watched = control({ stop: () => backendExpired ? 'deadline' : undefined });
    expect(attachSmoothFunctionCurve(tight, 0.01, () => {
      backendExpired = true;
      throw new MathDeadlineExceeded();
    }, watched)).toMatchObject({ status: 'stopped', reason: 'deadline', stats });
    for (const reason of ['deadline', 'cancelled'] as const) {
      expect(attachSmoothFunctionCurve(tight, 0.01, () => ({ status: 'stopped', reason, stats }), control()))
        .toEqual({ status: 'stopped', reason, stats });
    }
  });

  it('期限を過ぎた後でも、入力の問題でない例外は隠さない', () => {
    let clock = 0;
    expect(() => attachSmoothFunctionCurve(tight, 0.01, () => { clock = 100; throw new Error('defect'); },
      control({ now: () => clock }))).toThrow('defect');
  });
});
