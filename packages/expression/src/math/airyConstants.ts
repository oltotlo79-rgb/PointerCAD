/** Airy initial values, DLMF 9.2.3–6. Every constant remains enclosed.
 * Gamma(1/3), Gamma(2/3) use the positive series in 8.7.1 at M=9^3.
 * For 0<a<1, the omitted integral is <= M^(a-1)*exp(-M).
 */
import { MathInputProblem } from './mathInputContract.js';
import { BESSEL_FIXED_SCALE as S, FIXED_ONE, fixedRational, fixedAdd,
  fixedTimesRational, fixedMultiply, fixedDivide, fixedNegate, ceilQuotient,
  type BesselFixedRange as Range } from './besselFixedRange.js';

const M=729n, GUARD=10n**220n;
function positiveSeries(thirds:0|1|2,check:()=>void):Range {
  let term=thirds===0?FIXED_ONE:fixedRational(3n,BigInt(thirds)),sum=term;
  for(let k=0;k<4096;k++) {
    check();
    const p=thirds===0?M:3n*M,q=thirds===0?BigInt(k+1):BigInt(thirds+3*(k+1));
    if(q>2n*p) {
      const tail=ceilQuotient(term.upper*p,q-p);
      if(tail*GUARD<=sum.lower)return {lower:sum.lower,upper:sum.upper+tail};
    }
    term=fixedTimesRational(term,p,q);sum=fixedAdd(sum,term);
  }
  throw new MathInputProblem('budget','Airy関数の初期値を計算の上限内で確定できません。');
}
function rootThree(degree:2|3,check:()=>void):Range {
  let lower=S,upper=2n*S;const target=3n*S**BigInt(degree);
  while(upper-lower>1n) {
    check();const middle=(lower+upper)/2n;
    if(middle**BigInt(degree)<=target)lower=middle;else upper=middle;
  }
  return {lower,upper};
}
interface InitialValues { readonly Ai:readonly [Range,Range]; readonly Bi:readonly [Range,Range] }
let cached:InitialValues|undefined;
export function airyInitialValues(check:()=>void):InitialValues {
  check();if(cached!==undefined)return cached;
  const exponential=positiveSeries(0,check);
  const gamma=(thirds:1|2):Range=>{
    const power=thirds===1?9n:81n;
    const integral=fixedTimesRational(positiveSeries(thirds,check),power);
    const numerator={lower:integral.lower,upper:integral.upper+fixedRational(power,M).upper};
    return fixedDivide(numerator,exponential);
  };
  const cubeRoot=rootThree(3,check),squareRoot=rootThree(2,check);
  const ai=fixedDivide(FIXED_ONE,fixedMultiply(fixedMultiply(cubeRoot,cubeRoot),gamma(2)));
  const aiPrime=fixedNegate(fixedDivide(FIXED_ONE,fixedMultiply(cubeRoot,gamma(1))));
  const bi=fixedMultiply(squareRoot,ai),biPrime=fixedNegate(fixedMultiply(squareRoot,aiPrime));
  check();cached={Ai:[ai,aiPrime],Bi:[bi,biPrime]};return cached;
}
