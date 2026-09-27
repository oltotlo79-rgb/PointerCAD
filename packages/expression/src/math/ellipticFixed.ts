/** Directed arithmetic for real elliptic integrals; no floating-point domain decisions. */
import { MathInputProblem } from './mathInputContract.js';
import { BESSEL_FIXED_SCALE as S, FIXED_ONE, fixedMultiply, fixedAdd, fixedTimesRational,
  fixedWiden, ceilQuotient, type BesselFixedRange as Range } from './besselFixedRange.js';

function integerSqrt(value:bigint,check:()=>void):bigint {
  if(value<0n)throw new MathInputProblem('domain','楕円積分の平方根が実数ではありません。');
  if(value<2n)return value;
  let result=1n<<BigInt(Math.ceil(value.toString(2).length/2));
  for(;;) {
    check();const next=(result+value/result)/2n;
    if(next>=result)return result;
    result=next;
  }
}
export function ellipticSqrt(value:Range,check:()=>void):Range {
  const lower=integerSqrt(value.lower*S,check),upper=integerSqrt(value.upper*S,check);
  return {lower,upper:upper*upper===value.upper*S?upper:upper+1n};
}
export function ellipticSquare(value:Range):Range {
  if(value.lower<=0n&&value.upper>=0n) {
    const magnitude=-value.lower>value.upper?-value.lower:value.upper;
    return {lower:0n,upper:ceilQuotient(magnitude*magnitude,S)};
  }
  return fixedMultiply(value,value);
}
/** |r|<=2. All Taylor remainder terms are included using their geometric majorant. */
export function ellipticSinCos(r:Range,cosine:boolean,check:()=>void):Range {
  const magnitude=-r.lower>r.upper?-r.lower:r.upper;
  if(magnitude>2n*S)throw new MathInputProblem('budget','楕円積分の角度を縮小できません。');
  const squared=ellipticSquare(r);
  let term=cosine?FIXED_ONE:r,sum=term;
  for(let k=0;k<512;k++) {
    check();
    const a=2*k+(cosine?1:2),divisor=BigInt(a*(a+1));
    const absolute=-term.lower>term.upper?-term.lower:term.upper;
    if(divisor*S>squared.upper) {
      const tail=ceilQuotient(absolute*squared.upper,divisor*S-squared.upper);
      if(tail<=10n**40n)return fixedWiden(sum,tail);
    }
    term=fixedTimesRational(fixedMultiply(term,squared),-1n,divisor);
    sum=fixedAdd(sum,term);
  }
  throw new MathInputProblem('budget','楕円積分の角度を必要な桁数で確定できません。');
}
