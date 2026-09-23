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

function arithmetic(scale: bigint, check: () => void) {
  const multiply = (a: Range, b: Range): Range => {
    const products = [a.lower*b.lower, a.lower*b.upper, a.upper*b.lower, a.upper*b.upper];
    return { lower: floor(products.reduce((x,y) => x<y?x:y), scale), upper: ceil(products.reduce((x,y) => x>y?x:y), scale) };
  };
  function exponential(value: bigint): Range {
    check();
    if (value === 0n) return { lower: scale, upper: scale };
    const magnitude = value < 0n ? -value : value;
    if (magnitude > 8192n*scale) return budget();
    let denominator = scale, squares = 0;
    while (2n*magnitude > denominator) { denominator *= 2n; squares++; }
    let lower = scale, upper = scale, termLower = scale, termUpper = scale;
    for (let n = 1; n <= 4096; n++) {
      if ((n & 15) === 0) check();
      const divisor = denominator*BigInt(n);
      termLower = floor(termLower*magnitude, divisor);
      termUpper = ceil(termUpper*magnitude, divisor);
      lower += termLower; upper += termUpper;
      // All later ratios are <= r/(n+1). The geometric bound includes
      // every omitted term, in addition to all directed arithmetic errors.
      const tail = ceil(termUpper*magnitude, denominator*BigInt(n+1)-magnitude);
      if (tail > 1n) continue;
      let result = { lower, upper: upper+tail };
      // Inverting before repeated squaring avoids loss of tiny negative tails.
      if (value < 0n) result = { lower: floor(scale*scale,result.upper), upper: ceil(scale*scale,result.lower) };
      for (let index=0;index<squares;index++) { check(); result=multiply(result,result); }
      return result;
    }
    return budget();
  }
  return (value: bigint): Range => multiply({lower:value,upper:value},exponential(value));
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
  const scale=10n**BigInt(digits), value=arithmetic(scale,check);
  const compare=(range:Range): -1|0|1 => range.upper*q<p*scale ? -1 : range.lower*q>p*scale ? 1 : 0;
  if (p<0n) {
    const atBranch=compare(value(-scale));
    if (atBranch===1) throw new MathInputProblem('domain', '実数のLambert Wには-1/e以上の値が必要です。');
    if (atBranch===0) return budget(); // Exact -1/e is resolved symbolically before this rational kernel.
  }
  return {p,q,scale,value,compare};
}

export function validateLambertArgument(branch: RealLambertBranch, argument: ExactRational, check: () => void): void {
  prepareArgument(branch,argument,check);
}

export function lambertWBounds(branch: RealLambertBranch, argument: ExactRational, check: () => void): LambertWBounds {
  const {p,q,scale,value,compare}=prepareArgument(branch,argument,check);
  if (p===0n) return {lower:argument,upper:argument,decimal:'0',iterations:0};
  let lower:bigint,upper:bigint;
  if (branch===-1) {
    upper=-scale;lower=-2n*scale;
    while (compare(value(lower))!==1) { lower*=2n;check(); }
  } else if (p<0n) {
    lower=4n*(-p)<=q ? floor(2n*p*scale,q) : -scale;
    upper=ceil(p*scale,q);
  } else if (p<=q) {
    // For 0<=t<1, exp(t)<=1/(1-t), hence x/(1+x)<=W_0(x)<=x.
    lower=floor(p*scale,q+p);upper=ceil(p*scale,q);
  } else {
    lower=0n;upper=scale;
    while (compare(value(upper))!==1) { upper*=2n;check(); }
  }
  for(let iteration=0;iteration<1024;iteration++) {
    check();
    const left={numerator:lower,denominator:scale},right={numerator:upper,denominator:scale};
    const decimal=roundBesselRational(left);
    if(decimal===roundBesselRational(right)) return {lower:left,upper:right,decimal,iterations:iteration};
    const middle=floor(lower+upper,2n);
    if(middle<=lower||middle>=upper) return budget();
    const direction=compare(value(middle));
    if(direction===0) return budget();
    if(branch===0 ? direction<0 : direction>0) lower=middle;else upper=middle;
  }
  return budget();
}
