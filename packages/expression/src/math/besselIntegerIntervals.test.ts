import Decimal from 'decimal.js';
import { describe, expect, it } from 'vitest';
import { BESSEL_INTEGER_REFERENCES } from './besselIntegerReferences.js';
import { integerBesselRanges, integerBesselValueRange } from './besselIntegerIntervals.js';
import { exactDouble } from './exactDoubleInterval.js';
import { nextFloat, type MathInterval } from './mathInterval.js';
import { MathInputProblem } from './mathInputContract.js';

const D = Decimal.clone({ precision: 260 });
function double(value: number): Decimal {
  const exact = exactDouble(value);
  if (exact === null) throw new Error('Finite interval required');
  return new D(exact.numerator.toString()).div(exact.denominator.toString());
}
function contains(range: MathInterval | null, expected: string): void {
  expect(range).not.toBeNull();
  if (range === null) throw new Error('Missing enclosure');
  expect(double(range.lower).lte(expected)).toBe(true);
  expect(double(range.upper).gte(expected)).toBe(true);
}

describe('整数次数のBesselの値と微分を作図する範囲全体で囲む', () => {
  // Exact decimal inputs must not be silently replaced by their nearby IEEE value.
  const dyadic = BESSEL_INTEGER_REFERENCES.filter(([, ,x]) => ['0','1','32','64','128','0.125','3','-4'].includes(x));
  it.each(dyadic)('%s_%s(%s)の値・一階二階微分を独立な基準で照合する', (kind,n,x,v,d1,d2) => {
    const range=integerBesselRanges(kind,n,{lower:Number(x),upper:Number(x)});
    contains(range.value,v); contains(range.first,d1); contains(range.second,d2);
  });

  it('内部に振動や極値がある区間を端点だけで結ばない', () => {
    const range=integerBesselValueRange('J',0,{lower:0,upper:128});
    contains(range,'1'); contains(range,'-0.402759395702552972096002186427');
    expect(range).toEqual({lower:-1,upper:1});
    const narrow=integerBesselRanges('J',0,{lower:0.99,upper:1.01});
    const reference=BESSEL_INTEGER_REFERENCES.find(([kind,n,x])=>kind==='J'&&n===0&&x==='1');
    if (!reference) throw new Error('Missing reference');
    contains(narrow.value,reference[3]); contains(narrow.first,reference[4]); contains(narrow.second,reference[5]);
  });

  it('Iの偶関数の原点での最小値と奇関数の負側を保つ', () => {
    for (const n of [0,1,2,3]) {
      const range=integerBesselRanges('I',n,{lower:-4,upper:4});
      contains(range.value,n===0?'1':'0');
      contains(range.first,n===1?'0.5':'0');
      contains(range.second,n===0?'0.5':n===2?'0.25':'0');
      if (n%2===0) expect(range.value?.lower).toBe(n===0?1:0);
    }
  });

  it('極小値を0だけの範囲にせず、最小の倍精度数の隣まで含める', () => {
    const range=integerBesselValueRange('J',128,{lower:2**-100,upper:2**-100});
    expect(range).toEqual({lower:0,upper:Number.MIN_VALUE});
    const atOrigin=integerBesselValueRange('J',128,{lower:0,upper:0});
    expect(atOrigin).toEqual({lower:0,upper:0});
  });

  it('微分用の内部次数を公開範囲として受け入れない', () => {
    for (const order of [129,-129,0.5,NaN]) expect(integerBesselRanges('J',order,{lower:1,upper:1})).toEqual({value:null,first:null,second:null});
    for (const input of [{lower:0,upper:nextFloat(128,1)},{lower:-129,upper:0},
      {lower:2,upper:1},{lower:NaN,upper:1},{lower:0,upper:Infinity}]) {
      expect(integerBesselValueRange('I',0,input)).toBeNull();
    }
  });

  it('値の範囲と微分でも途中の中止を吞み込まない', () => {
    const stopped=new MathInputProblem('budget','利用者による中止');
    let calls=0;
    expect(()=>integerBesselRanges('J',32,{lower:127,upper:128},()=>{if(++calls===8)throw stopped;})).toThrow(stopped);
    expect(calls).toBe(8);
    expect(()=>integerBesselValueRange('J',0,{lower:-128,upper:128},()=>{throw stopped;})).toThrow(stopped);
  });
});
