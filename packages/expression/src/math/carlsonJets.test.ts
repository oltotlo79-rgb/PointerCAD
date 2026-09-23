import Decimal from 'decimal.js';
import { describe, expect, it } from 'vitest';
import { carlsonRFJet, carlsonRJJet } from './carlsonJets.js';
import { CARLSON_JET_REFERENCES } from './carlsonJetReferences.js';
import { exactDouble, exactDoubleInterval } from './exactDoubleInterval.js';
import { constant, variable, point, sum, scale, squareRoot, reciprocal, sq, div, ONE, ZERO,
  UnprovedEllipticRange, type Jet, type Range } from './ellipticJetArithmetic.js';

const D=Decimal.clone({precision:110});
const exact=(value:number)=>{
  const result=exactDouble(value);if(result===null)throw new Error('Finite endpoint required');
  return new D(result.numerator.toString()).div(result.denominator.toString());
};
function range(source:string):Range {
  const digits=source.replace('.',''),places=source.includes('.')?source.length-source.indexOf('.')-1:0;
  const result=exactDoubleInterval({numerator:BigInt(digits),denominator:10n**BigInt(places)});
  if(result===null)throw new Error('Reference argument is not finite');return result;
}
function contains(actual:Range,expected:string|number|Decimal):void {
  const target=new D(expected);
  expect(exact(actual.lower).lte(target)).toBe(true);expect(exact(actual.upper).gte(target)).toBe(true);
}
function integral(family:'RF'|'RJ',m:Range,n:Range):Jet {
  const x=constant(ZERO),z=constant(ONE);
  const y=sum(z,scale(variable(m,0),point(-1))),p=sum(z,scale(variable(n,1),point(-1)));
  return family==='RF'?carlsonRFJet(x,y,z):carlsonRJJet(x,y,z,p);
}
describe('対称楕円積分の値と一階二階の上下限を積分から囲む',()=>{
  it('0を割る場合も分母の成立を確認し、最小の非零の商を0へ丸めない',()=>{
    expect(div(ZERO,{lower:1,upper:2})).toEqual(ZERO);
    expect(div(ZERO,{lower:-2,upper:-1})).toEqual(ZERO);
    expect(()=>div(ZERO,ZERO)).toThrow(UnprovedEllipticRange);
    expect(()=>div(ZERO,{lower:-1,upper:1})).toThrow(UnprovedEllipticRange);
    expect(div(point(Number.MIN_VALUE),point(2)).upper).toBeGreaterThan(0);
    expect(div(point(-Number.MIN_VALUE),point(2)).lower).toBeLessThan(0);
  });
  it.each(CARLSON_JET_REFERENCES)('%sのm=%s・n=%sを独立した高精度の微分へ照合する',(family,m,n,...expected)=>{
    const result=integral(family,range(m),range(n)),actual=[result.value,...result.first,...result.second];
    for(let index=0;index<actual.length;index++) {
      contains(actual[index],expected[index]);
      const width=exact(actual[index].upper).sub(exact(actual[index].lower));
      expect(width.lte(D.max(1,new D(expected[index]).abs()).mul('1e-9'))).toBe(true);
      if(new D(expected[index]).isZero())expect(actual[index]).toEqual(ZERO);
    }
  });
  it.each(['RF','RJ'] as const)('%sの等しい引数を同時に動かすと同次性の微分になる',family=>{
    const t=variable(ONE,0),result=family==='RF'?carlsonRFJet(t,t,t):carlsonRJJet(t,t,t,t);
    contains(result.value,1);contains(result.first[0],family==='RF'?-.5:-1.5);
    contains(result.second[0],family==='RF'?.75:3.75);
    expect(result.first[1]).toEqual(ZERO);expect(result.second[1]).toEqual(ZERO);expect(result.second[2]).toEqual(ZERO);
  });
  it('入力の区間でも全ての値と導関数を含み、値の一点化で範囲を狭めない',()=>{
    const result=integral('RJ',{lower:0,upper:.5},{lower:0,upper:.25});
    for(const row of CARLSON_JET_REFERENCES.filter(([kind,m,n])=>kind==='RJ'&&['0','0.5'].includes(m)&&['0','0.25'].includes(n))) {
      const actual=[result.value,...result.first,...result.second];
      row.slice(3).forEach((expected,index)=>contains(actual[index],expected));
    }
  });
  it('合成の二つの一階・二階と混合微分を保つ',()=>{
    const a=variable(point(.25),0),b=variable(point(.75),1),result=reciprocal(squareRoot(sum(a,b)));
    contains(result.value,1);result.first.forEach(value=>contains(value,-.5));result.second.forEach(value=>contains(value,.75));
  });
  it('正確な0の二乗と定数の微分は0を保ち、非零の微小値は0にしない',()=>{
    expect(sq(ZERO)).toEqual(ZERO);
    const tiny=sq(point(Number.MIN_VALUE));
    expect(tiny.lower).toBe(0);expect(tiny.upper).toBeGreaterThan(0);
    const fixed=reciprocal(squareRoot(constant(ONE)));
    [...fixed.first,...fixed.second].forEach(value=>expect(value).toEqual(ZERO));
  });
  it('負の引数・二つの0・非正の分母・微分できない平方根を拒否する',()=>{
    const zero=constant(ZERO),one=constant(ONE),negative=constant(point(-1));
    expect(()=>carlsonRFJet(negative,one,one)).toThrow(UnprovedEllipticRange);
    expect(()=>carlsonRFJet(zero,zero,one)).toThrow(UnprovedEllipticRange);
    expect(()=>carlsonRJJet(zero,one,one,zero)).toThrow(UnprovedEllipticRange);
    expect(()=>carlsonRFJet(variable(ZERO,0),one,one)).toThrow(UnprovedEllipticRange);
    const fixed=carlsonRFJet(zero,one,one);contains(fixed.value,new D(-1).acos().div(2));
    fixed.first.forEach(value=>expect(value).toEqual(ZERO));
  });
});
