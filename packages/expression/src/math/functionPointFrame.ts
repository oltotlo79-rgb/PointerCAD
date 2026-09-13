/** Local differential directions enclose the original function around a certified point.
 * The caller must revalidate the saved branch before using this internal helper.
 */
import {compileFunctionScalar} from './compileFunctionScalar.js';
import {createScalarDirectionalJet} from './scalarCurveCurvature.js';
import {isCurvePointInput,isSurfacePointInput,type PointCalculationRequest,type PointCalculationCandidate} from './pointCalculationContract.js';
import {intervalAdd,intervalSubtract,intervalMultiply,intervalDivide,intervalSquare,intervalSqrt,nextFloat,type MathInterval,type IntervalValue} from './mathInterval.js';
import type {PreparedScalarMathContext} from './evaluatePreparedScalarMath.js';
import type {FunctionPointDirectionKind} from './functionDirectionContract.js';
type Vector=readonly [MathInterval,MathInterval,MathInterval];
type Range=MathInterval|null;
const ZERO:MathInterval={lower:0,upper:0};
const unpack=(value:IntervalValue):Range=>value.status==='range'&&Number.isFinite(value.interval.lower)&&Number.isFinite(value.interval.upper)?value.interval:null;
const zero=(value:MathInterval)=>value.lower===0&&value.upper===0;
const add=(a:Range,b:Range):Range=>a===null||b===null?null:zero(a)?b:zero(b)?a:unpack(intervalAdd(a,b));
const subtract=(a:Range,b:Range):Range=>a===null||b===null?null:zero(b)?a:unpack(intervalSubtract(a,b));
const multiply=(a:Range,b:Range):Range=>a===null||b===null?null:zero(a)||zero(b)?ZERO:unpack(intervalMultiply(a,b));
const vector=(ranges:readonly Range[]):Vector|null=>ranges.length===3&&ranges.every((range):range is MathInterval=>range!==null)
  ?[ranges[0],ranges[1],ranges[2]]:null;
function cross(a:Vector,b:Vector):Vector|null {
  return vector([subtract(multiply(a[1],b[2]),multiply(a[2],b[1])),subtract(multiply(a[2],b[0]),multiply(a[0],b[2])),
    subtract(multiply(a[0],b[1]),multiply(a[1],b[0]))]);
}
function squaredLength(a:Vector):Range {return a.reduce<Range>((sum,value)=>add(sum,unpack(intervalSquare(value))),ZERO);}
function unit(a:Vector):Vector|null {
  const squared=squaredLength(a);if(squared===null||squared.lower<=0)return null;
  const length=unpack(intervalSqrt(squared));if(length===null||length.lower<=0)return null;
  return vector(a.map(value=>zero(value)?ZERO:unpack(intervalDivide(value,length))));
}
/** Expand by one representable value so an absolute-value corner or integer jump
 * cannot masquerade as a smooth function merely because its location is exact.
 */
function neighborhood(ranges:readonly MathInterval[]):readonly MathInterval[]|null {
  const result=ranges.map(range=>({lower:nextFloat(range.lower,-1),upper:nextFloat(range.upper,1)}));
  return result.every(range=>Number.isFinite(range.lower)&&Number.isFinite(range.upper))?result:null;
}

