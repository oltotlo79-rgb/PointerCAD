import { functionPreparationProgress } from './functionPreparationProgress.js';
import { BoundedCalculationClient, type CalculationWorkerPort } from './boundedCalculationClient.js';
import { createFunctionSurfaceWorkEnvelope, decodeFunctionSurfaceWorkRequest, type FunctionSurfaceWorkRequest } from './functionSurfaceWorkRequest.js';
import { beginFunctionSurfaceWorkReply, decodeFunctionSurfaceWorkReply } from './functionSurfaceWorkReply.js';
import type { FunctionSurfaceWorkResult } from './functionSurfaceWorkExecution.js';

/**
 * A surface reply carries up to the whole certified mesh and spline, and its certificate is recomputed here: the
 * client checks the envelope first (another request's reply is refused unread) and then decodes and verifies the
 * rest in short slices, so the page keeps handling input, cancellation and new requests meanwhile.
 */
export class FunctionSurfaceWorkerClient extends BoundedCalculationClient<FunctionSurfaceWorkRequest,FunctionSurfaceWorkResult> {
  constructor(options: { readonly createWorker: () => CalculationWorkerPort }) {
    super({ progress: functionPreparationProgress(),...options,decodeRequest:decodeFunctionSurfaceWorkRequest,createEnvelope:createFunctionSurfaceWorkEnvelope,
      decodeReply:decodeFunctionSurfaceWorkReply,beginReply:beginFunctionSurfaceWorkReply});
  }
}
export type { FunctionSurfaceWorkRequest } from './functionSurfaceWorkRequest.js';
