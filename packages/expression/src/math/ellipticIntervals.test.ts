import Decimal from 'decimal.js';
import { describe,expect,it } from 'vitest';
import { ellipticRanges,ellipticSample } from './ellipticIntervals.js';
import { exactDouble } from './exactDoubleInterval.js';
import { ELLIPTIC_PLOT_REFERENCES } from './ellipticPlotReferences.js';
import type { MathInterval } from './mathInterval.js';

const D=Decimal.clone({precision:110});
const point=(x:number)=>({lower:x,upper:x});
function exact(x:number):Decimal {
  const q=exactDouble(x);if(q===null)throw new Error('Nonfinite interval');
  return new D(q.numerator.toString()).div(q.denominator.toString());
}
function contains(range:MathInterval|null,reference:string,narrow=true):void {
  expect(range).not.toBeNull();if(range===null)throw new Error('Unproved enclosure');
  const value=new D(reference),lo=exact(range.lower),hi=exact(range.upper);
  expect(lo.lte(value),`${range.lower} <= ${reference}`).toBe(true);
  expect(hi.gte(value),`${range.upper} >= ${reference}`).toBe(true);
  if(narrow)expect(hi.minus(lo).lte(D.max(1,value.abs()).mul('1e-8'))).toBe(true);
}
describe('楕円積分の作図の値・全引数の微分を誤差の範囲とともに保つ',()=>{
  it('半周期の厳密な0を基準値の数値微分の残りで置き換えない',()=>{
    for(const reference of ELLIPTIC_PLOT_REFERENCES.filter(x=>x.degree)) {
      const amp=reference.kind==='Piinc'?1:0;
      if(Number(reference.args[amp])%90===0)expect(reference.second[amp][amp]).toBe('0');
    }
    for(const kind of ['F','Einc','Piinc'] as const) {
      const amp=kind==='Piinc'?1:0;
      const args=(phi:number)=>(kind==='Piinc'?[.25,phi,.5]:[phi,.5]).map(point);
      const center=ellipticRanges(kind,args(90),true).second[amp][amp];
      contains(center,'0');
      const left=ellipticRanges(kind,args(89),true).second[amp][amp];
      const right=ellipticRanges(kind,args(91),true).second[amp][amp];
      if(left===null||right===null)throw new Error('Missing one-sided derivative bounds');
      expect(kind==='Einc'?left.upper:left.lower)[kind==='Einc'?'toBeLessThan':'toBeGreaterThan'](0);
      expect(kind==='Einc'?right.lower:right.upper)[kind==='Einc'?'toBeGreaterThan':'toBeLessThan'](0);
    }
  });
  it.each(ELLIPTIC_PLOT_REFERENCES)('$kind($args) degree=$degreeの全成分を別の計算と照合する',reference=>{
    const result=ellipticRanges(reference.kind,reference.args.map(x=>point(Number(x))),reference.degree);
    contains(result.value,reference.value);
    for(let i=0;i<reference.args.length;i++) {
      contains(result.first[i],reference.first[i]);
      for(let j=0;j<reference.args.length;j++)contains(result.second[i][j],reference.second[i][j]);
    }
  });
  it('幅のある三引数の全範囲に内部と両側の微分を含める',()=>{
    const result=ellipticRanges('Piinc',[{lower:-.5,upper:.25},{lower:-4,upper:4},{lower:-2,upper:.5}]);
    for(const reference of ELLIPTIC_PLOT_REFERENCES.filter(x=>x.kind==='Piinc'&&!x.degree&&Number(x.args[0])<1)) {
      contains(result.value,reference.value,false);
      for(let i=0;i<3;i++) {
        contains(result.first[i],reference.first[i],false);
        for(let j=0;j<3;j++)contains(result.second[i][j],reference.second[i][j],false);
      }
    }
  });
  it('度の半周期・複数周期と負の角度で周期の値を落とさない',()=>{
    for(const [kind,complete] of [['F','K'],['Einc','E'],['Piinc','Pi']] as const) {
      const base=ellipticSample(complete,complete==='Pi'?[.25,.5]:[.5]);
      for(const [phi,multiple] of [[90,1],[270,3],[-270,-3],[450,5]] as const) {
        const args=kind==='Piinc'?[.25,phi,.5]:[phi,.5];
        expect(ellipticSample(kind,args,true)).toBeCloseTo(multiple*base,10);
      }
    }
  });
  it('角度0の値と母数微分を正確に0として保つ',()=>{
    for(const kind of ['F','Einc','Piinc'] as const) {
      const args=kind==='Piinc'?[2,0,2]:[0,2],result=ellipticRanges(kind,args.map(point));
      expect(result.value).toEqual(point(0));
      expect(result.first[args.length-1]).toEqual(point(0));
      contains(result.first[kind==='Piinc'?1:0],'1');
      expect(ellipticSample(kind,args)).toBe(0);
    }
  });
  it('第二種の母数1の有限値と、存在しない母数微分を区別する',()=>{
    const complete=ellipticRanges('E',[point(1)]);
    expect(complete.value).toEqual(point(1));expect(complete.first[0]).toBeNull();
    for(const [phi,expected] of [[90,1],[270,3],[-450,-5]] as const) {
      const result=ellipticRanges('Einc',[point(phi),point(1)],true);
      contains(result.value,String(expected));expect(result.first[1]).toBeNull();
    }
  });
  it('終点が実数でも途中の発散・非実数部分を越える入力は断る',()=>{
    expect(ellipticRanges('F',[point(3.125),point(2)]).value).toBeNull();
    expect(ellipticRanges('Piinc',[point(2),point(3.125),point(.5)]).value).toBeNull();
    expect(ellipticRanges('K',[{lower:.5,upper:1.1}]).value).toBeNull();
    expect(ellipticRanges('Pi',[{lower:.5,upper:1.1},point(.5)]).value).toBeNull();
    expect(ellipticRanges('K',[point(1)]).value).toBeNull();
    expect(ellipticRanges('E',[point(1.1)]).value).toBeNull();
  });
});
