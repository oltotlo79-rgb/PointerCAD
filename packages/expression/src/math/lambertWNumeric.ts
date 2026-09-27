/** Real W_0 and W_-1, DLMF 4.13.1. Directed bounds retain both branches.
 * Every decision uses bounds for w*exp(w), never a rounded residual.
 */
import type { ExactRational } from './exactRational.js';
import { MathInputProblem } from './mathInputContract.js';
import { roundBesselRational } from './besselIntegerRounding.js';

export type RealLambertBranch = 0 | -1;
interface Range { readonly lower: bigint; readonly upper: bigint }
export interface LambertWBounds {
  readonly lower: ExactRational; readonly upper: ExactRational;
  readonly decimal: string; readonly iterations: number;
}
const floor = (a: bigint, b: bigint): bigint => a / b - (a % b < 0n ? 1n : 0n);
const ceil = (a: bigint, b: bigint): bigint => -floor(-a, b);
const budget = (): never => { throw new MathInputProblem('budget', 'Lambert Wの値を計算の上限内で確定できません。'); };

/** Directed bounds of work*exp(magnitude/scale) for magnitude>=0.
 * The result is at least work, so its relative precision is set by work alone
 * and never by the size of the fixed-point grid used for w.
 */
function growth(magnitude: bigint, scale: bigint, work: bigint, check: () => void): Range {
  if (magnitude === 0n) return { lower: work, upper: work };
  if (magnitude > 8192n*scale) return budget();
  let denominator = scale, squares = 0;
  while (2n*magnitude > denominator) { denominator *= 2n; squares++; }
  // r=magnitude/denominator<=1/2, rounded outward once to the working places.
  const ratioLower = floor(magnitude*work, denominator), ratioUpper = ceil(magnitude*work, denominator);
  let lower = work, upper = work, termLower = work, termUpper = work;
  for (let n = 1; n <= 4096; n++) {
    if ((n & 15) === 0) check();
    const divisor = work*BigInt(n);
    termLower = floor(termLower*ratioLower, divisor);
    termUpper = ceil(termUpper*ratioUpper, divisor);
    lower += termLower; upper += termUpper;
    // All later ratios are <= r/(n+1). The geometric bound includes
    // every omitted term, in addition to all directed arithmetic errors.
    const tail = ceil(termUpper*ratioUpper, work*BigInt(n+1)-ratioUpper);
    if (tail > 1n) continue;
    let result = { lower, upper: upper+tail };
    for (let index=0;index<squares;index++) {
      check();
      result = { lower: floor(result.lower*result.lower, work), upper: ceil(result.upper*result.upper, work) };
    }
    return result;
  }
  return budget();
}

/** Sign of w*exp(w)-p/q at w=value/scale: -1 below, 1 above, 0 undecided.
 * Both sides are multiplied by the positive q*scale*exp(|w|) (w<0) or
 * q*scale (w>0), so tiny arguments never need a grid-sized exponential.
 */
function signedResidual(p: bigint, q: bigint, scale: bigint, work: bigint, check: () => void) {
  return (value: bigint): -1|0|1 => {
    check();
    if (value === 0n) return p>0n ? -1 : p<0n ? 1 : 0;
    const e = growth(value<0n ? -value : value, scale, work, check);
    let low: bigint, high: bigint;
    if (value > 0n) {
      const target = p*scale*work;
      low = value*q*e.lower-target; high = value*q*e.upper-target;
    } else {
      const left = value*q*work, a = p*scale*e.lower, b = p*scale*e.upper;
      low = left-(a>b?a:b); high = left-(a<b?a:b);
    }
    return high<0n ? -1 : low>0n ? 1 : 0;
  };
}

function prepareArgument(branch: RealLambertBranch, argument: ExactRational, check: () => void) {
  check();
  if (branch !== 0 && branch !== -1) throw new MathInputProblem('unsupported', '実数のLambert Wの枝は0または-1で指定してください。');
  const { numerator: p, denominator: q } = argument;
  if (q<=0n || (p<0n?-p:p).toString(2).length>8192 || q.toString(2).length>8192) return budget();
  if (branch===-1 && p>=0n) throw new MathInputProblem('domain', 'Lambert Wの枝-1には-1/e以上で0未満の値を指定してください。');
  // Keep input fractions exact. Extra places let tiny nonzero arguments stay
  // nonzero and distinguish rational points very close to -1/e.
  const digits=Math.max(120,q.toString().length+120);
  if (digits>2600) return budget();
  // The residual is decided relative to |x|. The places beyond the input's own
  // size keep at least the relative precision of an absolute grid of digits.
  const places=digits-Math.max(0,q.toString().length-(p<0n?-p:p).toString().length)+16;
  const scale=10n**BigInt(digits), compare=signedResidual(p,q,scale,10n**BigInt(places),check);
  if (p<0n) {
    const atBranch=compare(-scale);
    if (atBranch===1) throw new MathInputProblem('domain', '実数のLambert Wには-1/e以上の値が必要です。');
    if (atBranch===0) return budget(); // Exact -1/e is resolved symbolically before this rational kernel.
  }
  return {p,q,scale,compare};
}

export function validateLambertArgument(branch: RealLambertBranch, argument: ExactRational, check: () => void): void {
  prepareArgument(branch,argument,check);
}

export function lambertWBounds(branch: RealLambertBranch, argument: ExactRational, check: () => void): LambertWBounds {
  const {p,q,scale,compare}=prepareArgument(branch,argument,check);
  if (p===0n) return {lower:argument,upper:argument,decimal:'0',iterations:0};
  let lower:bigint,upper:bigint;
  if (branch===-1) {
    upper=-scale;lower=-2n*scale;
    while (compare(lower)!==1) { lower*=2n;check(); }
  } else if (p<0n) {
    lower=4n*(-p)<=q ? floor(2n*p*scale,q) : -scale;
    upper=ceil(p*scale,q);
  } else if (p<=q) {
    // For 0<=t<1, exp(t)<=1/(1-t), hence x/(1+x)<=W_0(x)<=x.
    lower=floor(p*scale,q+p);upper=ceil(p*scale,q);
  } else {
    lower=0n;upper=scale;
    while (compare(upper)!==1) { upper*=2n;check(); }
  }
  for(let iteration=0;iteration<1024;iteration++) {
    check();
    const left={numerator:lower,denominator:scale},right={numerator:upper,denominator:scale};
    const decimal=roundBesselRational(left);
    if(decimal===roundBesselRational(right)) return {lower:left,upper:right,decimal,iterations:iteration};
    const middle=floor(lower+upper,2n);
    if(middle<=lower||middle>=upper) return budget();
    const direction=compare(middle);
    if(direction===0) return budget();
    if(branch===0 ? direction<0 : direction>0) lower=middle;else upper=middle;
  }
  return budget();
}
