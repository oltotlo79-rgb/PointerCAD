/** One compiled F supplies values, interval derivatives and domain enclosures on two or three coordinate axes. */
import { compileFunctionScalar } from './compileFunctionScalar.js';
import { createScalarSampler } from './scalarMathTape.js';
import { createScalarIntervalSampler } from './scalarMathIntervals.js';
import { createScalarFirstDerivatives } from './scalarCurveCurvature.js';
import { createScalarDifferential,type ScalarDifferential } from './scalarDifferential.js';
import type { PreparedScalarMathContext } from './evaluatePreparedScalarMath.js';
import type { FunctionPoint } from './functionGeometryBounds.js';
import { MathInputProblem,type MathAxis } from './mathInputContract.js';
import type { MathInterval } from './mathInterval.js';
import type { IntervalUnion } from './mathIntervalUnion.js';

export interface FunctionImplicitEvaluator {
  readonly point:(point:FunctionPoint)=>number;
  readonly enclosure:(minimum:FunctionPoint,maximum:FunctionPoint)=>IntervalUnion;
  readonly gradient:(point:FunctionPoint)=>ScalarDifferential;
  readonly partials:(minimum:FunctionPoint,maximum:FunctionPoint)=>readonly (MathInterval|null)[];
  readonly along:(direction:FunctionPoint)=>(minimum:FunctionPoint,maximum:FunctionPoint)=>MathInterval|null;
}
const AXES=['X','Y','Z'] as const;
export function createFunctionImplicitEvaluator(definition:unknown,coefficients:unknown,
  context:Omit<PreparedScalarMathContext,'angleUnit'>,inputs:readonly MathAxis[]=AXES):FunctionImplicitEvaluator {
  const fixedInputs=[...inputs];
  if(fixedInputs.length<2 || fixedInputs.length>3 || new Set(fixedInputs).size!==fixedInputs.length || fixedInputs.some(axis=>!AXES.includes(axis))) {
    throw new MathInputProblem('syntax','陰関数の入力には2つか3つの座標軸を指定してください。');
  }
  const slots=fixedInputs.map(axis=>AXES.indexOf(axis));
  const tape=context.backend.withinDeadline(()=>compileFunctionScalar(definition,fixedInputs,coefficients,context));
  const scalar=createScalarSampler(tape),interval=createScalarIntervalSampler(tape),differential=createScalarDifferential(tape);
  const box=(minimum:FunctionPoint,maximum:FunctionPoint)=>slots.map(axis=>({lower:minimum[axis],upper:maximum[axis]}));
  const partials=createScalarFirstDerivatives(tape,AXES.map(axis=>fixedInputs.map(input=>input===axis?1:0)));
  return {
    point:point=>scalar(slots.map(axis=>point[axis])),
    enclosure:(minimum,maximum)=>interval(box(minimum,maximum)),
    gradient:point=>{
      const result=differential(slots.map(axis=>point[axis])),gradient=result.gradient;
      return gradient===null?result:{...result,gradient:AXES.map(axis=>{
        const slot=fixedInputs.indexOf(axis);return slot<0?0:gradient[slot];
      })};
    },
    partials:(minimum,maximum)=>partials(box(minimum,maximum)),
    along:direction=>{
      const evaluate=createScalarFirstDerivatives(tape,[slots.map(axis=>direction[axis])]);
      return (minimum,maximum)=>evaluate(box(minimum,maximum))[0] ?? null;
    },
  };
}
