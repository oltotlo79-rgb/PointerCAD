/** Internal derivatives of Legendre integrals. These operations are generated
 * after validating the user's expression; they never replace its saved source.
 */
import { ellipticKind } from './ellipticFunctions.js';
import type { EllipticKind } from './ellipticNumeric.js';
import { ellipticRanges,type EllipticRanges } from './ellipticIntervals.js';
import { reduceEllipticAmplitude } from './ellipticAmplitude.js';
import { ellipticFactorial,ellipticIntegrand,MAX_ELLIPTIC_PARTIAL_ORDER } from './ellipticIntegrand.js';
import { integrateEllipticParameter } from './ellipticQuadrature.js';
import { exactDouble,exactDoubleInterval } from './exactDoubleInterval.js';
import { BESSEL_FIXED_SCALE,type BesselFixedRange } from './besselFixedRange.js';
import { besselConstants } from './besselConstants.js';
import { MathInputProblem } from './mathInputContract.js';
import { type Range,point,ZERO,ONE,add,sub,mul,div,neg,UnprovedEllipticRange } from './ellipticJetArithmetic.js';

type Bound=Range|null;
export interface EllipticOperation {readonly family:EllipticKind;readonly orders:readonly number[]}
const countOf=(kind:EllipticKind):number=>kind==='K'||kind==='E'?1:kind==='Piinc'?3:2;
const amplitudeIndex=(kind:EllipticKind):number=>kind==='F'||kind==='Einc'?0:kind==='Piinc'?1:-1;
const valid=(orders:readonly number[],count:number):boolean=>orders.length===count
  &&orders.every(x=>Number.isSafeInteger(x)&&x>=0)&&orders.reduce((a,b)=>a+b,0)<=MAX_ELLIPTIC_PARTIAL_ORDER;
export function ellipticOperation(operation:string):EllipticOperation|null {
  const ordinary=ellipticKind(operation);
  if(ordinary!==null)return {family:ordinary,orders:Array<number>(countOf(ordinary)).fill(0)};
  const match=/^elliptic-partial:(K|E|F|Einc|Pi|Piinc):([0-9,]+)$/u.exec(operation);
  if(match===null)return null;
  const family=match[1] as EllipticKind,orders=match[2].split(',').map(Number);
  return valid(orders,countOf(family))?{family,orders}:null;
}
export function ellipticPartialOperation(value:EllipticOperation,index:number):string {
  const orders=value.orders.map((order,i)=>order+Number(index===i));
  if(index<0||index>=orders.length||!valid(orders,countOf(value.family)))throw new MathInputProblem('budget','楕円積分の微分の次数が上限を越えました。');
  return `elliptic-partial:${value.family}:${orders.join(',')}`;
}
function rational(numerator:bigint,denominator=1n):Range {
  const answer=exactDoubleInterval({numerator,denominator});
  if(answer===null)throw new UnprovedEllipticRange();return answer;
}
function fixed(range:BesselFixedRange):Range {
  return {lower:rational(range.lower,BESSEL_FIXED_SCALE).lower,upper:rational(range.upper,BESSEL_FIXED_SCALE).upper};
}
const degreeFactor=()=>div(fixed(besselConstants(()=>undefined).pi),point(180));
const cache=new Map<string,Range>();
function integralAt(kind:EllipticKind,args:readonly number[],p:number,q:number,degree:boolean):Range {
  const key=[kind,...args,p,q,degree].join(':'),known=cache.get(key);if(known!==undefined)return known;
  const family=kind==='F'?'K':kind==='Einc'?'E':kind==='Piinc'?'Pi':kind;
  const m=args[args.length-1],n=family==='Pi'?args[0]:0,amp=amplitudeIndex(kind);
  function integrate(angle:Range):Range {
    const base=integrateEllipticParameter(family,m,n,0,angle.lower,p,q,{check:()=>undefined});
    if(angle.lower===angle.upper)return base;
    // The exact reduced angle lies anywhere in its directed enclosure. The
    // endpoint strip is bounded by its FULL integrand range, not its centre.
    const strip=mul({lower:0,upper:sub(point(angle.upper),point(angle.lower)).upper},
      ellipticIntegrand(family,point(m),point(n),angle,p,q,0)[0]);
    return add(base,strip);
  }
  const complete=():Range=>integrate(div(fixed(besselConstants(()=>undefined).pi),point(2)));
  let result:Range;
  if(amp<0)result=complete();
  else if(args[amp]===0)result=ZERO;
  else {
    const input=exactDouble(args[amp]);if(input===null)throw new UnprovedEllipticRange();
    const reduced=reduceEllipticAmplitude(degree?{numerator:input.numerator,denominator:input.denominator*180n}:input,degree,()=>undefined);
    result=integrate(fixed(reduced.angle));
    if(reduced.turns!==0n)result=add(result,mul(rational(2n*reduced.turns),complete()));
    if(reduced.negative)result=neg(result);
  }
  if(cache.size>=256)cache.clear();cache.set(key,result);return result;
}
/** Include all corners only for pure parameter derivatives. Their integrands
 * have fixed signs and are separately monotone in m, n and amplitude. */
