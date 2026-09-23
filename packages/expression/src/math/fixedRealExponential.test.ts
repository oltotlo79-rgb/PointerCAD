import Decimal from 'decimal.js';
import { describe,expect,it } from 'vitest';
import { fixedRealExponential } from './fixedRealExponential.js';
import { BESSEL_FIXED_SCALE as S,fixedRational } from './besselFixedRange.js';
const D=Decimal.clone({precision:300});
const proceed=()=>undefined;
const number=(n:bigint)=>new D(n.toString()).div(S.toString());
describe('固定小数の指数関数は丸めと全残項を囲む',()=>{
  it.each([-1024,-128,-32,-1,0,1,32,128,1024])('exp(%s)を独立した高精度の値と照合する',x=>{
    const result=fixedRealExponential(fixedRational(BigInt(x)),proceed),reference=new D(x).exp();
    expect(number(result.lower).lte(reference)).toBe(true);
    expect(number(result.upper).gte(reference)).toBe(true);
    if(x>=-128)expect(number(result.upper-result.lower).lte(reference.mul('1e-170'))).toBe(true);
    else expect(result.upper).toBeGreaterThan(0n);
  });
  it('0だけを正確な1にし、入力の区間の両端を保持する',()=>{
    expect(fixedRealExponential(fixedRational(0n),proceed)).toEqual(fixedRational(1n));
    const result=fixedRealExponential({lower:S/4n,upper:S/2n},proceed);
    expect(number(result.lower).lte(new D('.25').exp())).toBe(true);
    expect(number(result.upper).gte(new D('.5').exp())).toBe(true);
  });
  it('逆転した範囲、上限超過、中止で値を返さない',()=>{
    expect(()=>fixedRealExponential({lower:1n,upper:0n},proceed)).toThrow('範囲');
    expect(()=>fixedRealExponential(fixedRational(1025n),proceed)).toThrow('範囲');
    let steps=0;
    expect(()=>fixedRealExponential(fixedRational(32n),()=>{if(++steps===5)throw new Error('中止');})).toThrow('中止');
  });
});
