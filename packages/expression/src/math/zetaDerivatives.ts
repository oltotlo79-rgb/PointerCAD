/** Taylor jets of zeta and an explicit bound for every differentiated remainder. */
import Decimal from 'decimal.js';
import type { ExactRational } from './exactRational.js';
import { MathInputProblem } from './mathInputContract.js';
import { validateZetaArgument,zetaValue,type ZetaBounds } from './zetaNumeric.js';
import { besselLog } from './besselConstants.js';
import { roundBesselRational } from './besselIntegerRounding.js';
import { fixedRealExponential } from './fixedRealExponential.js';
import { ZETA_COEFFICIENTS } from './zetaCoefficients.js';
import { BESSEL_FIXED_SCALE as S,FIXED_ZERO,FIXED_ONE,fixedAdd,fixedMultiply,fixedTimesRational,
  fixedWiden,type BesselFixedRange as Range } from './besselFixedRange.js';

const N=128;
const logarithms=new Map<number,Range>();
const abs=(x:bigint)=>x<0n?-x:x;
const magnitude=(x:Range)=>abs(x.lower)>abs(x.upper)?abs(x.lower):abs(x.upper);
type Jet=readonly Range[];
function product(a:Jet,b:Jet):Range[] {
  return a.map((_,k)=>{
    let result=FIXED_ZERO;
    for(let j=0;j<=k;j++)result=fixedAdd(result,fixedMultiply(a[j],b[k-j]));
    return result;
  });
}
/** Multiply by (s+offset)/divisor, retaining the linear term exactly. */
function linear(a:Jet,input:ExactRational,offset:number,divisor=1n):Range[] {
  return a.map((value,k)=>fixedAdd(fixedTimesRational(value,input.numerator+BigInt(offset)*input.denominator,
    input.denominator*divisor),k===0?FIXED_ZERO:fixedTimesRational(a[k-1],1n,divisor)));
}
function powerJet(base:number,input:ExactRational,order:number,check:()=>void):Range[] {
  if(base===1)return Array.from({length:order+1},(_,index)=>index===0?FIXED_ONE:FIXED_ZERO);
  let logarithm=logarithms.get(base);
  if(logarithm===undefined) {
    logarithm=besselLog({numerator:BigInt(base),denominator:1n},check);logarithms.set(base,logarithm);
  }
  const terms=[fixedRealExponential(fixedTimesRational(logarithm,-input.numerator,input.denominator),check)];
  for(let j=1;j<=order;j++) {check();terms.push(fixedTimesRational(fixedMultiply(terms[j-1],logarithm),-1n,BigInt(j)));}
  return terms;
}
function round(value:Range,factorial:bigint,corrections:number):ZetaBounds|null {
  const lower={numerator:value.lower*factorial,denominator:S},upper={numerator:value.upper*factorial,denominator:S};
  const decimal=roundBesselRational(lower);if(decimal!==roundBesselRational(upper))return null;
  return {lower,upper,decimal:new Decimal(decimal).toString(),corrections};
}
export function zetaDerivatives(input:ExactRational,order:number,check:()=>void):readonly ZetaBounds[] {
  check();validateZetaArgument(input);
  if(!Number.isSafeInteger(order)||order<0||order>17)throw new MathInputProblem('budget','ゼータ関数の微分は17階までです。');
  if(order===0)return [zetaValue(input,check)];
  const {numerator:p,denominator:q}=input;
  const exactValue=p<=0n&&p%q===0n?zetaValue(input,check):null;
  const pole:Range[]=[];
  let inverse=FIXED_ONE;
  for(let j=0;j<=order;j++) {
    check();inverse=fixedTimesRational(inverse,q*(p<q?-1n:1n),abs(p-q));
    pole.push(fixedTimesRational(inverse,j%2===0?BigInt(N):-BigInt(N)));
  }
  pole[0]=fixedAdd(pole[0],fixedTimesRational(FIXED_ONE,1n,2n));
  const base=powerJet(N,input,order,check);
  let sum=product(base,pole);
  for(let n=1;n<N;n++) {
    check();const values=powerJet(n,input,order,check);sum=sum.map((value,k)=>fixedAdd(value,values[k]));
  }
  let term=linear(base,input,0,BigInt(N));
  for(const [index,coefficient] of ZETA_COEFFICIENTS.entries()) {
    check();const m=index+1;
    const correction=term.map(value=>fixedTimesRational(value,BigInt(coefficient[0]),BigInt(coefficient[1])));
    sum=sum.map((value,k)=>fixedAdd(value,correction[k]));
    const delta=p+BigInt(2*m-1)*q;
    if(delta>0n) {
      // Put x=N*y in the periodic Bernoulli remainder. D(s) contains its
      // N^(1-s-2M) factor. Integral log(y)^l/l! <= delta^(-l-1).
      // Therefore |R_j| <= sum[t=0..j] |D_t|/delta^(j-t+1).
      const d=linear(correction,input,2*m-1),errors:bigint[]=[];
      for(let j=0;j<=order;j++) {
        let error=FIXED_ZERO;
        for(let t=0;t<=j;t++) {
          let contribution:Range={lower:0n,upper:magnitude(d[t])};
          for(let k=0;k<=j-t;k++)contribution=fixedTimesRational(contribution,q,delta);
          error=fixedAdd(error,contribution);
        }
        errors.push(error.upper);
      }
      let factorial=1n;
      const answers=sum.map((value,j)=>{
        if(j>0)factorial*=BigInt(j);
        return j===0&&exactValue!==null?exactValue:round(fixedWiden(value,errors[j]),factorial,m);
      });
      if(answers.every(answer=>answer!==null)) {check();return answers;}
    }
    term=linear(linear(term,input,2*m-1,BigInt(N)),input,2*m,BigInt(N));
  }
  throw new MathInputProblem('budget','ゼータ関数の微分を必要な桁数で確定できません。');
}
