import { BoundedCalculationClient,type CalculationWorkerPort } from './boundedCalculationClient.js';
import { createFunctionImplicitCurveWorkEnvelope,decodeFunctionImplicitCurveWorkRequest,type FunctionImplicitCurveWorkRequest } from './functionImplicitCurveWorkRequest.js';
import { decodeFunctionImplicitCurveWorkReply } from './functionImplicitCurveWorkReply.js';
import type { FunctionImplicitCurveWorkResult } from './functionImplicitCurveProtocol.js';

export class FunctionImplicitCurveWorkerClient extends BoundedCalculationClient<FunctionImplicitCurveWorkRequest,FunctionImplicitCurveWorkResult> {
  constructor(options:{readonly createWorker:()=>CalculationWorkerPort}){
    super({...options,decodeRequest:decodeFunctionImplicitCurveWorkRequest,createEnvelope:createFunctionImplicitCurveWorkEnvelope,decodeReply:decodeFunctionImplicitCurveWorkReply});
  }
}
