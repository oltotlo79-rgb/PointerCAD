import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMathBackend } from './createMathBackend.js';
import { MathInputProblem } from './mathInputContract.js';
import { executeMathWorkRequest } from './mathWorkExecution.js';

afterEach(() => { vi.restoreAllMocks(); });
describe('共通の高精度計算の実用上限だけを広げ、通常式と同じ依頼全体の期限を保つ', () => {
  it.each(['Erf','Erfc'])('%sの複素数計算も依頼全体の1秒を共有し、親の期限と次の式を保つ',head=>{
    let now=0;vi.spyOn(performance,'now').mockImplementation(()=>now);
    const backend=createMathBackend(),value=backend.box([head,['Complex',{num:'1'},{num:'1'}]]);
    expect(()=>backend.withinDeadline(()=>{const result=value.evaluate().N();now=999;return result;})).not.toThrow();
    now=0;
    expect(()=>backend.withinDeadline(()=>{value.N();now=800;value.N();now=1001;return 1;})).toThrow(MathInputProblem);
    now=0;
    expect(()=>backend.withinDeadline(()=>backend.withinDeadline(()=>{value.N();now=201;return 1;}))).toThrow(MathInputProblem);
    now=0;
    expect(()=>backend.withinDeadline(()=>{value.N();throw new Error('中止');})).toThrow('中止');
    expect(()=>backend.withinDeadline(()=>{now=201;return backend.box({num:'1'}).N();})).toThrow(MathInputProblem);
  });
  it('整数ゼータの係数を保存した式から繰り返し計算しても元の期限で答えを返す',()=>{
    let now=0;vi.spyOn(performance,'now').mockImplementation(()=>(now+=2));
    const backend=createMathBackend();
    for(const source of ['zeta(2)','coef("a")','zeta(4)','coef("a")']) {
      const result=executeMathWorkRequest({kind:'evaluate-math',serial:1,request:{
        source,notation:'text',angleUnit:'radian',
        identity:{documentId:'zeta-recompute',documentVersion:1,editorId:'coordinate',inputRevision:1},
        coefficients:[{id:'a',label:'a',decimal:'1.644934066848226436472415166646025189219',
          exactExpression:{kind:'operation',operation:'zeta',operands:[{kind:'number',decimal:'2'}]}}],
      }},backend);
      expect(result.evaluation,source).toMatchObject({status:'value',kind:'real'});
      if(result.evaluation.status!=='value'||result.evaluation.kind!=='real')throw new Error(JSON.stringify(result));
      expect(result.evaluation.coordinate).toBeCloseTo(source==='zeta(4)'?Math.PI**4/90:Math.PI**2/6,14);
    }
  });
  it.each(['EllipticK','EllipticE','EllipticF','EllipticEinc','EllipticPi','EllipticPiinc'])(
    '%sは同じ依頼の3秒を共有し、通常式や親の期限を延ばさない',head=>{
      let now=0;vi.spyOn(performance,'now').mockImplementation(()=>now);
      const backend=createMathBackend();
      const args=head==='EllipticK'||head==='EllipticE'?[{num:'0'}]
        :head==='EllipticPiinc'?[{num:'0'},{num:'0'},{num:'0'}]:[{num:'0'},{num:'0'}];
      const value=backend.box([head,...args]);
      expect(()=>backend.withinDeadline(()=>{const result=value.evaluate().N();now=2999;return result;})).not.toThrow();
      now=0;expect(()=>backend.withinDeadline(()=>{value.N();now=3001;return 1;})).toThrow(MathInputProblem);
      now=0;expect(()=>backend.withinDeadline(()=>{value.N();now=2500;value.N();now=3001;return 1;})).toThrow(MathInputProblem);
      now=0;expect(()=>backend.withinDeadline(()=>{
        value.N();now=2000;backend.box(['Gamma',{num:'1'}]).N();now=2999;return 1;
      })).not.toThrow();
      now=0;expect(()=>backend.withinDeadline(()=>{value.N();throw new Error('操作中止');})).toThrow('操作中止');
      expect(()=>backend.withinDeadline(()=>{now=201;return backend.box({num:'1'}).N();})).toThrow(MathInputProblem);
      now=0;expect(()=>backend.withinDeadline(()=>backend.withinDeadline(()=>{value.N();now=201;return 1;}))).toThrow(MathInputProblem);
    });
  it.each(['Gamma','Polygamma','Beta','BesselJ','BesselY','BesselI','BesselK','Zeta'])('%sの値と評価後の箱も同じ1秒を使い、次の通常式や外側の期限を変えない', head => {
    let now=0;vi.spyOn(performance,'now').mockImplementation(()=>now);
    const backend=createMathBackend();
    const args=head==='Zeta'?[{num:'2'}]:head==='Gamma'?[{num:'1'}]:head==='Beta'?[{num:'0.5'},{num:'0.5'}]:[{num:'1'},{num:'1'}];
    const value=backend.box([head,...args]);
    expect(()=>backend.withinDeadline(()=>{const result=value.evaluate().N();now=999;return result;})).not.toThrow();
    now=0;
    expect(()=>backend.withinDeadline(()=>{const result=value.N();now=1001;return result;})).toThrow(MathInputProblem);
    now=0;
    expect(()=>backend.withinDeadline(()=>{value.N();now=800;value.N();now=1001;return 1;})).toThrow(MathInputProblem);
    now=0;
    expect(()=>backend.withinDeadline(()=>{value.N();throw new Error('操作中止');})).toThrow('操作中止');
    expect(()=>backend.withinDeadline(()=>{now=201;return backend.box({num:'1'}).N();})).toThrow(MathInputProblem);
    now=0;
    expect(()=>backend.withinDeadline(()=>backend.withinDeadline(()=>{value.N();now=201;return 1;}))).toThrow(MathInputProblem);
  });
  it.each(['ChiSquarePdf','ChiSquareCdf','ChiSquareQuantile','TPdf','TCdf','TQuantile','FPdf','FCdf','FQuantile'])('%sでも共通計算の1秒の期限を引き継ぐ', head => {
    let now=0;vi.spyOn(performance,'now').mockImplementation(()=>now);
    const backend=createMathBackend();
    const args=head.startsWith('F')?[{num:'3'},{num:'5'},{num:'0.25'}]:[{num:'3'},{num:'0.25'}];
    expect(()=>backend.withinDeadline(()=>{const result=backend.box([head,...args]).N();now=999;return result;})).not.toThrow();
    now=0;
    expect(()=>backend.withinDeadline(()=>{const result=backend.box([head,...args]).N();now=1001;return result;})).toThrow(MathInputProblem);
  });
  it('通常数式は200ms、分布は評価後の箱でも1秒を越えたら停止する', () => {
    let now = 0; vi.spyOn(performance,'now').mockImplementation(() => now);
    const backend = createMathBackend();
    expect(() => backend.withinDeadline(() => { now = 201; return backend.box({num:'1'}).N(); })).toThrow(MathInputProblem);
    now = 0;
    expect(() => backend.withinDeadline(() => {
      const value = backend.box(['BetaPdf',{num:'2'},{num:'2'},{num:'0.5'}]).evaluate().N();
      now = 999; return value;
    })).not.toThrow();
    now = 0;
    expect(() => backend.withinDeadline(() => {
      const value = backend.box(['BetaPdf',{num:'2'},{num:'2'},{num:'0.5'}]).N();
      now = 1001; return value;
    })).toThrow(MathInputProblem);
  });
  it('同じ式内で分布を複数回呼んでも、元の依頼から1秒で止める', () => {
    let now = 0; vi.spyOn(performance,'now').mockImplementation(() => now);
    const backend = createMathBackend();
    expect(() => backend.withinDeadline(() => {
      const value = backend.box(['GammaPdf',{num:'2'},{num:'1'},{num:'1'}]);
      value.N(); now = 800; value.N(); now = 1001; return value;
    })).toThrow(MathInputProblem);
  });
  it('例外後と次の通常式へ分布用の延長を持ち越さず、外側の期限も越えない', () => {
    let now = 0; vi.spyOn(performance,'now').mockImplementation(() => now);
    const backend = createMathBackend(), value = backend.box(['BetaPdf',{num:'2'},{num:'2'},{num:'0.5'}]);
    expect(() => backend.withinDeadline(() => { value.N(); throw new Error('操作中止'); })).toThrow('操作中止');
    expect(() => backend.withinDeadline(() => { now = 201; return 1; })).toThrow(MathInputProblem);
    now = 0;
    expect(() => backend.withinDeadline(() => backend.withinDeadline(() => { value.N(); now = 201; return 1; }))).toThrow(MathInputProblem);
  });
});
