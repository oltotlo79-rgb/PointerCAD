/** Solve only inside the parent's finite XYZ box. Regular roots and exact polynomial tangencies share one result contract. */
import {createFunctionImplicitEvaluator} from './functionImplicitEvaluation.js';
import {readFunctionMathSource} from './functionMathSource.js';
import {decodeMathCoefficientValues} from './mathWorkRequest.js';
import {coefficientExpressionMap} from './mathCoefficientExpression.js';
import {functionWorkBounds,functionWorkNumber} from './functionWorkData.js';
import {exactCoordinatePolynomial} from './exactCoordinatePolynomial.js';
import {substituteCoordinatePolynomial} from './substituteCoordinatePolynomial.js';
import {exactDouble} from './exactDoubleInterval.js';
import {isolateExactPolynomialRoots} from './isolateExactPolynomialRoots.js';
import {isolateScalarRoots,type ScalarRootOptions} from './isolateScalarRoots.js';
import {MathInputProblem,type MathAxis} from './mathInputContract.js';
import {collapsedImplicitPoints} from './collapsedImplicitPoints.js';
import type {PreparedScalarMathContext} from './evaluatePreparedScalarMath.js';
import type {FunctionPoint} from './functionGeometryBounds.js';
import type {FunctionPointCandidate,FunctionPointCandidates,FunctionKnownCoordinate} from './functionPointCandidates.js';

const AXES=['X','Y','Z'] as const;
type Axis=0|1|2;
export interface ImplicitFunctionPointInput {
  readonly expression:unknown;readonly coefficients:unknown;
  readonly minimum:FunctionPoint;readonly maximum:FunctionPoint;readonly tolerance:number;
  readonly fixed?:FunctionKnownCoordinate;
  readonly known:readonly FunctionKnownCoordinate[];
}

export function solveImplicitFunctionPoints(input:ImplicitFunctionPointInput,
  context:Omit<PreparedScalarMathContext,'angleUnit'>):FunctionPointCandidates {
  const {minimum,maximum}=functionWorkBounds(input.minimum,input.maximum),tolerance=functionWorkNumber(input.tolerance);
  if(tolerance<=0) throw new MathInputProblem('domain','点の精度には正の値を指定してください。');
  if(input.known.length<1 || input.known.length>2 || new Set(input.known.map(value=>value.axis)).size!==input.known.length) {
    throw new MathInputProblem('syntax','既知の座標を重複しない1軸か2軸で指定してください。');
  }
  const known=new Map<MathAxis,number>();
  for(const item of [...(input.fixed?[input.fixed]:[]),...input.known]){
    if(!AXES.includes(item.axis)) throw new MathInputProblem('syntax','既知の座標はX・Y・Zから指定してください。');
    const value=functionWorkNumber(item.value),previous=known.get(item.axis);
    if(previous!==undefined && previous!==value) return {status:'ready',candidates:[],exhaustive:true,unresolved:[]};
    known.set(item.axis,value);
  }
  const outside=AXES.filter((axis,index)=>{const value=known.get(axis);return value!==undefined && (value<minimum[index] || value>maximum[index]);});
  if(outside.length>0) return {status:'out-of-range',axes:outside};
  const inputs=AXES.filter(axis=>axis!==input.fixed?.axis),coefficients=decodeMathCoefficientValues(input.coefficients);
  const stored=readFunctionMathSource(input.expression,{axes:inputs,parameters:[],coefficients},context.backend);
  const polynomial=exactCoordinatePolynomial(stored.expression,coefficientExpressionMap(coefficients),()=>context.shouldStop()!==undefined);
  const missing=AXES.filter(axis=>!known.has(axis));
  const stopped=context.shouldStop();if(stopped) return {status:'stopped',reason:stopped};
  if(missing.length!==1){
    const collapsed=polynomial===null?null:collapsedImplicitPoints(polynomial,known,minimum,maximum,tolerance,()=>context.shouldStop()!==undefined);
    const stopped=context.shouldStop();if(stopped) return {status:'stopped',reason:stopped};
    if(collapsed!==null) return collapsed;
    if(missing.length>1) return {status:'underconstrained',additionalCoordinates:1};
    const x=known.get('X'),y=known.get('Y'),z=known.get('Z');
    if(x===undefined || y===undefined || z===undefined) throw new MathInputProblem('syntax','点の座標を確定できません。');
    const point:FunctionPoint=[x,y,z],evaluator=createFunctionImplicitEvaluator(stored,coefficients,context,inputs),value=evaluator.enclosure(point,point);
    if(value.continuous && value.ranges.length===1 && value.ranges[0].lower===0 && value.ranges[0].upper===0) {
      return {status:'ready',candidates:[{point,minimum:point,maximum:point,location:{kind:'direct'}}],exhaustive:true,unresolved:[]};
    }
    if(value.continuous && value.ranges.length>0 && value.ranges.every(range=>range.lower>0 || range.upper<0)) {
      return {status:'ready',candidates:[],exhaustive:true,unresolved:[]};
    }
    return {status:'ready',candidates:[],exhaustive:false,unresolved:[{axis:'X',interval:{lower:x,upper:x},reason:'domain'}]};
  }
  const axis=missing[0],slot=AXES.indexOf(axis) as Axis;
  const base:FunctionPoint=[known.get('X')??0,known.get('Y')??0,known.get('Z')??0];
  const at=(value:number):FunctionPoint=>slot===0?[value,base[1],base[2]]:slot===1?[base[0],value,base[2]]:[base[0],base[1],value];
  const fixed=base.map((value,index)=>index===slot?null:exactDouble(value));
  const scalar=polynomial===null?null:substituteCoordinatePolynomial(polynomial,slot,[fixed[0],fixed[1],fixed[2]],()=>context.shouldStop()!==undefined);
  const options:ScalarRootOptions={lower:minimum[slot],upper:maximum[slot],tolerance:tolerance/4,
    maximumEvaluations:200_000,maximumRegions:1024,maximumDepth:64,shouldStop:context.shouldStop};
  const solveGeneral=()=>{
    const evaluator=createFunctionImplicitEvaluator(stored,coefficients,context,inputs),direction:FunctionPoint=slot===0?[1,0,0]:slot===1?[0,1,0]:[0,0,1];
    const derivative=evaluator.along(direction);
    return isolateScalarRoots({enclosure:(lower,upper)=>evaluator.enclosure(at(lower),at(upper)),
      derivative:(lower,upper)=>derivative(at(lower),at(upper))},options);
  };
  const result=scalar===null?solveGeneral():isolateExactPolynomialRoots(scalar,options);
  if(result.status==='cancelled' || result.status==='deadline' || result.status==='budget') return {status:'stopped',reason:result.status};
  const candidates:FunctionPointCandidate[]=result.roots.map(root=>({point:at(root.lower+(root.upper-root.lower)/2),
    minimum:at(root.lower),maximum:at(root.upper),location:{kind:'implicit',axis,interval:{lower:root.lower,upper:root.upper}}}));
  return {status:'ready',candidates,exhaustive:result.status==='complete',unresolved:result.unresolved.map(region=>({axis,
    interval:{lower:region.lower,upper:region.upper},reason:region.reason}))};
}
