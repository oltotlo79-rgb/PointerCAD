/** Substitute only explicitly known coordinates; the remaining coordinate stays a variable. */
import {exactAdd,exactMultiply,EXACT_ZERO,type CoordinatePolynomial} from './exactCoordinatePolynomial.js';
import {rational,type ExactRational} from './exactRational.js';
import type {ExactScalarPolynomial} from './exactScalarPolynomial.js';

export function substituteCoordinatePolynomial(polynomial:CoordinatePolynomial,axis:0|1|2,
  coordinates:readonly [ExactRational|null,ExactRational|null,ExactRational|null],shouldStop:()=>boolean):ExactScalarPolynomial|null {
  if(coordinates[axis]!==null || coordinates.some((value,index)=>index!==axis && value===null)) return null;
  const fixed=coordinates.map(value=>value===null?null:rational(value.numerator,value.denominator));
  if(fixed.some((value,index)=>index!==axis && value===null) || polynomial.size>35) return null;
  const result:ExactRational[]=[EXACT_ZERO,EXACT_ZERO,EXACT_ZERO,EXACT_ZERO,EXACT_ZERO];
  for(const [key,coefficient] of polynomial){
    if(shouldStop()) return null;
    if(!/^[0-4],[0-4],[0-4]$/u.test(key)) return null;
    const powers=key.split(',').map(Number);if(powers.reduce((total,value)=>total+value,0)>4) return null;
    let term:ExactRational|null=rational(coefficient.numerator,coefficient.denominator);
    for(const index of [0,1,2]){
      if(index===axis) continue;const value=fixed[index];if(value===null) return null;
      for(let degree=0;degree<powers[index];degree++){if(term===null || shouldStop()) return null;term=exactMultiply(term,value);}
    }
    if(term===null) return null;const total=exactAdd(result[powers[axis]],term);if(total===null) return null;result[powers[axis]]=total;
  }
  while(result.length>0 && result[result.length-1].numerator===0n) result.pop();return result;
}
