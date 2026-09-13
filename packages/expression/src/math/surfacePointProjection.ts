/** Accept points only when every original XYZ coordinate is defined, precise and inside its box. */
import type {SurfacePointCandidate,SurfacePointWorkRequest} from './surfacePointWorkRequest.js';
import type {SurfaceCoordinateEvaluation} from './surfacePointEvaluation.js';
import type {ParameterBox} from './bivariateIntervalNewton.js';
import type {MathInterval} from './mathInterval.js';

const AXES=['X','Y','Z'] as const;
export type SurfacePointProjection={readonly status:'point';readonly candidate:SurfacePointCandidate}|{readonly status:'outside'}
  |{readonly status:'unresolved';readonly reason:'domain'|'precision'|'boundary'};
/** The caller must first prove that all supplied coordinates hold on the certified root. */
export function projectSurfacePoint(input:SurfacePointWorkRequest,evaluation:Pick<SurfaceCoordinateEvaluation,'ranges'>,box:ParameterBox):SurfacePointProjection {
  const values=evaluation.ranges(box),ranges:MathInterval[]=[];
  for(const index of [0,1,2] as const){
    const value=values[index];if(value.ranges.length===0)return {status:'outside'};
    if(!value.continuous||value.ranges.length!==1)return {status:'unresolved',reason:'domain'};
    const known=input.known.find(item=>item.axis===AXES[index]);
    const range=known?{lower:known.value,upper:known.value}:value.ranges[0];
    if(!Number.isFinite(range.lower)||!Number.isFinite(range.upper))return {status:'unresolved',reason:'domain'};
    if(range.upper<input.minimum[index]||range.lower>input.maximum[index])return {status:'outside'};
    if(range.lower<input.minimum[index]||range.upper>input.maximum[index])return {status:'unresolved',reason:'boundary'};
    if(range.upper-range.lower>input.tolerance)return {status:'unresolved',reason:'precision'};
    ranges.push(range);
  }
  const [x,y,z]=ranges;
  return {status:'point',candidate:{point:[x.lower+(x.upper-x.lower)/2,y.lower+(y.upper-y.lower)/2,z.lower+(z.upper-z.lower)/2],
    minimum:[x.lower,y.lower,z.lower],maximum:[x.upper,y.upper,z.upper],location:{kind:'parametric-surface',box}}};
}
