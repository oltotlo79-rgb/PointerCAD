/** A two-variable fixed-point enclosure. Samples choose the preconditioner, never prove a root. */
import {intervalAdd,intervalSubtract,intervalMultiply,
  type MathInterval,type IntervalValue} from './mathInterval.js';

export type ParameterBox=readonly [MathInterval,MathInterval];
export type IntervalJacobian=readonly [readonly [MathInterval,MathInterval],readonly [MathInterval,MathInterval]];
export interface BivariateNewtonResult {
  /** Every zero in the supplied box belongs to this intersection; null proves absence. */
  readonly intersection:ParameterBox|null;
  /** The fixed-point map is a contraction on the original box, so it has at most one zero there. */
  readonly unique:boolean;
  /** A contraction mapping the closed box into itself proves existence as well. */
  readonly exists:boolean;
}

const ONE:MathInterval={lower:1,upper:1},ZERO:MathInterval={lower:0,upper:0};
const exact=(value:number):MathInterval=>({lower:value,upper:value});
const isZero=(value:MathInterval)=>value.lower===0&&value.upper===0;
function unpack(value:IntervalValue):MathInterval|null{return value.status==='range'?value.interval:null;}
function add(a:MathInterval,b:MathInterval):MathInterval|null {
  return isZero(a)?b:isZero(b)?a:unpack(intervalAdd(a,b));
}
function subtract(a:MathInterval,b:MathInterval):MathInterval|null {
  return isZero(b)?a:a.lower===a.upper&&b.lower===b.upper&&a.lower===b.lower?ZERO:unpack(intervalSubtract(a,b));
}
function multiply(a:MathInterval,b:MathInterval):MathInterval|null {
  return isZero(a)||isZero(b)?ZERO:unpack(intervalMultiply(a,b));
}
function dot(a:readonly [MathInterval,MathInterval],b:readonly [MathInterval,MathInterval]):MathInterval|null {
  const first=multiply(a[0],b[0]),second=multiply(a[1],b[1]);
  return first===null||second===null?null:add(first,second);
}
const finite=(value:MathInterval)=>Number.isFinite(value.lower)&&Number.isFinite(value.upper)&&value.lower<=value.upper;
export const parameterBoxContains=(outer:ParameterBox,inner:ParameterBox):boolean=>
  outer.every((range,index)=>range.lower<=inner[index].lower&&range.upper>=inner[index].upper);
export function intersectParameterBoxes(a:ParameterBox,b:ParameterBox):ParameterBox|null {
  const first={lower:Math.max(a[0].lower,b[0].lower),upper:Math.min(a[0].upper,b[0].upper)};
  const second={lower:Math.max(a[1].lower,b[1].lower),upper:Math.min(a[1].upper,b[1].upper)};
  return first.lower>first.upper||second.lower>second.upper?null:[first,second];
}

export function bivariateIntervalNewton(box:ParameterBox,center:readonly [number,number],
  atCenter:readonly [MathInterval,MathInterval],jacobian:IntervalJacobian):BivariateNewtonResult|null {
  if(!box.every(finite)||!atCenter.every(finite)||!jacobian.every(row=>row.every(finite))
    ||center.some((value,index)=>!Number.isFinite(value)||value<box[index].lower||value>box[index].upper))return null;
  const middle=jacobian.map(row=>row.map(value=>value.lower+(value.upper-value.lower)/2));
  const determinant=middle[0][0]*middle[1][1]-middle[0][1]*middle[1][0];
  if(!Number.isFinite(determinant)||determinant===0)return null;
  const inverse:IntervalJacobian=[
    [exact(middle[1][1]/determinant),exact(-middle[0][1]/determinant)],
    [exact(-middle[1][0]/determinant),exact(middle[0][0]/determinant)],
  ];
  if(!inverse.every(row=>row.every(finite)))return null;
  // The rounded inverse need not be exact, but must be nonsingular as real binary coefficients.
  const diagonal=multiply(inverse[0][0],inverse[1][1]),offDiagonal=multiply(inverse[0][1],inverse[1][0]);
  const inverseDet=diagonal===null||offDiagonal===null?null:subtract(diagonal,offDiagonal);
  if(inverseDet===null||inverseDet.lower<=0&&inverseDet.upper>=0)return null;
  const offsets=box.map((value,index)=>subtract(value,exact(center[index])));
  if(offsets[0]===null||offsets[1]===null)return null;
  const columns=[
    [jacobian[0][0],jacobian[1][0]] as const,
    [jacobian[0][1],jacobian[1][1]] as const,
  ];
  const images:MathInterval[]=[],rowBounds:number[]=[];
  for(const index of [0,1] as const){
    const first=dot(inverse[index],columns[0]),second=dot(inverse[index],columns[1]);
    const e0=first===null?null:subtract(index===0?ONE:ZERO,first);
    const e1=second===null?null:subtract(index===1?ONE:ZERO,second);
    if(e0===null||e1===null)return null;
    const rowBound=add(exact(Math.max(Math.abs(e0.lower),Math.abs(e0.upper))),
      exact(Math.max(Math.abs(e1.lower),Math.abs(e1.upper))));
    const correction=dot(inverse[index],atCenter);
    const imageCenter=correction===null?null:subtract(exact(center[index]),correction);
    const displacement=dot([e0,e1],[offsets[0],offsets[1]]);
    const image=imageCenter===null||displacement===null?null:add(imageCenter,displacement);
    if(image===null||rowBound===null)return null;
    images.push(image);rowBounds.push(rowBound.upper);
  }
  const image:ParameterBox=[images[0],images[1]],unique=rowBounds.every(value=>value<1);
  return {intersection:intersectParameterBoxes(box,image),unique,exists:unique&&parameterBoxContains(box,image)};
}
