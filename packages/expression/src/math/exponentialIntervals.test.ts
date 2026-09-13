import {describe,expect,it,vi} from 'vitest';
import {exponentialRange} from './exponentialIntervals.js';
import {exactDouble} from './exactDoubleInterval.js';
import {decimalRational,type ExactRational} from './exactRational.js';

function compare(a:ExactRational,b:ExactRational):number {
  const difference=a.numerator*b.denominator-b.numerator*a.denominator;
  return difference<0n?-1:difference>0n?1:0;
}

describe('指数関数を剰余つき級数で囲み、座標精度を確認する',()=>{
  it('exp(1)は高精度十進数で示したeの上下を挟み、Math.expを証拠にしない',()=>{
    const spy=vi.spyOn(Math,'exp').mockImplementation(()=>{throw new Error('unproved native exp');});
    try {
      const result=exponentialRange({lower:1,upper:1});
      if(result===null)throw new Error('missing enclosure');
      const lower=exactDouble(result.lower),upper=exactDouble(result.upper);
      const referenceLower=decimalRational('2.71828182845904523536028747135266249775724709369995');
      const referenceUpper=decimalRational('2.71828182845904523536028747135266249775724709369996');
      if(lower===null||upper===null||referenceLower===null||referenceUpper===null)throw new Error('invalid reference');
      expect(compare(lower,referenceLower)).toBeLessThan(0);
      expect(compare(upper,referenceUpper)).toBeGreaterThan(0);
      expect(result.upper-result.lower).toBeLessThan(1e-11);
    }finally{spy.mockRestore();}
  });
  it.each([-2048,-1000,-746,-745,-744,-710,-708,-10,-1,-0.5,-Number.MIN_VALUE,0,
    Number.MIN_VALUE,0.5,1,10,708,709,710,2048])('%sで独立評価値を挟み、符号や有限性を失わない',value=>{
    const result=exponentialRange({lower:value,upper:value});
    if(result===null)throw new Error('missing enclosure');
    const comparison=Math.exp(value);
    expect(result.lower).toBeGreaterThanOrEqual(0);
    expect(comparison).toBeGreaterThanOrEqual(result.lower);
    expect(comparison).toBeLessThanOrEqual(result.upper);
    if(value>=-708&&value<=709){
      expect(Number.isFinite(result.upper)).toBe(true);
      expect((result.upper-result.lower)/comparison).toBeLessThan(1e-9);
    }
  });
  it('入力区間全体を単調性で囲み、ゼロ・無限端点・不正な区間を区別する',()=>{
    expect(exponentialRange({lower:0,upper:0})).toEqual({lower:1,upper:1});
    expect(exponentialRange({lower:-Infinity,upper:Infinity})).toEqual({lower:0,upper:Infinity});
    expect(exponentialRange({lower:-Infinity,upper:-2049})).toEqual({lower:0,upper:Number.MIN_VALUE});
    expect(exponentialRange({lower:2049,upper:Infinity})).toEqual({lower:Number.MAX_VALUE,upper:Infinity});
    const result=exponentialRange({lower:-2,upper:3});
    if(result===null)throw new Error('missing enclosure');
    for(const value of [-2,-1,0,1,2,3]){
      expect(Math.exp(value)).toBeGreaterThanOrEqual(result.lower);
      expect(Math.exp(value)).toBeLessThanOrEqual(result.upper);
    }
    expect(exponentialRange({lower:NaN,upper:1})).toBeNull();
    expect(exponentialRange({lower:2,upper:1})).toBeNull();
  });
});
