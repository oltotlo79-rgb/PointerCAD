/** exp enclosures use a finite Taylor sum, its explicit tail, and directed basic arithmetic. */
import {intervalAdd,intervalSubtract,intervalMultiply,intervalDivide,intervalSquare,
  type MathInterval,type IntervalValue} from './mathInterval.js';

const ONE:MathInterval={lower:1,upper:1};
const point=(value:number):MathInterval=>({lower:value,upper:value});
function unpack(value:IntervalValue):MathInterval|null{return value.status==='range'?value.interval:null;}

function exponentialPoint(value:number):MathInterval|null {
  if(Number.isNaN(value))return null;
  if(value===0)return ONE;
  if(value===-Infinity)return point(0);
  if(value===Infinity)return point(Infinity);
  // e>2 proves these outer bounds; no rounded Math.exp result is used as evidence.
  if(value>2048)return {lower:Number.MAX_VALUE,upper:Infinity};
  if(value< -2048)return {lower:0,upper:Number.MIN_VALUE};
  let reduced=Math.abs(value),squares=0;
  // Division by 2 is exact here: subnormals already satisfy reduced<=1/2.
  while(reduced>0.5){reduced/=2;squares++;}
  const input=point(reduced);
  let sum=ONE,term=ONE;
  for(let index=1;index<=24;index++){
    const product=unpack(intervalMultiply(term,input));
    const next=product===null?null:unpack(intervalDivide(product,point(index)));
    const total=next===null?null:unpack(intervalAdd(sum,next));
    if(next===null||total===null)return null;
    term=next;sum=total;
  }
  // For r<=1/2, the omitted sum is <=(r^25/25!)/(1-r/26).
  const product=unpack(intervalMultiply(term,input));
  const omitted=product===null?null:unpack(intervalDivide(product,point(25)));
  const ratio=unpack(intervalDivide(input,point(26)));
  const denominator=ratio===null?null:unpack(intervalSubtract(ONE,ratio));
  const tail=omitted===null||denominator===null?null:unpack(intervalDivide(omitted,denominator));
  let result=tail===null?null:unpack(intervalAdd(sum,{lower:0,upper:tail.upper}));
  if(result===null)return null;
  // Invert before squaring so negative inputs near underflow do not require exp(-x)
  // to fit into a double first. Both paths keep directed subnormal/overflow bounds.
  if(value<0)result=unpack(intervalDivide(ONE,result));
  for(let index=0;index<squares;index++){
    if(result===null)return null;
    result=unpack(intervalSquare(result));
  }
  return result===null?null:{lower:Math.max(0,result.lower),upper:result.upper};
}

/** Monotonicity encloses the entire interval, including unbounded endpoints. */
export function exponentialRange(value:MathInterval):MathInterval|null {
  if(Number.isNaN(value.lower)||Number.isNaN(value.upper)||value.lower>value.upper)return null;
  const lower=exponentialPoint(value.lower),upper=exponentialPoint(value.upper);
  return lower===null||upper===null?null:{lower:lower.lower,upper:upper.upper};
}
