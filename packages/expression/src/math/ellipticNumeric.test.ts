import Decimal from 'decimal.js';
import { describe,expect,it } from 'vitest';
import { decimalRational,type ExactRational } from './exactRational.js';
import { ellipticValue,type EllipticBounds,type EllipticKind } from './ellipticNumeric.js';
import { ELLIPTIC_REFERENCES } from './ellipticReferences.js';
import { MathInputProblem } from './mathInputContract.js';

const D=Decimal.clone({precision:310,rounding:Decimal.ROUND_HALF_EVEN});
const proceed=()=>undefined;
function rational(source:string):ExactRational {
  const value=decimalRational(source);if(value===null)throw new Error('Invalid test input');return value;
}
const number=(value:ExactRational)=>new D(value.numerator.toString()).div(value.denominator.toString());
const value=(kind:EllipticKind,args:readonly string[])=>ellipticValue(kind,args.map(rational),proceed);
function matches(answer:EllipticBounds,reference:string):void {
  const expected=new D(reference);
  expect(number(answer.lower).lte(expected)).toBe(true);
  expect(number(answer.upper).gte(expected)).toBe(true);
  expect(answer.decimal).toBe(expected.toSignificantDigits(40).toString());
}
describe('楕円積分の三種類で母数・角度・途中の極を区別する',()=>{
  it.each(ELLIPTIC_REFERENCES)('%s(%s)を独立した360/480桁の値と上下限まで照合する',(kind,args,reference)=>{
    matches(value(kind,args),reference);
  },30_000);
  it('第一種の発散を第二種の有限な境界と混同しない',()=>{
    expect(value('E',['1']).decimal).toBe('1');
    for(const kind of ['K','Pi'] as const)expect(()=>value(kind,kind==='K'?['1']:['0.25','1'])).toThrow(MathInputProblem);
    for(const kind of ['K','E'] as const)expect(()=>value(kind,['1.0001'])).toThrow(MathInputProblem);
  });
  it.each(['F','Einc','Piinc'] as const)('%sは終点が実数でも途中で実数範囲や極を越えた入力を拒否する',kind=>{
    const args=kind==='Piinc'?['2','3.14','0.5']:['3.14','2'];
    expect(()=>value(kind,args)).toThrow('途中');
    expect(()=>value(kind,kind==='Piinc'?['2','1','0.5']:['1','2'])).toThrow(MathInputProblem);
    expect(value(kind,kind==='Piinc'?['2','0.125','0.5']:['0.125','2']).decimal).not.toBe('0');
  });
  it.each(['1','1.00001','2'])('第三種のn=%sは主値へ置き換えない',n=>{
    expect(()=>value('Pi',[n,'0.5'])).toThrow('主値');
  });
  it('m=1の第二種は一周期を越えてもcosの絶対値を積分する',()=>{
    const phi=new D(4),reference=new D(2).sub(phi.sin());
    // Integral to 4 is 2+sin(4-pi)=2-sin(4), not sin(4).
    matches(value('Einc',['4','1']),reference.toString());
    expect(new D(value('Einc',['-4','1']).decimal).add(value('Einc',['4','1']).decimal).isZero()).toBe(true);
  });
  it('piの正確な倍数は半周期の境界を丸めず、発散と第二種の有限値を区別する',()=>{
    for(const multiple of ['0.5','1','1.5','-2']) {
      const result=ellipticValue('Einc',[rational(multiple),rational('1')],proceed,true);
      expect(result.decimal).toBe(new D(multiple).mul(2).toString());
      expect(()=>ellipticValue('F',[rational(multiple),rational('1')],proceed,true)).toThrow('途中');
    }
    const half=ellipticValue('F',[rational('0.5'),rational('0.5')],proceed,true);
    expect(half.decimal).toBe(value('K',['0.5']).decimal);
  });
  it.each(['F','Einc','Piinc'] as const)('%sの振幅の微分は独立した定義の被積分関数と一致する',kind=>{
    const h=new D('1e-10'),phi=new D('0.75'),m=new D('0.5'),n=new D('0.25');
    const args=(x:Decimal)=>kind==='Piinc'?[n.toString(),x.toString(),m.toString()]:[x.toString(),m.toString()];
    const slope=new D(value(kind,args(phi.add(h))).decimal).sub(value(kind,args(phi.sub(h))).decimal).div(h.mul(2));
    const radical=new D(1).sub(m.mul(phi.sin().pow(2))).sqrt();
    const expected=kind==='Einc'?radical:kind==='F'?new D(1).div(radical)
      :new D(1).div(radical.mul(new D(1).sub(n.mul(phi.sin().pow(2)))));
    expect(slope.sub(expected).abs().lt('1e-18')).toBe(true);
  },30_000);
  it('m=0では第一種と第二種は元の振幅となり、第三種のn=0は第一種と一致する',()=>{
    for(const phi of ['-4','0','0.25','4'])for(const kind of ['F','Einc'] as const)matches(value(kind,[phi,'0']),phi);
    expect(value('Pi',['0','0.5']).decimal).toBe(value('K',['0.5']).decimal);
    expect(value('Piinc',['0','4','0.5']).decimal).toBe(value('F',['4','0.5']).decimal);
  },30_000);
  it('精度不足を0や不成立の答えに置き換えず、引数の数と保持上限を確認する',()=>{
    expect(()=>value('F',['1e-1000','0.5'])).toThrow('桁数');
    expect(()=>value('K',[])).toThrow('引数の数');
    expect(()=>ellipticValue('K',[{numerator:0n,denominator:0n}],proceed)).toThrow('保持');
    expect(()=>ellipticValue('K',[{numerator:-(1n<<8192n),denominator:1n}],proceed)).toThrow('保持');
    expect(()=>value('K',['0.'+'9'.repeat(1000)])).toThrow('境界');
  });
  it('開始前と反復の途中の中止を結果へ置き換えない',()=>{
    const stopped=new MathInputProblem('budget','中止しました');
    for(const stopAt of [1,4,20,200]) {
      let calls=0;
      expect(()=>ellipticValue('Pi',[rational('0.25'),rational('0.5')],()=>{if(++calls===stopAt)throw stopped;})).toThrow(stopped);
      expect(calls).toBe(stopAt);
    }
  });
});
