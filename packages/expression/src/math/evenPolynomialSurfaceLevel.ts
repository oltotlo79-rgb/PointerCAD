/** A same-sign sum of even monomials is zero only where every summand is zero.
 * A pure U term and a pure V term therefore certify the sole point U=V=0.
 * Mixed terms alone certify no isolated point: U²V²=0 includes two whole axes.
 */
import {exactAdd,exactNegative,EXACT_ZERO,type CoordinatePolynomial} from './exactCoordinatePolynomial.js';
import {exactDouble} from './exactDoubleInterval.js';
import type {ParameterBox} from './bivariateIntervalNewton.js';
import type {QuadraticSurfaceLevel} from './quadraticSurfaceLevel.js';

export function evenPolynomialSurfaceLevel(polynomial:CoordinatePolynomial,level:number,domain:ParameterBox,
  shouldStop:()=>boolean):QuadraticSurfaceLevel {
  const unresolved:QuadraticSurfaceLevel={status:'unresolved'};
  const exactLevel=exactDouble(level);if(exactLevel===null||shouldStop())return unresolved;
  const offset=exactAdd(polynomial.get('0,0,0')??EXACT_ZERO,exactNegative(exactLevel));if(offset===null)return unresolved;
  let sign=0n,pureU=false,pureV=false;
  for(const [key,value]of polynomial){
    if(shouldStop())return unresolved;
    if(key==='0,0,0'||value.numerator===0n)continue;
    const powers=key.split(',').map(Number);
    if(powers.length!==3||powers[2]!==0||powers.some(power=>!Number.isSafeInteger(power)||power<0||power%2!==0))return unresolved;
    const next=value.numerator>0n?1n:-1n;
    if(sign!==0n&&sign!==next)return unresolved;sign=next;
    pureU ||= powers[0]>0&&powers[1]===0;pureV ||= powers[1]>0&&powers[0]===0;
  }
  if(sign===0n)return unresolved;
  const shifted=offset.numerator*sign;
  if(shifted>0n)return {status:'empty'};
  if(shifted!==0n||!pureU||!pureV)return unresolved;
  if(domain.some(range=>range.lower>0||range.upper<0))return {status:'empty'};
  return {status:'points',boxes:[[{lower:0,upper:0},{lower:0,upper:0}]]};
}
