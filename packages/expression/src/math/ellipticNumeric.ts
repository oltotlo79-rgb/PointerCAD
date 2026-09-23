/** Legendre integrals with parameter m=k^2, not modulus k. Real ordinary integrals.
 * DLMF 19.2/19.25; periodic extension is allowed only when the whole path is real
 * and has no pole. A Cauchy principal value is never substituted for divergence.
 */
import Decimal from 'decimal.js';
import type { ExactRational } from './exactRational.js';
import { MathInputProblem } from './mathInputContract.js';
import { roundBesselRational } from './besselIntegerRounding.js';
import { carlsonRF,carlsonRD,carlsonRJ } from './carlsonSymmetric.js';
import { ellipticSquare } from './ellipticFixed.js';
import { reduceEllipticAmplitude } from './ellipticAmplitude.js';
import { BESSEL_FIXED_SCALE as S, FIXED_ZERO, FIXED_ONE, fixedRational, fixedAdd, fixedSubtract,
  fixedMultiply, fixedTimesRational, fixedNegate, type BesselFixedRange as Range } from './besselFixedRange.js';

export type EllipticKind='K'|'E'|'F'|'Einc'|'Pi'|'Piinc';
export interface EllipticBounds { readonly lower:ExactRational;readonly upper:ExactRational;readonly decimal:string }
const abs=(value:bigint)=>value<0n?-value:value;
function validate(value:ExactRational):void {
  if(value.denominator<=0n||abs(value.numerator).toString(2).length>8192||value.denominator.toString(2).length>8192) {
    throw new MathInputProblem('budget','楕円積分の引数を正確に保持できません。');
  }
}
function rounded(value:Range):EllipticBounds {
  const lower={numerator:value.lower,denominator:S},upper={numerator:value.upper,denominator:S};
  const result=roundBesselRational(lower);
  if(result!==roundBesselRational(upper))throw new MathInputProblem('budget','楕円積分を必要な桁数で確定できません。');
  return {lower,upper,decimal:new Decimal(result).toString()};
}
function positive(value:Range):Range {
  if(value.upper<=0n)throw new MathInputProblem('domain','積分する途中で値が実数でなくなるか、分母が0になります。');
  if(value.lower<=0n)throw new MathInputProblem('budget','積分する範囲の境界を必要な桁数で確定できません。');
  return value;
}
function complete(kind:'K'|'E'|'Pi',m:ExactRational,n:ExactRational,check:()=>void,domainOnly=false):Range {
  if(m.numerator>m.denominator||(m.numerator===m.denominator&&kind!=='E')) {
    throw new MathInputProblem('domain','完全楕円積分の実数の範囲では母数mを1未満にしてください。第二種は1も使えます。');
  }
  if(kind==='Pi'&&n.numerator>=n.denominator) {
    throw new MathInputProblem('domain','完全な第三種楕円積分はnが1以上で発散します。主値へは置き換えません。');
  }
  if(kind==='E'&&m.numerator===m.denominator)return FIXED_ONE;
  const y=positive(fixedRational(m.denominator-m.numerator,m.denominator));
  const p=kind==='Pi'?positive(fixedRational(n.denominator-n.numerator,n.denominator)):FIXED_ONE;
  // Domain validation shares every boundary check but does not calculate a value.
  if(domainOnly)return FIXED_ZERO;
  const rf=carlsonRF(FIXED_ZERO,y,FIXED_ONE,check);
  if(kind==='E')return fixedSubtract(rf,fixedTimesRational(carlsonRD(FIXED_ZERO,y,FIXED_ONE,check),m.numerator,3n*m.denominator));
  if(kind==='Pi'&&n.numerator!==0n) {
    return fixedAdd(rf,fixedTimesRational(carlsonRJ(FIXED_ZERO,y,FIXED_ONE,p,check),n.numerator,3n*n.denominator));
  }
  return rf;
}
function incomplete(kind:'F'|'Einc'|'Piinc',amplitude:ExactRational,m:ExactRational,n:ExactRational,check:()=>void,piMultiple:boolean,domainOnly=false):Range {
  if(amplitude.numerator===0n)return FIXED_ZERO;
  const {negative,turns:low,beforeHalf,sine,cosine}=reduceEllipticAmplitude(amplitude,piMultiple,check);
  const restricted=m.numerator>m.denominator||(m.numerator===m.denominator&&kind!=='Einc')
    ||(kind==='Piinc'&&n.numerator>=n.denominator);
  if(restricted&&beforeHalf===false) {
    throw new MathInputProblem('domain','積分する途中の発散や実数でない範囲を越えることはできません。');
  }
  if(restricted&&beforeHalf===null) {
    throw new MathInputProblem('budget','積分する角度と境界の順序を確定できません。');
  }
  let partial:Range;
  if(kind==='Einc'&&m.numerator===m.denominator) {
    if(domainOnly)return FIXED_ZERO;
    partial=sine;
  }
  else {
    const square=ellipticSquare(sine);
    const y=positive(fixedSubtract(FIXED_ONE,fixedTimesRational(square,m.numerator,m.denominator)));
    const x=ellipticSquare(cosine);
    const p=kind==='Piinc'?positive(fixedSubtract(FIXED_ONE,fixedTimesRational(square,n.numerator,n.denominator))):FIXED_ONE;
    if(domainOnly)return FIXED_ZERO;
    const rf=carlsonRF(x,y,FIXED_ONE,check);
    partial=fixedMultiply(sine,rf);
    if(kind==='Einc')partial=fixedSubtract(partial,fixedTimesRational(
      fixedMultiply(fixedMultiply(sine,square),carlsonRD(x,y,FIXED_ONE,check)),m.numerator,3n*m.denominator));
    if(kind==='Piinc'&&n.numerator!==0n) {
      partial=fixedAdd(partial,fixedTimesRational(
        fixedMultiply(fixedMultiply(sine,square),carlsonRJ(x,y,FIXED_ONE,p,check)),n.numerator,3n*n.denominator));
    }
  }
  const total=low===0n?partial:fixedAdd(partial,fixedTimesRational(
    complete(kind==='F'?'K':kind==='Einc'?'E':'Pi',m,n,check),2n*low));
  return negative?fixedNegate(total):total;
}
/** F/Einc(phi,m), Piinc(n,phi,m), K/E(m), Pi(n,m). Angles here are radians. */
function calculate(kind:EllipticKind,args:readonly ExactRational[],check:()=>void,amplitudePiMultiple:boolean,domainOnly:boolean):Range {
  check();args.forEach(validate);
  const expected=kind==='K'||kind==='E'?1:kind==='Piinc'?3:2;
  if(args.length!==expected)throw new MathInputProblem('domain','楕円積分の引数の数が一致しません。');
  const m=args[args.length-1],n=kind==='Pi'||kind==='Piinc'?args[0]:{numerator:0n,denominator:1n};
  const result=kind==='K'||kind==='E'||kind==='Pi'?complete(kind,m,n,check,domainOnly)
    :incomplete(kind,args[kind==='Piinc'?1:0],m,n,check,amplitudePiMultiple,domainOnly);
  check();return result;
}
/** Validate the original path without paying for the RF/RD/RJ value twice. */
export function validateEllipticDomain(kind:EllipticKind,args:readonly ExactRational[],check:()=>void,amplitudePiMultiple=false):void {
  calculate(kind,args,check,amplitudePiMultiple,true);
}
export function ellipticValue(kind:EllipticKind,args:readonly ExactRational[],check:()=>void,amplitudePiMultiple=false):EllipticBounds {
  return rounded(calculate(kind,args,check,amplitudePiMultiple,false));
}
