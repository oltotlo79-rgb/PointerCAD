/** Directed Taylor coefficients on whole real intervals, including the differentiated
 * periodic Bernoulli remainder. Reflection avoids cancellation for negative s. */
import type { MathInterval } from './mathInterval.js';
import { exactDouble,exactDoubleInterval } from './exactDoubleInterval.js';
import { logarithmicPositiveRange } from './logarithmicIntervals.js';
import { exponentialRange } from './exponentialIntervals.js';
import { trigonometricInterval } from './trigonometricIntervals.js';
import { gammaFunctionRanges } from './gammaFunctionIntervals.js';
import { polygammaRange } from './polygammaIntervals.js';
import { ZETA_COEFFICIENTS } from './zetaCoefficients.js';
import { zetaDerivatives } from './zetaDerivatives.js';
import { MathInputProblem } from './mathInputContract.js';
import { type Range,point,ZERO,ONE,add,sub,mul,div,neg,UnprovedEllipticRange } from './ellipticJetArithmetic.js';

type Jet=readonly Range[];
const N=32,M=24,PI={lower:3.141592653589793,upper:3.1415926535897936};
const magnitude=(x:Range)=>Math.max(Math.abs(x.lower),Math.abs(x.upper));
function known(x:Range|null):Range {if(x===null)throw new UnprovedEllipticRange();return x;}
const logarithms=new Map<number,Range>();
function log(n:number):Range {
  const existing=logarithms.get(n);if(existing!==undefined)return existing;
  const value=known(logarithmicPositiveRange(point(n),'e'));logarithms.set(n,value);return value;
}
function product(a:Jet,b:Jet):Range[] {
  return a.map((_,k)=>{let result=ZERO;for(let j=0;j<=k;j++)result=add(result,mul(a[j],b[k-j]));return result;});
}
function linear(a:Jet,s:Range,offset:number,divisor=1):Range[] {
  const value=div(add(s,point(offset)),point(divisor));
  return a.map((term,j)=>add(mul(term,value),j===0?ZERO:div(a[j-1],point(divisor))));
}
function exponentialJet(value:Range,slope:Range,order:number):Range[] {
  const result=[known(exponentialRange(value))];
  for(let j=1;j<=order;j++)result.push(div(mul(result[j-1],slope),point(j)));
  return result;
}
function power(base:number,s:Range,order:number):Range[] {
  if(base===1)return Array.from({length:order+1},(_,j)=>j===0?ONE:ZERO);
  const slope=neg(log(base));return exponentialJet(mul(s,slope),slope,order);
}
const coefficients=ZETA_COEFFICIENTS.slice(0,M).map(([n,d])=>
  known(exactDoubleInterval({numerator:BigInt(n),denominator:BigInt(d)})));
