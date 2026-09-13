/** A unique scalar root must exist for every intermediate edit, not only at its two endpoints. */
import {coordinatePolynomialInterval} from './coordinatePolynomialInterval.js';
import {substituteCoordinatePolynomial} from './substituteCoordinatePolynomial.js';
import {exactDouble} from './exactDoubleInterval.js';
import type {CoordinatePolynomial} from './exactCoordinatePolynomial.js';
import type {MathInterval} from './mathInterval.js';

export function proveScalarPointPath(polynomial:CoordinatePolynomial,
  input:{readonly before:MathInterval;readonly after:MathInterval;readonly domain:MathInterval;readonly tolerance:number},
  shouldStop:()=> 'cancelled'|'deadline'|undefined):boolean|'cancelled'|'deadline' {
  const {before,after,domain,tolerance}=input,fixed=after.lower;
  if(fixed===after.upper && fixed===before.lower && fixed===before.upper) {
    const alongEdit=substituteCoordinatePolynomial(polynomial,1,[exactDouble(fixed),null,exactDouble(0)],()=>shouldStop()!==undefined);
    const derivative=coordinatePolynomialInterval(polynomial,[{lower:fixed,upper:fixed},{lower:0,upper:1},{lower:0,upper:0}],0);
    if(alongEdit!==null && alongEdit.every(value=>value.numerator===0n) && derivative!==null
      && (derivative.lower>0 || derivative.upper<0)) return true;
  }
  const low=Math.min(before.lower,after.lower),high=Math.max(before.upper,after.upper),width=Math.max(high-low,tolerance);
  for(const factor of [1/16,1/8,1/4,1/2,1,2,4]) {
    const stopped=shouldStop();if(stopped) return stopped;
    const lower=Math.max(domain.lower,low-width*factor),upper=Math.min(domain.upper,high+width*factor);
    if(!Number.isFinite(lower) || !Number.isFinite(upper) || lower>=upper) continue;
    const box=(range:MathInterval):readonly [MathInterval,MathInterval,MathInterval]=>[range,{lower:0,upper:1},{lower:0,upper:0}];
    const derivative=coordinatePolynomialInterval(polynomial,box({lower,upper}),0);
    if(derivative===null || (derivative.lower<=0 && derivative.upper>=0)) continue;
    const left=coordinatePolynomialInterval(polynomial,box({lower,upper:lower})),right=coordinatePolynomialInterval(polynomial,box({lower:upper,upper}));
    if(left!==null && right!==null && (derivative.lower>0?left.upper<=0 && right.lower>=0:left.lower>=0 && right.upper<=0)) return true;
  }
  return false;
}
