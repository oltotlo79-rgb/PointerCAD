import { MathInputProblem, type StoredMathExpression } from './mathInputContract.js';
import { decodeMathCoefficientValues, decodeMathRequestIdentity, type MathRequestIdentity, type MathWorkRequest } from './mathWorkRequest.js';
import { functionWorkRecord, functionWorkCounter, functionWorkNumber, functionWorkArray, functionWorkBounds,
  functionWorkPair, frozenFunctionDefinition } from './functionWorkData.js';
import { FUNCTION_SURFACE_LIMITS, type FunctionSurfaceBudget } from './functionSurfaceLimits.js';
export { FUNCTION_SURFACE_LIMITS } from './functionSurfaceLimits.js';
import type { FunctionPoint } from './functionGeometryBounds.js';
import type { SurfaceParameter } from './surfaceParameterGrid.js';

export type FunctionSurfaceInputs = readonly ['X','Y'] | readonly ['X','Z'] | readonly ['Y','Z'] | readonly ['U','V'];
export interface FunctionSurfaceParameterBounds {
  readonly lower: readonly [StoredMathExpression,StoredMathExpression];
  readonly upper: readonly [StoredMathExpression,StoredMathExpression];
}
export interface FunctionSurfaceWorkRequest {
  readonly identity: MathRequestIdentity;
  readonly independent: FunctionSurfaceInputs;
  readonly outputs: readonly [StoredMathExpression,StoredMathExpression,StoredMathExpression];
  readonly lower: SurfaceParameter; readonly upper: SurfaceParameter;
  readonly minimum: FunctionPoint; readonly maximum: FunctionPoint; readonly tolerance: number;
  readonly budget: FunctionSurfaceBudget;
  readonly coefficients: MathWorkRequest['coefficients'];
  /** Original scalar definitions permit exact seam proofs; numeric endpoints alone do not. */
  readonly parameterBounds?: FunctionSurfaceParameterBounds;
}
export interface FunctionSurfaceWorkEnvelope { readonly kind:'sample-function-surface'; readonly serial:number; readonly request:FunctionSurfaceWorkRequest }
function inputs(value: unknown): FunctionSurfaceInputs {
  const raw = functionWorkArray(value,2);
  if (raw.length === 2) {
    if (raw[0] === 'X' && raw[1] === 'Y') return Object.freeze(['X','Y']);
    if (raw[0] === 'X' && raw[1] === 'Z') return Object.freeze(['X','Z']);
    if (raw[0] === 'Y' && raw[1] === 'Z') return Object.freeze(['Y','Z']);
    if (raw[0] === 'U' && raw[1] === 'V') return Object.freeze(['U','V']);
  }
  throw new MathInputProblem('syntax','曲面の独立変数はXY・XZ・YZまたは媒介変数UVから指定してください。');
}
export function decodeFunctionSurfaceWorkRequest(input: unknown): FunctionSurfaceWorkRequest {
  const hasParameterBounds = input !== null && typeof input === 'object' && Object.hasOwn(input,'parameterBounds');
  const raw = functionWorkRecord(input,['identity','independent','outputs','lower','upper','minimum','maximum','tolerance','budget','coefficients',
    ...(hasParameterBounds ? ['parameterBounds'] : [])]);
  const independent = inputs(raw.independent), lower = functionWorkPair(raw.lower), upper = functionWorkPair(raw.upper);
  const {minimum,maximum} = functionWorkBounds(raw.minimum,raw.maximum), tolerance = functionWorkNumber(raw.tolerance);
  if (!(tolerance > 0) || lower.some((value,index)=>!(value < upper[index]) || !Number.isFinite(upper[index]-value))) {
    throw new MathInputProblem('domain','曲面の変数の範囲と精度を確認してください。');
  }
  if (independent[0] !== 'U') for (let index = 0; index < 2; index++) {
    const name = independent[index], axis = name === 'X' ? 0 : name === 'Y' ? 1 : 2;
    if (lower[index] !== minimum[axis] || upper[index] !== maximum[axis]) {
      throw new MathInputProblem('domain','独立軸の作図区間は指定したXYZ範囲と一致させてください。');
    }
  }
  const supplied = functionWorkRecord(raw.budget,['maximumSamples','maximumCells','maximumTriangles','maximumDepth']);
  const budget = Object.freeze({
    maximumSamples:functionWorkCounter(supplied.maximumSamples,FUNCTION_SURFACE_LIMITS.maximumSamples,5),
    maximumCells:functionWorkCounter(supplied.maximumCells,FUNCTION_SURFACE_LIMITS.maximumCells,1),
    maximumTriangles:functionWorkCounter(supplied.maximumTriangles,FUNCTION_SURFACE_LIMITS.maximumTriangles,4),
    maximumDepth:functionWorkCounter(supplied.maximumDepth,FUNCTION_SURFACE_LIMITS.maximumDepth,1),
  });
  const coefficients = decodeMathCoefficientValues(raw.coefficients), ids = new Set(coefficients.map(value=>value.id));
  const outputs = functionWorkArray(raw.outputs,3);
  if (outputs.length !== 3) throw new MathInputProblem('syntax','曲面のX・Y・Zの式を指定してください。');
  let parameterBounds: FunctionSurfaceParameterBounds | undefined;
  if (hasParameterBounds) {
    if (independent[0] !== 'U') throw new MathInputProblem('syntax','媒介変数の境界式はU・V形式で指定してください。');
    const value = functionWorkRecord(raw.parameterBounds,['lower','upper']);
    const pair = (input: unknown): readonly [StoredMathExpression,StoredMathExpression] => {
      const items = functionWorkArray(input,2);
      if (items.length !== 2) throw new MathInputProblem('syntax','U・V両方の境界式を指定してください。');
      return Object.freeze([frozenFunctionDefinition(items[0],ids),frozenFunctionDefinition(items[1],ids)]);
    };
    parameterBounds = Object.freeze({lower:pair(value.lower),upper:pair(value.upper)});
  }
  return Object.freeze({identity:decodeMathRequestIdentity(raw.identity),independent,lower,upper,minimum,maximum,tolerance,budget,coefficients,
    outputs:Object.freeze([frozenFunctionDefinition(outputs[0],ids),frozenFunctionDefinition(outputs[1],ids),frozenFunctionDefinition(outputs[2],ids)] as const),
    ...(parameterBounds === undefined ? {} : {parameterBounds})});
}
export function decodeFunctionSurfaceWorkEnvelope(value: unknown): FunctionSurfaceWorkEnvelope {
  const raw = functionWorkRecord(value,['kind','serial','request']);
  if (raw.kind !== 'sample-function-surface') throw new MathInputProblem('syntax','曲面の計算依頼の種類が不正です。');
  return Object.freeze({kind:'sample-function-surface',serial:functionWorkCounter(raw.serial,Number.MAX_SAFE_INTEGER,1),request:decodeFunctionSurfaceWorkRequest(raw.request)});
}
export function createFunctionSurfaceWorkEnvelope(serial: number, request: FunctionSurfaceWorkRequest): FunctionSurfaceWorkEnvelope {
  return decodeFunctionSurfaceWorkEnvelope({kind:'sample-function-surface',serial,request});
}
