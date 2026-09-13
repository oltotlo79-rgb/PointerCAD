/** Even a fixed U/V point can leave the displayed XYZ box while coefficients change. */
import {surfacePointContinuationFormula} from './surfacePointContinuationFormula.js';
import {coordinatePolynomialInterval} from './coordinatePolynomialInterval.js';
import type {SurfacePointWorkRequest} from './surfacePointWorkRequest.js';
import type {ParameterBox} from './bivariateIntervalNewton.js';
import type {MathInterval} from './mathInterval.js';

/** Every certified parameter tube must also stay inside the displayed XYZ volume. */
export function createSurfacePointPathBounds(before:SurfacePointWorkRequest,after:SurfacePointWorkRequest,stop:()=>boolean):
  (box:ParameterBox,progress:MathInterval)=>boolean {
  const outputs=(['X','Y','Z']as const).map(axis=>{
    // Subtract zero to enclose the full output coordinate over edit progress 0..1.
    const known=[{axis,value:0}];return surfacePointContinuationFormula({...before,known},{...after,known},axis,stop);
  });
  return (box,progress)=>!stop()&&!box.some((range,index)=>range.lower<Math.max(before.lower[index],after.lower[index])
    ||range.upper>Math.min(before.upper[index],after.upper[index]))&&outputs.every((polynomial,index)=>{
      if(polynomial===null)return false;
      const range=coordinatePolynomialInterval(polynomial,[...box,progress]);
      return range!==null&&range.lower>=Math.max(before.minimum[index],after.minimum[index])
        &&range.upper<=Math.min(before.maximum[index],after.maximum[index]);
    });
}
