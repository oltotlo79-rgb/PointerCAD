/** Scalar-input adapter for the shared bounded, cancellable calculation queue. */
import type { MathWorkResult } from './mathWorkReply.js';
import { decodeMathWorkRequest, createMathWorkEnvelope, type MathRequestIdentity, type MathWorkRequest } from './mathWorkRequest.js';
import { BoundedCalculationClient, type CalculationCompletion, type CalculationClientOptions } from './boundedCalculationClient.js';
import { EXACT_MATH_ENGINE_LIMITS } from './exactMathEngineClient.js';
import { createMathWorkProgressReceiver, type MathWorkProgress } from './mathWorkProgress.js';
export type { MathRequestIdentity, MathWorkRequest } from './mathWorkRequest.js';
export type { CalculationWorkerPort as MathWorkerPort } from './boundedCalculationClient.js';
export type MathWorkCompletion = CalculationCompletion<MathWorkResult>;
export type MathWorkerClientOptions = Pick<CalculationClientOptions<MathWorkRequest, MathWorkResult>, 'createWorker' | 'decodeReply'>;

export class MathWorkerClient extends BoundedCalculationClient<MathWorkRequest, MathWorkResult> {
  private readonly progressListeners: Set<(value: MathWorkProgress) => void>;
  constructor(options: MathWorkerClientOptions) {
    const listeners = new Set<(value: MathWorkProgress) => void>();
    super({ ...options, decodeRequest: decodeMathWorkRequest, createEnvelope: createMathWorkEnvelope,
      progress: { maximumDurationMs: EXACT_MATH_ENGINE_LIMITS.totalMs,
        createReceiver: (request, serial, startedAt) => createMathWorkProgressReceiver(request, serial, startedAt,
          value => { for (const listener of listeners) listener(value); }),
      },
    });
    this.progressListeners = listeners;
  }
  subscribeProgress(listener: (value: MathWorkProgress) => void): () => void {
    this.progressListeners.add(listener);
    return () => { this.progressListeners.delete(listener); };
  }
  override dispose(): void {
    this.progressListeners.clear();
    super.dispose();
  }
}

export function sameMathIdentity(left: MathRequestIdentity, right: MathRequestIdentity): boolean {
  return left.documentId === right.documentId && left.documentVersion === right.documentVersion
    && left.editorId === right.editorId && left.inputRevision === right.inputRevision;
}
