/** Preserve a proven U/V branch through edits, including every intermediate equation. */
import {decodeSurfacePointWorkRequest,type SurfacePointCandidate} from './surfacePointWorkRequest.js';
import {decodeSurfacePointLocation} from './surfacePointWorkReply.js';
import {solveSurfaceFunctionPoints} from './solveSurfaceFunctionPoints.js';
import {createSurfacePointEvaluation} from './surfacePointEvaluation.js';
import {surfacePointContinuationFormula} from './surfacePointContinuationFormula.js';
import {proveBivariatePointPath} from './proveBivariatePointPath.js';
import {proveQuadraticSurfacePointPath} from './proveQuadraticSurfacePointPath.js';
import {createSurfacePointPathBounds} from './surfacePointPathBounds.js';
import {parameterBoxContains,type ParameterBox} from './bivariateIntervalNewton.js';
import {MathInputProblem} from './mathInputContract.js';
import {sameMathMeaning} from './mathNotationConversion.js';
import {coefficientExpression} from './mathCoefficientExpression.js';
import type {PreparedScalarMathContext} from './evaluatePreparedScalarMath.js';

export type SurfacePointContinuation={readonly status:'ready';readonly candidate:SurfacePointCandidate}
  |{readonly status:'unresolved';readonly reason:'formula-changed'|'invalid-anchor'|'branch-missing'|'branch-unproved'}
  |{readonly status:'stopped';readonly reason:'cancelled'|'deadline'|'budget'};
const unresolved=(reason:Extract<SurfacePointContinuation,{status:'unresolved'}>['reason']):SurfacePointContinuation=>({status:'unresolved',reason});

export function continueSurfaceFunctionPoint(previous:unknown,current:unknown,anchor:SurfacePointCandidate['location'],
  context:Omit<PreparedScalarMathContext,'angleUnit'>):SurfacePointContinuation {
  const before=decodeSurfacePointWorkRequest(previous),after=decodeSurfacePointWorkRequest(current);
  if(before.known.length!==after.known.length||before.known.some(item=>!after.known.some(next=>next.axis===item.axis))
    ||before.outputs.some((item,index)=>item.angleUnit!==after.outputs[index].angleUnit
      ||!sameMathMeaning(item.expression,after.outputs[index].expression)))return unresolved('formula-changed');
  try{decodeSurfacePointLocation(anchor,before);}catch(error){if(error instanceof MathInputProblem)return unresolved('invalid-anchor');throw error;}
  const old=solveSurfaceFunctionPoints(before,context);if(old.status==='stopped')return old;
  if(old.status!=='ready'||!old.exhaustive)return unresolved('invalid-anchor');
  // Earlier saved files can contain exact U/V values while the current solver
  // encloses that same root. Accept the point only after both original equations
  // prove exact zero; mere overlap with a computed enclosure is not sufficient.
  const exactAnchor=before.known.length===2&&anchor.box.every(range=>range.lower===range.upper)
    &&createSurfacePointEvaluation(before,context).enclosure(anchor.box).every(value=>value.continuous&&value.ranges.length===1
      &&value.ranges[0].lower===0&&value.ranges[0].upper===0);
  const matches=old.candidates.filter(item=>parameterBoxContains(anchor.box,item.location.box)
    ||exactAnchor&&parameterBoxContains(item.location.box,anchor.box));
  if(matches.length!==1)return unresolved('invalid-anchor');
  const next=solveSurfaceFunctionPoints(after,context);if(next.status==='stopped')return next;
  if(next.status!=='ready'||!next.exhaustive||next.candidates.length===0)return unresolved('branch-missing');
  const original=matches[0].location.box;
  const sameInputs=before.known.every(item=>after.known.some(next=>next.axis===item.axis&&next.value===item.value))
    &&before.coefficients.length===after.coefficients.length&&before.coefficients.every(item=>after.coefficients.some(next=>next.id===item.id
      &&sameMathMeaning(coefficientExpression(item),coefficientExpression(next))));
  const retained=()=>next.candidates.filter(item=>parameterBoxContains(original,item.location.box)||parameterBoxContains(item.location.box,original));
  if(sameInputs){const kept=retained();if(kept.length===1)return {status:'ready',candidate:kept[0]};}
  try{
    const conditions=before.known.map(item=>surfacePointContinuationFormula(before,after,item.axis,()=>context.shouldStop()!==undefined));
    const first=conditions[0],second=conditions[1];if(first===null||second===null)return unresolved('branch-unproved');
    const contains=createSurfacePointPathBounds(before,after,()=>context.shouldStop()!==undefined);
    // One-coordinate searches can leave a whole parameter line at the same XYZ.
    // Only an isolated exact U/V pair may reuse an unchanged one-coordinate equation.
    const isolated=original.every(range=>range.lower===range.upper);
    if((before.known.length===2||isolated)
      &&conditions.every(item=>item!==null&&[...item.keys()].every(key=>key.split(',')[2]==='0'))){
      if(!contains(original,{lower:0,upper:1}))return unresolved('branch-unproved');
      const kept=retained();if(kept.length===1)return {status:'ready',candidate:kept[0]};
    }
    const sharedRange=(index:0|1)=>({lower:Math.max(before.lower[index],after.lower[index]),upper:Math.min(before.upper[index],after.upper[index])});
    const domain:ParameterBox=[sharedRange(0),sharedRange(1)];
    const proven:SurfacePointCandidate[]=[];
    for(const candidate of next.candidates){
      const path={before:original,after:candidate.location.box,domain,tolerance:Math.max(before.tolerance,after.tolerance),contains};
      const proof=before.known.length===1?proveQuadraticSurfacePointPath(first,path,context.shouldStop)
        :proveBivariatePointPath([first,second],path,context.shouldStop);
      if(proof==='cancelled'||proof==='deadline')return {status:'stopped',reason:proof};
      if(proof)proven.push(candidate);
    }
    return proven.length===1?{status:'ready',candidate:proven[0]}:unresolved('branch-unproved');
  }catch(error){
    if(!(error instanceof MathInputProblem))throw error;
    const stopped=context.shouldStop();return stopped?{status:'stopped',reason:stopped}:error.code==='budget'
      ?{status:'stopped',reason:'budget'}:unresolved('branch-unproved');
  }
}
