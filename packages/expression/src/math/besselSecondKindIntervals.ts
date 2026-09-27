/** Positive-real Y/K ranges. K is completely monotone; Y uses its ODE with a
 * weighted max-norm Gronwall bound, so internal oscillations are not missed.
 */
import { exactDouble } from './exactDoubleInterval.js';
import { roundBesselRational } from './besselIntegerRounding.js';
import { BESSEL_FIXED_SCALE as S, type BesselFixedRange } from './besselFixedRange.js';
import { secondKindSequence, type SecondBesselKind } from './besselSecondKindNumeric.js';
import { exponentialRange } from './exponentialIntervals.js';
import { intervalAdd, intervalSubtract, intervalMultiply, intervalDivide, nextFloat,
  type MathInterval, type IntervalValue } from './mathInterval.js';

type Range=MathInterval|null;
const point=(value:number):MathInterval=>({lower:value,upper:value});
const unpack=(value:IntervalValue):Range=>value.status==='range'?value.interval:null;
const add=(a:Range,b:Range):Range=>a===null||b===null?null:unpack(intervalAdd(a,b));
const subtract=(a:Range,b:Range):Range=>a===null||b===null?null:unpack(intervalSubtract(a,b));
const multiply=(a:Range,b:Range):Range=>a===null||b===null?null:unpack(intervalMultiply(a,b));
const divide=(a:Range,b:Range):Range=>a===null||b===null?null:unpack(intervalDivide(a,b));
const magnitude=(a:MathInterval):number=>Math.max(Math.abs(a.lower),Math.abs(a.upper));
const proceed=()=>undefined;
function finite(value:Range):Range {
  return value!==null&&Number.isFinite(value.lower)&&Number.isFinite(value.upper)&&value.lower<=value.upper?value:null;
}
function doubleRange(value:BesselFixedRange):Range {
  const seed=Number(roundBesselRational({numerator:value.lower+value.upper,denominator:2n*S}));
  let lower=seed,upper=seed;
  for(let attempt=0;attempt<8;attempt+=1) {
    const lo=exactDouble(lower),hi=exactDouble(upper);if(lo===null||hi===null)return null;
    const below=lo.numerator*S<=value.lower*lo.denominator;
    const above=hi.numerator*S>=value.upper*hi.denominator;
    if(below&&above)return {lower,upper};
    if(!below)lower=nextFloat(lower,-1);if(!above)upper=nextFloat(upper,1);
  }
  return null;
}
function at(kind:SecondBesselKind,maximum:number,x:number,check:()=>void):(order:number)=>Range {
  const input=exactDouble(x);
  if(input===null)return ()=>null;
  const values=secondKindSequence(kind,maximum,input,check).map(doubleRange);
  return order=>{
    const value=values[Math.abs(order)]??null;
    return value!==null&&kind==='Y'&&order<0&&order%2!==0?{lower:-value.upper,upper:-value.lower}:value;
  };
}
function yRanges(order:number,input:MathInterval,check:()=>void):readonly Range[] {
  const center=input.lower/2+input.upper/2,radius=nextFloat(Math.max(center-input.lower,input.upper-center),1);
  const lookup=at('Y',Math.abs(order)+3,center,check);
  const inverse=divide(point(1),point(input.lower));
  return [-2,-1,0,1,2].map(offset=>{
    check();const n=order+offset,value=lookup(n);
    const derivative=multiply(subtract(lookup(n-1),lookup(n+1)),point(0.5));
    if(value===null||derivative===null||inverse===null)return null;
    const weight=Math.max(1,Math.abs(n)/input.lower);
    if(!Number.isFinite(weight))return null;
    // For state (y,y'/w): ||A||_infinity <= max(w, (1+n²/a²)/w+1/a).
    const squaredInverse=multiply(inverse,inverse);
    const secondRow=add(divide(add(point(1),multiply(point(n*n),squaredInverse)),point(weight)),inverse);
    if(secondRow===null)return null;
    const matrixBound=Math.max(weight,secondRow.upper);
    const exponent=multiply(point(matrixBound),point(radius));
    const growth=exponent===null?null:exponentialRange(exponent);
    const scaledDerivative=divide(point(magnitude(derivative)),point(weight));
    if(growth===null||scaledDerivative===null)return null;
    const stateBound=Math.max(magnitude(value),scaledDerivative.upper);
    const variation=multiply(multiply(multiply(point(radius),point(weight)),point(stateBound)),growth);
    return variation===null?null:finite({lower:nextFloat(value.lower-variation.upper,-1),upper:nextFloat(value.upper+variation.upper,1)});
  });
}
function valid(kind:SecondBesselKind,order:number,input:MathInterval):boolean {
  return (kind==='Y'||kind==='K')&&Number.isSafeInteger(order)&&Math.abs(order)<=128
    &&Number.isFinite(input.lower)&&Number.isFinite(input.upper)&&input.lower>0&&input.lower<=input.upper&&input.upper<=128;
}
export interface SecondBesselRanges { readonly value:Range; readonly first:Range; readonly second:Range }
export function secondBesselRanges(kind:SecondBesselKind,order:number,input:MathInterval,
  check:()=>void=proceed):SecondBesselRanges {
  check();if(!valid(kind,order,input))return {value:null,first:null,second:null};
  let values:readonly Range[];
  if(input.lower===input.upper) {
    const lookup=at(kind,Math.abs(order)+2,input.lower,check);values=[-2,-1,0,1,2].map(offset=>lookup(order+offset));
  } else if(kind==='K') {
    const lower=at(kind,Math.abs(order)+2,input.upper,check),upper=at(kind,Math.abs(order)+2,input.lower,check);
    values=[-2,-1,0,1,2].map(offset=>{
      const lo=lower(order+offset),hi=upper(order+offset);return lo===null||hi===null?null:{lower:lo.lower,upper:hi.upper};
    });
  } else values=yRanges(order,input,check);
  const [minusTwo,minusOne,value,plusOne,plusTwo]=values;
  const first=multiply(kind==='Y'?subtract(minusOne,plusOne):add(minusOne,plusOne),point(kind==='Y'?0.5:-0.5));
  const outer=add(minusTwo,plusTwo),middle=multiply(value,point(2));
  const second=multiply(kind==='Y'?subtract(outer,middle):add(outer,middle),point(0.25));
  check();return {value:finite(value),first:finite(first),second:finite(second)};
}
