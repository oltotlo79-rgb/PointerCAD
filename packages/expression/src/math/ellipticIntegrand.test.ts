import Decimal from 'decimal.js';
import { describe,expect,it } from 'vitest';
import { ellipticIntegrand,ellipticFactorial } from './ellipticIntegrand.js';
import { point,UnprovedEllipticRange,type Range } from './ellipticJetArithmetic.js';
import { exactDouble } from './exactDoubleInterval.js';
const D=Decimal.clone({precision:100});
function number(value:number) {
  const exact=exactDouble(value);if(exact===null)throw new Error('Nonfinite enclosure');
  return new D(exact.numerator.toString()).div(exact.denominator.toString());
}
function contains(range:Range,value:Decimal) {
  expect(number(range.lower).lte(value)).toBe(true);expect(number(range.upper).gte(value)).toBe(true);
}
describe('楕円積分の高階の被積分関数を元の成立条件で囲む',()=>{
  it('第二種m=1の原点近くはcosとなり、17階まで既知の係数と一致する',()=>{
    const result=ellipticIntegrand('E',point(1),point(0),point(0),0,0,17);
    result.forEach((range,k)=>contains(range,k%2===1?new D(0):new D(k%4===0?1:-1).div(ellipticFactorial(k).toString())));
  });
  it('第一種m=1の原点ではsecの係数を保持する',()=>{
    const result=ellipticIntegrand('K',point(1),point(0),point(0),0,0,6);
    const expected=['1','0','0.5','0',new D(5).div(24).toString(),'0',new D(61).div(720).toString()];
    result.forEach((range,k)=>contains(range,new D(expected[k])));
  });
  it('母数0で一階の被積分関数sin²/2の低次係数を保つ',()=>{
    for(const family of ['K','E','Pi'] as const) {
      const result=ellipticIntegrand(family,point(0),point(0),point(0),1,0,6),sign=family==='E'?-1:1;
      for(const [k,value] of [[0,new D(0)],[2,new D(sign).div(2)],[4,new D(-sign).div(6)],[6,new D(sign).div(45)]] as const)contains(result[k],value);
    }
  });
  it('17階の母数微分と混合微分が原点ではsinの34乗を保持する',()=>{
    for(const [p,q] of [[17,0],[9,8],[0,17]]) {
      const result=ellipticIntegrand('Pi',point(0),point(0),point(0),p,q,17);
      for(const coefficient of result)expect(coefficient).toEqual(point(0));
    }
  });
  it('度の四分の一周期で対称性による奇数次の係数を正確な0に保つ',()=>{
    for(const family of ['K','E','Pi'] as const)for(const angle of [0,90,180,270]) {
      const result=ellipticIntegrand(family,point(.5),point(.25),point(angle),0,0,15,true);
      for(let k=1;k<=15;k+=2)expect(result[k]).toEqual(point(0));
    }
  });
  it('幅のある区間は端点と内部の係数をすべて含める',()=>{
    const box=ellipticIntegrand('Pi',{lower:-1,upper:.5},{lower:-.5,upper:.25},{lower:.125,upper:.25},2,1,4);
    for(const m of [-1,0,.5])for(const n of [-.5,0,.25])for(const phi of [.125,.1875,.25]) {
      const at=ellipticIntegrand('Pi',point(m),point(n),point(phi),2,1,4);
      for(let k=0;k<5;k++) {
        expect(box[k].lower).toBeLessThanOrEqual(at[k].lower);expect(box[k].upper).toBeGreaterThanOrEqual(at[k].upper);
      }
    }
  });
  it('微分の上限、根号と分母の不成立を拒否する',()=>{
    expect(()=>ellipticIntegrand('K',point(0),point(0),point(0),18,0,0)).toThrow(UnprovedEllipticRange);
    expect(()=>ellipticIntegrand('Pi',point(0),point(0),point(0),9,9,0)).toThrow(UnprovedEllipticRange);
    expect(()=>ellipticIntegrand('Pi',point(0),point(2),point(1),1,0,4)).toThrow(UnprovedEllipticRange);
    expect(()=>ellipticIntegrand('K',point(2),point(0),point(1),1,0,4)).toThrow(UnprovedEllipticRange);
  });
});
