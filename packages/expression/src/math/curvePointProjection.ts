/** XYZ enclosures, not samples of a displayed polyline, authorize a curve point. */
import type {CurvePointCandidate,CurvePointWorkRequest} from './curvePointWorkRequest.js';
import type {CurvePointEvaluation} from './curvePointEvaluation.js';
import type {MathInterval} from './mathInterval.js';

const AXES=['X','Y','Z'] as const;
export type CurvePointProjection={readonly status:'point';readonly candidate:CurvePointCandidate}
  |{readonly status:'outside'}|{readonly status:'unresolved';readonly reason:'domain'|'precision'|'condition'|'boundary'};

export function projectCurvePoint(input:CurvePointWorkRequest,evaluation:CurvePointEvaluation,interval:MathInterval,direct:boolean):CurvePointProjection {
  const enclosures=evaluation.ranges(interval),coordinates:MathInterval[]=[];
  for(const [index,axis] of AXES.entries()) {
    const enclosure=enclosures[index],known=input.known.find(item=>item.axis===axis);
    if(enclosure.ranges.length===0) return {status:'outside'};
    if(!enclosure.continuous || enclosure.ranges.length!==1) return {status:'unresolved',reason:'domain'};
    let range=enclosure.ranges[0];
    if(!Number.isFinite(range.lower) || !Number.isFinite(range.upper)) return {status:'unresolved',reason:'domain'};
    if(known) {
      const proven=direct?axis===input.independent: evaluation.allKnownProven || axis===evaluation.primaryAxis;
      const exact=interval.lower===interval.upper?evaluation.knownAt(axis,interval.lower):null;
      if(!proven && exact!==true && !(range.lower===known.value && range.upper===known.value)) {
        if(exact===false || range.upper<known.value || range.lower>known.value) return {status:'outside'};
        return {status:'unresolved',reason:'condition'};
      }
      range={lower:known.value,upper:known.value};
    }
    if(range.upper<input.minimum[index] || range.lower>input.maximum[index]) return {status:'outside'};
    if(range.lower<input.minimum[index] || range.upper>input.maximum[index]) return {status:'unresolved',reason:'boundary'};
    if(range.upper-range.lower>input.tolerance) return {status:'unresolved',reason:'precision'};
    coordinates.push(range);
  }
  const [x,y,z]=coordinates;
  return {status:'point',candidate:{point:[x.lower+(x.upper-x.lower)/2,y.lower+(y.upper-y.lower)/2,z.lower+(z.upper-z.lower)/2],
    minimum:[x.lower,y.lower,z.lower],maximum:[x.upper,y.upper,z.upper],
    location:{kind:'curve',independent:input.independent,interval:{...interval},direct}}};
}
