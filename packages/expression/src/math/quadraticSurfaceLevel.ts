/** Exact extrema of a definite quadratic on a rectangle certify isolated level points.
 * A positive definite quadratic is strictly convex: its minimum is unique, and
 * its maximum is at vertices. Equality at an extreme cannot hide an interior level curve.
 */
import {exactAdd,exactMultiply,exactDivide,exactNegative,EXACT_ZERO,type CoordinatePolynomial} from './exactCoordinatePolynomial.js';
import {exactDouble,exactDoubleInterval} from './exactDoubleInterval.js';
import type {ExactRational} from './exactRational.js';
import type {ParameterBox} from './bivariateIntervalNewton.js';

type Point=readonly [ExactRational,ExactRational];
export type QuadraticSurfaceLevel={readonly status:'points';readonly boxes:readonly ParameterBox[]}
  |{readonly status:'empty'}|{readonly status:'unresolved'};
class Unproved extends Error {}
const TWO:ExactRational={numerator:2n,denominator:1n};

export function quadraticSurfaceLevel(polynomial:CoordinatePolynomial,level:number,domain:ParameterBox,
  shouldStop:()=>boolean):QuadraticSurfaceLevel {
  const unresolved:QuadraticSurfaceLevel={status:'unresolved'};
  const keys=['2,0,0','1,1,0','0,2,0','1,0,0','0,1,0','0,0,0'];
  if([...polynomial.keys()].some(key=>!keys.includes(key)))return unresolved;
  let operations=2048;
  function check(){if(--operations<0||shouldStop())throw new Unproved();}
  function require(value:ExactRational|null):ExactRational{check();if(value===null)throw new Unproved();return value;}
  const add=(a:ExactRational,b:ExactRational)=>require(exactAdd(a,b));
  const multiply=(a:ExactRational,b:ExactRational)=>require(exactMultiply(a,b));
  const divide=(a:ExactRational,b:ExactRational)=>require(exactDivide(a,b));
  const subtract=(a:ExactRational,b:ExactRational)=>add(a,exactNegative(b));
  const compare=(a:ExactRational,b:ExactRational)=>{check();const value=a.numerator*b.denominator-b.numerator*a.denominator;return value<0n?-1:value>0n?1:0;};
  try {
    let [a,b,c,d,e,f]=keys.map(key=>polynomial.get(key)??EXACT_ZERO);
    f=subtract(f,require(exactDouble(level)));
    if(a.numerator<0n)[a,b,c,d,e,f]=[a,b,c,d,e,f].map(exactNegative);
    if(a.numerator<=0n)return unresolved;
    const aa=multiply(TWO,a),cc=multiply(TWO,c),determinant=subtract(multiply(aa,cc),multiply(b,b));
    if(determinant.numerator<=0n)return unresolved;
    const lower:Point=[require(exactDouble(domain[0].lower)),require(exactDouble(domain[1].lower))];
    const upper:Point=[require(exactDouble(domain[0].upper)),require(exactDouble(domain[1].upper))];
    if(compare(lower[0],upper[0])>=0||compare(lower[1],upper[1])>=0)return unresolved;
    const inside=(point:Point)=>point.every((value,index)=>compare(value,lower[index])>=0&&compare(value,upper[index])<=0);
    const clamp=(value:ExactRational,index:0|1)=>compare(value,lower[index])<0?lower[index]:compare(value,upper[index])>0?upper[index]:value;
    const center:Point=[divide(subtract(multiply(b,e),multiply(cc,d)),determinant),
      divide(subtract(multiply(b,d),multiply(aa,e)),determinant)];
    const vertices:Point[]=[[lower[0],lower[1]],[lower[0],upper[1]],[upper[0],lower[1]],[upper[0],upper[1]]];
    const choices:Point[]=inside(center)?[center]:[];
    for(const u of [lower[0],upper[0]])choices.push([u,clamp(divide(exactNegative(add(multiply(b,u),e)),cc),1)]);
    for(const v of [lower[1],upper[1]])choices.push([clamp(divide(exactNegative(add(multiply(b,v),d)),aa),0),v]);
    function evaluate([u,v]:Point):ExactRational {
      return add(add(multiply(add(add(multiply(a,u),multiply(b,v)),d),u),multiply(add(multiply(c,v),e),v)),f);
    }
    const values=choices.map(point=>({point,value:evaluate(point)}));
    let minimum=values[0];for(const candidate of values)if(compare(candidate.value,minimum.value)<0)minimum=candidate;
    const corners=vertices.map(point=>({point,value:evaluate(point)}));
    if(minimum.value.numerator>0n||corners.every(corner=>corner.value.numerator<0n))return {status:'empty'};
    const points=minimum.value.numerator===0n?[minimum.point]:corners.every(corner=>corner.value.numerator<=0n)
      ?corners.filter(corner=>corner.value.numerator===0n).map(corner=>corner.point):null;
    if(points===null)return unresolved;
    const boxes:ParameterBox[]=[];
    for(const point of points){
      const u=exactDoubleInterval(point[0]),v=exactDoubleInterval(point[1]);
      if(u===null||v===null||u.lower<domain[0].lower||u.upper>domain[0].upper
        ||v.lower<domain[1].lower||v.upper>domain[1].upper)return unresolved;
      boxes.push([u,v]);
    }
    return {status:'points',boxes};
  }catch(error){if(error instanceof Unproved)return unresolved;throw error;}
}
