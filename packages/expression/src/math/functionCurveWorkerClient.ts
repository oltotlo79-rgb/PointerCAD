import { BoundedCalculationClient, type CalculationWorkerPort } from './boundedCalculationClient.js';
import { createFunctionCurveWorkEnvelope, decodeFunctionCurveWorkRequest, type FunctionCurveWorkRequest } from './functionCurveWorkRequest.js';
import { decodeFunctionCurveWorkReply } from './functionCurveWorkReply.js';
import type { FunctionCurveWorkResult } from './functionCurveWorkExecution.js';

/** Uses exactly the same termination, bounded queue and stale-Worker protection as scalar input. */
export class FunctionCurveWorkerClient extends BoundedCalculationClient<FunctionCurveWorkRequest, FunctionCurveWorkResult> {
  constructor(options: { readonly createWorker: () => CalculationWorkerPort }) {
    super({ ...options, decodeRequest: decodeFunctionCurveWorkRequest, createEnvelope: createFunctionCurveWorkEnvelope,
      decodeReply: decodeFunctionCurveWorkReply });
  }
}
export type { FunctionCurveWorkRequest } from './functionCurveWorkRequest.js';
