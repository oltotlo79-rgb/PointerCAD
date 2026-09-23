import Decimal from 'decimal.js';
import { describe,expect,it } from 'vitest';
import { integrateEllipticParameter } from './ellipticQuadrature.js';
import { UnprovedEllipticRange,type Range } from './ellipticJetArithmetic.js';
import { exactDouble } from './exactDoubleInterval.js';
const D=Decimal.clone({precision:100});
function number(value:number) {
  const exact=exactDouble(value);if(exact===null)throw new Error('Nonfinite enclosure');
  return new D(exact.numerator.toString()).div(exact.denominator.toString());
}
function contains(range:Range,value:Decimal) {
  expect(number(range.lower).lte(value)).toBe(true);expect(number(range.upper).gte(value)).toBe(true);
  expect(number(range.upper).minus(number(range.lower)).lte(D.max(1,value.abs()).mul('1e-9'))).toBe(true);
}
// Independent reduction of the exact sin-power integral by integration by parts.
function sinMoment(order:number,phi:Decimal):Decimal {
  let result=phi;
  for(let k=1;k<=order;k++)result=result.mul(2*k-1).minus(phi.sin().pow(2*k-1).mul(phi.cos())).div(2*k);
  return result;
}
describe('高階の楕円積分に四階微分の残差を含める',()=>{
  it.each([0,1,3,6,15,17])('母数0で第%s階をsinの冪の正確な積分と照合する',p=>{
    const result=integrateEllipticParameter('K',0,0,0,1,p,0,{check:()=>undefined});
    let coefficient=new D(1);for(let k=0;k<p;k++)coefficient=coefficient.mul(2*k+1).div(2);
    contains(result,sinMoment(p,new D(1)).mul(coefficient));
    expect(number(result.upper).minus(number(result.lower)).lte(D.max(1,sinMoment(p,new D(1)).mul(coefficient).abs()).mul('1e-11'))).toBe(true);
  },30_000);
  it.each([.5,1,1.5])('中央の値に偏らず、上端%sの第15階も積分全体の精度を保つ',upper=>{
    let coefficient=new D(1);for(let k=0;k<15;k++)coefficient=coefficient.mul(2*k+1).div(2);
    const result=integrateEllipticParameter('K',0,0,0,upper,15,0,{check:()=>undefined});
    const reference=sinMoment(15,new D(upper)).mul(coefficient);
    contains(result,reference);
    expect(number(result.upper).minus(number(result.lower)).lte(D.max(1,reference.abs()).mul('1e-11'))).toBe(true);
  },30_000);
  it('第三種の混合微分と積分の向きを保持する',()=>{
    let coefficient=new D(1);for(let k=0;k<4;k++)coefficient=coefficient.mul(2*k+1).div(2);
    coefficient=coefficient.mul(6);
    const reference=sinMoment(7,new D(1)).mul(coefficient);
    contains(integrateEllipticParameter('Pi',0,0,0,1,4,3,{check:()=>undefined}),reference);
    contains(integrateEllipticParameter('Pi',0,0,1,0,4,3,{check:()=>undefined}),reference.negated());
  },30_000);
  it('第二種の母数による高階微分の負符号を落とさない',()=>{
    contains(integrateEllipticParameter('E',0,0,0,1,3,0,{check:()=>undefined}),sinMoment(3,new D(1)).mul(-3).div(8));
  },30_000);
  it('中止・分割上限・不正な予算では途中の積分を返さない',()=>{
    const stop=new Error('cancelled');let calls=0;
    expect(()=>integrateEllipticParameter('K',.5,0,0,1,3,0,{check:()=>{if(++calls>10)throw stop;}})).toThrow(stop);
    expect(()=>integrateEllipticParameter('K',.5,0,0,1,3,0,{check:()=>undefined,maximumCells:1})).toThrow(UnprovedEllipticRange);
    expect(()=>integrateEllipticParameter('K',0,0,0,1,3,0,{check:()=>undefined,relativeTolerance:0})).toThrow(UnprovedEllipticRange);
  });
});
