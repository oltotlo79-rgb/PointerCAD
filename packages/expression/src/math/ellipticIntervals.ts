/** Real Legendre values and first/second partial derivatives with directed bounds.
 * Parameter partials are integrals of fixed-sign powers of sin², (1-m sin²)
 * and (1-n sin²). Every such partial is separately monotone in each argument
 * on an admissible box (the sign reverses with a negative amplitude). Thus all
 * box corners enclose them; amplitude partials use the integrand on the WHOLE box.
 */
import type { EllipticKind } from './ellipticNumeric.js';
import { reduceEllipticAmplitude } from './ellipticAmplitude.js';
import { carlsonRFJet,carlsonRJJet } from './carlsonJets.js';
import { exactDouble,exactDoubleInterval } from './exactDoubleInterval.js';
import { BESSEL_FIXED_SCALE,type BesselFixedRange } from './besselFixedRange.js';
import { MathInputProblem } from './mathInputContract.js';
import { trigonometricInterval } from './trigonometricIntervals.js';
import { type Range,type Jet,point,constant,variable,ONE,ZERO,add,sub,mul,div,neg,sq,root,
  factor,sum,product,scale,UnprovedEllipticRange } from './ellipticJetArithmetic.js';

type Bound=Range|null;
export interface EllipticRanges {
  readonly value:Bound;
  readonly first:readonly Bound[];
  readonly second:readonly (readonly Bound[])[];
}
interface ParameterJet { readonly value:Range;readonly first:readonly [Bound,Bound];readonly second:readonly [Bound,Bound,Bound] }
const DEGREE={lower:0.01745329251994329,upper:0.0174532925199433};
const completeKind=(kind:EllipticKind):'K'|'E'|'Pi'=>kind==='F'?'K':kind==='Einc'?'E':kind==='Piinc'?'Pi':kind;
const amplitudeIndex=(kind:EllipticKind):number=>kind==='F'||kind==='Einc'?0:kind==='Piinc'?1:-1;
const countOf=(kind:EllipticKind):number=>kind==='K'||kind==='E'?1:kind==='Piinc'?3:2;
const unknown=(count:number):EllipticRanges=>({value:null,first:Array<Bound>(count).fill(null),
  second:Array.from({length:count},()=>Array<Bound>(count).fill(null))});
