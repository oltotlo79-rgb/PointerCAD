import { CANDIDATE_MATH_BY_ID } from './mathOperations.js';
import { executeMathWorkRequest, type MathExecutionBackend } from './mathWorkExecution.js';
import { decodeMathWorkReply, type MathWorkResult } from './mathWorkReply.js';
import type { MathWorkRequest } from './mathWorkerClient.js';

/** Borrow the current backend at the call site; build decode context after execution. */
export function evaluateMathInput(input: MathWorkRequest, backend: MathExecutionBackend): MathWorkResult {
  const raw = executeMathWorkRequest({ kind: 'evaluate-math', serial: 1, request: input }, backend);
  return decodeMathWorkReply(raw, input, {
    operationsById: CANDIDATE_MATH_BY_ID,
    coefficientIds: new Set(),
    declaredIds: new Set(),
  }).result;
}
