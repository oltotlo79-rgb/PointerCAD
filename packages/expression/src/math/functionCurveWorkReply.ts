/** Reject malformed or stale geometry before it reaches the CAD Worker. */
import { MathInputProblem } from './mathInputContract.js';
import { decodeMathRequestIdentity } from './mathWorkRequest.js';
import { sameMathIdentity } from './mathWorkerClient.js';
import { FUNCTION_CURVE_LIMITS, functionCurveRecord, functionCurveArray, functionCurveNumber, functionCurvePoint,
  type FunctionCurveWorkRequest } from './functionCurveWorkRequest.js';
import type { FunctionCurveWorkReply, FunctionCurveWorkResult } from './functionCurveWorkExecution.js';
import type { FunctionCurveSamplingStats, FunctionCurveSample } from './adaptiveFunctionCurve.js';
import type { FunctionCurveBezier } from './exactFunctionCurveBezier.js';

function counter(value: unknown, maximum: number): number {
  const number = functionCurveNumber(value);
  if (!Number.isSafeInteger(number) || number < 0 || number > maximum) throw new MathInputProblem('budget', '関数の計算数が上限と一致しません。');
  return number;
}
function stats(value: unknown): FunctionCurveSamplingStats {
  const raw = functionCurveRecord(value, ['samples', 'cells']);
  return Object.freeze({ samples: counter(raw.samples, FUNCTION_CURVE_LIMITS.maximumSamples), cells: counter(raw.cells, FUNCTION_CURVE_LIMITS.maximumCells) });
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
  const raw = functionCurveRecord(value, ['status', 'components', 'maximumChordErrorBound', 'stats', ...('bezier' in value ? ['bezier'] : [])]);
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
  return Object.freeze({ status: 'ready', components: Object.freeze(components), maximumChordErrorBound: error, stats: sampled,
    ...(bezier === undefined ? {} : { bezier }) });
}
export function decodeFunctionCurveWorkReply(value: unknown, request: FunctionCurveWorkRequest): FunctionCurveWorkReply {
  const raw = functionCurveRecord(value, ['kind', 'serial', 'identity', 'result']);
  if (raw.kind !== 'function-curve-result') throw new MathInputProblem('syntax', '関数の返信の種類が不正です。');
  const serial = counter(raw.serial, Number.MAX_SAFE_INTEGER), identity = decodeMathRequestIdentity(raw.identity);
  if (serial < 1 || !sameMathIdentity(identity, request.identity)) throw new MathInputProblem('syntax', '別の編集状態の関数を反映できません。');
  return Object.freeze({ kind: 'function-curve-result', serial, identity, result: result(raw.result, request) });
}
