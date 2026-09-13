import {
  decodeFunctionPointWorkRequest,
  decodeCurvePointWorkRequest,
  decodeSurfacePointWorkRequest,
  functionCoordinateEquation,
  type FunctionKnownCoordinate,
  type PointCalculationRequest,
} from '@pointercad/expression/math/contracts';

import type {FunctionFormula} from './functionDefinitionTypes.js';
import type {ResolvedFunctionRanges} from './resolveFunctionRanges.js';
import type {FunctionRequestContext} from './functionRequestInputs.js';
import {functionCurveRequest} from './functionCurveRequest.js';
import {functionSurfaceRequest} from './functionSurfaceRequest.js';

export function functionPointRequest(formula:FunctionFormula,ranges:ResolvedFunctionRanges,known:readonly FunctionKnownCoordinate[],
  context:FunctionRequestContext):PointCalculationRequest {
  if(formula.kind==='coordinate-curve' || formula.kind==='parametric-curve') {
    return decodeCurvePointWorkRequest({...functionCurveRequest(formula,{...ranges,tolerance:Math.min(ranges.tolerance,1e-7)},context),kind:'curve',known});
  }
  if(formula.kind==='parametric-surface') {
    return decodeSurfacePointWorkRequest({...functionSurfaceRequest(formula,{...ranges,tolerance:Math.min(ranges.tolerance,1e-7)},context),
      kind:'parametric-surface',known});
  }
  if(formula.kind!=='implicit-curve' && formula.kind!=='implicit-surface' && formula.kind!=='coordinate-surface') throw new Error('この関数形式の点の計算部を準備できません。');
  const X=ranges.bounds.interval('X'),Y=ranges.bounds.interval('Y'),Z=ranges.bounds.interval('Z');
  if(formula.kind==='implicit-curve' && ranges.fixedCoordinate===null) throw new Error('平面等式の固定座標を再計算してください。');
  const expression=formula.kind==='coordinate-surface'?functionCoordinateEquation(formula.expression,formula.output):formula.expression;
  return decodeFunctionPointWorkRequest({identity:context.identity,coefficients:context.coefficients,expression,
    // Point coordinates must remain useful for CAD references even when the parent is coarsely tessellated.
    minimum:[X.min,Y.min,Z.min],maximum:[X.max,Y.max,Z.max],tolerance:Math.min(ranges.tolerance,1e-7),known,
    ...(formula.kind==='implicit-curve'?{fixed:{axis:formula.fixedAxis,value:ranges.fixedCoordinate}}:{})});
}
