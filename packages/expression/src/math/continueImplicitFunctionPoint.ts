/** Follow a proved continuous branch; candidate order and nearest-point distance are never selectors. */
import {decodeFunctionPointWorkRequest,type FunctionPointWorkRequest} from './functionPointWorkRequest.js';
import {solveImplicitFunctionPoints} from './solveImplicitFunctionPoints.js';
import {readFunctionMathSource} from './functionMathSource.js';
import {sameMathMeaning} from './mathNotationConversion.js';
import {coefficientExpression} from './mathCoefficientExpression.js';
import {implicitPointContinuationFormula} from './implicitPointContinuationFormula.js';
import {proveScalarPointPath} from './proveScalarPointPath.js';
import {MathInputProblem} from './mathInputContract.js';
import type {FunctionPointCandidate} from './functionPointCandidates.js';
import type {PreparedScalarMathContext} from './evaluatePreparedScalarMath.js';

export type FunctionPointContinuation={readonly status:'ready';readonly candidate:FunctionPointCandidate}
  |{readonly status:'unresolved';readonly reason:'formula-changed'|'invalid-anchor'|'branch-missing'|'branch-unproved'}
  |{readonly status:'stopped';readonly reason:'cancelled'|'deadline'|'budget'};
const AXES=['X','Y','Z'] as const;
const unresolved=(reason:Extract<FunctionPointContinuation,{status:'unresolved'}>['reason']):FunctionPointContinuation=>({status:'unresolved',reason});
export function continueImplicitFunctionPoint(previous:FunctionPointWorkRequest,current:FunctionPointWorkRequest,
  anchor:FunctionPointCandidate['location'],context:Omit<PreparedScalarMathContext,'angleUnit'>):FunctionPointContinuation {
  const before=decodeFunctionPointWorkRequest(previous),after=decodeFunctionPointWorkRequest(current);
  const source=(request:FunctionPointWorkRequest)=>readFunctionMathSource(request.expression,
    {axes:AXES.filter(axis=>axis!==request.fixed?.axis),parameters:[],coefficients:request.coefficients},context.backend);
  const oldSource=source(before),newSource=source(after);
  if(oldSource.angleUnit!==newSource.angleUnit || !sameMathMeaning(oldSource.expression,newSource.expression)
    || before.fixed?.axis!==after.fixed?.axis || before.known.length!==after.known.length
    || before.known.some(item=>!after.known.some(next=>next.axis===item.axis))) return unresolved('formula-changed');
  const old=solveImplicitFunctionPoints(before,context);if(old.status==='stopped') return old;
  if(old.status!=='ready' || !old.exhaustive) return unresolved('invalid-anchor');
  const matches=old.candidates.filter(candidate=>{
    if(anchor.kind==='direct') return candidate.location.kind==='direct';
    const axis=AXES.indexOf(anchor.axis),range=anchor.interval;
    return axis>=0 && Number.isFinite(range.lower) && Number.isFinite(range.upper) && range.lower<=range.upper
      && range.lower>=before.minimum[axis] && range.upper<=before.maximum[axis] && range.upper-range.lower<=before.tolerance
      && candidate.location.kind==='implicit' && candidate.location.axis===anchor.axis
      && candidate.location.interval.lower>=range.lower && candidate.location.interval.upper<=range.upper;
  });
  if(matches.length!==1) return unresolved('invalid-anchor');
  const next=solveImplicitFunctionPoints(after,context);if(next.status==='stopped') return next;
  if(next.status!=='ready' || !next.exhaustive || next.candidates.length===0) return unresolved('branch-missing');
  if(anchor.kind==='direct') return next.candidates.length===1 && next.candidates[0].location.kind==='direct'
    ?{status:'ready',candidate:next.candidates[0]}:unresolved('branch-unproved');
  const original=matches[0],slot=AXES.indexOf(anchor.axis);
  const valuesUnchanged=before.known.every(item=>after.known.some(next=>next.axis===item.axis && next.value===item.value))
    && before.fixed?.value===after.fixed?.value && before.coefficients.length===after.coefficients.length
    && before.coefficients.every(item=>after.coefficients.some(next=>next.id===item.id && sameMathMeaning(
      coefficientExpression(item),coefficientExpression(next))));
  if(valuesUnchanged){
    const kept=next.candidates.filter(candidate=>candidate.location.kind==='implicit' && candidate.location.axis===anchor.axis
      && candidate.minimum[slot]>=original.minimum[slot] && candidate.maximum[slot]<=original.maximum[slot]);
    if(kept.length===1) return {status:'ready',candidate:kept[0]};
  }
  try{
    const polynomial=implicitPointContinuationFormula(before,after,anchor.axis,()=>context.shouldStop()!==undefined);
    if(polynomial===null) return unresolved('branch-unproved');
    const proven:FunctionPointCandidate[]=[];
    for(const candidate of next.candidates){
      if(candidate.location.kind!=='implicit' || candidate.location.axis!==anchor.axis) continue;
      const proof=proveScalarPointPath(polynomial,{before:{lower:original.minimum[slot],upper:original.maximum[slot]},
        after:{lower:candidate.minimum[slot],upper:candidate.maximum[slot]},
        domain:{lower:Math.min(before.minimum[slot],after.minimum[slot]),upper:Math.max(before.maximum[slot],after.maximum[slot])},
        tolerance:Math.max(before.tolerance,after.tolerance)},context.shouldStop);
      if(proof==='cancelled' || proof==='deadline') return {status:'stopped',reason:proof};
      if(proof) proven.push(candidate);
    }
    return proven.length===1?{status:'ready',candidate:proven[0]}:unresolved('branch-unproved');
  }catch(error){
    if(!(error instanceof MathInputProblem)) throw error;
    const stopped=context.shouldStop();return stopped?{status:'stopped',reason:stopped}:error.code==='budget'
      ?{status:'stopped',reason:'budget'}:unresolved('branch-unproved');
  }
}
