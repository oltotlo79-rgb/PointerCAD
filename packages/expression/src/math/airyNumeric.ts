/** Real Airy Ai/Bi and their derivatives, DLMF 9.2/9.4.
 * Directed series arithmetic includes all tails before rounding to 40 digits.
 */
import Decimal from 'decimal.js';
import type { ExactRational } from './exactRational.js';
import { MathInputProblem } from './mathInputContract.js';
import { roundBesselRational } from './besselIntegerRounding.js';
import { airyInitialValues } from './airyConstants.js';
import { BESSEL_FIXED_SCALE as S, FIXED_ONE, fixedRational, fixedAdd, fixedMultiply,
  fixedTimesRational, fixedWiden, ceilQuotient, type BesselFixedRange as Range } from './besselFixedRange.js';

export type AiryKind='Ai'|'Bi';
export interface AiryBounds { readonly lower:ExactRational; readonly upper:ExactRational; readonly decimal:string }
export interface AiryValues { readonly value:AiryBounds; readonly first:AiryBounds; readonly terms:number }
// A resource bound of this series kernel, not a mathematical domain boundary.
export const AIRY_ARGUMENT_LIMIT=32;
const abs=(value:bigint)=>value<0n?-value:value;
function validate(input:ExactRational):void {
  if(input.denominator<=0n||abs(input.numerator).toString(2).length>8192||input.denominator.toString(2).length>8192) {
    throw new MathInputProblem('budget','Airy関数の引数を正確に保持できません。');
  }
  if(abs(input.numerator)>BigInt(AIRY_ARGUMENT_LIMIT)*input.denominator) {
    throw new MathInputProblem('budget','Airy関数のこの計算では引数の絶対値を32以下にしてください。');
  }
}
function basis(which:0|1,derivative:0|1,input:ExactRational,check:()=>void):{range:Range;terms:number} {
  const p=input.numerator,q=input.denominator,power=p*p*p,denominator=q*q*q;
  let term=derivative===0?(which===0?FIXED_ONE:fixedRational(p,q))
    :which===0?fixedRational(p*p,2n*q*q):FIXED_ONE;
  let sum=term;
  for(let k=0;k<1024;k++) {
    check();
    const a=derivative===0?3*k+which+3:3*k+(which===0?3:1);
    const b=derivative===0?a-1:a+2;
    const divisor=denominator*BigInt(a)*BigInt(b);
    if(divisor>2n*abs(power)) {
      const magnitude=abs(term.lower)>abs(term.upper)?abs(term.lower):abs(term.upper);
      const tail=ceilQuotient(magnitude*abs(power),divisor-abs(power));
      if(tail<=10n**60n)return {range:fixedWiden(sum,tail),terms:k+1};
    }
    term=fixedTimesRational(term,power,divisor);sum=fixedAdd(sum,term);
  }
  throw new MathInputProblem('budget','Airy関数の級数を計算の上限内で確定できません。');
}
function rounded(value:Range):AiryBounds {
  const lower={numerator:value.lower,denominator:S},upper={numerator:value.upper,denominator:S};
  const result=roundBesselRational(lower);
  if(result!==roundBesselRational(upper))throw new MathInputProblem('budget','Airy関数の値を必要な桁数で確定できません。');
  // String conversion retains all digits and matches the public scalar presentation.
  return {lower,upper,decimal:new Decimal(result).toString()};
}
export function airyValues(kind:AiryKind,input:ExactRational,check:()=>void):AiryValues {
  check();validate(input);
  const [a,b]=airyInitialValues(check)[kind];
  const f=basis(0,0,input,check),g=basis(1,0,input,check);
  const df=basis(0,1,input,check),dg=basis(1,1,input,check);
  const value=rounded(fixedAdd(fixedMultiply(a,f.range),fixedMultiply(b,g.range)));
  const first=rounded(fixedAdd(fixedMultiply(a,df.range),fixedMultiply(b,dg.range)));
  check();return {value,first,terms:f.terms+g.terms+df.terms+dg.terms};
}