const union=(a:Bound,b:Bound):Bound=>a===null||b===null?null:{lower:Math.min(a.lower,b.lower),upper:Math.max(a.upper,b.upper)};
function fixed(range:BesselFixedRange):Range {
  const lower=exactDoubleInterval({numerator:range.lower,denominator:BESSEL_FIXED_SCALE});
  const upper=exactDoubleInterval({numerator:range.upper,denominator:BESSEL_FIXED_SCALE});
  if(lower===null||upper===null)throw new UnprovedEllipticRange();
  return {lower:lower.lower,upper:upper.upper};
}
function integral(kind:'K'|'E'|'Pi',sine:Range,cosine:Range,mValue:number,nValue:number):Jet {
  const m=variable(point(mValue),0),n=variable(point(nValue),1),one=constant(ONE);
  const s2=sq(sine),y=sum(one,scale(m,neg(s2))),x=constant(sq(cosine));
  if(y.value.lower<=0)throw new UnprovedEllipticRange();
  const rf=carlsonRFJet(x,y,one);
  let value=scale(rf,sine);
  if(kind==='E')value=sum(value,scale(product(m,carlsonRJJet(x,y,one,one)),neg(mul(mul(sine,s2),factor(1,3)))));
  if(kind==='Pi') {
    const p=sum(one,scale(n,neg(s2)));
    if(p.value.lower<=0)throw new UnprovedEllipticRange();
    value=sum(value,scale(product(n,carlsonRJJet(x,y,one,p)),mul(mul(sine,s2),factor(1,3))));
  }
  return value;
}
const completeCache=new Map<string,Jet>();
function complete(kind:'K'|'E'|'Pi',m:number,n:number):Jet {
  if(m>=1||kind==='Pi'&&n>=1)throw new UnprovedEllipticRange();
  const key=[kind,m,n].join(':'),known=completeCache.get(key);if(known!==undefined)return known;
  const value=integral(kind,ONE,ZERO,m,n);
  if(completeCache.size>=128)completeCache.clear();completeCache.set(key,value);return value;
}
const cache=new Map<string,ParameterJet>();
function at(kind:EllipticKind,args:readonly number[],degree:boolean):ParameterJet {
  const key=[kind,degree,...args].join(':'),known=cache.get(key);if(known!==undefined)return known;
  const m=args[args.length-1],n=kind==='Pi'||kind==='Piinc'?args[0]:0,amp=amplitudeIndex(kind),family=completeKind(kind);
  let value:ParameterJet;
  if(amp<0)value=kind==='E'&&m===1?{value:ONE,first:[null,ZERO],second:[null,ZERO,ZERO]}:complete(family,m,n);
  else if(args[amp]===0)value=constant(ZERO);
  else {
    const input=exactDouble(args[amp]);if(input===null)throw new UnprovedEllipticRange();
    const reduced=reduceEllipticAmplitude(degree?{numerator:input.numerator,denominator:input.denominator*180n}:input,degree,()=>undefined);
    if((m>1||m===1&&family!=='E'||family==='Pi'&&n>=1)&&reduced.beforeHalf!==true)throw new UnprovedEllipticRange();
    const sine=fixed(reduced.sine),cosine=fixed(reduced.cosine);
    const turns=exactDoubleInterval({numerator:2n*reduced.turns,denominator:1n});
    if(turns===null)throw new UnprovedEllipticRange();
    if(family==='E'&&m===1&&reduced.beforeHalf!==true) {
      const total=add(turns,sine);
      value={value:reduced.negative?neg(total):total,first:[null,ZERO],second:[null,ZERO,ZERO]};
    } else {
      const partial=integral(family,sine,cosine,m,n);
      const total=reduced.turns===0n?partial:sum(partial,scale(complete(family,m,n),turns));
      value=reduced.negative?scale(total,point(-1)):total;
    }
  }
  if(cache.size>=256)cache.clear();cache.set(key,value);return value;
}
function parameterBounds(kind:EllipticKind,args:readonly Range[],degree:boolean):ParameterJet {
  let combined:ParameterJet|null=null;
  function visit(values:number[]):void {
    const index=values.length;
    if(index<args.length) {
      visit([...values,args[index].lower]);
      if(args[index].upper!==args[index].lower)visit([...values,args[index].upper]);
      return;
    }
    const current=at(kind,values,degree);
    if(combined===null)combined=current;
    else combined={value:{lower:Math.min(combined.value.lower,current.value.lower),upper:Math.max(combined.value.upper,current.value.upper)},
      first:[union(combined.first[0],current.first[0]),union(combined.first[1],current.first[1])],
      second:[union(combined.second[0],current.second[0]),union(combined.second[1],current.second[1]),union(combined.second[2],current.second[2])]};
  }
  visit([]);if(combined===null)throw new UnprovedEllipticRange();return combined;
}
/** The amplitude derivatives follow directly from the defining integral. */
function amplitudePartials(kind:EllipticKind,args:readonly Range[],degree:boolean) {
  const amp=amplitudeIndex(kind),phi=args[amp],m=args[args.length-1],n=kind==='Piinc'?args[0]:ZERO;
  const sine=trigonometricInterval(phi,false,degree),cosine=trigonometricInterval(phi,true,degree);
  if(sine.status!=='range'||cosine.status!=='range')throw new UnprovedEllipticRange();
  const s2=sq(sine.interval),sc=mul(sine.interval,cosine.interval),a=sub(ONE,mul(m,s2)),b=sub(ONE,mul(n,s2));
  if(a.lower<=0||b.lower<=0)throw new UnprovedEllipticRange();
  const r=root(a),angle=degree?DEGREE:ONE;
  const integrand=kind==='Einc'?r:div(ONE,mul(r,b));
  const dm=kind==='Einc'?neg(div(s2,mul(point(2),r))):div(mul(integrand,s2),mul(point(2),a));
  const dn=kind==='Piinc'?div(mul(integrand,s2),b):ZERO;
  const dphi=kind==='Einc'?neg(div(mul(m,sc),r)):
    mul(integrand,add(div(mul(m,sc),a),kind==='Piinc'?div(mul(point(2),mul(n,sc)),b):ZERO));
  return {first:mul(integrand,angle),dm:mul(dm,angle),dn:mul(dn,angle),second:mul(dphi,sq(angle))};
}
export function ellipticRanges(kind:EllipticKind,args:readonly Range[],degree=false):EllipticRanges {
  const count=countOf(kind),empty=unknown(count);
  if(args.length!==count||args.some(x=>!Number.isFinite(x.lower)||!Number.isFinite(x.upper)||x.lower>x.upper))return empty;
  try {
    const result=parameterBounds(kind,args,degree),amp=amplitudeIndex(kind),m=count-1,n=kind==='Pi'||kind==='Piinc'?0:-1;
    const first:Bound[]=Array<Bound>(count).fill(ZERO),second:Bound[][]=Array.from({length:count},()=>Array<Bound>(count).fill(ZERO));
    first[m]=result.first[0];second[m][m]=result.second[0];
    if(n>=0) {first[n]=result.first[1];second[n][n]=result.second[2];second[m][n]=second[n][m]=result.second[1];}
    if(amp>=0) {
      // A finite E endpoint need not have finite parameter derivatives.
      try {
        const derivatives=amplitudePartials(kind,args,degree);
        first[amp]=derivatives.first;second[amp][amp]=derivatives.second;
        second[m][amp]=second[amp][m]=derivatives.dm;
        if(n>=0)second[n][amp]=second[amp][n]=derivatives.dn;
      } catch(error) {
        if(!(error instanceof UnprovedEllipticRange))throw error;
        first[amp]=null;for(let i=0;i<count;i++)second[i][amp]=second[amp][i]=null;
      }
    }
    return {value:result.value,first,second};
  } catch(error) {
    if(error instanceof UnprovedEllipticRange||error instanceof MathInputProblem)return empty;
    throw error;
  }
}
export function ellipticMidpoint(range:Bound):number {
  if(range===null)return NaN;
  if(range.lower===range.upper)return range.lower;
  if(range.lower<=0&&range.upper>=0)return NaN;
  return range.lower/2+range.upper/2;
}
export const ellipticSample=(kind:EllipticKind,args:readonly number[],degree=false):number=>
  ellipticMidpoint(ellipticRanges(kind,args.map(point),degree).value);
