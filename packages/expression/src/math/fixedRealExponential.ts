/** Directed real exponential, with a geometric bound for the complete tail. */
import { MathInputProblem } from './mathInputContract.js';
import { BESSEL_FIXED_SCALE as S,FIXED_ONE,fixedAdd,fixedMultiply,fixedTimesRational,
  fixedDivide,ceilQuotient,type BesselFixedRange as Range } from './besselFixedRange.js';

function positiveExponent(input:bigint,check:()=>void):Range {
  if(input===0n)return FIXED_ONE;
  let argument:Range={lower:input,upper:input},squares=0;
  while(argument.upper>S/2n) {argument=fixedTimesRational(argument,1n,2n);squares++;}
  let term=FIXED_ONE,sum=term;
  for(let k=1;k<=512;k++) {
    check();term=fixedTimesRational(fixedMultiply(term,argument),1n,BigInt(k));sum=fixedAdd(sum,term);
    // Every next term is at most argument/(k+1) times its predecessor.
    const tail=ceilQuotient(term.upper*argument.upper,BigInt(k+1)*S-argument.upper);
    if(tail<=1n) {
      let answer={lower:sum.lower,upper:sum.upper+tail};
      for(let i=0;i<squares;i++) {check();answer=fixedMultiply(answer,answer);}
      return answer;
    }
  }
  throw new MathInputProblem('budget','指数関数を必要な精度で確定できません。');
}
export function fixedRealExponential(input:Range,check:()=>void):Range {
  check();
  if(input.lower>input.upper||input.lower < -1024n*S||input.upper>1024n*S) {
    throw new MathInputProblem('budget','指数関数の内部計算の範囲を越えました。');
  }
  const endpoint=(x:bigint):Range=>x<0n?fixedDivide(FIXED_ONE,positiveExponent(-x,check)):positiveExponent(x,check);
  const lower=endpoint(input.lower);
  return input.lower===input.upper?lower:{lower:lower.lower,upper:endpoint(input.upper).upper};
}
