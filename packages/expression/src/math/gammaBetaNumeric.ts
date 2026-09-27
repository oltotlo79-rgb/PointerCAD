/** Positive real incomplete Gamma/Beta. Series remainder bounds and positive
 * continued-fraction convergents control truncation; local guard digits control rounding.
 * References: DLMF 5.11.1(ii), 8.7.1, 8.9.2, 8.17.3/4/8.
 */
import Decimal from 'decimal.js';
import { MathInputProblem } from './mathInputContract.js';
import { STIRLING_COEFFICIENTS } from './gammaStirlingCoefficients.js';

export const DistributionDecimal = Decimal.clone({ precision: 80, rounding: Decimal.ROUND_HALF_EVEN });
const D = DistributionDecimal, ONE = new D(1), HALF_LOG_TWO_PI = D.acos(-1).mul(2).ln().div(2);
const TOLERANCE = new D('1e-60'), LOG_TOLERANCE = new D('1e-65');
export function distributionBudget(): never {
  throw new MathInputProblem('budget', '分布の計算が回数または桁数の上限に達しました。条件を小さくするか、端から離して確認してください。');
}
export function logGammaPositive(a: Decimal, check: () => void): Decimal {
  check();
  if (!a.isFinite() || a.lte(0) || a.gt(20_000)) return distributionBudget();
  let z = a, product = ONE;
  for (let n = 0; z.lt(64); n += 1) {
    if ((n & 15) === 0) check();
    product = product.mul(z); z = z.add(1);
  }
  let result = z.sub('0.5').mul(z.ln()).sub(z).add(HALF_LOG_TWO_PI).sub(product.ln());
  const inverse = ONE.div(z), square = inverse.mul(inverse);
  let power = inverse;
  for (const [numerator, denominator] of STIRLING_COEFFICIENTS) {
    const term = new D(numerator).div(denominator).mul(power);
    // For positive real z, the first omitted term bounds the Stirling remainder.
    if (term.abs().lt(LOG_TOLERANCE)) return result;
    result = result.add(term); power = power.mul(square);
  }
  return distributionBudget();
}

interface ProbabilityParts { readonly lower: Decimal; readonly upper: Decimal; readonly density: Decimal }
export function gammaKernel(a: Decimal, check: () => void): (x: Decimal) => ProbabilityParts {
  const logGamma = logGammaPositive(a, check), logGammaNext = logGamma.add(a.ln());
  const shifts = a.ceil().sub(1).toNumber(), base = a.sub(shifts);
  if (shifts > 10_000 || base.lte(0)) return distributionBudget();
  const baseLogGamma = shifts === 0 ? logGamma : logGammaPositive(base, check);
  return (x: Decimal): ProbabilityParts => {
    check();
    if (x.lte(0) || !x.isFinite() || x.gt(1_000_000)) return distributionBudget();
    const logX = x.ln(), factorLog = a.mul(logX).sub(x).sub(logGamma);
    const density = factorLog.sub(logX).exp();
    if (x.lte(a.add(1))) {
      let term = ONE, sum = ONE;
      for (let n = 1; n <= 32_768; n += 1) {
        if ((n & 15) === 0) check();
        term = term.mul(x).div(a.add(n)); sum = sum.add(term);
        const next = x.div(a.add(n+1));
        if (next.lt(1) && term.mul(next).div(ONE.sub(next)).lte(sum.mul(TOLERANCE))) {
          const lower = a.mul(logX).sub(x).sub(logGammaNext).exp().mul(sum);
          if (lower.lte(0) || lower.gt(1)) return distributionBudget();
          return { lower, upper: ONE.sub(lower), density };
        }
      }
      return distributionBudget();
    }
    // Reduce the shape to (0,1]. All numerators in DLMF 8.9.2 are then nonnegative,
    // so adjacent convergents bracket the upper tail. Recurrence adds positive terms.
    let p0 = ONE, p1 = new D(0), q0 = new D(0), q1 = ONE, previous: Decimal | null = null;
    for (let n = 1; n <= 8192; n += 1) {
      if ((n & 15) === 0) check();
      const coefficient = (n === 1 ? ONE : new D(Math.floor(n/2)).sub(n % 2 === 0 ? base : 0)).div(x);
      const p = p1.add(coefficient.mul(p0)), q = q1.add(coefficient.mul(q0));
      p0 = p1; p1 = p; q0 = q1; q1 = q;
      const ratio = p.div(q);
      if (previous !== null && ratio.sub(previous).abs().lte(ratio.abs().mul(TOLERANCE))) {
        const factor = base.mul(logX).sub(x).sub(baseLogGamma).exp();
        let upper = factor.mul(ratio.add(previous).div(2)), term = factor.div(base);
        for (let k = 0; k < shifts; k += 1) {
          if ((k & 31) === 0) check();
          upper = upper.add(term); term = term.mul(x).div(base.add(k+1));
        }
        if (upper.lte(0) || upper.gt(1)) return distributionBudget();
        return { lower: ONE.sub(upper), upper, density };
      }
      previous = ratio;
    }
    return distributionBudget();
  };
}

function betaSeries(a: Decimal, b: Decimal, x: Decimal, y: Decimal, logBeta: Decimal, check: () => void): Decimal {
  const factor = a.mul(x.ln()).add(b.mul(y.ln())).sub(a.ln()).sub(logBeta).exp();
  let term = ONE, sum = ONE;
  for (let n = 1; n <= 32_768; n += 1) {
    if ((n & 15) === 0) check();
    term = term.mul(a.add(b).add(n-1)).mul(x).div(a.add(n)); sum = sum.add(term);
    // Ratios are monotone towards x. Their maximum bounds the remaining geometric sum.
    const ratioBound = D.max(x, x.mul(a.add(b).add(n)).div(a.add(n+1)));
    if (ratioBound.lt(1) && term.mul(ratioBound).div(ONE.sub(ratioBound)).lte(sum.mul(TOLERANCE))) {
      const value = factor.mul(sum);
      if (value.lte(0) || value.gt(1)) return distributionBudget();
      return value;
    }
  }
  return distributionBudget();
}
export function betaKernel(a: Decimal, b: Decimal, check: () => void): {
  readonly logBeta: Decimal;
  readonly at: (x: Decimal, y?: Decimal) => ProbabilityParts;
} {
  const logBeta = logGammaPositive(a, check).add(logGammaPositive(b, check)).sub(logGammaPositive(a.add(b), check));
  const pivot = a.add(1).div(a.add(b).add(2));
  return { logBeta, at: (x: Decimal, y = ONE.sub(x)): ProbabilityParts => {
    check();
    if (x.lte(0) || y.lte(0) || x.gt(1) || y.gt(1)) return distributionBudget();
    const density = a.sub(1).mul(x.ln()).add(b.sub(1).mul(y.ln())).sub(logBeta).exp();
    const lowerSide = x.lte(pivot), small = lowerSide ? betaSeries(a, b, x, y, logBeta, check) : betaSeries(b, a, y, x, logBeta, check);
    return { lower: lowerSide ? small : ONE.sub(small), upper: lowerSide ? ONE.sub(small) : small, density };
  } };
}
