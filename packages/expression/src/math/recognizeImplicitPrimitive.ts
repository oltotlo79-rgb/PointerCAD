/** Exact equations authorize exact CAD primitives; all other functions retain the general implicit sampler. */
import {rational,type ExactRational} from './exactRational.js';
import {EXACT_ZERO,exactAdd,exactMultiply,exactDivide,exactNegative,sameExact,type CoordinatePolynomial} from './exactCoordinatePolynomial.js';

export type ExactImplicitPrimitive={readonly kind:'sphere';readonly center:readonly [ExactRational,ExactRational,ExactRational];readonly radiusSquared:ExactRational}
  |{readonly kind:'torus';readonly axis:0|1|2;readonly majorSquared:ExactRational;readonly minorSquared:ExactRational};
const power=(axis:number,degree:number)=>[0,1,2].map(index=>index===axis?degree:0).join(',');
const integer=(value:bigint):ExactRational=>({numerator:value,denominator:1n});

export function recognizeImplicitPrimitive(polynomial:CoordinatePolynomial):ExactImplicitPrimitive|null {
  const value=(key:string)=>polynomial.get(key)??EXACT_ZERO;
  const quadratic=[0,1,2].map(axis=>value(power(axis,2))),linear=[0,1,2].map(axis=>value(power(axis,1)));
  const sphereKeys=new Set(['0,0,0',...[0,1,2].flatMap(axis=>[power(axis,1),power(axis,2)])]);
  if([...polynomial.keys()].every(key=>sphereKeys.has(key)) && quadratic[0].numerator!==0n && quadratic.every(q=>sameExact(q,quadratic[0]))){
    const twice=exactMultiply(integer(2n),quadratic[0]);if(twice===null) return null;
    const x=exactDivide(exactNegative(linear[0]),twice),y=exactDivide(exactNegative(linear[1]),twice),z=exactDivide(exactNegative(linear[2]),twice);
    if(x===null || y===null || z===null) return null;
    let radiusSquared=exactDivide(exactNegative(value('0,0,0')),quadratic[0]);
    for(const center of [x,y,z]){const squared=exactMultiply(center,center);radiusSquared=radiusSquared===null || squared===null?null:exactAdd(radiusSquared,squared);}
    return radiusSquared===null || radiusSquared.numerator<=0n?null:{kind:'sphere',center:[x,y,z],radiusSquared};
  }
  const coefficient=value('4,0,0');if(coefficient.numerator===0n) return null;
  const twice=exactMultiply(integer(2n),coefficient),four=exactMultiply(integer(4n),coefficient);if(twice===null || four===null) return null;
  const keys=new Set(['0,0,0',...[0,1,2].flatMap(axis=>[power(axis,2),power(axis,4)]),'2,2,0','2,0,2','0,2,2']);
  if([...polynomial.keys()].some(key=>!keys.has(key)) || ![0,1,2].every(axis=>sameExact(value(power(axis,4)),coefficient))
    || !['2,2,0','2,0,2','0,2,2'].every(key=>sameExact(value(key),twice))) return null;
  for(const axis of [0,1,2] as const){
    const radial=[0,1,2].filter(index=>index!==axis);if(!sameExact(quadratic[radial[0]],quadratic[radial[1]])) continue;
    const difference=exactAdd(quadratic[axis],exactNegative(quadratic[radial[0]])),d=exactDivide(quadratic[axis],twice);
    const majorSquared=difference===null?null:exactDivide(difference,four);
    const minorSquared=d===null || majorSquared===null?null:exactAdd(majorSquared,exactNegative(d));
    if(d===null || d.numerator<=0n || majorSquared===null || minorSquared===null || majorSquared.numerator<=0n || minorSquared.numerator<=0n) continue;
    const square=rational(d.numerator*d.numerator,d.denominator*d.denominator),constant=square===null?null:exactMultiply(square,coefficient);
    if(constant!==null && sameExact(constant,value('0,0,0'))) return {kind:'torus',axis,majorSquared,minorSquared};
  }
  return null;
}
