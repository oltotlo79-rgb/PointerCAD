/** Enclose a rational using comparisons against the exact IEEE-754 value, never its printed decimal. */
import {rational,type ExactRational} from './exactRational.js';
import {nextFloat,type MathInterval} from './mathInterval.js';

export function exactDouble(value:number):ExactRational|null {
  if(!Number.isFinite(value)) return null;if(value===0) return {numerator:0n,denominator:1n};
  const bits=new DataView(new ArrayBuffer(8));bits.setFloat64(0,value,false);const encoded=bits.getBigUint64(0,false);
  const exponent=Number((encoded>>52n)&0x7ffn),fraction=encoded&((1n<<52n)-1n);
  const mantissa=(exponent===0?fraction:(1n<<52n)|fraction)*((encoded>>63n)===0n?1n:-1n);
  const shift=(exponent===0?-1022:exponent-1023)-52;
  return shift>=0?rational(mantissa<<BigInt(shift)):rational(mantissa,1n<<BigInt(-shift));
}
function compare(a:ExactRational,b:ExactRational):number {
  const difference=a.numerator*b.denominator-b.numerator*a.denominator;return difference<0n?-1:difference>0n?1:0;
}
export function exactDoubleInterval(value:ExactRational):MathInterval|null {
  const candidate=Number(value.numerator)/Number(value.denominator);if(!Number.isFinite(candidate)) return null;
  let lower=candidate,upper=candidate;
  for(let index=0;index<8;index++){
    const low=exactDouble(lower),high=exactDouble(upper);if(low===null || high===null) return null;
    const lowOrder=compare(low,value),highOrder=compare(high,value);
    if(lowOrder<=0 && highOrder>=0) return {lower,upper};
    if(lowOrder>0) lower=nextFloat(lower,-1);if(highOrder<0) upper=nextFloat(upper,1);
  }
  return null;
}
