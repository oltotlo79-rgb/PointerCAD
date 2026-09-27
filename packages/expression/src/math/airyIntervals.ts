/** Airy enclosures: monotonicity on x>=0, and E=y'^2-x*y^2, E'=-y^2 on x<=0. */
import { airyValues, AIRY_ARGUMENT_LIMIT, type AiryKind, type AiryBounds } from './airyNumeric.js';
import { exactDouble } from './exactDoubleInterval.js';
import { MathInputProblem } from './mathInputContract.js';
import { nextFloat, intervalAdd, intervalSubtract, intervalMultiply, intervalSquare, intervalSqrt,
  type MathInterval, type IntervalValue } from './mathInterval.js';

type Range=MathInterval|null;
type Pair={value:MathInterval;first:MathInterval};
const point=(x:number):MathInterval=>({lower:x,upper:x});
const unpack=(x:IntervalValue):Range=>x.status==='range'?x.interval:null;
const add=(a:Range,b:Range):Range=>a===null||b===null?null:unpack(intervalAdd(a,b));
const multiply=(a:Range,b:Range):Range=>a===null||b===null?null:unpack(intervalMultiply(a,b));
const square=(a:MathInterval):Range=>unpack(intervalSquare(a));
const union=(a:Range,b:Range):Range=>a===null||b===null?null:{lower:Math.min(a.lower,b.lower),upper:Math.max(a.upper,b.upper)};
function outward(bounds:AiryBounds):Range {
  let lower=Number(bounds.decimal),upper=lower;
  for(let attempt=0;attempt<8;attempt++) {
    const lo=exactDouble(lower),hi=exactDouble(upper);if(lo===null||hi===null)return null;
    const below=lo.numerator*bounds.lower.denominator<=bounds.lower.numerator*lo.denominator;
    const above=hi.numerator*bounds.upper.denominator>=bounds.upper.numerator*hi.denominator;
    if(below&&above)return {lower,upper};
    if(!below)lower=nextFloat(lower,-1);if(!above)upper=nextFloat(upper,1);
  }
  return null;
}
const cache=new Map<string,Pair>();
function at(kind:AiryKind,x:number):Pair|null {
  const key=kind+':'+String(x),known=cache.get(key);if(known!==undefined)return known;
  const input=exactDouble(x);if(input===null)return null;
  try {
    const bounds=airyValues(kind,input,()=>undefined),value=outward(bounds.value),first=outward(bounds.first);
    if(value===null||first===null)return null;
    if(cache.size>=256)cache.clear();
    const result={value,first};cache.set(key,result);return result;
  } catch(error) { if(error instanceof MathInputProblem)return null;throw error; }
}
function pair(kind:AiryKind,input:MathInterval):Pair|null {
  const {lower:a,upper:b}=input,left=at(kind,a);if(left===null)return null;
  if(a===b)return left;
  if(a<0&&b>0) {
    const negative=pair(kind,{lower:a,upper:0}),positive=pair(kind,{lower:0,upper:b});
    const value=union(negative?.value??null,positive?.value??null),first=union(negative?.first??null,positive?.first??null);
    return value===null||first===null?null:{value,first};
  }
  if(a>=0) {
    const right=at(kind,b);if(right===null)return null;
    return {value:kind==='Ai'?{lower:right.value.lower,upper:left.value.upper}:{lower:left.value.lower,upper:right.value.upper},
      first:{lower:left.first.lower,upper:right.first.upper}};
  }
  // E decreases as x increases. For a<=x<=b<=0, |y'|<=sqrt(E(a)).
  const derivativeSquared=square(left.first),weightedValue=multiply(point(a),square(left.value));
  const energy=derivativeSquared===null||weightedValue===null?null:unpack(intervalSubtract(derivativeSquared,weightedValue));
  const speed=energy===null?null:unpack(intervalSqrt({lower:Math.max(0,energy.lower),upper:energy.upper}));
  if(speed===null)return null;
  const middle=a/2+b/2,center=at(kind,middle);if(center===null)return null;
  const radius=nextFloat(Math.max(middle-a,b-middle),1);
  const displacement=nextFloat(radius*speed.upper,1);
  const value=add(center.value,{lower:-displacement,upper:displacement});if(value===null)return null;
  const acceleration=nextFloat(Math.max(-a,-b)*Math.max(-value.lower,value.upper),1);
  const slopeChange=nextFloat(radius*acceleration,1);
  const slope=add(center.first,{lower:-slopeChange,upper:slopeChange});if(slope===null)return null;
  const first={lower:Math.max(-speed.upper,slope.lower),upper:Math.min(speed.upper,slope.upper)};
  return first.lower>first.upper?null:{value,first};
}
export function airyRanges(kind:AiryKind,prime:boolean,input:MathInterval):{value:Range;first:Range;second:Range} {
  if(!Number.isFinite(input.lower)||!Number.isFinite(input.upper)||input.lower>input.upper
    ||input.lower < -AIRY_ARGUMENT_LIMIT||input.upper>AIRY_ARGUMENT_LIMIT)return {value:null,first:null,second:null};
  const result=pair(kind,input);if(result===null)return {value:null,first:null,second:null};
  const second=input.lower===0&&input.upper===0?point(0):multiply(input,result.value);
  return prime?{value:result.first,first:second,second:add(result.value,multiply(input,result.first))}
    :{...result,second};
}
function midpoint(range:Range):number {
  if(range===null)return NaN;
  if(range.lower===range.upper)return range.lower;
  if(range.lower<=0&&range.upper>=0)return NaN;
  return range.lower/2+range.upper/2;
}
export const airySample=(kind:AiryKind,prime:boolean,x:number):number=>midpoint(airyRanges(kind,prime,point(x)).value);
export const airySlope=(kind:AiryKind,prime:boolean,x:number):number=>midpoint(airyRanges(kind,prime,point(x)).first);
