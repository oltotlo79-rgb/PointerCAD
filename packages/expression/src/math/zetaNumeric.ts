/** Real Riemann zeta by Euler–Maclaurin with its periodic Bernoulli remainder.
 * DLMF 25.2.9 and 24.9.1. All arithmetic and the complete remainder are enclosed.
 */
import Decimal from 'decimal.js';
import type { ExactRational } from './exactRational.js';
import { MathInputProblem } from './mathInputContract.js';
import { besselLog } from './besselConstants.js';
import { roundBesselRational } from './besselIntegerRounding.js';
import { ZETA_COEFFICIENTS } from './zetaCoefficients.js';
import { fixedRealExponential } from './fixedRealExponential.js';
import { BESSEL_FIXED_SCALE as S,FIXED_ONE,fixedAdd,fixedTimesRational,
  fixedWiden,fixedRational,type BesselFixedRange as Range } from './besselFixedRange.js';

export interface ZetaBounds {readonly lower:ExactRational;readonly upper:ExactRational;readonly decimal:string;readonly corrections:number}
const abs=(value:bigint)=>value<0n?-value:value;
const logarithms=new Map<number,Range>();
const N=128;
export function validateZetaArgument(input:ExactRational):void {
  const {numerator:p,denominator:q}=input;
  if(q<=0n||abs(p).toString(2).length>8192||q.toString(2).length>8192) {
    throw new MathInputProblem('budget','ゼータ関数の引数を正確に保持できません。');
  }
  if(p===q)throw new MathInputProblem('domain','ゼータ関数は引数1で発散します。');
  if(p < -32n*q||p>128n*q)throw new MathInputProblem('budget','ゼータ関数のこの計算では引数を−32から128の範囲にしてください。');
}
function rounded(range:Range,corrections:number):ZetaBounds|null {
  const lower={numerator:range.lower,denominator:S},upper={numerator:range.upper,denominator:S};
  const result=roundBesselRational(lower);
  if(result!==roundBesselRational(upper))return null;
  return {lower,upper,decimal:new Decimal(result).toString(),corrections};
}
function exactInteger(input:ExactRational):ZetaBounds|null {
  const {numerator:p,denominator:q}=input;
  if(p>0n||p%q!==0n)return null;
  const n=Number(-p/q);
  let value:ExactRational;
  if(n===0)value={numerator:-1n,denominator:2n};
  else if(n%2===0)value={numerator:0n,denominator:1n};
  else {
    const coefficient=ZETA_COEFFICIENTS[(n-1)/2];
    let factorial=1n;for(let k=2;k<=n;k++)factorial*=BigInt(k);
    // zeta(-n) = -B_(n+1)/(n+1) for odd n.
    value={numerator:-BigInt(coefficient[0])*factorial,denominator:BigInt(coefficient[1])};
  }
  return {lower:value,upper:value,decimal:new Decimal(roundBesselRational(value)).toString(),corrections:0};
}
function inversePower(base:number,input:ExactRational,check:()=>void):Range {
  if(base===1)return FIXED_ONE;
  // Integer powers are exact rationals. Avoid hundreds of log/exp terms for
  // ordinary saved coefficients such as zeta(2), without changing the remainder.
  if(input.numerator%input.denominator===0n) {
    check();const exponent=input.numerator/input.denominator;
    const power=BigInt(base)**abs(exponent);
    return exponent<0n?fixedRational(power):fixedRational(1n,power);
  }
  let logarithm=logarithms.get(base);
  if(logarithm===undefined) {
    logarithm=besselLog({numerator:BigInt(base),denominator:1n},check);logarithms.set(base,logarithm);
  }
  return fixedRealExponential(fixedTimesRational(logarithm,-input.numerator,input.denominator),check);
}
export function zetaValue(input:ExactRational,check:()=>void):ZetaBounds {
  check();validateZetaArgument(input);
  const integer=exactInteger(input);if(integer!==null)return integer;
  const {numerator:p,denominator:q}=input,power=inversePower(N,input,check);
  let sum=fixedTimesRational(power,1n,2n);
  const pole=abs(p-q);
  sum=fixedAdd(sum,fixedTimesRational(power,BigInt(N)*q*(p<q?-1n:1n),pole));
  for(let k=1;k<N;k++) {check();sum=fixedAdd(sum,inversePower(k,input,check));}
  // Combine N powers with the rising factorial before applying its exact
  // Bernoulli coefficient, avoiding artificial underflow in separate factors.
  let term=fixedTimesRational(power,p,q*BigInt(N));
  for(const [index,coefficient] of ZETA_COEFFICIENTS.entries()) {
    check();const m=index+1;
    const correction=fixedTimesRational(term,BigInt(coefficient[0]),BigInt(coefficient[1]));
    sum=fixedAdd(sum,correction);
    if(p+BigInt(2*m-1)*q>0n) {
      // Integrating the absolute periodic Bernoulli bound cancels the last
      // positive rising-factorial factor. The LAST included term bounds R.
      const error=abs(correction.lower)>abs(correction.upper)?abs(correction.lower):abs(correction.upper);
      const answer=rounded(fixedWiden(sum,error),m);
      if(answer!==null) {check();return answer;}
    }
    term=fixedTimesRational(term,p+BigInt(2*m-1)*q,q*BigInt(N));
    term=fixedTimesRational(term,p+BigInt(2*m)*q,q*BigInt(N));
  }
  throw new MathInputProblem('budget','ゼータ関数を必要な桁数で確定できません。');
}
