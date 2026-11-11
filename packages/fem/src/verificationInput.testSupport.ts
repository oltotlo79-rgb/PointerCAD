import type { VerificationValue } from './verificationComparison.testSupport.js';

/** Convert fixture-owned inputs to the finite JSON values accepted by verification. */
export function verificationData(value: unknown): VerificationValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(verificationData);
  if (typeof value === 'object' && value !== null) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, verificationData(item)]));
  throw new Error('Invalid verification input value');
}
