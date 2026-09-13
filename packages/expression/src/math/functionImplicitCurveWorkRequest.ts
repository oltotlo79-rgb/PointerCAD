import { MathInputProblem,type MathAxis } from './mathInputContract.js';
import { functionWorkCounter,functionWorkNumber,functionWorkRecord } from './functionWorkData.js';
import { decodeFunctionImplicitWorkRequest,type FunctionImplicitWorkRequest } from './functionImplicitWorkRequest.js';

export interface FunctionImplicitCurveWorkRequest extends Omit<FunctionImplicitWorkRequest,'budget'|'nativePrimitives'> {
  readonly fixedAxis:MathAxis;readonly fixedCoordinate:number;
  readonly budget:{readonly maximumSamples:number;readonly maximumCells:number;readonly maximumSegments:number;readonly maximumDepth:number};
}
export function decodeFunctionImplicitCurveWorkRequest(value:unknown):FunctionImplicitCurveWorkRequest {
  const raw=functionWorkRecord(value,['identity','expression','minimum','maximum','tolerance','budget','coefficients','fixedAxis','fixedCoordinate']);
  if(raw.fixedAxis!=='X' && raw.fixedAxis!=='Y' && raw.fixedAxis!=='Z') throw new MathInputProblem('syntax','平面の陰関数で固定する軸をX・Y・Zから指定してください。');
  const supplied=functionWorkRecord(raw.budget,['maximumSamples','maximumCells','maximumSegments','maximumDepth']);
  const common=decodeFunctionImplicitWorkRequest({identity:raw.identity,expression:raw.expression,minimum:raw.minimum,maximum:raw.maximum,
    tolerance:raw.tolerance,coefficients:raw.coefficients,budget:{maximumSamples:supplied.maximumSamples,maximumCells:supplied.maximumCells,
      maximumTriangles:supplied.maximumSegments,maximumDepth:supplied.maximumDepth}});
  return Object.freeze({...common,fixedAxis:raw.fixedAxis,fixedCoordinate:functionWorkNumber(raw.fixedCoordinate),budget:Object.freeze({
    maximumSamples:common.budget.maximumSamples,maximumCells:common.budget.maximumCells,maximumSegments:common.budget.maximumTriangles,maximumDepth:common.budget.maximumDepth})});
}
export function decodeFunctionImplicitCurveWorkEnvelope(value:unknown){
  const raw=functionWorkRecord(value,['kind','serial','request']);
  if(raw.kind!=='sample-function-implicit-curve') throw new MathInputProblem('syntax','平面等式の計算依頼の種類が不正です。');
  return Object.freeze({kind:'sample-function-implicit-curve' as const,serial:functionWorkCounter(raw.serial,Number.MAX_SAFE_INTEGER,1),request:decodeFunctionImplicitCurveWorkRequest(raw.request)});
}
export function createFunctionImplicitCurveWorkEnvelope(serial:number,request:FunctionImplicitCurveWorkRequest){
  return decodeFunctionImplicitCurveWorkEnvelope({kind:'sample-function-implicit-curve',serial,request});
}
