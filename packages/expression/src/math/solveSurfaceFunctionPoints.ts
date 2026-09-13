/** Two supplied XYZ coordinates constrain the original U/V surface, within both finite boxes. */
import {MathInputProblem} from './mathInputContract.js';
import {decodeSurfacePointWorkRequest,type SurfacePointCandidate,type SurfacePointCandidates} from './surfacePointWorkRequest.js';
import {createSurfacePointEvaluation} from './surfacePointEvaluation.js';
import {projectSurfacePoint} from './surfacePointProjection.js';
import {solveCollapsedSurfaceFunctionPoints} from './solveCollapsedSurfaceFunctionPoints.js';
import {isolateBivariateRoots} from './isolateBivariateRoots.js';
import type {ParameterBox} from './bivariateIntervalNewton.js';
import type {PreparedScalarMathContext} from './evaluatePreparedScalarMath.js';

const AXES=['X','Y','Z'] as const;

export function solveSurfaceFunctionPoints(value:unknown,context:Omit<PreparedScalarMathContext,'angleUnit'>):SurfacePointCandidates {
  const input=decodeSurfacePointWorkRequest(value);
  const outside=input.known.filter(item=>{const index=AXES.indexOf(item.axis);return item.value<input.minimum[index]||item.value>input.maximum[index];});
  if(outside.length>0)return {status:'out-of-range',axes:outside.map(item=>item.axis)};
  const stopped=context.shouldStop();if(stopped)return {status:'stopped',reason:stopped};
  try {
    if(input.known.length===1)return solveCollapsedSurfaceFunctionPoints(input,context);
    const evaluation=createSurfacePointEvaluation(input,context),candidates:SurfacePointCandidate[]=[];
    const unresolved:{box:ParameterBox;reason:string}[]=[],box:ParameterBox=[
      {lower:input.lower[0],upper:input.upper[0]},{lower:input.lower[1],upper:input.upper[1]},
    ];
    let remaining=200_000;
    function isolate(box:ParameterBox,tolerance:number){
      if(remaining<1)throw new MathInputProblem('budget','曲面の座標探索の計算上限に達しました。');
      const result=isolateBivariateRoots(evaluation,{box,tolerance,maximumEvaluations:remaining,maximumDepth:64,
        maximumRegions:1024,shouldStop:context.shouldStop});remaining-=result.evaluations;return result;
    }
    const tolerance=Math.max(Number.MIN_VALUE,input.tolerance/4),result=isolate(box,tolerance);
    if(result.status!=='complete'&&result.status!=='unresolved')return {status:'stopped',reason:result.status};
    unresolved.push(...result.unresolved);
    for(const root of result.roots){
      let box=root.box,precision=tolerance;
      for(let attempt=0;attempt<=16;attempt++){
        const stopped=context.shouldStop();if(stopped)return {status:'stopped',reason:stopped};
        const projection=projectSurfacePoint(input,evaluation,box);
        if(projection.status==='point'){candidates.push(projection.candidate);break;}
        if(projection.status==='outside')break;
        if(attempt===16||box.some(range=>range.lower===range.upper)){unresolved.push({box,reason:projection.reason});break;}
        precision=Math.max(Number.MIN_VALUE,precision/16);
        const narrower=isolate(box,precision);
        if(narrower.status!=='complete'&&narrower.status!=='unresolved')return {status:'stopped',reason:narrower.status};
        if(narrower.status!=='complete'||narrower.roots.length!==1){unresolved.push({box,reason:projection.reason});break;}
        const next=narrower.roots[0].box;
        if(next.every((range,index)=>range.lower===box[index].lower&&range.upper===box[index].upper)){
          unresolved.push({box,reason:projection.reason});break;
        }
        box=next;
      }
    }
    return {status:'ready',candidates,unresolved,exhaustive:unresolved.length===0};
  }catch(error){
    const stopped=context.shouldStop();if(stopped)return {status:'stopped',reason:stopped};
    if(error instanceof MathInputProblem&&error.code==='budget')return {status:'stopped',reason:'budget'};
    throw error;
  }
}
