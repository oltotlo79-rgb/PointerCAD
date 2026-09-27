/** Integer-order Y/K on the positive real axis; principal branch, DLMF 10.8/10.31. */
import Decimal from 'decimal.js';
import type { ExactRational } from './exactRational.js';
import { MathInputProblem } from './mathInputContract.js';
import { roundBesselRational } from './besselIntegerRounding.js';
import { besselConstants, besselLog } from './besselConstants.js';
import { secondKindSeries } from './besselSecondSeries.js';
import { BESSEL_FIXED_SCALE as S, fixedRational, fixedAdd, fixedSubtract, fixedNegate,
  fixedMultiply, fixedDivide, fixedTimesRational, type BesselFixedRange } from './besselFixedRange.js';

export type SecondBesselKind = 'Y' | 'K';
export function secondKindSequence(kind: SecondBesselKind, maximumOrder: number, input: ExactRational,
  check: () => void): readonly BesselFixedRange[] {
  check();
  if(kind!=='Y'&&kind!=='K')throw new MathInputProblem('unsupported','Bessel関数の種類に対応していません。');
  // A Y interval needs one additional order to bound the derivative of n+2.
  if(!Number.isSafeInteger(maximumOrder)||maximumOrder<0||maximumOrder>131) {
    throw new MathInputProblem('budget','Bessel関数の次数が計算範囲を超えています。');
  }
  const {numerator:p,denominator:q}=input;
  if(q<=0n || p.toString(2).replace('-','').length>8192 || q.toString(2).length>8192) {
    throw new MathInputProblem('budget','Bessel関数の引数を正確に保持できません。');
  }
  if(p<=0n)throw new MathInputProblem('domain','このBessel関数の計算には正の実数の引数が必要です。');
  if(p>128n*q)throw new MathInputProblem('budget','Bessel関数の引数は128以下にしてください。');
  const constants=besselConstants(check);
  const logarithm=fixedAdd(besselLog({numerator:p,denominator:2n*q},check),constants.gamma);
  const zero=secondKindSeries(0,input,check);
  const y0=()=>fixedDivide(fixedSubtract(fixedTimesRational(fixedMultiply(logarithm,zero.j),2n),zero.harmonicJ),constants.pi);
  const k0=()=>fixedSubtract(fixedTimesRational(zero.harmonicI,1n,2n),fixedMultiply(logarithm,zero.i));
  const result:BesselFixedRange[]=[kind==='Y'?y0():k0()];
  if(maximumOrder===0) { check();return result; }
  const one=secondKindSeries(1,input,check);
  if(kind==='Y') {
    const first=fixedTimesRational(fixedSubtract(fixedTimesRational(fixedMultiply(logarithm,one.j),2n),one.harmonicJ),p,2n*q);
    result.push(fixedDivide(fixedSubtract(first,fixedRational(2n*q,p)),constants.pi));
  } else {
    const first=fixedTimesRational(fixedSubtract(fixedMultiply(logarithm,one.i),fixedTimesRational(one.harmonicI,1n,2n)),p,2n*q);
    result.push(fixedAdd(fixedRational(q,p),first));
  }
  for(let n=1;n<maximumOrder;n+=1) {
    check();
    const scaled=fixedTimesRational(result[n],2n*BigInt(n)*q,p);
    result.push(kind==='Y'?fixedSubtract(scaled,result[n-1]):fixedAdd(scaled,result[n-1]));
  }
  check();return result;
}

export function secondBesselBound(kind: SecondBesselKind, order: number, input: ExactRational,
  check: () => void): BesselFixedRange {
  if(!Number.isSafeInteger(order)||Math.abs(order)>130)throw new MathInputProblem('budget','Bessel関数の次数が計算範囲を超えています。');
  const sequence=secondKindSequence(kind,Math.abs(order),input,check);
  const value=sequence[Math.abs(order)];
  return kind==='Y'&&order<0&&order%2!==0?fixedNegate(value):value;
}

export function secondBesselDecimal(kind: SecondBesselKind, order: number, input: ExactRational,
  check: () => void): string {
  check();
  if(!Number.isSafeInteger(order)||Math.abs(order)>128)throw new MathInputProblem('budget','Bessel関数の次数の絶対値は128以下の整数にしてください。');
  const value=secondBesselBound(kind,order,input,check);
  const lower=roundBesselRational({numerator:value.lower,denominator:S});
  const upper=roundBesselRational({numerator:value.upper,denominator:S});
  check();
  if(lower!==upper)throw new MathInputProblem('budget','Bessel関数の値を必要な桁数で確定できません。');
  return new Decimal(lower).toString();
}
