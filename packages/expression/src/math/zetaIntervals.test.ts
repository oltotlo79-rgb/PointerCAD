import { describe,expect,it } from 'vitest';
import { zetaDerivativeRanges,zetaSample } from './zetaIntervals.js';
import { ZETA_DERIVATIVE_REFERENCES } from './zetaDerivativeReferences.js';
import type { MathInterval } from './mathInterval.js';
function contains(range:MathInterval|undefined,value:number):void {
  if(range===undefined)throw new Error('Missing enclosure');
  expect(range.lower).toBeLessThanOrEqual(value);expect(range.upper).toBeGreaterThanOrEqual(value);
}
describe('ゼータ関数の作図用の範囲は微分の余りと反射の丸めを含む',()=>{
  it.each(ZETA_DERIVATIVE_REFERENCES)('引数%sの全次数を独立した高精度の値と照合する',(source,references)=>{
    const x=Number(source),ranges=zetaDerivativeRanges({lower:x,upper:x},references.length-1);
    expect(ranges).not.toBeNull();
    for(const [order,reference] of references.entries()) {
      const expected=Number(reference);contains(ranges?.[order],expected);
      const sample=zetaSample(order,x);
      if(expected===0)expect(sample).toBe(0);
      else expect(Math.abs(sample/expected-1)).toBeLessThan(2e-12);
    }
  },30_000);
  it.each([[-32,-1],[-2,.5],[-.5,.875],[1.01,128]])('%s〜%sの内部の値と一階二階を全て含む',(lower,upper)=>{
    const ranges=zetaDerivativeRanges({lower,upper},2);expect(ranges).not.toBeNull();
    for(const [source,references] of ZETA_DERIVATIVE_REFERENCES) {
      const x=Number(source);if(x<lower||x>upper)continue;
      for(let j=0;j<3;j++)contains(ranges?.[j],Number(references[j]));
    }
  });
  it('元の発散点、範囲外、非有限、次数超過を連続の範囲にしない',()=>{
    for(const range of [{lower:1,upper:1},{lower:.5,upper:2},{lower:-33,upper:-32},
      {lower:128,upper:129},{lower:NaN,upper:2},{lower:2,upper:1}]) {
      expect(zetaDerivativeRanges(range,2)).toBeNull();
    }
    expect(zetaDerivativeRanges({lower:2,upper:2},18)).toBeNull();
    expect(Number.isFinite(zetaSample(0,1))).toBe(false);
  });
  it('負の偶数の0とその前後の非零・符号を保持する',()=>{
    for(const x of [-32,-16,-8,-2]) {
      expect(zetaSample(0,x)).toBe(0);
      if(x>-32)expect(zetaSample(0,x-.001)*zetaSample(0,x+.001)).toBeLessThan(0);
    }
    expect(zetaSample(0,0)).toBe(-.5);
  });
});
