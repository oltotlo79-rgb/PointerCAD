/** Polynomial proof variables X/Y/Z mean U/V/edit progress, never output coordinates. */
import {exactCoordinatePolynomial,type CoordinatePolynomial} from './exactCoordinatePolynomial.js';
import {pointEditCoordinate,pointEditInterpolation,resolvePointEditExpression} from './pointEditExpression.js';
import {MathInputProblem,type MathAxis,type MathNode} from './mathInputContract.js';
import type {SurfacePointWorkRequest} from './surfacePointWorkRequest.js';
import {coefficientExpressionMap} from './mathCoefficientExpression.js';

export function surfacePointContinuationFormula(before:SurfacePointWorkRequest,after:SurfacePointWorkRequest,
  axis:MathAxis,stop:()=>boolean):CoordinatePolynomial|null {
  const oldValue=before.known.find(item=>item.axis===axis),newValue=after.known.find(item=>item.axis===axis);
  if(oldValue===undefined||newValue===undefined)throw new MathInputProblem('domain','曲面の追従に必要な座標が不足しています。');
  const oldCoefficients=coefficientExpressionMap(before.coefficients);
  const newCoefficients=coefficientExpressionMap(after.coefficients);
  const interpolate=(a:MathNode,b:MathNode)=>pointEditInterpolation(a,b,{role:'axis',name:'Z'});
  const expression=resolvePointEditExpression(after.outputs[axis==='X'?0:axis==='Y'?1:2].expression,ref=>{
    if(ref.role==='parameter'&&(ref.name==='U'||ref.name==='V'))return {kind:'symbol',reference:{role:'axis',name:ref.name==='U'?'X':'Y'}};
    if(ref.role==='coefficient'){
      const old=oldCoefficients.get(ref.id),current=newCoefficients.get(ref.id);
      if(old===undefined||current===undefined)throw new MathInputProblem('domain','曲面の追従に必要な係数がありません。');
      return interpolate(old,current);
    }
    return null;
  },stop);
  const difference:MathNode={kind:'operation',operation:'subtract',operands:[expression,
    interpolate(pointEditCoordinate(oldValue.value),pointEditCoordinate(newValue.value))]};
  return exactCoordinatePolynomial(difference,new Map(),stop);
}
