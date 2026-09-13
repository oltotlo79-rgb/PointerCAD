/** A bounded polynomial in X (the unknown coordinate) and Y (edit progress, 0..1). */
import {exactCoordinatePolynomial} from './exactCoordinatePolynomial.js';
import {MathInputProblem,type MathAxis} from './mathInputContract.js';
import {pointEditCoordinate as coordinate,pointEditInterpolation as interpolate,resolvePointEditExpression} from './pointEditExpression.js';
import type {FunctionPointWorkRequest} from './functionPointWorkRequest.js';
import {coefficientExpressionMap} from './mathCoefficientExpression.js';

export function implicitPointContinuationFormula(before:FunctionPointWorkRequest,after:FunctionPointWorkRequest,
  axis:MathAxis,shouldStop:()=>boolean){
  const known=(request:FunctionPointWorkRequest)=>new Map([...request.known,...(request.fixed?[request.fixed]:[])].map(item=>[item.axis,item.value]));
  const oldKnown=known(before),newKnown=known(after),oldCoefficients=coefficientExpressionMap(before.coefficients);
  const newCoefficients=coefficientExpressionMap(after.coefficients);
  const expression=resolvePointEditExpression(after.expression.expression,ref=>{
      if(ref.role==='axis'){
        if(ref.name===axis) return {kind:'symbol',reference:{role:'axis',name:'X'}};
        const old=oldKnown.get(ref.name),current=newKnown.get(ref.name);
        if(old===undefined || current===undefined) throw new MathInputProblem('domain','追従に必要な既知座標が不足しています。');
        return interpolate(coordinate(old),coordinate(current));
      }
      if(ref.role==='coefficient'){
        const old=oldCoefficients.get(ref.id),current=newCoefficients.get(ref.id);
        if(old===undefined || current===undefined) throw new MathInputProblem('domain','追従に必要な係数が見つかりません。');
        return interpolate(old,current);
      }
    return null;
  },shouldStop);
  return exactCoordinatePolynomial(expression,new Map(),shouldStop);
}
