/** directed second-order jets in the two Legendre parameters (m,n). */
import { intervalAdd, intervalMultiply, intervalDivide, intervalSquare, intervalSqrt,
  type MathInterval, type IntervalValue } from './mathInterval.js';

export type Range = MathInterval;
export interface Jet {
  readonly value: Range;
  readonly first: readonly [Range, Range];
  readonly second: readonly [Range, Range, Range]; // mm, mn, nn
}
export class UnprovedEllipticRange extends Error {}
export const point=(value:number):Range=>({lower:value,upper:value});
export const ZERO=point(0), ONE=point(1);
export const isZero=(value:Range):boolean=>value.lower===0&&value.upper===0;
function unpack(value:IntervalValue):Range {
  if(value.status!=='range'||!Number.isFinite(value.interval.lower)||!Number.isFinite(value.interval.upper))throw new UnprovedEllipticRange();
  return value.interval;
}
export const add=(a:Range,b:Range):Range=>unpack(intervalAdd(a,b));
export const neg=(a:Range):Range=>({lower:-a.upper,upper:-a.lower});
export const sub=(a:Range,b:Range):Range=>add(a,neg(b));
export const mul=(a:Range,b:Range):Range=>isZero(a)||isZero(b)?ZERO:unpack(intervalMultiply(a,b));
// Exact zero divided by a finite, proved nonzero denominator is exact zero.
// Check the denominator before simplifying: 0/0 must remain a domain failure.
export const div=(a:Range,b:Range):Range=>isZero(a)&&Number.isFinite(b.lower)&&Number.isFinite(b.upper)
  &&b.lower<=b.upper&&(b.lower>0||b.upper<0)?ZERO:unpack(intervalDivide(a,b));
export const sq=(a:Range):Range=>isZero(a)?ZERO:unpack(intervalSquare(a));
export const root=(a:Range):Range=>unpack(intervalSqrt(a));
export const factor=(n:number,d=1):Range=>d===1?point(n):div(point(n),point(d));
export const constant=(value:Range):Jet=>({value,first:[ZERO,ZERO],second:[ZERO,ZERO,ZERO]});
export const variable=(value:Range,slot:0|1):Jet=>({value,first:slot===0?[ONE,ZERO]:[ZERO,ONE],second:[ZERO,ZERO,ZERO]});
export function sum(a:Jet,b:Jet):Jet {
  return {value:add(a.value,b.value),first:[add(a.first[0],b.first[0]),add(a.first[1],b.first[1])],
    second:[add(a.second[0],b.second[0]),add(a.second[1],b.second[1]),add(a.second[2],b.second[2])]};
}
export function scale(a:Jet,k:Range):Jet {
  return {value:mul(a.value,k),first:[mul(a.first[0],k),mul(a.first[1],k)],
    second:[mul(a.second[0],k),mul(a.second[1],k),mul(a.second[2],k)]};
}
export function product(a:Jet,b:Jet):Jet {
  const second=(i:0|1,j:0|1,slot:0|1|2)=>add(add(mul(a.second[slot],b.value),mul(a.value,b.second[slot])),
    add(mul(a.first[i],b.first[j]),mul(a.first[j],b.first[i])));
  return {value:mul(a.value,b.value),first:[add(mul(a.first[0],b.value),mul(a.value,b.first[0])),
    add(mul(a.first[1],b.value),mul(a.value,b.first[1]))],second:[second(0,0,0),second(0,1,1),second(1,1,2)]};
}
export function compose(a:Jet,value:Range,first:Range,second:Range):Jet {
  return {value,first:[mul(first,a.first[0]),mul(first,a.first[1])],second:[
    add(mul(second,sq(a.first[0])),mul(first,a.second[0])),
    add(mul(second,mul(a.first[0],a.first[1])),mul(first,a.second[1])),
    add(mul(second,sq(a.first[1])),mul(first,a.second[2]))]};
}
export function square(a:Jet):Jet {return compose(a,sq(a.value),mul(point(2),a.value),point(2));}
export function reciprocal(a:Jet):Jet {
  const squared=sq(a.value);
  return compose(a,div(ONE,a.value),neg(div(ONE,squared)),div(point(2),mul(squared,a.value)));
}
export function squareRoot(a:Jet):Jet {
  if(isZero(a.value)&&[...a.first,...a.second].every(isZero))return constant(ZERO);
  if(a.value.lower<=0)throw new UnprovedEllipticRange();
  const value=root(a.value);
  return compose(a,value,div(ONE,mul(point(2),value)),neg(div(ONE,mul(point(4),mul(a.value,value)))));
}
