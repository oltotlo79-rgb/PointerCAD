import {beforeAll,describe,expect,it} from 'vitest';
import {createMathBackend} from './createMathBackend.js';
import {createFunctionMathSource} from './functionMathSource.js';
import {exactCoordinatePolynomial} from './exactCoordinatePolynomial.js';
import {recognizeImplicitPrimitive} from './recognizeImplicitPrimitive.js';
import {implicitPrimitiveNumbers} from './implicitPrimitiveNumbers.js';
import {exactDouble,exactDoubleInterval} from './exactDoubleInterval.js';
import {rational,type ExactRational} from './exactRational.js';
import type {MathExecutionBackend} from './mathWorkExecution.js';

let backend:MathExecutionBackend;beforeAll(()=>{backend=createMathBackend();});
function recognize(source:string,coefficients:ReadonlyMap<string,string>=new Map()){
  const definition=createFunctionMathSource(source,'text','radian',{axes:['X','Y','Z'],parameters:[],
    coefficients:[...coefficients.keys()].map(id=>({id,label:id}))},backend);
  const polynomial=exactCoordinatePolynomial(definition.expression,coefficients,()=>false);
  return polynomial===null?null:recognizeImplicitPrimitive(polynomial);
}
const exact=(n:bigint,d=1n):ExactRational=>{const value=rational(n,d);if(value===null) throw new Error('Invalid fixture');return value;};
describe('陰関数の原式を近似等価でなく正確な多項式として識別する',()=>{
  it.each(['X^2+Y^2+Z^2-1','2*(X*X+Y*Y+Z*Z)-2','-(X^2+Y^2+Z^2-1)'])('%sを同じ半径1の球と証明する',source=>{
    expect(recognize(source)).toEqual({kind:'sphere',center:[exact(0n),exact(0n),exact(0n)],radiusSquared:exact(1n)});
  });
  it('平行移動と現在の係数を原式から正確に展開する',()=>{
    const source='(X-0.1)^2+(Y+2)^2+(Z-3)^2-coef("R")^2';
    expect(recognize(source,new Map([['R','1.5']]))).toEqual({kind:'sphere',center:[exact(1n,10n),exact(-2n),exact(3n)],radiusSquared:exact(9n,4n)});
    expect(recognize(source,new Map([['R','2']]))).toMatchObject({radiusSquared:exact(4n)});
  });
  it.each([0,1,2] as const)('軸%sのトーラスを係数の厳密な比較で認める',axis=>{
    const axes=['X','Y','Z'],radial=axes.filter((_,index)=>index!==axis);
    const result=recognize(`(X^2+Y^2+Z^2+4-0.25)^2-16*(${radial[0]}^2+${radial[1]}^2)`);
    expect(result).toEqual({kind:'torus',axis,majorSquared:exact(4n),minorSquared:exact(1n,4n)});
  });
  it.each(['X^2+Y^2+Z^2+0.00000000000000000000001*X*Y-1','X^2+Y^2+2*Z^2-1','X^2+Y^2+Z^2+1','X^2+Y^2+Z^2',
    '(X^2+Y^2+Z^2+4-0.25)^2-16*(X^2+Y^2)+0.0000000000000000001'])('別の面・空集合・退化を球/トーラスへ変えない: %s',source=>{
    expect(recognize(source)).toBeNull();
  });
  it('変数除算や定義域のある演算をゼロ倍で消さず、中止にも従う',()=>{
    const definition=createFunctionMathSource('X^2+Y^2+Z^2-1+0*(1/X)','text','radian',{axes:['X','Y','Z'],parameters:[],coefficients:[]},backend);
    expect(exactCoordinatePolynomial(definition.expression,new Map(),()=>false)).toBeNull();
    expect(exactCoordinatePolynomial(definition.expression,new Map(),()=>true)).toBeNull();
  });
  it('0.1を印字された小数ではなく実際のIEEE754の有理数として包み、パラメータ誤差を精度に含める',()=>{
    const tenth=exact(1n,10n),bits=exactDouble(0.1);expect(bits).not.toEqual(tenth);
    const bounds=exactDoubleInterval(tenth);if(bounds===null) throw new Error('Missing rational bounds');
    for(const [value,lower] of [[bounds.lower,true],[bounds.upper,false]] as const){
      const represented=exactDouble(value);if(represented===null) throw new Error('Not a double');
      const difference=represented.numerator*tenth.denominator-tenth.numerator*represented.denominator;
      expect(lower?difference<=0n:difference>=0n).toBe(true);
    }
    const source=recognize('(X-0.1)^2+Y^2+Z^2-2');if(source===null) throw new Error('Missing sphere');
    const numeric=implicitPrimitiveNumbers(source,0.01);expect(numeric?.primitive).toMatchObject({kind:'sphere'});
    expect(numeric?.maximumParameterError).toBeGreaterThan(0);expect(numeric?.maximumParameterError).toBeLessThan(0.0025);
    expect(implicitPrimitiveNumbers(source,1e-25)).toBeNull();
  });
});
