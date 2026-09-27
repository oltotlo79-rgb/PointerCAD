/** Enclosed log, pi and Euler's constant. No decimal constants are treated as exact. */
import type { ExactRational } from './exactRational.js';
import { STIRLING_COEFFICIENTS } from './gammaStirlingCoefficients.js';
import { MathInputProblem } from './mathInputContract.js';
import { BESSEL_FIXED_SCALE as S, FIXED_ZERO, fixedRational, fixedAdd, fixedSubtract,
  fixedTimesRational, fixedWiden, ceilQuotient, type BesselFixedRange } from './besselFixedRange.js';

/** 2*atanh((x-1)/(x+1)), for 1<=x<=2. Geometric bound includes all omitted terms. */
function logMantissa(p: bigint, q: bigint, check: () => void): BesselFixedRange {
  if (p === q) return FIXED_ZERO;
  const a = p-q, b=p+q, square=a*a, denominator=b*b;
  let power=fixedRational(a,b), sum=FIXED_ZERO;
  for (let k=0;k<1024;k+=1) {
    check(); sum=fixedAdd(sum,fixedTimesRational(power,2n,BigInt(2*k+1)));
    power=fixedTimesRational(power,square,denominator);
    const tail=ceilQuotient(2n*power.upper*denominator,BigInt(2*k+3)*(denominator-square));
    if (tail<=4n) return {lower:sum.lower,upper:sum.upper+tail};
  }
  throw new MathInputProblem('budget','Bessel関数の対数を必要な桁数で確定できません。');
}
function arctangentInverse(q: bigint, check: () => void): BesselFixedRange {
  let power=q, sum=FIXED_ZERO;
  for (let k=0;k<1024;k+=1) {
    check();
    const term=fixedRational(k%2===0?1n:-1n,BigInt(2*k+1)*power);
    sum=fixedAdd(sum,term); power*=q*q;
    const tail=ceilQuotient(S,BigInt(2*k+3)*power);
    if (tail<=1n) return fixedWiden(sum,tail);
  }
  throw new MathInputProblem('budget','Bessel関数の円周率を必要な桁数で確定できません。');
}
interface Constants { readonly pi: BesselFixedRange; readonly gamma: BesselFixedRange; readonly ln2: BesselFixedRange }
let cached: Constants | undefined;
export function besselConstants(check: () => void): Constants {
  check(); if(cached!==undefined)return cached;
  const ln2=logMantissa(2n,1n,check);
  // Machin's identity, with an alternating-series remainder for both arctangents.
  const pi=fixedSubtract(fixedTimesRational(arctangentInverse(5n,check),16n),
    fixedTimesRational(arctangentInverse(239n,check),4n));
  const n=8192n;
  let harmonic=FIXED_ZERO;
  for(let k=1n;k<=n;k+=1n) { if(k%64n===0n)check(); harmonic=fixedAdd(harmonic,fixedRational(1n,k)); }
  // gamma = H_N-log(N)-1/(2N)+sum B_(2k)/(2k*N^(2k)).
  // DLMF 5.11.2/5.11(ii): the next term bounds the positive-real remainder.
  let gamma=fixedSubtract(fixedSubtract(harmonic,fixedTimesRational(ln2,13n)),fixedRational(1n,2n*n));
  let power=n*n;
  for(const [index,coefficient] of STIRLING_COEFFICIENTS.entries()) {
    check();
    const numerator=BigInt(coefficient[0])*BigInt(2*index+1), denominator=BigInt(coefficient[1])*power;
    if(index===STIRLING_COEFFICIENTS.length-1) {
      const error=ceilQuotient((numerator<0n?-numerator:numerator)*S,denominator);
      gamma=fixedWiden(gamma,error);
    } else gamma=fixedAdd(gamma,fixedRational(numerator,denominator));
    power*=n*n;
  }
  check(); cached={pi,gamma,ln2};return cached;
}

export function besselLog(input: ExactRational, check: () => void): BesselFixedRange {
  check();
  let p=input.numerator,q=input.denominator;
  if(p<=0n||q<=0n)throw new MathInputProblem('domain','Bessel関数の対数には正の引数が必要です。');
  let shift=p.toString(2).length-q.toString(2).length;
  if(shift>=0)q<<=BigInt(shift);else p<<=BigInt(-shift);
  if(p<q) { p*=2n;shift-=1; }
  return fixedAdd(logMantissa(p,q,check),fixedTimesRational(besselConstants(check).ln2,BigInt(shift)));
}
