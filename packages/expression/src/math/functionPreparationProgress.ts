/** Geometry opts into the same finite preparation budget only for an ODE-bearing request. */
import { EXACT_MATH_ENGINE_LIMITS } from './exactMathEngineClient.js';
import { createBoundedMathProgressReceiver } from './mathWorkProgress.js';
import type { CalculationRequest } from './boundedCalculationClient.js';

function containsProblem(request: CalculationRequest): boolean {
  const pending: unknown[] = [request], seen = new Set<object>();
  let remaining = 65_536;
  while (pending.length > 0) {
    if (--remaining < 0) throw new Error('Function preparation input exceeds its bound');
    const value = pending.pop();
    if (value === null || typeof value !== 'object' || seen.has(value)) continue;
    seen.add(value);
    const fields = Object.getOwnPropertyDescriptors(value);
    if (fields.operation?.value === 'solve-ode' || fields.operation?.value === 'ode-value') return true;
    for (const field of Object.values(fields)) {
      if (!Object.hasOwn(field, 'value')) throw new Error('Invalid function preparation property');
      pending.push(field.value);
    }
  }
  return false;
}
export function functionPreparationProgress() {
  return {
    maximumDurationMs: EXACT_MATH_ENGINE_LIMITS.totalMs,
    createReceiver: (request: CalculationRequest, serial: number, startedAt: number) =>
      createBoundedMathProgressReceiver(request.identity, serial, startedAt, containsProblem(request), () => undefined),
  };
}
