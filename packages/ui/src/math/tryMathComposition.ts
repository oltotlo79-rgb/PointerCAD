import { MathInputProblem } from '@pointercad/expression/math/contracts';

/** Only expected mathematical input failures become editable UI errors; programming faults still surface. */
export function tryMathComposition<T>(calculate: () => T):
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly message: string } {
  try { return { ok: true, value: calculate() }; }
  catch (error) {
    if (!(error instanceof MathInputProblem)) throw error;
    return { ok: false, message: error.message };
  }
}
