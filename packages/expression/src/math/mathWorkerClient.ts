/** Scalar-input adapter for the shared bounded, cancellable calculation queue. */
import type { MathWorkResult } from './mathWorkReply.js';
import { decodeMathWorkRequest, createMathWorkEnvelope, type MathRequestIdentity, type MathWorkRequest } from './mathWorkRequest.js';
import { BoundedCalculationClient, type CalculationCompletion, type CalculationClientOptions } from './boundedCalculationClient.js';
export type { MathRequestIdentity, MathWorkRequest } from './mathWorkRequest.js';
export type { CalculationWorkerPort as MathWorkerPort } from './boundedCalculationClient.js';
export type MathWorkCompletion = CalculationCompletion<MathWorkResult>;
export type MathWorkerClientOptions = Pick<CalculationClientOptions<MathWorkRequest, MathWorkResult>, 'createWorker' | 'decodeReply'>;

export class MathWorkerClient extends BoundedCalculationClient<MathWorkRequest, MathWorkResult> {
  constructor(options: MathWorkerClientOptions) {
    super({ ...options, decodeRequest: decodeMathWorkRequest, createEnvelope: createMathWorkEnvelope });
  }
}

export function sameMathIdentity(left: MathRequestIdentity, right: MathRequestIdentity): boolean {
  return left.documentId === right.documentId && left.documentVersion === right.documentVersion
    && left.editorId === right.editorId && left.inputRevision === right.inputRevision;
}
