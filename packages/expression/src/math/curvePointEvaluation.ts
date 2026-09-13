/** Compile the original outputs once, then prove coordinate constraints in the independent variable. */
import {compileFunctionScalar} from './compileFunctionScalar.js';
import {createScalarIntervalSampler} from './scalarMathIntervals.js';
import {createScalarDirectionalJet} from './scalarCurveCurvature.js';
import {intervalUnion,unionSubtract,type IntervalUnion} from './mathIntervalUnion.js';
import {isolateScalarRoots,type ScalarRootOptions,type ScalarRootResult} from './isolateScalarRoots.js';
import {isolateExactPolynomialRoots} from './isolateExactPolynomialRoots.js';
import {createExactPolynomialArithmetic,type ExactScalarPolynomial} from './exactScalarPolynomial.js';
import {exactDouble,exactDoubleInterval} from './exactDoubleInterval.js';
import {MathInputProblem} from './mathInputContract.js';
import {curvePointPolynomial,commonCurvePointPolynomial} from './curvePointPolynomial.js';
import type {PreparedScalarMathContext} from './evaluatePreparedScalarMath.js';
import type {CurvePointWorkRequest} from './curvePointWorkRequest.js';
import type {MathInterval} from './mathInterval.js';

const AXES=['X','Y','Z'] as const;
export interface CurvePointEvaluation {
  readonly allKnownProven:boolean;
  readonly primaryAxis:typeof AXES[number];
  readonly ranges:(interval:MathInterval)=>readonly IntervalUnion[];
  readonly knownAt:(axis:typeof AXES[number],parameter:number)=>boolean|null;
  readonly isolate:(interval:MathInterval,tolerance:number)=>ScalarRootResult;
}
export function createCurvePointEvaluation(input:CurvePointWorkRequest,context:Omit<PreparedScalarMathContext,'angleUnit'>):CurvePointEvaluation {
  const tapes=input.outputs.map(output=>compileFunctionScalar(output,[input.independent],input.coefficients,context));
  const ranges=tapes.map(createScalarIntervalSampler),jets=tapes.map(tape=>createScalarDirectionalJet(tape,[1])),stop=()=>context.shouldStop()!==undefined;
  const outputPolynomials=([0,1,2] as const).map(index=>curvePointPolynomial(input,index,0,stop));
  const constraints=input.known.map(item=>{
    const index=AXES.indexOf(item.axis) as 0|1|2;
    return {...item,index,polynomial:curvePointPolynomial(input,index,item.value,stop)};
  });
  const exact:ExactScalarPolynomial[]=[];
  for(const item of constraints) if(item.polynomial!==null) exact.push(item.polynomial);
  const allKnownProven=exact.length===constraints.length,common=allKnownProven?commonCurvePointPolynomial(exact,stop):null;
  const primary=constraints.find(item=>item.polynomial===null || item.polynomial.length>0)??constraints[0];
  const polynomial=allKnownProven?common:primary.polynomial;
  let remaining=200_000;
  const exhausted=():never=>{throw new MathInputProblem('budget','曲線の座標照合の計算上限に達しました。');};
  const arithmetic=createExactPolynomialArithmetic(()=>{if(--remaining<0 || stop()) exhausted();},exhausted);
  function knownAt(axis:typeof AXES[number],parameter:number):boolean|null {
    const item=constraints.find(item=>item.axis===axis),value=exactDouble(parameter);
    if(!item || item.polynomial===null || value===null) return null;
    return arithmetic.evaluate(item.polynomial,value).numerator===0n;
  }
  return {allKnownProven,primaryAxis:primary.axis,ranges:interval=>ranges.map((sample,index)=>{
    const parameter=interval.lower===interval.upper?exactDouble(interval.lower):null,polynomial=outputPolynomials[index];
    if(parameter!==null && polynomial!==null) {
      const range=exactDoubleInterval(arithmetic.evaluate(polynomial,parameter));
      if(range!==null) return intervalUnion(range.lower,range.upper);
    }
    return sample([interval]);
  }),knownAt,
    isolate:(interval,tolerance)=>{
      if(remaining<=0) return {status:'budget',evaluations:0};
      const options:ScalarRootOptions={...interval,tolerance,maximumDepth:64,maximumEvaluations:remaining,
        maximumRegions:1024,shouldStop:context.shouldStop};
      const result=polynomial!==null?isolateExactPolynomialRoots(polynomial,options):isolateScalarRoots({
        enclosure:(lower,upper)=>{
          const value=ranges[primary.index]([{lower,upper}]);
          // Subtracting an exactly certified equal coordinate is exactly zero, including constant constraints.
          if(value.continuous && value.ranges.length===1 && value.ranges[0].lower===primary.value && value.ranges[0].upper===primary.value) return intervalUnion(0);
          return unionSubtract(value,intervalUnion(primary.value));
        },
        derivative:(lower,upper)=>jets[primary.index]([{lower,upper}]).first},options);
      remaining-=result.evaluations;return result;
    }};
}
