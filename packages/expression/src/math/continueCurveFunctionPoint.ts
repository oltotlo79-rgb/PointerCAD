/** A saved parameter interval identifies a branch; list order and nearest geometry never do. */
import {decodeCurvePointWorkRequest,type CurvePointCandidate} from './curvePointWorkRequest.js';
import {solveCurveFunctionPoints} from './solveCurveFunctionPoints.js';
import {sameMathMeaning} from './mathNotationConversion.js';
import {coefficientExpression} from './mathCoefficientExpression.js';
import {curvePointContinuationFormula,proportionalPointConditions} from './curvePointContinuationFormula.js';
import {proveScalarPointPath} from './proveScalarPointPath.js';
import {MathInputProblem} from './mathInputContract.js';
import type {PreparedScalarMathContext} from './evaluatePreparedScalarMath.js';
import type {MathInterval} from './mathInterval.js';

export type CurvePointContinuation={readonly status:'ready';readonly candidate:CurvePointCandidate}
  |{readonly status:'unresolved';readonly reason:'formula-changed'|'invalid-anchor'|'branch-missing'|'branch-unproved'}
  |{readonly status:'stopped';readonly reason:'cancelled'|'deadline'|'budget'};
const unresolved=(reason:Extract<CurvePointContinuation,{status:'unresolved'}>['reason']):CurvePointContinuation=>({status:'unresolved',reason});
const contains=(outer:MathInterval,inner:MathInterval)=>outer.lower<=inner.lower && outer.upper>=inner.upper;

export function continueCurveFunctionPoint(previous:unknown,current:unknown,anchor:CurvePointCandidate['location'],
  context:Omit<PreparedScalarMathContext,'angleUnit'>):CurvePointContinuation {
  const before=decodeCurvePointWorkRequest(previous),after=decodeCurvePointWorkRequest(current);
  const formulaChanged=before.outputs.some((item,index)=>!sameMathMeaning(item.expression,after.outputs[index].expression));
  // A supplied independent coordinate names a unique location, even if dependent
  // formulas change. Still prove both saved/current candidates, all additional
  // constraints, domains and ranges below. An isolated root has no such identity.
  const directLocation=anchor.direct && before.independent!=='T'
    && before.known.some(item=>item.axis===before.independent)
    && after.known.some(item=>item.axis===after.independent);
  if(before.independent!==after.independent || before.known.length!==after.known.length
    || before.known.some(item=>!after.known.some(next=>next.axis===item.axis))
    || before.outputs.some((item,index)=>item.angleUnit!==after.outputs[index].angleUnit)
    || (formulaChanged && !directLocation)) return unresolved('formula-changed');
  const interval=anchor.interval;
  if(anchor.kind!=='curve' || anchor.independent!==before.independent || typeof anchor.direct!=='boolean'
    || !Number.isFinite(interval.lower) || !Number.isFinite(interval.upper) || interval.lower>interval.upper
    || interval.lower<before.lower || interval.upper>before.upper || interval.upper-interval.lower>before.tolerance) return unresolved('invalid-anchor');
  const old=solveCurveFunctionPoints(before,context);if(old.status==='stopped') return old;
  if(old.status!=='ready' || !old.exhaustive) return unresolved('invalid-anchor');
  const matches=old.candidates.filter(item=>item.location.direct===anchor.direct && contains(interval,item.location.interval));
  if(matches.length!==1) return unresolved('invalid-anchor');
  const next=solveCurveFunctionPoints(after,context);if(next.status==='stopped') return next;
  if(next.status!=='ready' || !next.exhaustive || next.candidates.length===0) return unresolved('branch-missing');
  if(anchor.direct) return next.candidates.length===1 && next.candidates[0].location.direct
    ?{status:'ready',candidate:next.candidates[0]}:unresolved('branch-unproved');
  const original=matches[0].location.interval;
  const sameInputs=before.known.every(item=>after.known.some(next=>next.axis===item.axis && next.value===item.value))
    && before.coefficients.length===after.coefficients.length && before.coefficients.every(item=>after.coefficients.some(next=>next.id===item.id
      && sameMathMeaning(coefficientExpression(item),coefficientExpression(next))));
  const retained=()=>next.candidates.filter(item=>!item.location.direct && (contains(original,item.location.interval) || contains(item.location.interval,original)));
  if(sameInputs){const kept=retained();if(kept.length===1) return {status:'ready',candidate:kept[0]};}
  try {
    const conditions=before.known.map(item=>curvePointContinuationFormula(before,after,item.axis,()=>context.shouldStop()!==undefined));
    const polynomial=conditions.find(item=>item!==null && item.size>0);
    if(!polynomial || conditions.some(item=>item===null)) return unresolved('branch-unproved');
    if(conditions.every(item=>item!==null && [...item.keys()].every(key=>key.split(',')[1]==='0'))) {
      const kept=retained();if(kept.length===1) return {status:'ready',candidate:kept[0]};
    }
    if(conditions.some(item=>item===null || !proportionalPointConditions(polynomial,item))) return unresolved('branch-unproved');
    const proven:CurvePointCandidate[]=[];
    for(const candidate of next.candidates) {
      if(candidate.location.direct) continue;
      const proof=proveScalarPointPath(polynomial,{before:original,after:candidate.location.interval,
        domain:{lower:Math.min(before.lower,after.lower),upper:Math.max(before.upper,after.upper)},
        tolerance:Math.max(before.tolerance,after.tolerance)},context.shouldStop);
      if(proof==='cancelled' || proof==='deadline') return {status:'stopped',reason:proof};
      if(proof) proven.push(candidate);
    }
    return proven.length===1?{status:'ready',candidate:proven[0]}:unresolved('branch-unproved');
  } catch(error) {
    if(!(error instanceof MathInputProblem)) throw error;
    const stopped=context.shouldStop();return stopped?{status:'stopped',reason:stopped}:error.code==='budget'
      ?{status:'stopped',reason:'budget'}:unresolved('branch-unproved');
  }
}
