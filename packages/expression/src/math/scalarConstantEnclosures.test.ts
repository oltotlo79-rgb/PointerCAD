import {beforeAll,describe,expect,it} from 'vitest';
import {createMathBackend} from './createMathBackend.js';
import {createFunctionMathSource} from './functionMathSource.js';
import {compileFunctionScalar} from './compileFunctionScalar.js';
import {createScalarIntervalSampler} from './scalarMathIntervals.js';
import {compileScalarMath} from './scalarMathTape.js';
import {exactDouble} from './exactDoubleInterval.js';
import {decimalRational,type ExactRational} from './exactRational.js';
import type {MathExecutionBackend} from './mathWorkExecution.js';

let backend:MathExecutionBackend;beforeAll(()=>{backend=createMathBackend();});
function enclosure(source:string) {
  const definition=createFunctionMathSource(source,'text','degree',{axes:['X'],parameters:[],coefficients:[]},backend);
  const tape=compileFunctionScalar(definition,['X'],[],{backend,shouldStop:()=>undefined});
  return createScalarIntervalSampler(tape)([{lower:0,upper:0}]);
}
function compare(a:ExactRational,b:ExactRational){
  const difference=a.numerator*b.denominator-b.numerator*a.denominator;return difference<0n?-1:difference>0n?1:0;
}
function exact(value:number){const result=exactDouble(value);if(result===null) throw new Error('non-finite fixture');return result;}

describe('定数の丸めを座標精度の証明に持ち込まない',()=>{
  it('QRの無理数成分も平方根の式を保ち、二乗した囲みが1/2を含む',()=>{
    const result=enclosure('component(qrq([[1,1],[1,0]]),1,1)');
    expect(result.continuous).toBe(true);expect(result.ranges).toHaveLength(1);
    const range=result.ranges[0],lower=exact(range.lower),upper=exact(range.upper),half={numerator:1n,denominator:2n};
    expect(compare({numerator:lower.numerator**2n,denominator:lower.denominator**2n},half)).toBeLessThanOrEqual(0);
    expect(compare({numerator:upper.numerator**2n,denominator:upper.denominator**2n},half)).toBeGreaterThanOrEqual(0);
    expect(range.upper-range.lower).toBeGreaterThan(0);
  });
  it('1/10を幅0の二進数として扱わず、元の有理数を挟む',()=>{
    const result=enclosure('1/10');expect(result.continuous).toBe(true);expect(result.ranges).toHaveLength(1);
    const range=result.ranges[0],target={numerator:1n,denominator:10n};
    expect(compare(exact(range.lower),target)).toBeLessThan(0);expect(compare(exact(range.upper),target)).toBeGreaterThan(0);
  });
  it('平方根の両端を正確な有理数で二乗すると、2を挟む',()=>{
    const result=enclosure('sqrt(2)');expect(result.continuous).toBe(true);expect(result.ranges).toHaveLength(1);
    const range=result.ranges[0],lower=exact(range.lower),upper=exact(range.upper),two={numerator:2n,denominator:1n};
    expect(compare({numerator:lower.numerator**2n,denominator:lower.denominator**2n},two)).toBeLessThanOrEqual(0);
    expect(compare({numerator:upper.numerator**2n,denominator:upper.denominator**2n},two)).toBeGreaterThanOrEqual(0);
    expect(range.upper-range.lower).toBeGreaterThan(0);
  });
  it.each([['pi','3.141592653589793238462643383279502884197169399375105820974944'],
    ['e','2.718281828459045235360287471352662497757247093699959574966967']])('%sの丸め値を幅0で返さない',(source,decimal)=>{
    const range=enclosure(source).ranges[0],target=decimalRational(decimal);if(target===null) throw new Error('invalid fixture');
    expect(compare(exact(range.lower),target)).toBeLessThan(0);expect(compare(exact(range.upper),target)).toBeGreaterThan(0);
  });
  it('正確に表せる1/8の幅は0のまま保持する',()=>{
    expect(enclosure('1/8')).toEqual({continuous:true,ranges:[{lower:0.125,upper:0.125}]});
  });
  it('定数の計算値が原式の正確な範囲を外れたら計算列を作らない',()=>{
    expect(()=>compileScalarMath({kind:'number',decimal:'1'},
      {inputs:['X'],angleUnit:'degree',evaluateConstant:()=>2})).toThrow('元の式から求めた範囲');
  });
  it('差を大きく増幅した式では、最終値の精度不足を隠さない',()=>{
    const result=enclosure('1000000000000*(sqrt(2)-1.4142135623730951)');
    expect(result.continuous).toBe(true);const range=result.ranges[0];
    expect(range.upper-range.lower).toBeGreaterThan(1e-7);
    expect(range.lower).toBeLessThan(-0.000051);expect(range.upper).toBeGreaterThan(-0.000052);
  });
  it('数値計算だけが成功した未証明の定数は区間を証明済みにしない',()=>{
    const tape=compileScalarMath({kind:'operation',operation:'gamma',operands:[{kind:'number',decimal:'1.5'}]},
      {inputs:['X'],angleUnit:'degree',evaluateConstant:()=>0.886226925452758});
    expect(createScalarIntervalSampler(tape)([{lower:0,upper:0}]).continuous).toBe(false);
  });
});