export function functionPointFrame(request:PointCalculationRequest,candidate:PointCalculationCandidate,
  kind:FunctionPointDirectionKind,context:Omit<PreparedScalarMathContext,'angleUnit'>):Vector|null {
  if(isCurvePointInput(request)){
    if(candidate.location.kind!=='curve'||candidate.location.independent!==request.independent||kind==='tangent-u'||kind==='tangent-v')return null;
    const bounds=neighborhood([candidate.location.interval]);if(bounds===null)return null;
    const jets=request.outputs.map(output=>createScalarDirectionalJet(compileFunctionScalar(output,[request.independent],request.coefficients,context),[1])(bounds));
    const velocity=vector(jets.map(jet=>jet.first));if(velocity===null||unit(velocity)===null)return null;
    if(kind==='tangent')return unit(velocity);
    // The principal normal is acceleration with its velocity component removed.
    // A straight line or a zero-speed point has no unique principal normal.
    const acceleration=vector(jets.map(jet=>jet.second));if(acceleration===null)return null;
    const binormal=cross(velocity,acceleration),normal=binormal===null?null:cross(binormal,velocity);
    return normal===null?null:unit(normal);
  }
  if(isSurfacePointInput(request)){
    if(candidate.location.kind!=='parametric-surface'||kind==='tangent')return null;
    const bounds=neighborhood(candidate.location.box);if(bounds===null)return null;
    const tapes=request.outputs.map(output=>compileFunctionScalar(output,['U','V'],request.coefficients,context));
    const u=vector(tapes.map(tape=>createScalarDirectionalJet(tape,[1,0])(bounds).first));
    const v=vector(tapes.map(tape=>createScalarDirectionalJet(tape,[0,1])(bounds).first));
    if(u===null||v===null)return null;
    const normal=cross(u,v);if(normal===null||unit(normal)===null)return null;
    return unit(kind==='normal'?normal:kind==='tangent-u'?u:v);
  }
  if(kind==='tangent-u'||kind==='tangent-v')return null;
  const bounds=neighborhood(candidate.minimum.map((lower,axis)=>({lower,upper:candidate.maximum[axis]})));if(bounds===null)return null;
  const tape=compileFunctionScalar(request.expression,['X','Y','Z'],request.coefficients,context);
  const gradient=vector([0,1,2].map(axis=>createScalarDirectionalJet(tape,[0,1,2].map(index=>axis===index?1:0))(bounds).first));
  if(gradient===null)return null;
  if(request.fixed===undefined)return kind==='normal'?unit(gradient):null;
  const fixed=['X','Y','Z'].indexOf(request.fixed.axis),planar=vector(gradient.map((range,axis)=>axis===fixed?ZERO:range));
  if(planar===null||unit(planar)===null)return null;
  if(kind==='normal')return unit(planar);
  const planeNormal=vector([0,1,2].map(axis=>({lower:axis===fixed?1:0,upper:axis===fixed?1:0})));
  const tangent=planeNormal===null?null:cross(planeNormal,planar);return tangent===null?null:unit(tangent);
}

/** Validate precision after multiplying by the requested length, not just after normalization. */
export function functionDirectionEndpoint(point:PointCalculationCandidate,direction:Vector,length:number,tolerance:number,reverse=false):
  {readonly point:readonly [number,number,number];readonly minimum:readonly [number,number,number];readonly maximum:readonly [number,number,number]}|null {
  if(!Number.isFinite(length)||length<=0||!Number.isFinite(tolerance)||tolerance<=0)return null;
  const signed=reverse?-length:length;
  const ranges=vector(direction.map((range,axis)=>add({lower:point.minimum[axis],upper:point.maximum[axis]},multiply(range,{lower:signed,upper:signed}))));
  if(ranges===null||ranges.some(range=>range.upper-range.lower>tolerance))return null;
  const middle=ranges.map(range=>range.lower+(range.upper-range.lower)/2);
  let error:Range=ZERO;
  for(let axis=0;axis<3;axis++){
    const value=middle[axis],range=ranges[axis];if(!Number.isFinite(value))return null;
    const low=unpack(intervalSubtract({lower:value,upper:value},{lower:range.lower,upper:range.lower}));
    const high=unpack(intervalSubtract({lower:range.upper,upper:range.upper},{lower:value,upper:value}));
    if(low===null||high===null)return null;const radius=Math.max(low.upper,high.upper);
    error=add(error,unpack(intervalSquare({lower:0,upper:radius})));
  }
  // Compare squared bounds directly. Outward addition can give a sum of squares
  // a tiny negative lower bound; it must not turn a precise endpoint into a
  // square-root domain failure. The upper bound still encloses every error.
  const toleranceSquared=unpack(intervalSquare({lower:tolerance,upper:tolerance}));
  if(error===null||toleranceSquared===null||error.upper>toleranceSquared.lower)return null;
  return {point:[middle[0],middle[1],middle[2]],minimum:[ranges[0].lower,ranges[1].lower,ranges[2].lower],
    maximum:[ranges[0].upper,ranges[1].upper,ranges[2].upper]};
}
