/** Reject malformed or stale geometry before it reaches the CAD Worker. */
import { MathInputProblem } from './mathInputContract.js';
import { decodeMathRequestIdentity } from './mathWorkRequest.js';
import { sameMathIdentity } from './mathWorkerClient.js';
import { FUNCTION_CURVE_LIMITS, functionCurveRecord, functionCurveArray, functionCurveNumber, functionCurvePoint,
  type FunctionCurveWorkRequest } from './functionCurveWorkRequest.js';
import type { FunctionCurveWorkReply, FunctionCurveWorkResult } from './functionCurveWorkExecution.js';
import type { FunctionCurveSamplingStats, FunctionCurveSample } from './adaptiveFunctionCurve.js';
import type { FunctionCurveBezier } from './exactFunctionCurveBezier.js';
import type { MathInterval } from './mathInterval.js';
import { cubicChordDeviation, FUNCTION_CURVE_SPLINE_POLE_LIMIT, junctionDiscrepancy, type FunctionCurveSpline,
  type SmoothFunctionCurve } from './smoothFunctionCurve.js';
import { certifyFunctionCurveTangents, expectedFunctionCurveSeam, type FunctionCurveDerivativeEnclosure, type FunctionCurveSeam,
  type FunctionCurveTangents } from './functionCurveTangentBounds.js';
import { requestPeriodicity, type FunctionCurvePeriodicity } from './functionCurvePeriodicity.js';

function counter(value: unknown, maximum: number): number {
  const number = functionCurveNumber(value);
  if (!Number.isSafeInteger(number) || number < 0 || number > maximum) throw new MathInputProblem('budget', '関数の計算数が上限と一致しません。');
  return number;
}
function stats(value: unknown): FunctionCurveSamplingStats {
  const raw = functionCurveRecord(value, ['samples', 'cells']);
  return Object.freeze({ samples: counter(raw.samples, FUNCTION_CURVE_LIMITS.maximumSamples), cells: counter(raw.cells, FUNCTION_CURVE_LIMITS.maximumCells) });
}
function interval(value: unknown): MathInterval {
  const raw = functionCurveRecord(value, ['lower', 'upper']);
  const lower = functionCurveNumber(raw.lower), upper = functionCurveNumber(raw.upper);
  if (!(lower <= upper)) throw new MathInputProblem('domain', '関数曲線の接線の証明を確認できません。');
  return Object.freeze({ lower, upper });
}
function optionalBound(value: unknown): number | null {
  return value === null ? null : functionCurveNumber(value);
}
/**
 * The tangent certificate is recomputed here from the received poles, knots and derivative enclosures, span by span in
 * order; every claimed count and bound must equal the recomputation. The decoder cannot re-evaluate the original
 * symbolic derivative: the enclosures are the Worker's, and only their algebraic consequences are checked.
 */
function tangents(value: unknown, splines: readonly FunctionCurveSpline[]): FunctionCurveTangents {
  const raw = functionCurveRecord(value, ['enclosures', 'regularSpans', 'unresolvedSpans', 'refinableSpans',
    'maximumError', 'minimumLower', 'maximumUnitTangent']);
  const groups = functionCurveArray(raw.enclosures, splines.length);
  if (groups.length !== splines.length) throw new MathInputProblem('syntax', '関数曲線の接線の証明の成分数を確認できません。');
  const enclosures = groups.map((group, index) => {
    const count = splines[index].knots.length - 1, spans = functionCurveArray(group, count);
    if (spans.length !== count) throw new MathInputProblem('syntax', '関数曲線の接線の証明の区間数を確認できません。');
    return spans.map((span): FunctionCurveDerivativeEnclosure | null => {
      if (span === null) return null;
      const axes = functionCurveArray(span, 3);
      if (axes.length !== 3) throw new MathInputProblem('syntax', '関数曲線の接線の証明を確認できません。');
      return Object.freeze([interval(axes[0]), interval(axes[1]), interval(axes[2])] as const);
    });
  });
  const certified = certifyFunctionCurveTangents(splines, enclosures);
  const limit = FUNCTION_CURVE_LIMITS.maximumSamples;
  if (certified === null || counter(raw.regularSpans, limit) !== certified.regularSpans
    || counter(raw.unresolvedSpans, limit) !== certified.unresolvedSpans || counter(raw.refinableSpans, limit) !== certified.refinableSpans
    || optionalBound(raw.maximumError) !== certified.maximumError || optionalBound(raw.minimumLower) !== certified.minimumLower
    || optionalBound(raw.maximumUnitTangent) !== certified.maximumUnitTangent) {
    throw new MathInputProblem('domain', '関数曲線の接線の証明を確認できません。');
  }
  return certified;
}
/**
 * The periodic proof is recomputed from the request's own original expressions, which the decoder holds; the reply
 * must state exactly that result. A reply cannot add a proof to a request without T sources, nor drop one.
 */
