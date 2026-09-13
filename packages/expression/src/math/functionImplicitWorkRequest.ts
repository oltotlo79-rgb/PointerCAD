import { MathInputProblem, type StoredMathExpression } from './mathInputContract.js';
import { decodeMathCoefficientValues, decodeMathRequestIdentity, type MathRequestIdentity, type MathWorkRequest } from './mathWorkRequest.js';
import { functionWorkBounds, functionWorkCounter, functionWorkNumber, functionWorkRecord, frozenFunctionDefinition } from './functionWorkData.js';
import { FUNCTION_SURFACE_LIMITS, type FunctionSurfaceBudget } from './functionSurfaceLimits.js';
import type { FunctionPoint } from './functionGeometryBounds.js';

export interface FunctionImplicitWorkRequest {
  readonly identity:MathRequestIdentity; readonly expression:StoredMathExpression;
  readonly minimum:FunctionPoint; readonly maximum:FunctionPoint; readonly tolerance:number;
  readonly budget:FunctionSurfaceBudget; readonly coefficients:MathWorkRequest['coefficients'];
  /** Capability of a CAD receiver. A mesh-only caller never receives analytic primitives. */
  readonly nativePrimitives?:true;
}
export function decodeFunctionImplicitWorkRequest(value:unknown):FunctionImplicitWorkRequest {
  const hasNative=value!==null && typeof value==='object' && Object.hasOwn(value,'nativePrimitives');
  const raw=functionWorkRecord(value,['identity','expression','minimum','maximum','tolerance','budget','coefficients',...(hasNative?['nativePrimitives']:[])]);
  if(hasNative && raw.nativePrimitives!==true) throw new MathInputProblem('syntax','解析曲面の受信能力を確認できません。');
  const bounds=functionWorkBounds(raw.minimum,raw.maximum),tolerance=functionWorkNumber(raw.tolerance);
  if(tolerance<=0) throw new MathInputProblem('domain','陰関数の作図精度には正の値を指定してください。');
  const supplied=functionWorkRecord(raw.budget,['maximumSamples','maximumCells','maximumTriangles','maximumDepth']);
  const budget=Object.freeze({maximumSamples:functionWorkCounter(supplied.maximumSamples,FUNCTION_SURFACE_LIMITS.maximumSamples,5),
    maximumCells:functionWorkCounter(supplied.maximumCells,FUNCTION_SURFACE_LIMITS.maximumCells,1),
    maximumTriangles:functionWorkCounter(supplied.maximumTriangles,FUNCTION_SURFACE_LIMITS.maximumTriangles,4),
    maximumDepth:functionWorkCounter(supplied.maximumDepth,FUNCTION_SURFACE_LIMITS.maximumDepth,1)});
  const coefficients=decodeMathCoefficientValues(raw.coefficients);
  return Object.freeze({...bounds,tolerance,budget,coefficients,identity:decodeMathRequestIdentity(raw.identity),
    expression:frozenFunctionDefinition(raw.expression,new Set(coefficients.map(value=>value.id))),...(hasNative?{nativePrimitives:true as const}:{})});
}
export function decodeFunctionImplicitWorkEnvelope(value:unknown) {
  const raw=functionWorkRecord(value,['kind','serial','request']);
  if(raw.kind!=='sample-function-implicit-surface') throw new MathInputProblem('syntax','陰関数の計算依頼の種類が不正です。');
  return Object.freeze({kind:'sample-function-implicit-surface' as const,serial:functionWorkCounter(raw.serial,Number.MAX_SAFE_INTEGER,1),request:decodeFunctionImplicitWorkRequest(raw.request)});
}
export function createFunctionImplicitWorkEnvelope(serial:number,request:FunctionImplicitWorkRequest) {
  return decodeFunctionImplicitWorkEnvelope({kind:'sample-function-implicit-surface',serial,request});
}
