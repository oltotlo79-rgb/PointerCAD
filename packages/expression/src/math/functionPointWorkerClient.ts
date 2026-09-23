import { functionPreparationProgress } from './functionPreparationProgress.js';
import {BoundedCalculationClient,type CalculationWorkerPort} from './boundedCalculationClient.js';
import {createFunctionPointWorkEnvelope,decodeFunctionPointWorkRequest,type FunctionPointWorkRequest} from './functionPointWorkRequest.js';
import {decodeFunctionPointWorkReply} from './functionPointWorkReply.js';
import type {FunctionPointWorkResult} from './functionPointWorkExecution.js';
import {createFunctionPointContinuationWorkEnvelope,decodeFunctionPointContinuationWorkRequest,decodeFunctionPointContinuationWorkReply,
  type FunctionPointContinuationWorkRequest,type FunctionPointContinuationWorkResult} from './functionPointContinuationWork.js';

export class FunctionPointWorkerClient extends BoundedCalculationClient<FunctionPointWorkRequest,FunctionPointWorkResult> {
  constructor(options:{readonly createWorker:()=>CalculationWorkerPort}){
    super({ progress: functionPreparationProgress(),...options,decodeRequest:decodeFunctionPointWorkRequest,createEnvelope:createFunctionPointWorkEnvelope,decodeReply:decodeFunctionPointWorkReply});
  }
}

export class FunctionPointContinuationWorkerClient extends BoundedCalculationClient<FunctionPointContinuationWorkRequest,FunctionPointContinuationWorkResult> {
  constructor(options:{readonly createWorker:()=>CalculationWorkerPort}){
    super({ progress: functionPreparationProgress(),...options,decodeRequest:decodeFunctionPointContinuationWorkRequest,createEnvelope:createFunctionPointContinuationWorkEnvelope,
      decodeReply:decodeFunctionPointContinuationWorkReply});
  }
}