function periodicity(value: unknown, request: FunctionCurveWorkRequest): FunctionCurvePeriodicity {
  const expected = requestPeriodicity(request);
  if (expected === undefined) throw new MathInputProblem('syntax', '関数曲線の周期の証明は媒介変数の範囲の原式と一緒にだけ受け取れます。');
  const status = value !== null && typeof value === 'object' && 'status' in value ? value.status : undefined;
  if (status === 'proved') {
    const raw = functionCurveRecord(value, ['status', 'period', 'turns']);
    const period = functionCurveRecord(raw.period, ['numerator', 'denominator', 'piPower']);
    if (expected.status !== 'proved' || raw.turns !== expected.turns || period.numerator !== expected.period.numerator
      || period.denominator !== expected.period.denominator || period.piPower !== expected.period.piPower) {
      throw new MathInputProblem('domain', '関数曲線の周期の証明を確認できません。');
    }
  } else {
    const raw = functionCurveRecord(value, ['status', 'reason']);
    if (raw.status !== 'unproved' || expected.status !== 'unproved' || raw.reason !== expected.reason) {
      throw new MathInputProblem('domain', '関数曲線の周期の証明を確認できません。');
    }
  }
  return expected;
}
/**
 * The seam is recomputed from the received controls: present exactly when the request's own expressions prove the
 * period and the single spline spans the whole range with the same binary point at both ends, with the same bound.
 */
function seam(value: unknown, present: boolean, splines: readonly FunctionCurveSpline[], request: FunctionCurveWorkRequest): FunctionCurveSeam | undefined {
  const expected = expectedFunctionCurveSeam(requestPeriodicity(request)?.status === 'proved', splines, request.lower, request.upper);
  if (!present) {
    if (expected !== null) throw new MathInputProblem('syntax', '周期の証明された閉じた曲線の継ぎ目の上限がありません。');
    return undefined;
  }
  const raw = functionCurveRecord(value, ['tangentMismatch']);
  if (expected === null || functionCurveNumber(raw.tangentMismatch) !== expected.tangentMismatch) {
    throw new MathInputProblem('domain', '関数曲線の継ぎ目の上限を確認できません。');
  }
  return expected;
}
/**
 * A smooth reply must match the certified samples knot for knot, interpolate them at both ends, and its claimed
 * bound is recomputed here from the received poles; a reply cannot assert a tighter bound than its geometry proves.
 */
