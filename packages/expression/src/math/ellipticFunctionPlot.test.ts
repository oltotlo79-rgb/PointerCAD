import { beforeAll,describe,expect,it } from 'vitest';
import { createMathBackend } from './createMathBackend.js';
import type { MathExecutionBackend } from './mathWorkExecution.js';
import { createFunctionMathSource } from './functionMathSource.js';
import { compileFunctionScalar } from './compileFunctionScalar.js';
import { createScalarSampler } from './scalarMathTape.js';
import { createScalarIntervalSampler } from './scalarMathIntervals.js';
import { createScalarDirectionalJet } from './scalarCurveCurvature.js';
import { createScalarDifferential } from './scalarDifferential.js';
import { ELLIPTIC_PLOT_REFERENCES } from './ellipticPlotReferences.js';
import type { MathInterval } from './mathInterval.js';
let backend:MathExecutionBackend;
beforeAll(()=>{backend=createMathBackend();});
function tape(source:string,degree=false) {
  return compileFunctionScalar(createFunctionMathSource(source,'text',degree?'degree':'radian',
    {axes:['X','Y','Z'],parameters:[],coefficients:[]},backend),['X','Y','Z'],[],{backend,shouldStop:()=>undefined});
}
function contains(range:MathInterval|null|undefined,value:number):void {
  expect(range).not.toBeNull();if(range==null)throw new Error('Missing derivative');
  expect(range.lower).toBeLessThanOrEqual(value);expect(range.upper).toBeGreaterThanOrEqual(value);
}
const operations={K:'elliptick(X)',E:'elliptice(X)',F:'ellipticf(X,Y)',Einc:'ellipticeinc(X,Y)',Pi:'ellipticpi(X,Y)',Piinc:'ellipticpiinc(X,Y,Z)'};
describe('楕円積分を作図の値・接線・曲がり方へ接続する',()=>{
  it.each(ELLIPTIC_PLOT_REFERENCES)('$kindの全引数が動く式を作図する',reference=>{
    const compiled=tape(operations[reference.kind],reference.degree),inputs=[...reference.args.map(Number)];
    while(inputs.length<3)inputs.push(0);
    expect(createScalarSampler(compiled)(inputs)).toBeCloseTo(Number(reference.value),9);
    const differential=createScalarDifferential(compiled)(inputs);
    expect(differential.reason).toBeNull();
    const box=inputs.map(x=>({lower:x,upper:x}));
    const directions=[[1,0,0],[0,1,0],[0,0,1],[1,-2,3]];
    for(const direction of directions) {
      const jet=createScalarDirectionalJet(compiled,direction)(box);
      let first=0,second=0;
      for(let i=0;i<reference.args.length;i++) {
        expect(differential.gradient?.[i]).toBeCloseTo(Number(reference.first[i]),8);
        first+=direction[i]*Number(reference.first[i]);
        for(let j=0;j<reference.args.length;j++)second+=direction[i]*direction[j]*Number(reference.second[i][j]);
      }
      contains(jet.first,first);contains(jet.second,second);
    }
  });
  it('内側の合成の二階微分と定数の囲いを保持する',()=>{
    const composed=tape('elliptick(X^2/2)'),atOne=[{lower:1,upper:1},{lower:0,upper:0},{lower:0,upper:0}];
    const reference=ELLIPTIC_PLOT_REFERENCES.find(x=>x.kind==='K'&&x.args[0]==='0.5');
    if(reference===undefined)throw new Error('Missing reference');
    const jet=createScalarDirectionalJet(composed,[1,0,0])(atOne);
    contains(jet.first,Number(reference.first[0]));contains(jet.second,Number(reference.first[0])+Number(reference.second[0][0]));
    const interval=createScalarIntervalSampler(tape('elliptick(0)+X'))([{lower:0,upper:0},{lower:0,upper:0},{lower:0,upper:0}]);
    expect(interval.continuous).toBe(true);contains(interval.ranges[0],Math.PI/2);
  });
  it.each(['elliptick(X)','0*elliptick(X)','elliptick(X)/elliptick(X)'])('%sで母数1の発散を消さない',source=>{
    const compiled=tape(source);
    expect(Number.isFinite(createScalarSampler(compiled)([1,0,0]))).toBe(false);
    expect(createScalarIntervalSampler(compiled)([{lower:.5,upper:1.1},{lower:0,upper:0},{lower:0,upper:0}]).continuous).toBe(false);
  });
  it('途中の極を越えた第三種や合成の内側の穴をつながない',()=>{
    expect(Number.isFinite(createScalarSampler(tape('ellipticpiinc(2,X,0.5)'))([3.125,0,0]))).toBe(false);
    expect(Number.isFinite(createScalarSampler(tape('elliptick(1/X)'))([0,0,0]))).toBe(false);
    expect(createScalarIntervalSampler(tape('elliptick(1/X)'))([{lower:-1,upper:1},{lower:0,upper:0},{lower:0,upper:0}]).continuous).toBe(false);
  });
  it('式としての三階微分にも、作図の値・傾き・曲がり方を渡す',()=>{
    const compiled=tape('diff(elliptick(X),X,X,X)'),inputs=[0,0,0],box=inputs.map(x=>({lower:x,upper:x}));
    function derivative(order:number):number {
      let coefficient=Math.PI/2;for(let k=0;k<order;k++)coefficient*=((2*k+1)/2)**2/(k+1);
      return coefficient;
    }
    expect(createScalarSampler(compiled)(inputs)).toBeCloseTo(derivative(3),8);
    expect(createScalarDifferential(compiled)(inputs).gradient?.[0]).toBeCloseTo(derivative(4),8);
    const jet=createScalarDirectionalJet(compiled,[1,0,0])(box);
    contains(jet.first,derivative(4));contains(jet.second,derivative(5));
  },30_000);
  it('15階を二階に制限せず、元の式を保持する',()=>{
    const source=`diff(elliptick(X),${Array<string>(15).fill('X').join(',')})`;
    const saved=createFunctionMathSource(source,'text','radian',{axes:['X','Y','Z'],parameters:[],coefficients:[]},backend);
    const original=JSON.stringify(saved);
    const compiled=compileFunctionScalar(JSON.parse(original),['X','Y','Z'],[],{backend,shouldStop:()=>undefined});
    let reference=Math.PI/2;for(let k=0;k<15;k++)reference*=((2*k+1)/2)**2/(k+1);
    expect(createScalarSampler(compiled)([0,0,0])/reference).toBeCloseTo(1,9);
    expect(JSON.stringify(saved)).toBe(original);expect(original).not.toContain('elliptic-partial');
    expect(compiled.instructions.some(x=>x.kind==='elliptic'&&x.orders[0]===15)).toBe(true);
  },30_000);
  it('三引数の混合微分と度の換算を、順序を入れ替えても保つ',()=>{
    for(const order of ['X,Y,Z','Z,X,Y','Y,Z,X']) {
      const compiled=tape(`diff(ellipticpiinc(X,Y,Z),${order})`,true);
      expect(createScalarSampler(compiled)([.25,120,.5])).toBeCloseTo(Number('0.0150488437635727924'),12);
    }
    const composed=tape('diff(elliptick(X^2/2),X,X)');
    expect(createScalarSampler(composed)([0,0,0])).toBeCloseTo(Math.PI/8,10);
  });
  it('90度の四階微分の正確な0を作図不能にせず、前後の非零も保つ',()=>{
    const compiled=tape('diff(ellipticeinc(X,0.5),X,X,X,X)',true),sample=createScalarSampler(compiled);
    expect(sample([90,0,0])).toBe(0);
    expect(sample([89,0,0])*sample([91,0,0])).toBeLessThan(0);
  });
  it.each(['diff(0*elliptick(X),X)','0*diff(elliptick(X),X,X,X)','diff(elliptice(X),X,X,X)'])('%sで整理後も元の発散や微分不能を成功にしない',source=>{
      const compiled=tape(source);
      expect(Number.isFinite(createScalarSampler(compiled)([1,0,0]))).toBe(false);
      expect(createScalarIntervalSampler(compiled)([{lower:.75,upper:1.25},{lower:0,upper:0},{lower:0,upper:0}]).continuous).toBe(false);
    });
});
