/** A shared, exact-rational period decision for numeric input and plot enclosures. */
import type { ExactRational } from './exactRational.js';
import { MathInputProblem } from './mathInputContract.js';
import { besselConstants } from './besselConstants.js';
import { ellipticSinCos } from './ellipticFixed.js';
import { FIXED_ZERO,FIXED_ONE,fixedRational,fixedTimesRational,fixedSubtract,floorQuotient,
  type BesselFixedRange } from './besselFixedRange.js';

export interface EllipticAmplitude {
  readonly negative:boolean;
  readonly turns:bigint;
  readonly beforeHalf:boolean|null;
  readonly angle:BesselFixedRange;
  readonly sine:BesselFixedRange;
  readonly cosine:BesselFixedRange;
}
export function reduceEllipticAmplitude(amplitude:ExactRational,piMultiple:boolean,check:()=>void):EllipticAmplitude {
  const magnitude=amplitude.numerator<0n?-amplitude.numerator:amplitude.numerator;
  const pi=besselConstants(check).pi,half=fixedTimesRational(pi,1n,2n);
  const phi=piMultiple?fixedTimesRational(pi,magnitude,amplitude.denominator):fixedRational(magnitude,amplitude.denominator);
  const beforeHalf=piMultiple?2n*magnitude<amplitude.denominator
    :phi.upper<half.lower?true:phi.lower>=half.upper?false:null;
  const low=piMultiple?floorQuotient(2n*magnitude+amplitude.denominator,2n*amplitude.denominator)
    :floorQuotient(2n*phi.lower+pi.upper,2n*pi.upper);
  const high=piMultiple?low:floorQuotient(2n*phi.upper+pi.lower,2n*pi.lower);
  if(low!==high)throw new MathInputProblem('budget','楕円積分の周期を必要な桁数で確定できません。');
  const coefficient=magnitude-low*amplitude.denominator;
  const reduced=piMultiple?fixedTimesRational(pi,coefficient,amplitude.denominator):fixedSubtract(phi,fixedTimesRational(pi,low));
  const atZero=piMultiple&&coefficient===0n,atHalf=piMultiple&&2n*(coefficient<0n?-coefficient:coefficient)===amplitude.denominator;
  const sine=atZero||magnitude===0n?FIXED_ZERO:atHalf?fixedRational(coefficient<0n?-1n:1n):ellipticSinCos(reduced,false,check);
  const cosine=atZero||magnitude===0n?FIXED_ONE:atHalf?FIXED_ZERO:ellipticSinCos(reduced,true,check);
  return {negative:amplitude.numerator<0n,turns:low,beforeHalf,angle:reduced,sine,cosine};
}
