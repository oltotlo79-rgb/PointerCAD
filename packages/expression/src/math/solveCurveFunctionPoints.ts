/** Finite, certified curve point search. Unproved regions never become accepted point references. */
import {MathInputProblem} from './mathInputContract.js';
import {decodeCurvePointWorkRequest,type CurvePointCandidates,type CurvePointCandidate} from './curvePointWorkRequest.js';
import {createCurvePointEvaluation} from './curvePointEvaluation.js';
import {projectCurvePoint} from './curvePointProjection.js';
import type {PreparedScalarMathContext} from './evaluatePreparedScalarMath.js';
import type {MathInterval} from './mathInterval.js';

export function solveCurveFunctionPoints(value:unknown,context:Omit<PreparedScalarMathContext,'angleUnit'>):CurvePointCandidates {
  const input=decodeCurvePointWorkRequest(value),axes=['X','Y','Z'] as const;
  const outside=input.known.filter(item=>{const index=axes.indexOf(item.axis);return item.value<input.minimum[index] || item.value>input.maximum[index];});
  if(outside.length>0) return {status:'out-of-range',axes:outside.map(item=>item.axis)};
  const stopped=context.shouldStop();if(stopped) return {status:'stopped',reason:stopped};
  try {
    const evaluation=createCurvePointEvaluation(input,context),direct=input.known.find(item=>item.axis===input.independent);
    const candidates:CurvePointCandidate[]=[],unresolved:{interval:MathInterval;reason:string}[]=[];
    if(direct) {
      const interval={lower:direct.value,upper:direct.value},result=projectCurvePoint(input,evaluation,interval,true);
      if(result.status==='point') candidates.push(result.candidate);
      else if(result.status==='unresolved') unresolved.push({interval,reason:result.reason});
    } else {
      const tolerance=Math.max(Number.MIN_VALUE,input.tolerance/4),roots=evaluation.isolate({lower:input.lower,upper:input.upper},tolerance);
      if(roots.status==='cancelled' || roots.status==='deadline' || roots.status==='budget') return {status:'stopped',reason:roots.status};
      unresolved.push(...roots.unresolved.map(region=>({interval:{lower:region.lower,upper:region.upper},reason:region.reason})));
      for(const root of roots.roots) {
        let interval:MathInterval={lower:root.lower,upper:root.upper},precision=tolerance;
        for(let refinement=0;refinement<=16;refinement++) {
          const stopped=context.shouldStop();if(stopped) return {status:'stopped',reason:stopped};
          const result=projectCurvePoint(input,evaluation,interval,false);
          if(result.status==='point'){candidates.push(result.candidate);break;}
          if(result.status==='outside') break;
          if(refinement===16 || interval.lower===interval.upper){unresolved.push({interval,reason:result.reason});break;}
          precision=Math.max(Number.MIN_VALUE,precision/16);
          const narrower=evaluation.isolate(interval,precision);
          if(narrower.status==='cancelled' || narrower.status==='deadline' || narrower.status==='budget') return {status:'stopped',reason:narrower.status};
          if(narrower.status!=='complete' || narrower.roots.length!==1){unresolved.push({interval,reason:result.reason});break;}
          const next=narrower.roots[0];
          if(next.lower===interval.lower && next.upper===interval.upper){unresolved.push({interval,reason:result.reason});break;}
          interval={lower:next.lower,upper:next.upper};
        }
      }
    }
    const stopped=context.shouldStop();if(stopped) return {status:'stopped',reason:stopped};
    return {status:'ready',candidates,exhaustive:unresolved.length===0,unresolved};
  } catch(error) {
    const stopped=context.shouldStop();if(stopped) return {status:'stopped',reason:stopped};
    if(error instanceof MathInputProblem && error.code==='budget') return {status:'stopped',reason:'budget'};
    throw error;
  }
}
