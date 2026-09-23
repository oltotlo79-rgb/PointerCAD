/** Positive real Beta. DLMF 5.12.1; combine logarithms before exponentiation. */
import Decimal from 'decimal.js';
import type { ExactRational } from './exactRational.js';
import { logGammaPositive } from './gammaBetaNumeric.js';
import { MathInputProblem } from './mathInputContract.js';

const D=Decimal.clone({precision:80,rounding:Decimal.ROUND_HALF_EVEN});
const decimal=(value:ExactRational):Decimal=>new D(value.numerator.toString()).div(value.denominator.toString());
function positive(value:ExactRational):void {
  if(value.denominator<=0n || value.numerator.toString(2).length>8192 || value.denominator.toString(2).length>8192) {
    throw new MathInputProblem('budget','Beta関数の引数を正確に保持できません。');
  }
  if(value.numerator<=0n) throw new MathInputProblem('domain','Beta関数の引数はどちらも正の実数で指定してください。');
}
export function betaFunctionDecimal(a:ExactRational,b:ExactRational,check:()=>void):string {
  check();positive(a);positive(b);
  // Check the original sum, including differences smaller than the working precision.
  const sumNumerator=a.numerator*b.denominator+b.numerator*a.denominator;
  const sumDenominator=a.denominator*b.denominator;
  if(sumNumerator>20000n*sumDenominator) throw new MathInputProblem('budget','Beta関数の二つの引数の和は20000以下にしてください。');
  const x=decimal(a),y=decimal(b);
  let result:Decimal;
  if(a.numerator===a.denominator) result=new D(1).div(y);
  else if(b.numerator===b.denominator) result=new D(1).div(x);
  else result=logGammaPositive(x,check).add(logGammaPositive(y,check))
    .sub(logGammaPositive(new D(sumNumerator.toString()).div(sumDenominator.toString()),check)).exp();
  check();
  if(!result.isFinite() || result.lte(0)) throw new MathInputProblem('budget','Beta関数の値を必要な桁数で確定できません。');
  return result.toSignificantDigits(40).toString();
}
