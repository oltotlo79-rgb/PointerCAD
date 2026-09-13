import type {ExactRational} from './exactRational.js';
import {exactDoubleInterval} from './exactDoubleInterval.js';
import {intervalSqrt,nextFloat} from './mathInterval.js';
import type {ExactImplicitPrimitive} from './recognizeImplicitPrimitive.js';
import type {FunctionPoint} from './functionGeometryBounds.js';

export type ImplicitPrimitive={readonly kind:'sphere';readonly center:FunctionPoint;readonly radius:number}
  |{readonly kind:'torus';readonly axis:0|1|2;readonly majorRadius:number;readonly minorRadius:number};
export interface NumericImplicitPrimitive {readonly primitive:ImplicitPrimitive;readonly maximumParameterError:number}
function number(value:ExactRational,squareRoot=false):{value:number;error:number}|null {
  const enclosed=exactDoubleInterval(value);if(enclosed===null) return null;
  const root=squareRoot?intervalSqrt(enclosed):{status:'range' as const,interval:enclosed};if(root.status!=='range') return null;
  const {lower,upper}=root.interval,result=lower+(upper-lower)/2;if(!Number.isFinite(result)) return null;
  const distance=Math.max(result-lower,upper-result);return {value:result,error:distance===0?0:nextFloat(distance,1)};
}
export function implicitPrimitiveNumbers(source:ExactImplicitPrimitive,tolerance:number):NumericImplicitPrimitive|null {
  if(!Number.isFinite(tolerance) || tolerance<=0) return null;
  if(source.kind==='sphere'){
    const x=number(source.center[0]),y=number(source.center[1]),z=number(source.center[2]),radius=number(source.radiusSquared,true);
    if(x===null || y===null || z===null || radius===null || radius.value<=0) return null;
    // L1 is a conservative translation bound; reserve the other 3/4 for native topology tolerances.
    const error=nextFloat(nextFloat(nextFloat(x.error+y.error,1)+z.error,1)+radius.error,1);
    if(!Number.isFinite(error) || error>tolerance/4) return null;
    return {primitive:{kind:'sphere',center:[x.value,y.value,z.value],radius:radius.value},maximumParameterError:error};
  }
  const major=number(source.majorSquared,true),minor=number(source.minorSquared,true);
  if(major===null || minor===null || minor.value<=0 || major.value<=minor.value) return null;
  const error=nextFloat(major.error+minor.error,1);if(!Number.isFinite(error) || error>tolerance/4) return null;
  return {primitive:{kind:'torus',axis:source.axis,majorRadius:major.value,minorRadius:minor.value},maximumParameterError:error};
}
