/** Exact coefficients for the derivatives used by Gamma. */
export const MAX_POLYGAMMA_ORDER = 17;

export function risingInteger(start: number, count: number): bigint {
  let value = 1n;
  for (let index = 0; index < count; index++) value *= BigInt(start+index);
  return value;
}

/** P_0(c)=c, P_(n+1)(c)=-(1+c²)P'_n(c); d^n cot(t)/dt^n=P_n(cot(t)). */
export function cotangentDerivativeCoefficients(order: number): readonly bigint[] {
  let polynomial = [0n, 1n];
  for (let index = 0; index < order; index++) {
    const next = Array<bigint>(polynomial.length+1).fill(0n);
    for (let power = 1; power < polynomial.length; power++) {
      const coefficient = -BigInt(power)*polynomial[power];
      next[power-1] += coefficient; next[power+1] += coefficient;
    }
    polynomial = next;
  }
  return polynomial;
}
