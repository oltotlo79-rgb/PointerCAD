import Decimal from 'decimal.js';
import { describe, expect, it } from 'vitest';
import { decimalRational, type ExactRational } from './exactRational.js';
import { integerBesselDecimal } from './besselIntegerNumeric.js';
import { integerBesselSeries } from './besselIntegerSeries.js';
import { roundBesselRational } from './besselIntegerRounding.js';
import { BESSEL_INTEGER_REFERENCES } from './besselIntegerReferences.js';
import { MathInputProblem } from './mathInputContract.js';

const D = Decimal.clone({ precision: 260, rounding: Decimal.ROUND_HALF_EVEN });
const proceed = () => undefined;
function exact(text: string): ExactRational {
  const value = decimalRational(text);
  if (value === null) throw new Error('Invalid reference input');
  return value;
}
const decimal = (value: ExactRational) => new D(value.numerator.toString()).div(value.denominator.toString());

describe('整数次数のJとIは全項の残差を囲んで有効40桁を返す', () => {
  it('独立基準に複素数表記や失われた微小な値を含めない', () => {
    for (const [kind, ,x,...values] of BESSEL_INTEGER_REFERENCES) for (const text of values) {
      expect(text).toMatch(/^-?\d+(?:\.\d+)?(?:e[+-]?\d+)?$/u);
      const value=new D(text);
      expect(value.isFinite()).toBe(true);
      if (x!=='0') expect(value.isZero()).toBe(false);
      if (kind==='I'&&new D(x).gt(0)) expect(value.gt(0)).toBe(true);
    }
  });
  it.each(BESSEL_INTEGER_REFERENCES)('%s_%s(%s)を独立した300/420桁の値と照合する', (kind, order, x, expected) => {
    const answer = integerBesselSeries(kind, order, exact(x), proceed);
    const reference = new D(expected);
    expect(decimal(answer.lower).lte(reference)).toBe(true);
    expect(decimal(answer.upper).gte(reference)).toBe(true);
    expect(integerBesselDecimal(kind, order, exact(x), proceed)).toBe(reference.toSignificantDigits(40).toString());
    expect(answer.terms).toBeLessThanOrEqual(1024);
  });

  it('零点を挟む二つの入力を同じ0にせず、符号を保つ', () => {
    const left = integerBesselDecimal('J',0,exact('2.404825557695772768621631879326454643124244909145'),proceed);
    const right = integerBesselDecimal('J',0,exact('2.404825557695772768621631879326454643124244909146'),proceed);
    expect(new D(left).gt(0)).toBe(true); expect(new D(right).lt(0)).toBe(true);
  });

  it('原点と、倍精度へ渡せない極小値を区別する', () => {
    expect(integerBesselDecimal('J',0,exact('0'),proceed)).toBe('1');
    expect(integerBesselDecimal('I',2,exact('0'),proceed)).toBe('0');
    for (const kind of ['J','I'] as const) {
      const tiny = integerBesselDecimal(kind,128,exact('1e-100'),proceed);
      expect(new D(tiny).gt(0)).toBe(true); expect(Number(tiny)).toBe(0);
    }
  });

  it('負の次数と負の入力の偶奇を丸める前に保つ', () => {
    for (const kind of ['J','I'] as const) for (const order of [0,1,2,7,128]) {
      const positive = new D(integerBesselDecimal(kind,order,exact('4'),proceed));
      expect(new D(integerBesselDecimal(kind,order,exact('-4'),proceed)).eq(positive.mul(order%2===0?1:-1))).toBe(true);
      expect(new D(integerBesselDecimal(kind,-order,exact('4'),proceed)).eq(positive.mul(kind==='J'&&order%2===1?-1:1))).toBe(true);
    }
  });

  it('偶数丸めの境界・繰上がり・負数を正確な分数で決める', () => {
    const round = (p: bigint, q: bigint) => new D(roundBesselRational({numerator:p,denominator:q})).toString();
    expect(round(10n**40n+5n,10n)).toBe(new D('1e39').toString());
    expect(round(10n**40n+15n,10n)).toBe(new D((10n**39n+2n).toString()).toString());
    expect(round(10n**41n-5n,10n)).toBe('1e+40');
    expect(round(-(10n**40n+15n),10n)).toBe(new D((-(10n**39n+2n)).toString()).toString());
    expect(round(1n,10n**4000n)).toBe('1e-4000');
    expect(()=>round(1n,0n)).toThrow('Positive denominator');
  });

  it.each([129,-129,Infinity,NaN,0.5])('未対応の次数%sを値へ置き換えない', (order) => {
    expect(()=>integerBesselDecimal('J',order,exact('1'),proceed)).toThrow(MathInputProblem);
  });

  it('元の正確な引数の範囲と有限な作業量を確認する', () => {
    expect(()=>integerBesselDecimal('J',0,exact('128.000000000000000000000000000000000000000000000001'),proceed)).toThrow('128以下');
    for (const input of [{numerator:1n,denominator:0n},{numerator:1n,denominator:-1n},
      {numerator:1n<<8192n,denominator:1n},{numerator:1n,denominator:1n<<8192n}]) {
      expect(()=>integerBesselDecimal('I',0,input,proceed)).toThrow(MathInputProblem);
    }
  });

  it('開始時・初項を作る途中・級数の途中の中止を引き継ぐ', () => {
    const stopped = new MathInputProblem('budget','利用者による中止');
    for (const [order, stopAt] of [[0,1],[32,7],[0,16]]) {
      let calls=0;
      expect(()=>integerBesselDecimal('J',order,exact('128'),()=>{if(++calls===stopAt)throw stopped;})).toThrow(stopped);
      expect(calls).toBe(stopAt);
    }
  });
});
