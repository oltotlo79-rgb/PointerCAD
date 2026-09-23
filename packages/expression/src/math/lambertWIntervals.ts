/** Monotone real branches and derivatives from w*exp(w)=x; no branch crossing. */
import { lambertWBounds, type RealLambertBranch } from './lambertWNumeric.js';
import { MathInputProblem } from './mathInputContract.js';
import { exactDouble } from './exactDoubleInterval.js';
import { nextFloat, intervalAdd, intervalMultiply, intervalDivide, intervalSquare,
  type MathInterval, type IntervalValue } from './mathInterval.js';
import { exponentialRange } from './exponentialIntervals.js';

type Range=MathInterval|null;
const point=(value:number):MathInterval=>({lower:value,upper:value});
const unpack=(value:IntervalValue):Range=>value.status==='range'?value.interval:null;
const add=(a:Range,b:Range):Range=>a===null||b===null?null:unpack(intervalAdd(a,b));
const multiply=(a:Range,b:Range):Range=>a===null||b===null?null:unpack(intervalMultiply(a,b));
const divide=(a:Range,b:Range):Range=>a===null||b===null?null:unpack(intervalDivide(a,b));
const square=(a:Range):Range=>a===null?null:unpack(intervalSquare(a));
const negate=(a:Range):Range=>a===null?null:{lower:-a.upper,upper:-a.lower};
const cache=new Map<string,MathInterval>();
function at(branch:RealLambertBranch,x:number):Range {
  const key=String(branch)+':'+String(x),known=cache.get(key);if(known!==undefined)return known;
  const input=exactDouble(x);if(input===null)return null;
  let bounds;
  try { bounds=lambertWBounds(branch,input,()=>undefined); }
  catch(error) { if(error instanceof MathInputProblem)return null;throw error; }
  let lower=Number(bounds.decimal),upper=lower;
  for(let attempt=0;attempt<8;attempt++) {
    const lo=exactDouble(lower),hi=exactDouble(upper);if(lo===null||hi===null)return null;
    const below=lo.numerator*bounds.lower.denominator<=bounds.lower.numerator*lo.denominator;
    const above=hi.numerator*bounds.upper.denominator>=bounds.upper.numerator*hi.denominator;
    if(below&&above) {
      if(cache.size>=128)cache.clear();
      const range={lower,upper};cache.set(key,range);return range;
    }
    if(!below)lower=nextFloat(lower,-1);if(!above)upper=nextFloat(upper,1);
  }
  return null;
}
export function lambertWValueRange(branch:RealLambertBranch,input:MathInterval):Range {
  if(!Number.isFinite(input.lower)||!Number.isFinite(input.upper)||input.lower>input.upper)return null;
  const a=at(branch,input.lower),b=input.lower===input.upper?a:at(branch,input.upper);
  return a===null||b===null?null:branch===0?{lower:a.lower,upper:b.upper}:{lower:b.lower,upper:a.upper};
}
export function lambertWRanges(branch:RealLambertBranch,input:MathInterval) {
  const value=lambertWValueRange(branch,input),negative=negate(value);
  const exponential=negative===null?null:exponentialRange(negative),onePlus=add(point(1),value);
  // exp(-w)/(1+w) also handles the removable W_0'(0)=1.
  const first=divide(exponential,onePlus);
  const second=negate(divide(multiply(square(exponential),add(point(2),value)),multiply(square(onePlus),onePlus)));
  return {value,first,second};
}
function midpoint(value:Range):number {
  if(value===null)return NaN;
  if(value.lower===value.upper)return value.lower;
  if(value.lower<=0&&value.upper>=0)return NaN;
  const answer=value.lower/2+value.upper/2;return answer===0?NaN:answer;
}
export const lambertWSample=(branch:RealLambertBranch,x:number):number=>midpoint(lambertWValueRange(branch,point(x)));
export const lambertWSlope=(branch:RealLambertBranch,x:number):number=>branch===0&&x===0?1:midpoint(lambertWRanges(branch,point(x)).first);
