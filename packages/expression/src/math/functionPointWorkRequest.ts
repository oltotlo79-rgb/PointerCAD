/** Detached point searches own the parent formula, all XYZ bounds and the supplied coordinates. */
import {MathInputProblem,type MathAxis,type StoredMathExpression} from './mathInputContract.js';
import {decodeMathCoefficientValues,decodeMathRequestIdentity,type MathRequestIdentity,type MathWorkRequest} from './mathWorkRequest.js';
import {functionWorkArray,functionWorkBounds,functionWorkCounter,functionWorkNumber,functionWorkRecord,frozenFunctionDefinition} from './functionWorkData.js';
import type {ImplicitFunctionPointInput} from './solveImplicitFunctionPoints.js';
import type {FunctionKnownCoordinate} from './functionPointCandidates.js';
export {functionCoordinateEquation} from './functionCoordinateEquation.js';

export interface FunctionPointWorkRequest extends ImplicitFunctionPointInput {
  readonly identity:MathRequestIdentity;
  readonly expression:StoredMathExpression;
  readonly coefficients:MathWorkRequest['coefficients'];
}
export type FunctionPointSavedInput=Omit<FunctionPointWorkRequest,'identity'>;

/** 保存・再計算・候補の確定が、同じ原式と有限範囲を保持するための唯一の写し口。 */
export function saveFunctionPointInput(input:unknown):FunctionPointSavedInput {
  const request=decodeFunctionPointWorkRequest(input);
  return Object.freeze({expression:request.expression,minimum:request.minimum,maximum:request.maximum,tolerance:request.tolerance,
    coefficients:request.coefficients,known:request.known,...(request.fixed?{fixed:request.fixed}:{})});
}
export function functionPointAxis(value:unknown):MathAxis {
  if(value!=='X' && value!=='Y' && value!=='Z') throw new MathInputProblem('syntax','点の既知座標はX・Y・Zから指定してください。');
  return value;
}
function coordinate(value:unknown):FunctionKnownCoordinate {
  const raw=functionWorkRecord(value,['axis','value']);
  return Object.freeze({axis:functionPointAxis(raw.axis),value:functionWorkNumber(raw.value)});
}
export function decodeFunctionPointWorkRequest(value:unknown):FunctionPointWorkRequest {
  const hasFixed=value!==null && typeof value==='object' && Object.hasOwn(value,'fixed');
  const raw=functionWorkRecord(value,['identity','expression','minimum','maximum','tolerance','coefficients','known',...(hasFixed?['fixed']:[])]);
  const {minimum,maximum}=functionWorkBounds(raw.minimum,raw.maximum),tolerance=functionWorkNumber(raw.tolerance);
  if(tolerance<=0) throw new MathInputProblem('domain','点の精度には正の値を指定してください。');
  const known=functionWorkArray(raw.known,2).map(coordinate);
  if(known.length<1 || new Set(known.map(item=>item.axis)).size!==known.length) {
    throw new MathInputProblem('syntax','既知の座標を重複しない1軸か2軸で指定してください。');
  }
  const coefficients=decodeMathCoefficientValues(raw.coefficients);
  return Object.freeze({identity:decodeMathRequestIdentity(raw.identity),minimum,maximum,tolerance,coefficients,
    expression:frozenFunctionDefinition(raw.expression,new Set(coefficients.map(item=>item.id))),known:Object.freeze(known),
    ...(hasFixed?{fixed:coordinate(raw.fixed)}:{})});
}
export function decodeFunctionPointWorkEnvelope(value:unknown){
  const raw=functionWorkRecord(value,['kind','serial','request']);
  if(raw.kind!=='solve-function-points') throw new MathInputProblem('syntax','関数上の点の計算依頼の種類が不正です。');
  return Object.freeze({kind:'solve-function-points' as const,serial:functionWorkCounter(raw.serial,Number.MAX_SAFE_INTEGER,1),
    request:decodeFunctionPointWorkRequest(raw.request)});
}
export function createFunctionPointWorkEnvelope(serial:number,request:FunctionPointWorkRequest){
  return decodeFunctionPointWorkEnvelope({kind:'solve-function-points',serial,request});
}
