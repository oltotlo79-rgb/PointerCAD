/** Reuse the checked Gamma/Beta kernels while retaining exact complementary and central probabilities. */
import type Decimal from 'decimal.js';
import type { ExactRational } from './exactRational.js';
import { exact, add, subtract, multiply, divide, compare } from './statisticsData.js';
import { DistributionDecimal as D, distributionBudget, betaKernel, logGammaPositive } from './gammaBetaNumeric.js';
import { gammaBetaDistributionDecimal } from './gammaBetaDistributionNumeric.js';

const ONE = new D(1), HALF = exact(1n,2n);
const decimal = (value: ExactRational): Decimal => new D(value.numerator.toString()).div(value.denominator.toString());
function betaInverse(a: ExactRational,b: ExactRational,p: ExactRational,check: () => void): Decimal {
  return new D(gammaBetaDistributionDecimal('beta-quantile',[a,b,p],check));
}
export function testDistributionDecimal(id: string, values: readonly ExactRational[], check: () => void): string {
  const [first,second,third] = values, halfFirst = multiply(first,HALF);
  if (id.startsWith('chi-square-')) return gammaBetaDistributionDecimal(id.replace('chi-square-','gamma-'),[halfFirst,exact(2n),second],check);
  const f = id.startsWith('f-'), inverse = id.endsWith('-quantile'), x = f ? third : second;
  const a = decimal(halfFirst);
  let result: Decimal;
  if (f) {
    const halfSecond = multiply(second,HALF), b = decimal(halfSecond);
    if (inverse) {
      const upper = compare(x,HALF)>0, p = upper ? subtract(exact(1n),x) : x;
      const small = upper ? betaInverse(halfSecond,halfFirst,p,check) : betaInverse(halfFirst,halfSecond,p,check);
      result = decimal(divide(second,first)).mul(upper ? ONE.sub(small).div(small) : small.div(ONE.sub(small)));
    } else {
      const nx = multiply(first,x), total = add(nx,second);
      const z = decimal(divide(nx,total)), y = decimal(divide(second,total));
      const kernel = betaKernel(a,b,check);
      result = id === 'f-cdf' ? kernel.at(z,y).lower
        : a.mul(z.ln()).add(b.mul(y.ln())).sub(decimal(x).ln()).sub(kernel.logBeta).exp();
    }
  } else if (inverse) {
    const negative = compare(x,HALF)<0, q = negative ? x : subtract(exact(1n),x);
    // Central probabilities need their exact difference from 1/2, not a rounded 2q.
    const tail = compare(q,exact(1n,4n))<=0;
    const p = multiply(exact(2n),tail ? q : subtract(HALF,q));
    const z = tail ? betaInverse(halfFirst,HALF,p,check) : betaInverse(HALF,halfFirst,p,check);
    result = decimal(first).mul(tail ? ONE.sub(z).div(z) : z.div(ONE.sub(z))).sqrt();
    if (negative) result = result.neg();
  } else {
    const squared = multiply(x,x), total = add(first,squared);
    if (id === 't-cdf') {
      const tail = betaKernel(a,new D('0.5'),check).at(decimal(divide(first,total)),decimal(divide(squared,total))).lower.div(2);
      result = compare(x,exact(0n))<0 ? tail : ONE.sub(tail);
    } else {
      result = logGammaPositive(a.add('0.5'),check).sub(logGammaPositive(a,check))
        .sub(D.acos(-1).mul(decimal(first)).ln().div(2))
        .sub(a.add('0.5').mul(decimal(divide(total,first)).ln())).exp();
    }
  }
  check();
  if (!result.isFinite() || result.isZero()) return distributionBudget();
  return result.toSignificantDigits(40).toString();
}
