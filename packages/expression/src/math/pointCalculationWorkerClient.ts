/** One bounded queue can switch between a curve and an implicit parent without accepting the other reply type. */
import {BoundedCalculationClient,type CalculationWorkerPort} from './boundedCalculationClient.js';
import {decodePointCalculationRequest,decodePointContinuationRequest,isCurvePointInput,isCurvePointContinuation,
  isSurfacePointInput,isSurfacePointContinuation,
  type PointCalculationRequest,type PointContinuationRequest} from './pointCalculationContract.js';
import {createFunctionPointWorkEnvelope} from './functionPointWorkRequest.js';
import {decodeFunctionPointWorkReply} from './functionPointWorkReply.js';
import {createCurvePointWorkEnvelope,type CurvePointWorkResult} from './curvePointWorkEnvelope.js';
import {decodeCurvePointWorkReply} from './curvePointWorkReply.js';
import {createFunctionPointContinuationWorkEnvelope,decodeFunctionPointContinuationWorkReply,type FunctionPointContinuationWorkResult} from './functionPointContinuationWork.js';
import {createCurvePointContinuationWorkEnvelope,decodeCurvePointContinuationWorkReply,type CurvePointContinuationWorkResult} from './curvePointContinuationWork.js';
import type {FunctionPointWorkResult} from './functionPointWorkExecution.js';
import {createSurfacePointWorkEnvelope,type SurfacePointWorkResult} from './surfacePointWorkEnvelope.js';
import {decodeSurfacePointWorkReply} from './surfacePointWorkReply.js';
import {createSurfacePointContinuationWorkEnvelope,decodeSurfacePointContinuationWorkReply,type SurfacePointContinuationWorkResult} from './surfacePointContinuationWork.js';

export class PointCalculationWorkerClient extends BoundedCalculationClient<PointCalculationRequest,FunctionPointWorkResult|CurvePointWorkResult|SurfacePointWorkResult> {
  constructor(options:{readonly createWorker:()=>CalculationWorkerPort}) {
    super({...options,decodeRequest:decodePointCalculationRequest,
      createEnvelope:(serial,request)=>isSurfacePointInput(request)?createSurfacePointWorkEnvelope(serial,request)
        :isCurvePointInput(request)?createCurvePointWorkEnvelope(serial,request):createFunctionPointWorkEnvelope(serial,request),
      decodeReply:(value,request)=>isSurfacePointInput(request)?decodeSurfacePointWorkReply(value,request)
        :isCurvePointInput(request)?decodeCurvePointWorkReply(value,request):decodeFunctionPointWorkReply(value,request)});
  }
}
export class PointContinuationWorkerClient extends BoundedCalculationClient<PointContinuationRequest,FunctionPointContinuationWorkResult|CurvePointContinuationWorkResult|SurfacePointContinuationWorkResult> {
  constructor(options:{readonly createWorker:()=>CalculationWorkerPort}) {
    super({...options,decodeRequest:decodePointContinuationRequest,
      createEnvelope:(serial,request)=>isSurfacePointContinuation(request)?createSurfacePointContinuationWorkEnvelope(serial,request)
        :isCurvePointContinuation(request)?createCurvePointContinuationWorkEnvelope(serial,request):createFunctionPointContinuationWorkEnvelope(serial,request),
      decodeReply:(value,request)=>isSurfacePointContinuation(request)?decodeSurfacePointContinuationWorkReply(value,request)
        :isCurvePointContinuation(request)?decodeCurvePointContinuationWorkReply(value,request):decodeFunctionPointContinuationWorkReply(value,request)});
  }
}