function parameterRange(kind:EllipticKind,args:readonly Range[],p:number,q:number,degree:boolean):Range {
  const corners:Range[]=[];
  function visit(values:number[]):void {
    const index=values.length;
    if(index===args.length) {corners.push(integralAt(kind,values,p,q,degree));return;}
    visit([...values,args[index].lower]);
    if(args[index].upper!==args[index].lower)visit([...values,args[index].upper]);
  }
  visit([]);return {lower:Math.min(...corners.map(x=>x.lower)),upper:Math.max(...corners.map(x=>x.upper))};
}
function partial(kind:EllipticKind,args:readonly Range[],orders:readonly number[],degree:boolean,base:EllipticRanges):Bound {
  const total=orders.reduce((a,b)=>a+b,0);
  if(!valid(orders,countOf(kind))||base.value===null)return null;
  if(total===0)return base.value;
  const slots=orders.flatMap((order,index)=>Array<number>(order).fill(index));
  if(total===1)return base.first[slots[0]];
  if(total===2)return base.second[slots[0]][slots[1]];
  const amp=amplitudeIndex(kind),j=amp<0?0:orders[amp],p=orders[orders.length-1],q=kind==='Pi'||kind==='Piinc'?orders[0]:0;
  // E at m=1 can be finite, but differentiating its parameter at a full
  // half-period is not an analytic real neighbourhood. Preserve that hole.
  if(p>0&&base.first[orders.length-1]===null||q>0&&base.first[0]===null)return null;
  try {
    if(j===0)return parameterRange(kind,args,p,q,degree);
    const family=kind==='F'?'K':kind==='Einc'?'E':'Pi',factor=degree?degreeFactor():ONE;
    const coefficient=ellipticIntegrand(family,args[args.length-1],kind==='Piinc'?args[0]:ZERO,args[amp],p,q,j-1,degree)[j-1];
    let result=mul(coefficient,rational(ellipticFactorial(j-1)));
    for(let k=0;k<j;k++)result=mul(result,factor);
    return result;
  } catch(error) {
    if(error instanceof UnprovedEllipticRange||error instanceof MathInputProblem)return null;
    throw error;
  }
}
export function ellipticPartialValue(kind:EllipticKind,args:readonly Range[],orders:readonly number[],degree=false):Bound {
  return partial(kind,args,orders,degree,ellipticRanges(kind,args,degree));
}
export function ellipticPartialRanges(kind:EllipticKind,args:readonly Range[],orders:readonly number[],degree=false):EllipticRanges {
  const base=ellipticRanges(kind,args,degree);
  if(valid(orders,countOf(kind))&&orders.every(x=>x===0))return base;
  const increase=(indices:readonly number[])=>orders.map((order,i)=>order+indices.filter(index=>index===i).length);
  return {value:partial(kind,args,orders,degree,base),
    first:orders.map((_,i)=>partial(kind,args,increase([i]),degree,base)),
    second:orders.map((_,i)=>orders.map((_,j)=>partial(kind,args,increase([i,j]),degree,base)))};
}
