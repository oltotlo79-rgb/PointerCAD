/** Fixed-point integer intervals: no rounded exponential decides an integer quantile. */
import type { ExactRational } from './exactRational.js';
import { MathInputProblem } from './mathInputContract.js';

type Bounds = readonly [bigint, bigint];
const ceilDivide = (a: bigint, b: bigint): bigint => (a + b - 1n) / b;

/** exp(-lambda) via positive Taylor sums, an explicit geometric tail and outward squares. */
function massAtZero(rate: ExactRational, scale: bigint, check: () => void): Bounds {
  const a = rate.numerator;
  let b = rate.denominator, squares = 0;
  while (2n * a > b) { b *= 2n; squares += 1; }
  let termLow = scale, termHigh = scale, low = scale, high = scale;
  for (let k = 1n; k <= 4096n; k += 1n) {
    check();
    termLow = termLow * a / (b * k);
    termHigh = ceilDivide(termHigh * a, b * k);
    low += termLow; high += termHigh;
    if (termHigh > 2n) continue;
    // Subsequent term ratios are at most r/(k+2), with r=a/b<=1/2.
    const next = ceilDivide(termHigh * a, b * (k + 1n));
    high += ceilDivide(next * b * (k + 2n), b * (k + 2n) - a);
    let lower = scale * scale / high, upper = ceilDivide(scale * scale, low);
    for (let i = 0; i < squares; i += 1) {
      check(); lower = lower * lower / scale; upper = ceilDivide(upper * upper, scale);
    }
    return [lower, upper];
  }
  throw new MathInputProblem('budget', 'ポアソン分布の確率の上下限を確定できませんでした。');
}

function search(rate: ExactRational, target: ExactRational, bits: number, check: () => void): string | null {
  const scale = 1n << BigInt(bits), threshold = target.numerator * scale;
  let [massLow, massHigh] = massAtZero(rate, scale, check);
  let low = 0n, high = 0n;
  for (let k = 0n; k <= 10_000n; k += 1n) {
    check(); low += massLow; high += massHigh;
    if (low * target.denominator >= threshold) return k.toString();
    if (high * target.denominator >= threshold) return null;
    massLow = massLow * rate.numerator / (rate.denominator * (k + 1n));
    massHigh = ceilDivide(massHigh * rate.numerator, rate.denominator * (k + 1n));
  }
  throw new MathInputProblem('budget', 'ポアソン分布の分位点が検索上限10,000回を超えました。');
}

export function poissonQuantile(values: readonly ExactRational[], check: () => void): string {
  const [rate, target] = values;
  // exp(-lambda)>2^(-2lambda); retain target-denominator bits beyond that range.
  const magnitudeBits = Number(ceilDivide(2n * rate.numerator, rate.denominator));
  const targetBits = target.denominator.toString(2).length;
  for (const guard of [128, 384, 1152, 3456]) {
    check();
    const result = search(rate, target, magnitudeBits + targetBits + guard, check);
    if (result !== null) return result;
  }
  throw new MathInputProblem('budget', '確率が分位点の境界に近く、回数を確定できませんでした。');
}
