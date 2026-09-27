import { functionPreparationProgress } from './functionPreparationProgress.js';
import { BoundedCalculationClient, type CalculationWorkerPort } from './boundedCalculationClient.js';
import { createFunctionImplicitWorkEnvelope, decodeFunctionImplicitWorkRequest, type FunctionImplicitWorkRequest } from './functionImplicitWorkRequest.js';
import { decodeFunctionImplicitWorkReply } from './functionImplicitWorkReply.js';
import type { FunctionImplicitWorkResult } from './functionImplicitProtocol.js';

export class FunctionImplicitWorkerClient extends BoundedCalculationClient<FunctionImplicitWorkRequest,FunctionImplicitWorkResult> {
  constructor(options:{readonly createWorker:()=>CalculationWorkerPort}){
    super({ progress: functionPreparationProgress(),...options,decodeRequest:decodeFunctionImplicitWorkRequest,createEnvelope:createFunctionImplicitWorkEnvelope,decodeReply:decodeFunctionImplicitWorkReply});
  }
}
