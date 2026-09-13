/** Outward polynomial bounds retain exact decimal coefficients before conversion to binary64. */
import type {CoordinatePolynomial} from './exactCoordinatePolynomial.js';
import {exactDoubleInterval} from './exactDoubleInterval.js';
import {intervalAdd,intervalMultiply,intervalSquare,type MathInterval} from './mathInterval.js';
import type {ExactRational} from './exactRational.js';

function power(value:MathInterval,exponent:number):MathInterval|null {
  if(exponent===0) return {lower:1,upper:1};if(exponent===1) return value;
  const square=intervalSquare(value);if(square.status!=='range') return null;
  if(exponent===2) return square.interval;
  const result=exponent===3?intervalMultiply(square.interval,value):intervalSquare(square.interval);
  return result.status==='range'?result.interval:null;
}
export function coordinatePolynomialInterval(polynomial:CoordinatePolynomial,box:readonly [MathInterval,MathInterval,MathInterval],
  derivativeAxis?:0|1|2):MathInterval|null {
  let sum:MathInterval={lower:0,upper:0};
  for(const [key,coefficient] of polynomial){
    const powers=key.split(',').map(Number);
    if(powers.length!==3 || powers.some(power=>!Number.isSafeInteger(power) || power<0 || power>4)) return null;
    let exact:ExactRational=coefficient;
    if(derivativeAxis!==undefined){
      const exponent=powers[derivativeAxis];if(exponent===0) continue;
      powers[derivativeAxis]--;exact={numerator:coefficient.numerator*BigInt(exponent),denominator:coefficient.denominator};
    }
    let term=exactDoubleInterval(exact);if(term===null) return null;
    if(term.lower===0 && term.upper===0) continue;
    for(let axis=0;axis<3;axis++){
      if(powers[axis]===0) continue;
      const factor=power(box[axis],powers[axis]);if(factor===null) return null;
      if(factor.lower===0 && factor.upper===0){term={lower:0,upper:0};break;}
      const next=intervalMultiply(term,factor);if(next.status!=='range') return null;term=next.interval;
    }
    if(term.lower===0 && term.upper===0) continue;
    if(sum.lower===0 && sum.upper===0){sum=term;continue;}
    const next=intervalAdd(sum,term);if(next.status!=='range') return null;sum=next.interval;
  }
  return Number.isFinite(sum.lower) && Number.isFinite(sum.upper)?sum:null;
}