function smooth(value: unknown, components: readonly (readonly FunctionCurveSample[])[], chordBound: number,
  request: FunctionCurveWorkRequest): SmoothFunctionCurve {
  const hasTangents = value !== null && typeof value === 'object' && Object.hasOwn(value, 'tangents');
  const hasSeam = value !== null && typeof value === 'object' && Object.hasOwn(value, 'seam');
  const raw = functionCurveRecord(value, ['splines', 'errorBound', 'reducedNodes', 'cornerNodes',
    ...(hasTangents ? ['tangents'] : []), ...(hasSeam ? ['seam'] : [])]);
  const entries = functionCurveArray(raw.splines, components.length);
  if (entries.length !== components.length) throw new MathInputProblem('syntax', '関数曲線の滑らかな成分数を確認できません。');
  const errorBound = functionCurveNumber(raw.errorBound);
  if (!(errorBound >= chordBound && errorBound <= request.tolerance)) throw new MathInputProblem('domain', '関数曲線の滑らかさの精度を確認できません。');
  let poleCount = 0, deviation = 0, junctionError = 0;
  const splines: FunctionCurveSpline[] = [];
  for (let index = 0; index < entries.length; index++) {
    const samples = components[index];
    const spline = functionCurveRecord(entries[index], ['knots', 'poles']);
    const knots = functionCurveArray(spline.knots, samples.length).map(functionCurveNumber);
    if ((poleCount += 2 * samples.length) > FUNCTION_CURVE_SPLINE_POLE_LIMIT) throw new MathInputProblem('budget', '関数曲線の制御点数が上限を超えています。');
    const poles = functionCurveArray(spline.poles, 2 * samples.length).map(functionCurvePoint);
    const same = (a: readonly number[], b: readonly number[]) => a.every((coordinate, axis) => coordinate === b[axis]);
    if (knots.length !== samples.length || knots.some((knot, at) => knot !== samples[at].parameter) || poles.length !== 2 * samples.length
      || !same(poles[0], samples[0].point) || !same(poles[poles.length - 1], samples[samples.length - 1].point)) {
      throw new MathInputProblem('syntax', '関数曲線の滑らかな制御点が標本と一致しません。');
    }
    // The native curve's interior junctions come from the poles, not from the samples: they must coincide up to
    // rounding, and that residual is added to the proof (moving a span's end moves the span by at most as much).
    const junctions = junctionDiscrepancy(knots, poles, samples.map(sample => sample.point));
    if (junctions === null) throw new MathInputProblem('domain', '関数曲線の滑らかな制御点が標本の位置を通りません。');
    junctionError = Math.max(junctionError, junctions);
    for (let span = 0; span < samples.length - 1; span++) {
      deviation = Math.max(deviation, cubicChordDeviation(samples[span].point, poles[2 * span + 1], poles[2 * span + 2], samples[span + 1].point));
    }
    splines.push(Object.freeze({ knots: Object.freeze(knots), poles: Object.freeze(poles) }));
  }
  if (!(chordBound + deviation + junctionError <= errorBound)) throw new MathInputProblem('domain', '関数曲線の滑らかさの精度を確認できません。');
  const certified = hasTangents ? tangents(raw.tangents, splines) : undefined;
  const closed = seam(raw.seam, hasSeam, splines, request);
  return Object.freeze({ splines: Object.freeze(splines), errorBound,
    reducedNodes: counter(raw.reducedNodes, FUNCTION_CURVE_LIMITS.maximumSamples), cornerNodes: counter(raw.cornerNodes, FUNCTION_CURVE_LIMITS.maximumSamples),
    ...(certified === undefined ? {} : { tangents: certified }), ...(closed === undefined ? {} : { seam: closed }) });
}
function result(value: unknown, request: FunctionCurveWorkRequest): FunctionCurveWorkResult {
  if (value === null || typeof value !== 'object' || !('status' in value)) throw new MathInputProblem('syntax', '関数の計算結果の種類を確認できません。');
  if (value.status === 'invalid') {
    const raw = functionCurveRecord(value, ['status', 'message']);
    if (typeof raw.message !== 'string' || raw.message.length < 1 || raw.message.length > 2048) throw new MathInputProblem('syntax', '関数の失敗理由を確認できません。');
    return { status: 'invalid', message: raw.message };
  }
  if (value.status === 'empty' || value.status === 'degenerate') {
    const raw = functionCurveRecord(value, ['status', 'stats']);
    return { status: value.status, stats: stats(raw.stats) };
  }
  if (value.status === 'stopped') {
    const raw = functionCurveRecord(value, ['status', 'reason', 'stats']);
    if (raw.reason !== 'cancelled' && raw.reason !== 'deadline' && raw.reason !== 'samples' && raw.reason !== 'cells'
      && raw.reason !== 'subdivision' && raw.reason !== 'roundoff') throw new MathInputProblem('syntax', '関数の停止理由を確認できません。');
    return { status: 'stopped', reason: raw.reason, stats: stats(raw.stats) };
  }
  if (value.status !== 'ready') throw new MathInputProblem('syntax', '関数の計算結果の種類が不正です。');
  const raw = functionCurveRecord(value, ['status', 'components', 'maximumChordErrorBound', 'stats',
    ...('bezier' in value ? ['bezier'] : []), ...('smooth' in value ? ['smooth'] : []), ...('periodicity' in value ? ['periodicity'] : [])]);
  if ('bezier' in raw && 'smooth' in raw) throw new MathInputProblem('syntax', '関数曲線の種類を確認できません。');
  let bezier: FunctionCurveBezier | undefined;
  if ('bezier' in raw) {
    const entries = functionCurveArray(raw.bezier, 4);
    if (entries.length !== 4) throw new MathInputProblem('syntax', '関数曲線の制御点数を確認できません。');
    const points = entries.map(functionCurvePoint);
    if (points.some(point => point.some((coordinate, axis) => coordinate < request.minimum[axis] || coordinate > request.maximum[axis]))
      || points[0].every((coordinate, axis) => coordinate === points[3][axis])) {
      throw new MathInputProblem('domain', '関数曲線の制御範囲を確認できません。');
    }
    bezier = Object.freeze([points[0], points[1], points[2], points[3]]);
  }
  const sampled = stats(raw.stats), error = functionCurveNumber(raw.maximumChordErrorBound);
  if (error < 0 || error > request.tolerance) throw new MathInputProblem('domain', '関数の作図精度を確認できません。');
  const groups = functionCurveArray(raw.components, sampled.samples);
  if (groups.length === 0) throw new MathInputProblem('syntax', '関数の曲線が空です。');
  let count = 0, previousEnd = request.lower;
  const components: (readonly FunctionCurveSample[])[] = [];
  for (const group of groups) {
    const entries = functionCurveArray(group, sampled.samples);
    if (entries.length < 2 || (count += entries.length) > sampled.samples) throw new MathInputProblem('budget', '関数の標本数を確認できません。');
    let previous: number | null = null;
    const samples: FunctionCurveSample[] = [];
    for (const entry of entries) {
      const rawSample = functionCurveRecord(entry, ['parameter', 'point']);
      const parameter = functionCurveNumber(rawSample.parameter);
      if (parameter < request.lower || parameter > request.upper || (previous === null ? parameter < previousEnd : parameter <= previous)) {
        throw new MathInputProblem('domain', '関数の標本の順序または媒介範囲を確認できません。');
      }
      samples.push(Object.freeze({ parameter, point: functionCurvePoint(rawSample.point) })); previous = parameter;
    }
    if (previous !== null) previousEnd = previous;
    components.push(Object.freeze(samples));
  }
  const smoothed = 'smooth' in raw ? smooth(raw.smooth, components, error, request) : undefined;
  const proof = 'periodicity' in raw ? periodicity(raw.periodicity, request) : undefined;
  if (proof === undefined && request.parameterSources !== undefined) {
    throw new MathInputProblem('syntax', '媒介変数の範囲の原式を送った依頼の周期の判定がありません。');
  }
  return Object.freeze({ status: 'ready', components: Object.freeze(components), maximumChordErrorBound: error, stats: sampled,
    ...(bezier === undefined ? {} : { bezier }), ...(smoothed === undefined ? {} : { smooth: smoothed }),
    ...(proof === undefined ? {} : { periodicity: proof }) });
}
export function decodeFunctionCurveWorkReply(value: unknown, request: FunctionCurveWorkRequest): FunctionCurveWorkReply {
  const raw = functionCurveRecord(value, ['kind', 'serial', 'identity', 'result']);
  if (raw.kind !== 'function-curve-result') throw new MathInputProblem('syntax', '関数の返信の種類が不正です。');
  const serial = counter(raw.serial, Number.MAX_SAFE_INTEGER), identity = decodeMathRequestIdentity(raw.identity);
  if (serial < 1 || !sameMathIdentity(identity, request.identity)) throw new MathInputProblem('syntax', '別の編集状態の関数を反映できません。');
  return Object.freeze({ kind: 'function-curve-result', serial, identity, result: result(raw.result, request) });
}
