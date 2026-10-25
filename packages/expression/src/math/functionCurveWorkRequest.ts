/** Detached curve requests always carry all six finite XYZ limits, separately from their parameter interval. */
import { MathInputProblem, type StoredMathExpression } from './mathInputContract.js';
import { decodeMathCoefficientValues, decodeMathRequestIdentity, type MathRequestIdentity, type MathWorkRequest } from './mathWorkRequest.js';
import type { FunctionCurvePoint } from './adaptiveFunctionCurve.js';
import { functionWorkRecord as functionCurveRecord, functionWorkNumber as functionCurveNumber,
  functionWorkArray as functionCurveArray, frozenFunctionDefinition, functionWorkBounds } from './functionWorkData.js';
export { functionWorkRecord as functionCurveRecord, functionWorkNumber as functionCurveNumber,
  functionWorkArray as functionCurveArray, functionWorkPoint as functionCurvePoint } from './functionWorkData.js';

export const FUNCTION_CURVE_LIMITS = Object.freeze({ maximumSamples: 200_000, maximumCells: 400_000, maximumDepth: 48 });
/** The original T.min/T.max of a parametric definition, carried only to prove periodic intent. */
export interface FunctionCurveParameterSources {
  readonly lower: StoredMathExpression;
  readonly upper: StoredMathExpression;
}
export interface FunctionCurveWorkRequest {
  readonly identity: MathRequestIdentity;
  readonly independent: 'X' | 'Y' | 'Z' | 'T';
  readonly outputs: readonly [StoredMathExpression, StoredMathExpression, StoredMathExpression];
  readonly lower: number;
  readonly upper: number;
  readonly minimum: FunctionCurvePoint;
  readonly maximum: FunctionCurvePoint;
  readonly tolerance: number;
  readonly coefficients: MathWorkRequest['coefficients'];
  /** Internal and optional; absent in every older request, which keeps its exact previous meaning. */
  readonly parameterSources?: FunctionCurveParameterSources;
}
export interface FunctionCurveWorkEnvelope {
  readonly kind: 'sample-function-curve'; readonly serial: number; readonly request: FunctionCurveWorkRequest;
}
export function decodeFunctionCurveWorkRequest(input: unknown): FunctionCurveWorkRequest {
  const hasSources = input !== null && typeof input === 'object' && Object.hasOwn(input, 'parameterSources');
  const raw = functionCurveRecord(input, ['identity', 'independent', 'outputs', 'lower', 'upper', 'minimum', 'maximum', 'tolerance', 'coefficients',
    ...(hasSources ? ['parameterSources'] : [])]);
  if (raw.independent !== 'X' && raw.independent !== 'Y' && raw.independent !== 'Z' && raw.independent !== 'T') {
    throw new MathInputProblem('syntax', '曲線の独立変数をX・Y・Z・Tから指定してください。');
  }
  const { minimum,maximum } = functionWorkBounds(raw.minimum,raw.maximum);
  const lower = functionCurveNumber(raw.lower), upper = functionCurveNumber(raw.upper), tolerance = functionCurveNumber(raw.tolerance);
  if (!(lower < upper) || !Number.isFinite(upper-lower) || !(tolerance > 0)) throw new MathInputProblem('domain', '関数の媒介範囲と精度を確認してください。');
  if (raw.independent !== 'T') {
    const index = raw.independent === 'X' ? 0 : raw.independent === 'Y' ? 1 : 2;
    if (lower !== minimum[index] || upper !== maximum[index]) throw new MathInputProblem('domain', '独立軸の作図区間は指定したXYZ範囲と一致させてください。');
  }
  const coefficients = decodeMathCoefficientValues(raw.coefficients), ids = new Set(coefficients.map(value => value.id));
  const outputs = functionCurveArray(raw.outputs, 3);
  if (outputs.length !== 3) throw new MathInputProblem('syntax', '曲線のX・Y・Zの式を指定してください。');
  let parameterSources: FunctionCurveParameterSources | undefined;
  if (hasSources) {
    // Only a parametric range has original T bounds; an axis range is the XYZ limits themselves.
    if (raw.independent !== 'T') throw new MathInputProblem('syntax', '媒介変数Tの範囲の原式は媒介変数曲線だけに指定できます。');
    const sources = functionCurveRecord(raw.parameterSources, ['lower', 'upper']);
    parameterSources = Object.freeze({ lower: frozenFunctionDefinition(sources.lower, ids), upper: frozenFunctionDefinition(sources.upper, ids) });
  }
  return Object.freeze({ identity: decodeMathRequestIdentity(raw.identity), independent: raw.independent, lower, upper, minimum, maximum, tolerance, coefficients,
    outputs: Object.freeze([frozenFunctionDefinition(outputs[0], ids), frozenFunctionDefinition(outputs[1], ids), frozenFunctionDefinition(outputs[2], ids)] as const),
    ...(parameterSources === undefined ? {} : { parameterSources }) });
}
export function createFunctionCurveWorkEnvelope(serial: number, request: FunctionCurveWorkRequest): FunctionCurveWorkEnvelope {
  return decodeFunctionCurveWorkEnvelope({ kind: 'sample-function-curve', serial, request });
}
export function decodeFunctionCurveWorkEnvelope(value: unknown): FunctionCurveWorkEnvelope {
  const raw = functionCurveRecord(value, ['kind', 'serial', 'request']);
  if (raw.kind !== 'sample-function-curve') throw new MathInputProblem('syntax', '関数の依頼の種類が不正です。');
  const serial = functionCurveNumber(raw.serial);
  if (!Number.isSafeInteger(serial) || serial < 1) throw new MathInputProblem('syntax', '関数の依頼番号が不正です。');
  return Object.freeze({ kind: 'sample-function-curve', serial, request: decodeFunctionCurveWorkRequest(raw.request) });
}
