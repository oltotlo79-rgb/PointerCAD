import {beforeAll,describe,expect,it} from 'vitest';
import {createMathBackend} from './createMathBackend.js';
import {createFunctionMathSource} from './functionMathSource.js';
import {exactCoordinatePolynomial} from './exactCoordinatePolynomial.js';
import {substituteCoordinatePolynomial} from './substituteCoordinatePolynomial.js';
import {isolateExactPolynomialRoots} from './isolateExactPolynomialRoots.js';
import {decimalRational,type ExactRational} from './exactRational.js';
import type {ScalarRootOptions,ScalarRootResult} from './isolateScalarRoots.js';
import type {MathExecutionBackend} from './mathWorkExecution.js';

let backend:MathExecutionBackend;beforeAll(()=>{backend=createMathBackend();});
const q=(source:string):ExactRational=>{const value=decimalRational(source);if(value===null) throw new Error('Fixture exceeds rational budget');return value;};
const options:ScalarRootOptions={lower:-4,upper:4,tolerance:1e-9,maximumEvaluations:200_000,maximumRegions:100,maximumDepth:64};
function polynomial(source:string,axis:0|1|2=0,fixed:readonly [ExactRational|null,ExactRational|null,ExactRational|null]=[null,q('0'),q('0')]){
  const definition=createFunctionMathSource(source,'text','radian',{axes:['X','Y','Z'],parameters:[],coefficients:[]},backend);
  const expanded=exactCoordinatePolynomial(definition.expression,new Map(),()=>false);
  if(expanded===null) throw new Error('Not an exact coordinate polynomial');
  const scalar=substituteCoordinatePolynomial(expanded,axis,fixed,()=>false);return scalar;
}
function solve(source:string,changes:Partial<ScalarRootOptions>={}):ScalarRootResult {
  const scalar=polynomial(source);if(scalar===null) throw new Error('Invalid substitution');
  return isolateExactPolynomialRoots(scalar,{...options,...changes});
}
function complete(result:ScalarRootResult,expected:readonly number[]):void {
  expect(result.status).toBe('complete');if(result.status!=='complete') throw new Error(JSON.stringify(result));
  expect(result.unresolved).toEqual([]);expect(result.roots).toHaveLength(expected.length);
  result.roots.forEach((root,index)=>{
    expect(root.unique).toBe(true);expect(root.lower).toBeLessThanOrEqual(expected[index]);expect(root.upper).toBeGreaterThanOrEqual(expected[index]);
    expect(root.upper-root.lower).toBeLessThanOrEqual(options.tolerance);
    if(index>0) expect(result.roots[index-1].upper).toBeLessThan(root.lower);
  });
}
describe('関数上の点の有限範囲から重根・端点を含む全多項式解を分離する',()=>{
  it.each(['X^2','X^3','X^4'])('%sの接点を未解決や無解にせず1候補と証明する',source=>complete(solve(source),[0]));
  it.each(['(X-1)^2*(X+2)^2','-0.125*(X-1)^2*(X+2)^2','(X+2)*(X-1)^3'])('%sの異なる重根をそれぞれ1件保持する',source=>complete(solve(source),[-2,1]));
  it('有限範囲の両端と内部の零点を重複せず含める',()=>complete(solve('(X+4)*X*(X-4)'),[-4,0,4]));
  it('整数でない重根も正確な有理数の符号で囲う',()=>complete(solve('(3*X-1)^2'),[1/3]));
  it('平方根の正負候補を保持し、端の外にある解は採用しない',()=>{
    complete(solve('X^2-2'),[-Math.SQRT2,Math.SQRT2]);complete(solve('X^2-2',{lower:0,upper:1}),[]);
  });
  it('許容誤差より近い別の2根を1候補に潰さない',()=>complete(solve('(X-0.000000000001)*(X+0.000000000001)'),[-1e-12,1e-12]));
  it('正確には違うが倍精度で分離できない候補は未解決として残す',()=>{
    const result=solve('(X-1)*(X-1.000000000000000001)');expect(result.status).toBe('unresolved');
    if(result.status!=='unresolved') throw new Error(JSON.stringify(result));expect(result.unresolved.length).toBeGreaterThan(0);
  });
  it('無解と恒等0による自由度不足を区別する',()=>{
    complete(solve('X^4+1'),[]);complete(solve('5'),[]);
    expect(solve('X-X')).toMatchObject({status:'unresolved',roots:[],unresolved:[{reason:'continuum'}]});
  });
  it('球に2つの座標を与えると正負候補・極の1候補・無解を区別する',()=>{
    for(const [x,y,expected] of [['0','0',[-1,1]],['1','0',[0]],['2','0',[]]] as const){
      const scalar=polynomial('X^2+Y^2+Z^2-1',2,[q(x),q(y),null]);if(scalar===null) throw new Error('Missing scalar');
      complete(isolateExactPolynomialRoots(scalar,options),expected);
    }
  });
  it('既知座標の不足を勝手に0で補わず、中止時にも代入をしない',()=>{
    const equation=new Map([['1,0,0',q('1')]]);
    expect(substituteCoordinatePolynomial(equation,0,[null,null,q('0')],()=>false)).toBeNull();
    expect(substituteCoordinatePolynomial(equation,0,[null,q('0'),q('0')],()=>true)).toBeNull();
  });
  it.each(['cancelled','deadline'] as const)('%sでは途中まで見つかった点を返さない',status=>{
    let calls=0;const result=solve('X^4-X^2',{shouldStop:()=>++calls>50?status:undefined});
    expect(result.status).toBe(status);expect(result).not.toHaveProperty('roots');
  });
  it('計算と候補数の上限、有限範囲と精度の契約を守る',()=>{
    expect(solve('X^4-X^2',{maximumEvaluations:5}).status).toBe('budget');
    expect(solve('X^4-X^2',{maximumRegions:1}).status).toBe('budget');
    for(const changes of [{lower:-Infinity},{upper:NaN},{lower:4},{tolerance:0},{maximumDepth:100}]) expect(()=>solve('X',changes)).toThrow();
  });
});