function eulerMaclaurin(s:Range,order:number):Range[] {
  const inverse=div(ONE,sub(s,ONE)),pole:Range[]=[mul(point(N),inverse)];
  for(let j=1;j<=order;j++)pole.push(neg(mul(pole[j-1],inverse)));
  pole[0]=add(pole[0],point(.5));
  const base=power(N,s,order);
  let sum=product(base,pole),term=linear(base,s,0,N),last:Range[]=[];
  for(let n=1;n<N;n++) {const values=power(n,s,order);sum=sum.map((x,j)=>add(x,values[j]));}
  for(let m=1;m<=M;m++) {
    last=term.map(value=>mul(value,coefficients[m-1]));sum=sum.map((value,j)=>add(value,last[j]));
    if(m<M)term=linear(linear(term,s,2*m-1,N),s,2*m,N);
  }
  const delta=add(s,point(2*M-1));if(delta.lower<=0)throw new UnprovedEllipticRange();
  const d=linear(last,s,2*M-1);
  return sum.map((value,j)=>{
    let error=ZERO;
    for(let t=0;t<=j;t++) {
      let bound:Range={lower:0,upper:magnitude(d[t])};
      for(let k=0;k<=j-t;k++)bound=div(bound,point(delta.lower));
      error=add(error,bound);
    }
    return add(value,{lower:-error.upper,upper:error.upper});
  });
}
function reflected(s:Range,order:number):Range[] {
  const t=sub(ONE,s),gamma=[known(gammaFunctionRanges(t).value)],h:Range[]=[ZERO];
  let factorial=1;
  for(let j=1;j<=order;j++) {
    factorial*=j;let psi=known(polygammaRange(j-1,t));if(j%2!==0)psi=neg(psi);
    h.push(div(psi,point(factorial)));
    let coefficient=ZERO;
    for(let k=1;k<=j;k++)coefficient=add(coefficient,mul(point(k),mul(h[k],gamma[j-k])));
    gamma.push(div(coefficient,point(j)));
  }
  const halfPi=div(PI,point(2)),angle=mul(s,halfPi);
  const sine=trigonometricInterval(angle,false,false),cosine=trigonometricInterval(angle,true,false);
  if(sine.status!=='range'||cosine.status!=='range')throw new UnprovedEllipticRange();
  const trig:Range[]=[],phases=[sine.interval,cosine.interval,neg(sine.interval),neg(cosine.interval)];
  let scale=ONE;
  for(let j=0;j<=order;j++) {if(j>0)scale=div(mul(scale,halfPi),point(j));trig.push(mul(scale,phases[j%4]));}
  const logarithm=known(logarithmicPositiveRange(mul(point(2),PI),'e'));
  const exponential=exponentialJet(mul(sub(s,ONE),logarithm),logarithm,order).map(x=>mul(point(2),x));
  const positive=eulerMaclaurin(t,order).map((x,j)=>j%2===0?x:neg(x));
  return product(product(exponential,trig),product(gamma,positive));
}
function coefficientsOn(s:Range,order:number):Range[] {
  if(s.lower<-.5&&s.upper>-.5) {
    const left=reflected({lower:s.lower,upper:-.5},order),right=eulerMaclaurin({lower:-.5,upper:s.upper},order);
    return left.map((x,j)=>({lower:Math.min(x.lower,right[j].lower),upper:Math.max(x.upper,right[j].upper)}));
  }
  return s.upper<=-.5?reflected(s,order):eulerMaclaurin(s,order);
}
/** Actual derivatives, not coefficients divided by factorial. A pole or unknown
 * range is never represented as a continuous interval. */
export function zetaDerivativeRanges(input:MathInterval,order:number):readonly Range[]|null {
  if(!Number.isInteger(order)||order<0||order>17||!Number.isFinite(input.lower)||!Number.isFinite(input.upper)
    ||input.lower>input.upper||input.lower < -32||input.upper>128||input.lower<=1&&input.upper>=1)return null;
  try {
    let factorial=1;
    return coefficientsOn(input,order).map((x,j)=>{if(j>0)factorial*=j;return mul(x,point(factorial));});
  } catch(error) {if(error instanceof UnprovedEllipticRange)return null;throw error;}
}
const pointCache=new Map<string,number>();
export function zetaSample(order:number,x:number):number {
  const key=String(order)+':'+String(x),knownValue=pointCache.get(key);if(knownValue!==undefined)return knownValue;
  const ranges=zetaDerivativeRanges(point(x),order),range=ranges?.[order];if(range===undefined)return NaN;
  let value:number;
  if(order===0&&x<=0&&Number.isInteger(x)&&x%2===0)value=x===0?-.5:0;
  else if((range.lower>0||range.upper<0)&&range.upper-range.lower<=1e-12*magnitude(range))value=range.lower/2+range.upper/2;
  else {
    const exact=exactDouble(x);if(exact===null)return NaN;
    try {value=Number(zetaDerivatives(exact,order,()=>undefined)[order].decimal);}
    catch(error) {if(error instanceof MathInputProblem)return NaN;throw error;}
  }
  if(!Number.isFinite(value))return NaN;
  if(pointCache.size>=512)pointCache.clear();pointCache.set(key,value);return value;
}
