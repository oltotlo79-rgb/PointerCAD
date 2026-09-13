import { BoundedCalculationClient, type CalculationWorkerPort } from './boundedCalculationClient.js';
import { createFunctionSurfaceWorkEnvelope, decodeFunctionSurfaceWorkRequest, type FunctionSurfaceWorkRequest } from './functionSurfaceWorkRequest.js';
import { decodeFunctionSurfaceWorkReply } from './functionSurfaceWorkReply.js';
import type { FunctionSurfaceWorkResult } from './functionSurfaceWorkExecution.js';

export class FunctionSurfaceWorkerClient extends BoundedCalculationClient<FunctionSurfaceWorkRequest,FunctionSurfaceWorkResult> {
  constructor(options: { readonly createWorker: () => CalculationWorkerPort }) {
    super({...options,decodeRequest:decodeFunctionSurfaceWorkRequest,createEnvelope:createFunctionSurfaceWorkEnvelope,decodeReply:decodeFunctionSurfaceWorkReply});
  }
}
export type { FunctionSurfaceWorkRequest } from './functionSurfaceWorkRequest.js';
