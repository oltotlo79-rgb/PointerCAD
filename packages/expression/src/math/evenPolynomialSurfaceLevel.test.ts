import {describe,expect,it} from 'vitest';
import {evenPolynomialSurfaceLevel} from './evenPolynomialSurfaceLevel.js';
import type {CoordinatePolynomial} from './exactCoordinatePolynomial.js';
const domain=[{lower:-2,upper:2},{lower:-3,upper:3}] as const;
const polynomial=(entries:readonly (readonly [string,number])[]):CoordinatePolynomial=>new Map(entries.map(([key,value])=>[key,{numerator:BigInt(value),denominator:1n}]));
describe('偶数乗の同符号和で一点を特定する',()=>{
  it.each([1,-1])('符号%sの四次曲面で唯一のU/Vを厳密に求める',sign=>{
    const equation=polynomial([['4,0,0',2*sign],['2,2,0',3*sign],['0,4,0',5*sign],['0,0,0',7]]);
    expect(evenPolynomialSurfaceLevel(equation,7,domain,()=>false)).toEqual({status:'points',boxes:[[{lower:0,upper:0},{lower:0,upper:0}]]});
    expect(evenPolynomialSurfaceLevel(equation,7-sign,domain,()=>false)).toEqual({status:'empty'});
    expect(evenPolynomialSurfaceLevel(equation,7+sign,domain,()=>false)).toEqual({status:'unresolved'});
  });
  it('二本の軸、正負の項、奇数乗では一点と断定しない',()=>{
    for(const entries of [[['2,2,0',1]],[['4,0,0',1],['0,4,0',-1]],[['3,0,0',1],['0,4,0',1]]] as const){
      expect(evenPolynomialSurfaceLevel(polynomial(entries),0,domain,()=>false).status).toBe('unresolved');
    }
  });
  it('範囲外の原点は空とし、取消時や一致しない微小な定数は成功にしない',()=>{
    const equation=polynomial([['4,0,0',1],['0,4,0',1]]);
    expect(evenPolynomialSurfaceLevel(equation,0,[{lower:1,upper:2},domain[1]],()=>false)).toEqual({status:'empty'});
    expect(evenPolynomialSurfaceLevel(equation,0,domain,()=>true)).toEqual({status:'unresolved'});
    expect(evenPolynomialSurfaceLevel(equation,Number.MIN_VALUE,domain,()=>false)).toEqual({status:'unresolved'});
  });
});
