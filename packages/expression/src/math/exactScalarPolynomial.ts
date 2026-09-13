/** Exact, bounded one-variable polynomial arithmetic for certified point candidates. Coefficients ascend by degree. */
import {exactAdd,exactDivide,exactMultiply,exactNegative,EXACT_ZERO} from './exactCoordinatePolynomial.js';
import {rational,type ExactRational} from './exactRational.js';

export type ExactScalarPolynomial=readonly ExactRational[];
export interface ExactPolynomialArithmetic {
  readonly canonical:(polynomial:ExactScalarPolynomial)=>ExactScalarPolynomial;
  readonly derivative:(polynomial:ExactScalarPolynomial)=>ExactScalarPolynomial;
  readonly evaluate:(polynomial:ExactScalarPolynomial,at:ExactRational)=>ExactRational;
  readonly divide:(dividend:ExactScalarPolynomial,divisor:ExactScalarPolynomial)=>{
    readonly quotient:ExactScalarPolynomial;readonly remainder:ExactScalarPolynomial};
  readonly squareFree:(polynomial:ExactScalarPolynomial)=>ExactScalarPolynomial;
  readonly sturm:(polynomial:ExactScalarPolynomial)=>readonly ExactScalarPolynomial[];
}

/** A caller-owned operation check bounds every coefficient operation, including rational normalization. */
export function createExactPolynomialArithmetic(check:()=>void,exhausted:()=>never):ExactPolynomialArithmetic {
  const require=(value:ExactRational|null):ExactRational=>{if(value===null) return exhausted();return value;};
  const add=(a:ExactRational,b:ExactRational)=>{check();return require(exactAdd(a,b));};
  const multiply=(a:ExactRational,b:ExactRational)=>{check();return require(exactMultiply(a,b));};
  const divideScalar=(a:ExactRational,b:ExactRational)=>{check();return require(exactDivide(a,b));};
  const trim=(p:ExactScalarPolynomial):ExactScalarPolynomial=>{
    let length=p.length;while(length>0 && p[length-1].numerator===0n) length--;return p.slice(0,length);
  };
  function canonical(p:ExactScalarPolynomial):ExactScalarPolynomial {
    if(p.length>5) return exhausted();
    return trim(p.map(value=>{check();return require(rational(value.numerator,value.denominator));}));
  }
  function derivative(p:ExactScalarPolynomial):ExactScalarPolynomial {
    return trim(p.slice(1).map((value,index)=>multiply(value,{numerator:BigInt(index+1),denominator:1n})));
  }
  function evaluate(p:ExactScalarPolynomial,at:ExactRational):ExactRational {
    let result=EXACT_ZERO;for(let index=p.length-1;index>=0;index--) result=add(multiply(result,at),p[index]);return result;
  }
  function divide(dividend:ExactScalarPolynomial,divisor:ExactScalarPolynomial){
    if(divisor.length===0) return exhausted();
    let remainder=trim(dividend);const quotient:ExactRational[]=Array.from({length:Math.max(0,dividend.length-divisor.length+1)},()=>EXACT_ZERO);
    while(remainder.length>=divisor.length){
      check();const degree=remainder.length-divisor.length,factor=divideScalar(remainder[remainder.length-1],divisor[divisor.length-1]);
      quotient[degree]=factor;const next=[...remainder];
      divisor.forEach((value,index)=>{next[degree+index]=add(next[degree+index],exactNegative(multiply(factor,value)));});
      remainder=trim(next);
    }
    return {quotient:trim(quotient),remainder};
  }
  const positiveNormalize=(p:ExactScalarPolynomial):ExactScalarPolynomial=>{
    if(p.length===0) return p;const leading=p[p.length-1],scale=leading.numerator<0n?exactNegative(leading):leading;
    return p.map(value=>divideScalar(value,scale));
  };
  function squareFree(p:ExactScalarPolynomial):ExactScalarPolynomial {
    if(p.length<2) return p;
    let a=positiveNormalize(p),b=positiveNormalize(derivative(p));
    while(b.length>0){const remainder=positiveNormalize(divide(a,b).remainder);a=b;b=remainder;}
    const result=divide(p,a);if(result.remainder.length!==0) return exhausted();return positiveNormalize(result.quotient);
  }
  function sturm(p:ExactScalarPolynomial):readonly ExactScalarPolynomial[] {
    const result=[positiveNormalize(p),positiveNormalize(derivative(p))];
    while(result[result.length-1].length>0){
      const remainder=divide(result[result.length-2],result[result.length-1]).remainder;
      if(remainder.length===0) break;result.push(positiveNormalize(remainder.map(exactNegative)));
    }
    return result.filter(part=>part.length>0);
  }
  return {canonical,derivative,evaluate,divide,squareFree,sturm};
}
