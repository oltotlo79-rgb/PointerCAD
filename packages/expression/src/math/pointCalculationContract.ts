/** Point definitions share a UI while retaining the original solver's validated input and branch type. */
import {MathInputProblem} from './mathInputContract.js';
import {decodeFunctionPointWorkRequest,saveFunctionPointInput,type FunctionPointWorkRequest,type FunctionPointSavedInput} from './functionPointWorkRequest.js';
import {decodeCurvePointWorkRequest,saveCurvePointInput,type CurvePointWorkRequest,type CurvePointSavedInput,type CurvePointCandidate} from './curvePointWorkRequest.js';
import {decodeFunctionPointContinuationWorkRequest,type FunctionPointContinuationWorkRequest} from './functionPointContinuationWork.js';
import {decodeCurvePointContinuationWorkRequest,type CurvePointContinuationWorkRequest} from './curvePointContinuationWork.js';
import {decodeSurfacePointWorkRequest,saveSurfacePointInput,type SurfacePointWorkRequest,type SurfacePointSavedInput,type SurfacePointCandidate} from './surfacePointWorkRequest.js';
import {decodeSurfacePointContinuationWorkRequest,type SurfacePointContinuationWorkRequest} from './surfacePointContinuationWork.js';
import type {FunctionPointCandidate} from './functionPointCandidates.js';

export type PointCalculationRequest=FunctionPointWorkRequest|CurvePointWorkRequest|SurfacePointWorkRequest;
export type PointCalculationSavedInput=FunctionPointSavedInput|CurvePointSavedInput|SurfacePointSavedInput;
export type PointCalculationCandidate=FunctionPointCandidate|CurvePointCandidate|SurfacePointCandidate;
export type PointContinuationRequest=FunctionPointContinuationWorkRequest|CurvePointContinuationWorkRequest|SurfacePointContinuationWorkRequest;

export function isCurvePointInput(value:unknown):value is CurvePointWorkRequest|CurvePointSavedInput {
  return value!==null && typeof value==='object' && 'kind' in value && value.kind==='curve';
}
export function isSurfacePointInput(value:unknown):value is SurfacePointWorkRequest|SurfacePointSavedInput {
  return value!==null&&typeof value==='object'&&'kind' in value&&value.kind==='parametric-surface';
}
export function decodePointCalculationRequest(value:unknown):PointCalculationRequest {
  return isSurfacePointInput(value)?decodeSurfacePointWorkRequest(value):isCurvePointInput(value)?decodeCurvePointWorkRequest(value):decodeFunctionPointWorkRequest(value);
}
export function savePointCalculationInput(value:unknown):PointCalculationSavedInput {
  return isSurfacePointInput(value)?saveSurfacePointInput(value):isCurvePointInput(value)?saveCurvePointInput(value):saveFunctionPointInput(value);
}
export function isCurvePointContinuation(value:PointContinuationRequest):value is CurvePointContinuationWorkRequest {
  return isCurvePointInput(value.previous);
}
export function isSurfacePointContinuation(value:PointContinuationRequest):value is SurfacePointContinuationWorkRequest {
  return isSurfacePointInput(value.previous);
}
export function decodePointContinuationRequest(value:unknown):PointContinuationRequest {
  if(value===null || typeof value!=='object' || !('previous' in value) || !('current' in value)) {
    throw new MathInputProblem('syntax','点の保存条件と現在の関数を確認してください。');
  }
  if(isCurvePointInput(value.previous)!==isCurvePointInput(value.current)||isSurfacePointInput(value.previous)!==isSurfacePointInput(value.current)) {
    throw new MathInputProblem('syntax','関数の形式が変わりました。点の候補を選び直してください。');
  }
  return isSurfacePointInput(value.previous)?decodeSurfacePointContinuationWorkRequest(value)
    :isCurvePointInput(value.previous)?decodeCurvePointContinuationWorkRequest(value):decodeFunctionPointContinuationWorkRequest(value);
}
