import type Decimal from 'decimal.js';
import type { ExactRational } from './exactRational.js';
import { exact, subtract, divide, compare } from './statisticsData.js';
import { DistributionDecimal as D, distributionBudget, gammaKernel, betaKernel, logGammaPositive } from './gammaBetaNumeric.js';

const ONE = new D(1), INVERSE_TOLERANCE = new D('1e-50');
const decimal = (value: ExactRational): Decimal => new D(value.numerator.toString()).div(value.denominator.toString());
function gammaQuantile(a: Decimal, probability: ExactRational, check: () => void): Decimal {
  const tail = compare(probability, exact(1n, 2n)) > 0;
  const target = decimal(tail ? subtract(exact(1n), probability) : probability), at = gammaKernel(a, check);
  let lower = new D(0), upper = D.max(1, a);
  for (let n = 0; n < 128; n += 1) {
    const parts = at(upper);
    if (tail ? parts.upper.lte(target) : parts.lower.gte(target)) break;
    upper = upper.mul(2);
    if (n === 127) return distributionBudget();
  }
  const logGamma = logGammaPositive(a, check), logTarget = target.ln();
  // For a far upper tail, starting at the bracket midpoint can need thousands of
  // unit-sized Newton steps. This asymptotic starting point is still bracketed and
  // must pass the same residual check; it never substitutes for the answer.
  let x = tail ? logTarget.neg().add(a.sub(1).mul(logTarget.neg().ln())).sub(logGamma)
    : logTarget.add(logGamma).add(a.ln()).div(a).exp();
  if (x.lte(lower) || x.gte(upper)) x = lower.add(upper).div(2);
  for (let n = 0; n < 256; n += 1) {
    check();
    const parts = at(x), residual = (tail ? parts.upper : parts.lower).sub(target);
    if (residual.abs().lte(target.mul(INVERSE_TOLERANCE))) return x;
    if (tail ? residual.gt(0) : residual.lt(0)) lower = x; else upper = x;
    const proposal = tail ? x.add(residual.div(parts.density)) : x.sub(residual.div(parts.density));
    const next = proposal.gt(lower) && proposal.lt(upper) ? proposal : lower.add(upper).div(2);
    if (next.eq(x)) return distributionBudget();
    x = next;
  }
  return distributionBudget();
}
function betaQuantile(a: Decimal, b: Decimal, probability: ExactRational, check: () => void): Decimal {
  const reflect = compare(probability, exact(1n, 2n)) > 0;
  const target = decimal(reflect ? subtract(exact(1n), probability) : probability);
  const first = reflect ? b : a, second = reflect ? a : b, kernel = betaKernel(first, second, check);
  let lower = new D(0), upper = ONE;
  let x = target.ln().add(first.ln()).add(kernel.logBeta).div(first).exp();
  if (x.lte(lower) || x.gte(upper)) x = first.div(first.add(second));
  for (let n = 0; n < 256; n += 1) {
    check();
    const parts = kernel.at(x), residual = parts.lower.sub(target);
    if (residual.abs().lte(target.mul(INVERSE_TOLERANCE))) {
      const result = reflect ? ONE.sub(x) : x;
      if (result.lte(0) || result.gte(1)) return distributionBudget();
      return result;
    }
    if (residual.lt(0)) lower = x; else upper = x;
    const proposal = x.sub(residual.div(parts.density));
    const next = proposal.gt(lower) && proposal.lt(upper) ? proposal : lower.add(upper).div(2);
    if (next.eq(x)) return distributionBudget();
    x = next;
  }
  return distributionBudget();
}
export function gammaBetaDistributionDecimal(id: string, parameters: readonly ExactRational[], check: () => void): string {
  const [first, second, position] = parameters, a = decimal(first), b = decimal(second);
  const beta = id.startsWith('beta-');
  let result: Decimal;
  if (id.endsWith('-quantile')) {
    result = beta ? betaQuantile(a, b, position, check) : gammaQuantile(a, position, check).mul(b);
  } else if (id.endsWith('-pdf')) {
    const x = decimal(beta ? position : divide(position, second));
    const logGamma = logGammaPositive(a, check);
    result = beta ? a.sub(1).mul(x.ln()).add(b.sub(1).mul(decimal(subtract(exact(1n), position)).ln()))
      .sub(logGamma).sub(logGammaPositive(b, check)).add(logGammaPositive(a.add(b), check)).exp()
      : a.sub(1).mul(x.ln()).sub(x).sub(logGamma).sub(b.ln()).exp();
  } else {
    const parts = beta ? betaKernel(a, b, check).at(decimal(position), decimal(subtract(exact(1n), position)))
      : gammaKernel(a, check)(decimal(divide(position, second)));
    result = parts.lower;
  }
  check();
  if (!result.isFinite() || result.lte(0)) return distributionBudget();
  // The extra 40 digits are internal guards, not additional trustworthy output.
  // Match the shared scalar precision only after the series/inverse has converged.
  const rounded = result.toSignificantDigits(40);
  if (beta && id.endsWith('-quantile') && rounded.gte(1)) return distributionBudget();
  return rounded.toString();
}
