import {MathWorkerClient} from '@pointercad/expression/math/client';
import {
  CANDIDATE_MATH_BY_ID,
  decodeMathWorkReply,
} from '@pointercad/expression/math/contracts';

import {browserMathWorker} from './browserMathWorker.js';

/** One client belongs to one document/editor owner; dispose it when that owner closes. */
export function createBrowserMathClient(): MathWorkerClient {
  return new MathWorkerClient({
    createWorker: () => browserMathWorker(new Worker(new URL('./math.worker.ts', import.meta.url), {type: 'module'})),
    decodeReply: (value, request) => decodeMathWorkReply(value, request, {
      operationsById: CANDIDATE_MATH_BY_ID,
      coefficientIds: new Set(request.coefficients.map(coefficient => coefficient.id)),
      declaredIds: new Set<string>(),
    }),
  });
}
