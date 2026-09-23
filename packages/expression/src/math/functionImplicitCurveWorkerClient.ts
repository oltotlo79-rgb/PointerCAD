import { functionPreparationProgress } from './functionPreparationProgress.js';
import { BoundedCalculationClient,type CalculationWorkerPort } from './boundedCalculationClient.js';
import { createFunctionImplicitCurveWorkEnvelope,decodeFunctionImplicitCurveWorkRequest,type FunctionImplicitCurveWorkRequest } from './functionImplicitCurveWorkRequest.js';
import { decodeFunctionImplicitCurveWorkReply } from './functionImplicitCurveWorkReply.js';
import type { FunctionImplicitCurveWorkResult } from './functionImplicitCurveProtocol.js';

export class FunctionImplicitCurveWorkerClient extends BoundedCalculationClient<FunctionImplicitCurveWorkRequest,FunctionImplicitCurveWorkResult> {
  constructor(options:{readonly createWorker:()=>CalculationWorkerPort}){
    super({ progress: functionPreparationProgress(),...options,decodeRequest:decodeFunctionImplicitCurveWorkRequest,createEnvelope:createFunctionImplicitCurveWorkEnvelope,decodeReply:decodeFunctionImplicitCurveWorkReply});
  }
}
