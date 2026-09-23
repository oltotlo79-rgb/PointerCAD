import { functionPreparationProgress } from './functionPreparationProgress.js';
import {BoundedCalculationClient,type CalculationWorkerPort} from './boundedCalculationClient.js';
import {decodeCurvePointWorkRequest,type CurvePointWorkRequest} from './curvePointWorkRequest.js';
import {createCurvePointWorkEnvelope,type CurvePointWorkResult} from './curvePointWorkEnvelope.js';
import {decodeCurvePointWorkReply} from './curvePointWorkReply.js';
import {createCurvePointContinuationWorkEnvelope,decodeCurvePointContinuationWorkRequest,decodeCurvePointContinuationWorkReply,
  type CurvePointContinuationWorkRequest,type CurvePointContinuationWorkResult} from './curvePointContinuationWork.js';

export class CurvePointWorkerClient extends BoundedCalculationClient<CurvePointWorkRequest,CurvePointWorkResult> {
  constructor(options:{readonly createWorker:()=>CalculationWorkerPort}) {
    super({ progress: functionPreparationProgress(),...options,decodeRequest:decodeCurvePointWorkRequest,createEnvelope:createCurvePointWorkEnvelope,decodeReply:decodeCurvePointWorkReply});
  }
}
export class CurvePointContinuationWorkerClient extends BoundedCalculationClient<CurvePointContinuationWorkRequest,CurvePointContinuationWorkResult> {
  constructor(options:{readonly createWorker:()=>CalculationWorkerPort}) {
    super({ progress: functionPreparationProgress(),...options,decodeRequest:decodeCurvePointContinuationWorkRequest,createEnvelope:createCurvePointContinuationWorkEnvelope,decodeReply:decodeCurvePointContinuationWorkReply});
  }
}
