/** Host-validated nonterminal updates for optional scalar mathematics only. */
import { EXACT_MATH_ENGINE_LIMITS, type ExactMathEnginePhase } from './exactMathEngineClient.js';
import { decodeMathRequestIdentity, type MathWorkRequest } from './mathWorkRequest.js';

export interface MathWorkProgress {
  readonly request: MathWorkRequest;
  readonly phase: ExactMathEnginePhase;
}
const phases = ['runtime-loading', 'symbolic-import', 'calculating'] as const;

/** The shared transport uses only the marker; the receiving client verifies every field. */
export function isMathWorkProgress(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return false;
  const descriptor = Object.getOwnPropertyDescriptor(value, 'kind');
  return descriptor !== undefined && Object.hasOwn(descriptor, 'value') && descriptor.value === 'math-phase';
}

export function createMathWorkProgressReceiver(request: MathWorkRequest, serial: number, startedAt: number,
  notify: (value: MathWorkProgress) => void): (value: unknown) => number | null {
  let previous = -1;
  return value => {
    if (!isMathWorkProgress(value)) return null;
    if (value === null || typeof value !== 'object' || Array.isArray(value)
      || request.functionScope !== undefined || request.renameCoefficient !== undefined) {
      throw new Error('Unexpected scalar preparation response');
    }
    const prototype: unknown = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new Error('Invalid progress prototype');
    const fields = ['kind', 'serial', 'identity', 'phase'];
    const keys = Reflect.ownKeys(value);
    if (keys.length !== fields.length || keys.some(key => typeof key !== 'string' || !fields.includes(key))) {
      throw new Error('Invalid progress fields');
    }
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) {
        throw new Error('Invalid progress property');
      }
    }
    if (!('serial' in value) || value.serial !== serial || !('identity' in value) || !('phase' in value)) {
      throw new Error('Progress does not belong to this request');
    }
    const identity = decodeMathRequestIdentity(value.identity);
    if (identity.documentId !== request.identity.documentId || identity.documentVersion !== request.identity.documentVersion
      || identity.editorId !== request.identity.editorId || identity.inputRevision !== request.identity.inputRevision) {
      throw new Error('Progress does not belong to this input generation');
    }
    const phase = phases.find(candidate => candidate === value.phase);
    if (phase === undefined) throw new Error('Unknown progress phase');
    const next = phases.indexOf(phase);
    if (next <= previous) throw new Error('Progress is repeated or out of order');
    // An already prepared engine starts at calculating. Its allowance starts when
    // the host sent the request, not when this notification eventually arrives.
    const warm = previous === -1 && next === 2;
    previous = next;
    const end = next === 2
      ? Math.min(startedAt + EXACT_MATH_ENGINE_LIMITS.totalMs,
        (warm ? startedAt : performance.now()) + EXACT_MATH_ENGINE_LIMITS.calculationMs)
      : startedAt + EXACT_MATH_ENGINE_LIMITS.preparationMs;
    notify({ request, phase });
    return end;
  };
}
