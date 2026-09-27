import Decimal from 'decimal.js';
import { describe,expect,it } from 'vitest';
import { carlsonRF,carlsonRD,carlsonRJ } from './carlsonSymmetric.js';
import { ellipticSqrt } from './ellipticFixed.js';
import { BESSEL_FIXED_SCALE as S, fixedRational,type BesselFixedRange as Range } from './besselFixedRange.js';

const D=Decimal.clone({precision:150});
const proceed=()=>undefined;
const f=(x:bigint)=>fixedRational(x);
const decimal=(x:bigint)=>new D(x.toString()).div(S.toString());
function encloses(answer:Range,expected:Decimal):void {
  expect(decimal(answer.lower).lte(expected)).toBe(true);
  expect(decimal(answer.upper).gte(expected)).toBe(true);
  expect(decimal(answer.upper-answer.lower).div(expected.abs()).lt('1e-100')).toBe(true);
}
describe('Carlson対称形の重複公式を等引数・解析値・同次性で確認する',()=>{
  it.each([1n,2n,100n])('等引数%sで定義積分の解析値を含む',x=>{
    const root=new D(x.toString()).sqrt();
    encloses(carlsonRF(f(x),f(x),f(x),proceed),root.pow(-1));
    encloses(carlsonRD(f(x),f(x),f(x),proceed),root.pow(-3));
    encloses(carlsonRJ(f(x),f(x),f(x),f(x),proceed),root.pow(-3));
  });
  it('零を一つ持つ第一種と第二種の補助値はpiの解析値に一致する',()=>{
    const pi=D.acos(-1);
    encloses(carlsonRF(f(0n),f(1n),f(1n),proceed),pi.div(2));
    encloses(carlsonRD(f(0n),f(1n),f(1n),proceed),pi.mul(3).div(4));
  });
  it('第三種の三引数の置換と拡大の同次性を保つ',()=>{
    const base=carlsonRJ(f(1n),f(2n),f(3n),f(4n),proceed);
    const swapped=carlsonRJ(f(3n),f(1n),f(2n),f(4n),proceed);
    expect(swapped.lower<=base.upper&&swapped.upper>=base.lower).toBe(true);
    const scaled=carlsonRJ(f(4n),f(8n),f(12n),f(16n),proceed);
    expect(scaled.lower*8n<=base.upper&&scaled.upper*8n>=base.lower).toBe(true);
  },30_000);
  it('入力区間の中の値を端の丸めで失わない',()=>{
    const range={lower:f(1n).lower,upper:f(2n).upper};
    const root=ellipticSqrt(range,proceed);
    expect(root.lower).toBe(S);
    expect(decimal(root.upper).gte(new D(2).sqrt())).toBe(true);
  });
  it('二つの零や負の引数、第三種の極を有限値として返さない',()=>{
    expect(()=>carlsonRF(f(0n),f(0n),f(1n),proceed)).toThrow('非負');
    expect(()=>carlsonRD(f(1n),f(1n),f(0n),proceed)).toThrow('分母');
    expect(()=>carlsonRJ(f(1n),f(2n),f(3n),f(-1n),proceed)).toThrow('分母');
  });
});
