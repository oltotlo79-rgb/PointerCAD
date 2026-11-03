import type { MathWorkRequest } from './mathWorkRequest.js';

/** Build the shared request shape while each test supplies its own notation, units and identity. */
export function mathTestRequest(source: string,
  options: Pick<MathWorkRequest, 'notation' | 'angleUnit' | 'identity'>): MathWorkRequest {
  return { source, notation: options.notation, angleUnit: options.angleUnit, coefficients: [], identity: options.identity };
}

/** Preserve the special-function tests' inferred literal notation and original field order. */
export function specialMathTestRequest(source: string, angleUnit: MathWorkRequest['angleUnit'], documentId: string): {
  source: string; angleUnit: MathWorkRequest['angleUnit']; notation: 'text'; coefficients: never[];
  identity: { documentId: string; documentVersion: number; editorId: string; inputRevision: number };
} {
  return { source, angleUnit, notation: 'text', coefficients: [],
    identity: { documentId, documentVersion: 1, editorId: 'coordinate', inputRevision: 1 } };
}
