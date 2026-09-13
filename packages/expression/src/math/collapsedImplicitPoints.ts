/** Exact point/empty decisions when an implicit intersection loses its usual free dimension. */
import {EXACT_ZERO,exactAdd,exactMultiply,exactNegative,type CoordinatePolynomial} from './exactCoordinatePolynomial.js';
import {exactDouble,exactDoubleInterval} from './exactDoubleInterval.js';
import {recognizeImplicitPrimitive} from './recognizeImplicitPrimitive.js';
import type {ExactRational} from './exactRational.js';
import type {FunctionPoint} from './functionGeometryBounds.js';
import type {MathAxis} from './mathInputContract.js';
import type {FunctionPointCandidates} from './functionPointCandidates.js';

const AXES=['X','Y','Z'] as const;
const empty=():FunctionPointCandidates=>({status:'ready',candidates:[],exhaustive:true,unresolved:[]});
function exactPoint(polynomial:CoordinatePolynomial,point:readonly ExactRational[],shouldStop:()=>boolean):ExactRational|null {
  let sum:ExactRational=EXACT_ZERO;
  for(const [key,coefficient] of polynomial){
    if(shouldStop()) return null;let term:ExactRational|null=coefficient;
    const powers=key.split(',').map(Number);
    for(let axis=0;axis<3;axis++) for(let exponent=0;exponent<powers[axis];exponent++){
      if(term===null || shouldStop()) return null;term=exactMultiply(term,point[axis]);
    }
    if(term===null) return null;const next=exactAdd(sum,term);if(next===null) return null;sum=next;
  }
  return sum;
}
function candidate(point:readonly [ExactRational,ExactRational,ExactRational],minimum:FunctionPoint,maximum:FunctionPoint,tolerance:number):FunctionPointCandidates|null {
  const intervals=point.map(exactDoubleInterval),[x,y,z]=intervals;if(x===null || y===null || z===null) return null;
  if(intervals.some((range,index)=>range!==null && (range.upper<minimum[index] || range.lower>maximum[index]))) return empty();
  if(intervals.some((range,index)=>range===null || range.lower<minimum[index] || range.upper>maximum[index])
    || (x.upper-x.lower)+(y.upper-y.lower)+(z.upper-z.lower)>tolerance/4) return null;
  return {status:'ready',exhaustive:true,unresolved:[],candidates:[{point:[x.lower+(x.upper-x.lower)/2,y.lower+(y.upper-y.lower)/2,z.lower+(z.upper-z.lower)/2],
    minimum:[x.lower,y.lower,z.lower],maximum:[x.upper,y.upper,z.upper],location:{kind:'direct'}}]};
}

export function collapsedImplicitPoints(polynomial:CoordinatePolynomial,known:ReadonlyMap<MathAxis,number>,
  minimum:FunctionPoint,maximum:FunctionPoint,tolerance:number,shouldStop:()=>boolean):FunctionPointCandidates|null {
  if(known.size===3){
    const x=exactDouble(known.get('X')??NaN),y=exactDouble(known.get('Y')??NaN),z=exactDouble(known.get('Z')??NaN);
    if(x===null || y===null || z===null) return null;const value=exactPoint(polynomial,[x,y,z],shouldStop);
    return value===null?null:value.numerator===0n?candidate([x,y,z],minimum,maximum,tolerance):empty();
  }
  if(known.size!==1) return null;
  const sphere=recognizeImplicitPrimitive(polynomial);if(sphere?.kind!=='sphere') return null;
  const entry=[...known][0],axis=AXES.indexOf(entry[0]),value=exactDouble(entry[1]);if(value===null) return null;
  const offset=exactAdd(value,exactNegative(sphere.center[axis])),square=offset===null?null:exactMultiply(offset,offset);
  const remaining=square===null?null:exactAdd(sphere.radiusSquared,exactNegative(square));if(remaining===null || remaining.numerator>0n) return null;
  if(remaining.numerator<0n) return empty();
  const center=sphere.center,point:readonly [ExactRational,ExactRational,ExactRational]=axis===0?[value,center[1],center[2]]:
    axis===1?[center[0],value,center[2]]:[center[0],center[1],value];
  return candidate(point,minimum,maximum,tolerance);
}
