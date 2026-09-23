/** J/I base series together with harmonic weights for Y/K: DLMF 10.8.1, 10.31.1. */
import type { ExactRational } from './exactRational.js';
import { MathInputProblem } from './mathInputContract.js';
import { BESSEL_FIXED_SCALE as S, FIXED_ZERO, FIXED_ONE, fixedRational, fixedAdd, fixedSubtract,
  fixedTimesRational, fixedMultiply, fixedWiden, ceilQuotient, type BesselFixedRange } from './besselFixedRange.js';

export interface SecondKindSeries {
  readonly j: BesselFixedRange; readonly i: BesselFixedRange;
  readonly harmonicJ: BesselFixedRange; readonly harmonicI: BesselFixedRange;
}
export function secondKindSeries(order: 0 | 1, input: ExactRational, check: () => void): SecondKindSeries {
  const p=input.numerator,q=input.denominator,square=p*p,fourQSquared=4n*q*q;
  let term=FIXED_ONE,j=FIXED_ONE,i=FIXED_ONE,harmonic=order===0?FIXED_ZERO:FIXED_ONE;
  let harmonicJ=harmonic,harmonicI=harmonic;
  for(let k=0;k<1024;k+=1) {
    check();
    const nextDenominator=fourQSquared*BigInt(k+1)*BigInt(order+k+1);
    if(2n*square<=nextDenominator) {
      const gap=nextDenominator-square;
      const tail=ceilQuotient(term.upper*square,gap);
      // h_(k+j)<=h_k+2j/(k+1). Sum r^j and j*r^j, not just the next weighted term.
      const weightedTail=ceilQuotient(term.upper*harmonic.upper*square,S*gap)
        +ceilQuotient(2n*term.upper*square*nextDenominator,BigInt(k+1)*gap*gap);
      if(tail<=4n && weightedTail<=4n) return {
        j:fixedWiden(j,tail),i:{lower:i.lower,upper:i.upper+tail},
        harmonicJ:fixedWiden(harmonicJ,weightedTail),harmonicI:{lower:harmonicI.lower,upper:harmonicI.upper+weightedTail},
      };
    }
    term=fixedTimesRational(term,square,nextDenominator);
    harmonic=fixedAdd(harmonic,fixedAdd(fixedRational(1n,BigInt(k+1)),fixedRational(1n,BigInt(order+k+1))));
    const weighted=fixedMultiply(term,harmonic);
    j=(k+1)%2===0?fixedAdd(j,term):fixedSubtract(j,term);i=fixedAdd(i,term);
    harmonicJ=(k+1)%2===0?fixedAdd(harmonicJ,weighted):fixedSubtract(harmonicJ,weighted);
    harmonicI=fixedAdd(harmonicI,weighted);
  }
  throw new MathInputProblem('budget','Bessel関数の残りの項を必要な精度で囲めません。');
}
