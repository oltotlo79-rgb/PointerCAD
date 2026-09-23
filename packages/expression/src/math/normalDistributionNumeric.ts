/** Normal tails use positive series / Laplace convergents, not 1 minus a rounded CDF.
 * Formula references: NIST DLMF 7.6.2 and 7.9.1 (transformed to standard normal z).
 * Guard digits are local: they never change the shared decimal arithmetic settings.
 */
import Decimal from 'decimal.js';
import { MathInputProblem } from './mathInputContract.js';
import { type ExactRational } from './exactRational.js';
import { exact, subtract, divide, compare } from './statisticsData.js';

const D = Decimal.clone({ precision: 80, rounding: Decimal.ROUND_HALF_EVEN });
const HALF = new D('0.5'), ONE = new D(1), SQRT_TWO_PI = D.acos(-1).mul(2).sqrt();
const SERIES_TOLERANCE = new D('1e-60'), INVERSE_TOLERANCE = new D('1e-50');
const decimal = (value: ExactRational): Decimal => new D(value.numerator.toString()).div(value.denominator.toString());
function budget(): never { throw new MathInputProblem('budget', '正規分布の計算が回数または桁数の上限に達しました。'); }
interface NormalParts { readonly density: Decimal; readonly center: Decimal | null; readonly tail: Decimal }

export function positiveNormal(x: Decimal, check: () => void): NormalParts {
  check();
  if (!x.isFinite() || x.lt(0) || x.gt(1_000_000)) return budget();
  const square = x.mul(x), density = square.div(-2).exp().div(SQRT_TWO_PI);
  if (density.isZero() || !density.isFinite()) return budget();
  if (x.isZero()) return { density, center: new D(0), tail: HALF };
  if (x.lt(4)) {
    let term = x, sum = x;
    for (let n = 1; n <= 2048; n += 1) {
      if ((n & 15) === 0) check();
      const ratio = square.div(2*n+1);
      term = term.mul(ratio); sum = sum.add(term);
      // Subsequent ratios decrease. Once ratio < 1/2, the remaining sum is < 2*term.
      if (ratio.lt(HALF) && term.lte(sum.mul(SERIES_TOLERANCE))) {
        const center = density.mul(sum);
        return { density, center, tail: HALF.sub(center) };
      }
    }
    return budget();
  }
  // R(x)=Q(x)/phi(x)=1/(x+1/(x+2/(x+3/(...)))). Positive consecutive
  // convergents bracket R. Never replace a small Q with a fixed zero.
  let previousNumerator = ONE, numerator = new D(0), previousDenominator = new D(0), denominator = ONE;
  let previous: Decimal | null = null;
  for (let n = 1; n <= 4096; n += 1) {
    if ((n & 15) === 0) check();
    const coefficient = n === 1 ? 1 : n-1;
    const nextNumerator = x.mul(numerator).add(previousNumerator.mul(coefficient));
    const nextDenominator = x.mul(denominator).add(previousDenominator.mul(coefficient));
    previousNumerator = numerator; numerator = nextNumerator;
    previousDenominator = denominator; denominator = nextDenominator;
    const ratio = numerator.div(denominator);
    if (previous !== null && ratio.sub(previous).abs().lte(ratio.abs().mul(SERIES_TOLERANCE))) {
      return { density, center: null, tail: density.mul(ratio.add(previous).div(2)) };
    }
    previous = ratio;
  }
  return budget();
}

function positiveQuantile(probability: ExactRational, check: () => void): Decimal {
  const half = exact(1n, 2n), isLower = compare(probability, half) < 0;
  // Subtract BEFORE converting to a decimal: 1-1e-1000 must not become 1.
  const q = isLower ? probability : subtract(exact(1n), probability);
  const delta = subtract(half, q), target = decimal(compare(q, exact(1n, 4n)) <= 0 ? q : delta);
  const tail = compare(q, exact(1n, 4n)) <= 0;
  let lower = new D(0), upper = tail ? target.ln().mul(-2).sqrt() : ONE;
  let x = tail ? upper.sub(upper.ln().add(SQRT_TWO_PI.ln()).div(upper)) : target.mul(SQRT_TWO_PI);
  if (x.lte(lower) || x.gte(upper)) x = lower.add(upper).div(2);
  for (let n = 0; n < 128; n += 1) {
    check();
    const parts = positiveNormal(x, check), value = tail ? parts.tail : parts.center;
    if (value === null) return budget();
    const residual = value.sub(target);
    if (residual.abs().lte(target.mul(INVERSE_TOLERANCE))) return isLower ? x.neg() : x;
    if (tail ? residual.gt(0) : residual.lt(0)) lower = x; else upper = x;
    const proposal = tail ? x.add(residual.div(parts.density)) : x.sub(residual.div(parts.density));
    x = proposal.gt(lower) && proposal.lt(upper) ? proposal : lower.add(upper).div(2);
  }
  return budget();
}

export function normalDistributionDecimal(id: string, parameters: readonly ExactRational[], check: () => void): string {
  const [mean, deviation, position] = parameters;
  let result: Decimal;
  if (id === 'normal-quantile') {
    const median = compare(position, exact(1n, 2n)) === 0;
    result = median ? decimal(mean) : decimal(mean).add(decimal(deviation).mul(positiveQuantile(position, check)));
    // The inverse is numerical. A mean cancelling all guard digits cannot certify zero.
    if (!median && result.isZero()) {
      throw new MathInputProblem('budget', '位置の計算で有効な桁が失われたため、0と確定できません。平均を0にして位置を確認してください。');
    }
  } else {
    const standardized = divide(subtract(position, mean), deviation), z = decimal(standardized);
    const parts = positiveNormal(z.abs(), check);
    result = id === 'normal-pdf' ? parts.density.div(decimal(deviation))
      : z.isNegative() ? parts.tail : ONE.sub(parts.tail);
    if (result.isZero()) return budget();
  }
  check();
  if (!result.isFinite()) return budget();
  // Keep guard digits until the usual coordinate conversion. Underflow is refused there.
  return result.toString();
}
