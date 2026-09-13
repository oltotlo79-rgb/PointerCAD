/** Preserve exact polynomial constraints while selecting one explicitly named variable. */
import {exactCoordinatePolynomial,exactAdd,exactNegative,EXACT_ZERO} from './exactCoordinatePolynomial.js';
import {substituteCoordinatePolynomial} from './substituteCoordinatePolynomial.js';
import {exactDouble} from './exactDoubleInterval.js';
import {MATH_INPUT_LIMITS,type MathNode} from './mathInputContract.js';
import type {MathWorkRequest} from './mathWorkRequest.js';
import type {ScalarInput} from './scalarMathTape.js';
import type {ExactScalarPolynomial} from './exactScalarPolynomial.js';
import {coefficientExpressionMap} from './mathCoefficientExpression.js';

export function exactParameterEquation(node:MathNode,independent:ScalarInput,
  coefficients:MathWorkRequest['coefficients'],value:number,stop:()=>boolean):ExactScalarPolynomial|null {
  let nodes=MATH_INPUT_LIMITS.nodes;
  function rename(node:MathNode,depth:number):MathNode|null {
    if(--nodes<0 || depth>MATH_INPUT_LIMITS.depth || stop()) return null;
    if(node.kind==='symbol') {
      const ref=node.reference;
      if((ref.role==='axis' || ref.role==='parameter') && ref.name===independent) {
        return {kind:'symbol',reference:{role:'axis',name:'X'}};
      }
      return ref.role==='coefficient'?node:null;
    }
    if(node.kind==='number' || node.kind==='constant') return node;
    if(node.kind!=='operation') return null;
    const operands:MathNode[]=[];
    for(const child of node.operands){const next=rename(child,depth+1);if(next===null) return null;operands.push(next);}
    return {...node,operands};
  }
  const expression=rename(node,0),target=exactDouble(value);
  if(expression===null || target===null) return null;
  const polynomial=exactCoordinatePolynomial(expression,coefficientExpressionMap(coefficients),stop);
  const scalar=polynomial===null?null:substituteCoordinatePolynomial(polynomial,0,[null,EXACT_ZERO,EXACT_ZERO],stop);
  if(scalar===null) return null;
  const constant=exactAdd(scalar[0]??EXACT_ZERO,exactNegative(target));if(constant===null) return null;
  const result=[...scalar];result[0]=constant;
  while(result.length>0 && result[result.length-1].numerator===0n) result.pop();return result;
}
