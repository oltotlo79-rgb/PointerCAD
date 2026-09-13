/** One XYZ value may select a collapsed parameter line. Never choose an arbitrary free parameter. */
import {MathInputProblem} from './mathInputContract.js';
import {createSurfaceCoordinateEvaluation} from './surfacePointEvaluation.js';
import {projectSurfacePoint} from './surfacePointProjection.js';
import {exactParameterEquation} from './exactParameterEquation.js';
import {isolateExactPolynomialRoots} from './isolateExactPolynomialRoots.js';
import {isolateScalarRoots} from './isolateScalarRoots.js';
import {quadraticSurfaceLevel} from './quadraticSurfaceLevel.js';
import {evenPolynomialSurfaceLevel} from './evenPolynomialSurfaceLevel.js';
import type {SurfacePointWorkRequest,SurfacePointCandidates,SurfacePointCandidate} from './surfacePointWorkRequest.js';
import type {PreparedScalarMathContext} from './evaluatePreparedScalarMath.js';
import type {ParameterBox} from './bivariateIntervalNewton.js';
import type {MathInterval} from './mathInterval.js';

const AXES=['X','Y','Z'] as const;
export function solveCollapsedSurfaceFunctionPoints(input:SurfacePointWorkRequest,
  context:Omit<PreparedScalarMathContext,'angleUnit'>):SurfacePointCandidates {
  const evaluation=createSurfaceCoordinateEvaluation(input,context),known=input.known[0];
  const axis=AXES.indexOf(known.axis) as 0|1|2,slots=evaluation.varyingSlots[axis];
  const full:ParameterBox=[{lower:input.lower[0],upper:input.upper[0]},{lower:input.lower[1],upper:input.upper[1]}];
  const candidates:SurfacePointCandidate[]=[],unresolved:{box:ParameterBox;reason:string}[]=[];
  const ready=():SurfacePointCandidates=>({status:'ready',candidates,unresolved,exhaustive:unresolved.length===0});
  if(slots.length===0){
    const equation=evaluation.equation(full,axis,known.value);
    if(equation.ranges.length===0||equation.ranges.every(range=>range.lower>0||range.upper<0))return ready();
    if(equation.continuous&&equation.ranges.length===1&&equation.ranges[0].lower===0&&equation.ranges[0].upper===0
      &&([0,1,2] as const).every(index=>evaluation.constantIn(full,index,0)&&evaluation.constantIn(full,index,1))){
      const result=projectSurfacePoint(input,evaluation,full);
      if(result.status==='point')candidates.push(result.candidate);
      else if(result.status==='unresolved')unresolved.push({box:full,reason:result.reason});
      return ready();
    }
    unresolved.push({box:full,reason:'free-parameters'});return ready();
  }
  if(slots.length!==1){
    const polynomial=evaluation.polynomials[axis];
    const quadratic=polynomial===null?null:quadraticSurfaceLevel(polynomial,known.value,full,()=>context.shouldStop()!==undefined);
    const proof=polynomial!==null&&quadratic?.status==='unresolved'
      ?evenPolynomialSurfaceLevel(polynomial,known.value,full,()=>context.shouldStop()!==undefined):quadratic;
    const stopped=context.shouldStop();if(stopped)return {status:'stopped',reason:stopped};
    if(proof?.status==='empty')return ready();
    if(proof?.status==='points'){
      for(const box of proof.boxes){
        const projection=projectSurfacePoint(input,evaluation,box);
        if(projection.status==='point')candidates.push(projection.candidate);
        else if(projection.status==='unresolved')unresolved.push({box,reason:projection.reason});
      }
      return ready();
    }
    unresolved.push({box:full,reason:'two-parameter-coordinate'});return ready();
  }
  const constrained=slots[0] as 0|1,free=constrained===0?1:0;
  const boxAt=(interval:MathInterval):ParameterBox=>{
    // Root certificates and unresolved reasons are internal, not saved interval fields.
    const range={lower:interval.lower,upper:interval.upper};
    return constrained===0?[range,full[1]]:[full[0],range];
  };
  const polynomial=exactParameterEquation(input.outputs[axis].expression,constrained===0?'U':'V',
    input.coefficients,known.value,()=>context.shouldStop()!==undefined);
  let remaining=200_000;
  function isolate(interval:MathInterval,tolerance:number){
    if(remaining<1)throw new MathInputProblem('budget','曲面の座標探索の計算上限に達しました。');
    const options={...interval,tolerance,maximumEvaluations:remaining,maximumRegions:1024,maximumDepth:64,shouldStop:context.shouldStop};
    const result=polynomial!==null?isolateExactPolynomialRoots(polynomial,options):isolateScalarRoots({
      enclosure:(lower,upper)=>evaluation.equation(boxAt({lower,upper}),axis,known.value),
      derivative:(lower,upper)=>evaluation.partial(boxAt({lower,upper}),axis,constrained),
    },options);remaining-=result.evaluations;return result;
  }
  const tolerance=Math.max(Number.MIN_VALUE,input.tolerance/4),roots=isolate(full[constrained],tolerance);
  if(roots.status!=='complete'&&roots.status!=='unresolved')return {status:'stopped',reason:roots.status};
  unresolved.push(...roots.unresolved.map(region=>({box:boxAt(region),reason:region.reason})));
  for(const root of roots.roots){
    let interval:MathInterval=root,precision=tolerance;
    for(let attempt=0;attempt<=16;attempt++){
      const stopped=context.shouldStop();if(stopped)return {status:'stopped',reason:stopped};
      const box=boxAt(interval),constant=([0,1,2] as const).every(index=>evaluation.constantIn(box,index,free));
      if(!constant){
        // Two disjoint, certified XYZ enclosures prove there are at least two points.
        // Merely seeing the free parameter in the formula does not prove multiplicity.
        const witnesses=[full[free].lower,full[free].upper].map(value=>{
          const fixed={lower:value,upper:value};
          return projectSurfacePoint(input,evaluation,free===0?[fixed,interval]:[interval,fixed]);
        });
        const [first,second]=witnesses;
        if(first.status==='point'&&second.status==='point'&&[0,1,2].some(index=>
          first.candidate.maximum[index]<second.candidate.minimum[index]||second.candidate.maximum[index]<first.candidate.minimum[index])){
          return {status:'underconstrained'};
        }
        unresolved.push({box,reason:'free-parameter'});break;
      }
      const projection=projectSurfacePoint(input,evaluation,box);
      if(projection.status==='point'){candidates.push(projection.candidate);break;}
      if(projection.status==='outside')break;
      if(attempt===16||interval.lower===interval.upper){unresolved.push({box,reason:projection.reason});break;}
      precision=Math.max(Number.MIN_VALUE,precision/16);
      const narrower=isolate(interval,precision);
      if(narrower.status!=='complete'&&narrower.status!=='unresolved')return {status:'stopped',reason:narrower.status};
      if(narrower.status!=='complete'||narrower.roots.length!==1){unresolved.push({box,reason:projection.reason});break;}
      const next=narrower.roots[0];
      if(next.lower===interval.lower&&next.upper===interval.upper){unresolved.push({box,reason:projection.reason});break;}
      interval=next;
    }
  }
  return ready();
}
