/** X is the curve parameter, Y is edit progress. XYZ output names never become progress variables. */
import {exactCoordinatePolynomial,exactMultiply,EXACT_ZERO,sameExact,type CoordinatePolynomial} from './exactCoordinatePolynomial.js';
import {MathInputProblem,type MathAxis,type MathNode} from './mathInputContract.js';
import {pointEditCoordinate,pointEditInterpolation,resolvePointEditExpression} from './pointEditExpression.js';
import type {CurvePointWorkRequest} from './curvePointWorkRequest.js';
import {coefficientExpressionMap} from './mathCoefficientExpression.js';

export function curvePointContinuationFormula(before:CurvePointWorkRequest,after:CurvePointWorkRequest,axis:MathAxis,stop:()=>boolean):CoordinatePolynomial|null {
  const oldValue=before.known.find(item=>item.axis===axis),newValue=after.known.find(item=>item.axis===axis);
  if(!oldValue || !newValue) throw new MathInputProblem('domain','追従に必要な既知座標が不足しています。');
  const slot=axis==='X'?0:axis==='Y'?1:2,oldCoefficients=coefficientExpressionMap(before.coefficients);
  const currentCoefficients=coefficientExpressionMap(after.coefficients);
  const expression=resolvePointEditExpression(after.outputs[slot].expression,ref=>{
    if((ref.role==='axis' || ref.role==='parameter') && ref.name===after.independent) return {kind:'symbol',reference:{role:'axis',name:'X'}};
    if(ref.role==='coefficient') {
      const old=oldCoefficients.get(ref.id),current=currentCoefficients.get(ref.id);
      if(old===undefined || current===undefined) throw new MathInputProblem('domain','追従に必要な係数が見つかりません。');
      return pointEditInterpolation(old,current);
    }
    return null;
  },stop);
  const difference:MathNode={kind:'operation',operation:'subtract',operands:[expression,
    pointEditInterpolation(pointEditCoordinate(oldValue.value),pointEditCoordinate(newValue.value))]};
  return exactCoordinatePolynomial(difference,new Map(),stop);
}

/** A second condition must vanish throughout the same path, not merely at its endpoints. */
export function proportionalPointConditions(primary:CoordinatePolynomial,other:CoordinatePolynomial):boolean {
  if(other.size===0) return true;
  const first=primary.entries().next().value;if(first===undefined) return false;
  const [key,left]=first,right=other.get(key);if(right===undefined) return false;
  for(const term of new Set([...primary.keys(),...other.keys()])) {
    const a=exactMultiply(primary.get(term)??EXACT_ZERO,right),b=exactMultiply(other.get(term)??EXACT_ZERO,left);
    if(a===null || b===null || !sameExact(a,b)) return false;
  }
  return true;
}
