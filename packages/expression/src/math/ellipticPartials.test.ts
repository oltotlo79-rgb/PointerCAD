import Decimal from 'decimal.js';
import { describe,expect,it } from 'vitest';
import { ellipticOperation,ellipticPartialOperation,ellipticPartialValue,ellipticPartialRanges } from './ellipticPartials.js';
import { exactDouble } from './exactDoubleInterval.js';
import { type Range,point } from './ellipticJetArithmetic.js';
const D=Decimal.clone({precision:100});
function number(value:number) {
  const exact=exactDouble(value);if(exact===null)throw new Error('Nonfinite enclosure');
  return new D(exact.numerator.toString()).div(exact.denominator.toString());
}
function contains(range:Range|null,value:Decimal):void {
  expect(range).not.toBeNull();if(range===null)throw new Error('Missing partial');
  expect(number(range.lower).lte(value)).toBe(true);expect(number(range.upper).gte(value)).toBe(true);
  expect(number(range.upper).minus(number(range.lower)).lte(D.max(1,value.abs()).mul('1e-9'))).toBe(true);
}
// mpmath 1.3.0: 70/110 digits agree to 1e-60; original artefact SHA256
// 8c865da65d46a894b8dd87df54bd6b9dec8a73ff6e8b9233b41f48015e9b4755.
const references=[
  ['K',[.5],[3],false,'7.624917763145811779458492111339724728333013192942479665545214353937606'],
  ['E',[-2],[4],false,'-0.01202505817786901633623506504316464510523054665149112746831214550448504'],
  ['Pi',[.25,.5],[1,2],false,'2.769235261659765377360380788848185894789057485551649609071335319783369'],
  ['F',[1,.5],[3,1],false,'1.65533019446666803077279637229708070577843081511697815735465046438053'],
  ['Einc',[-4,.5],[0,3],false,'1.665468616168372839870690735410728392697036606467264715095903291329311'],
  ['Piinc',[.25,120,.5],[1,1,1],true,'0.01504884376357279240245555604498230702923912895279439294681651913200096'],
  ['Piinc',[0,1,0],[2,0,2],false,'0.05552669953303014049153585318146322080746893897232918438461938857824824'],
  ['F',[1,0],[0,15],false,'50208972.87935045939254968724888903056821909273373892212112181599743693'],
] as const;
describe('楕円積分の式の高階・混合微分を誤差付きで求める',()=>{
  it.each(references)('%sの高階微分を独立した答えで囲む',(kind,args,orders,degree,value)=>{
    contains(ellipticPartialValue(kind,args.map(point),orders,degree),new D(value));
  },30_000);
  it('完全形の15階と作図の追加二階を元の級数係数に照合する',()=>{
    const range=ellipticPartialRanges('K',[point(0)],[15]);
    function derivative(order:number):Decimal {
      let coefficient=new D(1);for(let k=0;k<order;k++)coefficient=coefficient.mul(new D(2*k+1).div(2).pow(2)).div(k+1);
      return D.acos(-1).mul(coefficient).div(2);
    }
    contains(range.value,derivative(15));contains(range.first[0],derivative(16));contains(range.second[0][0],derivative(17));
  },30_000);
  it('零点・負の振幅・複数周期と混合微分の順序を保持する',()=>{
    const a=ellipticPartialValue('F',[point(90),point(0)],[0,3],true);
    const b=ellipticPartialValue('K',[point(0)],[3]);
    expect(a).not.toBeNull();expect(b).not.toBeNull();
    const reference=D.acos(-1).mul(75).div(256);
    contains(a,reference);contains(b,reference);
    contains(ellipticPartialValue('F',[point(-450),point(0)],[0,3],true),reference.mul(-5));
    expect(ellipticPartialValue('Piinc',[point(2),point(0),point(2)],[2,0,2])).toEqual(point(0));
    const operation=ellipticOperation('ellipticpiinc');
    if(operation===null)throw new Error('Missing operator');
    const first=ellipticOperation(ellipticPartialOperation(operation,0));
    const second=ellipticOperation(ellipticPartialOperation(operation,2));
    if(first===null||second===null)throw new Error('Missing derivative');
    expect(ellipticPartialOperation(first,2)).toBe(ellipticPartialOperation(second,0));
  },30_000);
  it('幅のある母数と角度では内部の値も囲み、振幅微分は角の標本だけで決めない',()=>{
    const box=[{lower:-.25,upper:.25},{lower:-1,upper:2},{lower:-.25,upper:.5}];
    for(const orders of [[2,0,1],[1,2,0]]) {
      const range=ellipticPartialValue('Piinc',box,orders);
      expect(range).not.toBeNull();if(range===null)throw new Error('Missing box');
      for(const n of [-.25,0,.25])for(const phi of [-1,0,.5,1,2])for(const m of [-.25,0,.5]) {
        const value=ellipticPartialValue('Piinc',[n,phi,m].map(point),orders);
        expect(value).not.toBeNull();if(value===null)throw new Error('Missing point');
        expect(range.lower).toBeLessThanOrEqual(value.lower);expect(range.upper).toBeGreaterThanOrEqual(value.upper);
      }
    }
  },30_000);
  it('高階微分でも元の途中の極・有限端点の微分不能と次数上限を保つ',()=>{
    expect(ellipticPartialValue('E',[point(1)],[3])).toBeNull();
    expect(ellipticPartialValue('Einc',[point(90),point(1)],[3,0],true)).toBeNull();
    expect(ellipticPartialValue('Piinc',[point(2),point(4),point(.5)],[1,1,1])).toBeNull();
    expect(ellipticPartialValue('K',[point(.5)],[18])).toBeNull();
    expect(ellipticOperation('elliptic-partial:Piinc:1,2,18')).toBeNull();
  });
});
