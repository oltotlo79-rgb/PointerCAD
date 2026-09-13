/** Exact polynomial equations in a curve parameter, including common roots of two supplied coordinates. */
import {exactParameterEquation} from './exactParameterEquation.js';
import {createExactPolynomialArithmetic,type ExactScalarPolynomial} from './exactScalarPolynomial.js';
import {MathInputProblem} from './mathInputContract.js';
import type {CurvePointWorkRequest} from './curvePointWorkRequest.js';

export function curvePointPolynomial(input:CurvePointWorkRequest,index:0|1|2,value:number,stop:()=>boolean):ExactScalarPolynomial|null {
  return exactParameterEquation(input.outputs[index].expression,input.independent,input.coefficients,value,stop);
}

/** Euclid's algorithm selects common roots exactly; overlapping approximations are insufficient. */
export function commonCurvePointPolynomial(polynomials:readonly ExactScalarPolynomial[],stop:()=>boolean):ExactScalarPolynomial {
  let remaining=20_000;
  const exhausted=():never=>{throw new MathInputProblem('budget','曲線の共通解の計算上限に達しました。');};
  const arithmetic=createExactPolynomialArithmetic(()=>{if(--remaining<0 || stop()) exhausted();},exhausted);
  let result:ExactScalarPolynomial=[];
  for(const polynomial of polynomials) {
    let first=result,second=arithmetic.canonical(polynomial);
    while(second.length>0){const remainder=arithmetic.divide(first,second).remainder;first=second;second=remainder;}
    result=first;
  }
  return result;
}
