import {MathWorkerClient, type MathWorkerPort} from '@pointercad/expression/math/client';
import {
  CANDIDATE_MATH_BY_ID,
  decodeMathWorkReply,
} from '@pointercad/expression/math/contracts';

import {createBrowserMathWorker} from './browserMathWorker.js';

/** One client belongs to one document/editor owner; dispose it when that owner closes. */
export function createBrowserMathClient(createWorker: () => MathWorkerPort = createBrowserMathWorker): MathWorkerClient {
  return new MathWorkerClient({
    createWorker,
    decodeReply: (value, request) => decodeMathWorkReply(value, request, {
      operationsById: CANDIDATE_MATH_BY_ID,
      coefficientIds: new Set(request.coefficients.map(coefficient => coefficient.id)),
      declaredIds: new Set<string>(),
    }),
  });
}
