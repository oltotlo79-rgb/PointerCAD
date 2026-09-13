/** Both coordinate equations use the same original tapes for intervals and their U/V Jacobian. */
import {compileFunctionScalar} from './compileFunctionScalar.js';
import {coefficientExpressionMap} from './mathCoefficientExpression.js';
import {createScalarIntervalSampler} from './scalarMathIntervals.js';
import {createScalarDirectionalJet} from './scalarCurveCurvature.js';
import {intervalUnion,unionSubtract,type IntervalUnion} from './mathIntervalUnion.js';
import {exactCoordinatePolynomial,exactAdd,exactMultiply,EXACT_ONE,EXACT_ZERO,type CoordinatePolynomial} from './exactCoordinatePolynomial.js';
import {exactDouble,exactDoubleInterval} from './exactDoubleInterval.js';
import {substituteCoordinatePolynomial} from './substituteCoordinatePolynomial.js';
import {MathInputProblem,MATH_INPUT_LIMITS,type MathNode} from './mathInputContract.js';
import type {ExactRational} from './exactRational.js';
import type {SurfacePointWorkRequest} from './surfacePointWorkRequest.js';
import type {PreparedScalarMathContext} from './evaluatePreparedScalarMath.js';
import type {ParameterBox} from './bivariateIntervalNewton.js';
import type {BivariateRootEvaluator} from './isolateBivariateRoots.js';
import type {MathInterval} from './mathInterval.js';

function polynomial(input:SurfacePointWorkRequest,index:number,stop:()=>boolean):CoordinatePolynomial|null {
  let nodes=MATH_INPUT_LIMITS.nodes;
  function rename(node:MathNode,depth:number):MathNode|null {
    if(--nodes<0||depth>MATH_INPUT_LIMITS.depth||stop())return null;
    if(node.kind==='symbol'){
      const ref=node.reference;
      if(ref.role==='parameter'&&(ref.name==='U'||ref.name==='V'))return {kind:'symbol',reference:{role:'axis',name:ref.name==='U'?'X':'Y'}};
      return ref.role==='coefficient'?node:null;
    }
    if(node.kind==='number'||node.kind==='constant')return node;
    if(node.kind!=='operation')return null;
    const operands:MathNode[]=[];
    for(const child of node.operands){const next=rename(child,depth+1);if(next===null)return null;operands.push(next);}
    return {...node,operands};
  }
  const expression=rename(input.outputs[index].expression,0);
  return expression===null?null:exactCoordinatePolynomial(expression,coefficientExpressionMap(input.coefficients),stop);
}
function exactAt(polynomial:CoordinatePolynomial,point:readonly [number,number],stop:()=>boolean):ExactRational|null {
  const u=exactDouble(point[0]),v=exactDouble(point[1]);if(u===null||v===null)return null;
  let sum=EXACT_ZERO;
  for(const [key,coefficient] of polynomial){
    if(stop())return null;
    const powers=key.split(',').map(Number);if(powers[2]!==0)return null;
    let product:ExactRational|null=EXACT_ONE;
    for(const axis of [0,1])for(let power=0;power<powers[axis];power++){
      product=product===null?null:exactMultiply(product,axis===0?u:v);
    }
    const term=product===null?null:exactMultiply(coefficient,product),next=term===null?null:exactAdd(sum,term);
    if(next===null)return null;sum=next;
  }
  return sum;
}
export interface SurfacePointEvaluation extends BivariateRootEvaluator {
  readonly ranges:(box:ParameterBox)=>readonly [IntervalUnion,IntervalUnion,IntervalUnion];
}
export interface SurfaceCoordinateEvaluation {
  readonly ranges:SurfacePointEvaluation['ranges'];
  readonly polynomials:readonly (CoordinatePolynomial|null)[];
  readonly varyingSlots:readonly (readonly number[])[];
  readonly constantIn:(box:ParameterBox,index:0|1|2,slot:0|1)=>boolean;
  readonly equation:(box:ParameterBox,index:0|1|2,target:number)=>IntervalUnion;
  readonly partial:(box:ParameterBox,index:0|1|2,slot:0|1)=>MathInterval|null;
}
export function createSurfaceCoordinateEvaluation(input:SurfacePointWorkRequest,context:Omit<PreparedScalarMathContext,'angleUnit'>):SurfaceCoordinateEvaluation {
  const tapes=input.outputs.map(output=>compileFunctionScalar(output,['U','V'],input.coefficients,context));
  const samplers=tapes.map(createScalarIntervalSampler),stop=()=>context.shouldStop()!==undefined;
  const polynomials=input.outputs.map((_output,index)=>polynomial(input,index,stop));
  const jets=tapes.map(tape=>[createScalarDirectionalJet(tape,[1,0]),createScalarDirectionalJet(tape,[0,1])]);
  const varyingSlots=tapes.map(tape=>[...new Set(tape.instructions.flatMap(item=>item.kind==='input'?[item.slot]:[]))]);
  function collapsedConstant(box:ParameterBox,index:number,free:0|1):ExactRational|null {
    const polynomial=polynomials[index],fixed=free===0?1:0;
    if(polynomial===null||box[fixed].lower!==box[fixed].upper)return null;
    const value=exactDouble(box[fixed].lower);if(value===null)return null;
    const reduced=substituteCoordinatePolynomial(polynomial,free,free===0?[null,value,EXACT_ZERO]:[value,null,EXACT_ZERO],stop);
    return reduced===null||reduced.length>1?null:reduced[0]??EXACT_ZERO;
  }
  function coordinate(box:ParameterBox,index:number):IntervalUnion {
    const polynomial=polynomials[index];
    if(box.every(range=>range.lower===range.upper)&&polynomial!==null){
      const value=exactAt(polynomial,[box[0].lower,box[1].lower],stop),range=value===null?null:exactDoubleInterval(value);
      if(range!==null)return intervalUnion(range.lower,range.upper);
    }
    for(const free of [0,1] as const){
      const value=collapsedConstant(box,index,free),range=value===null?null:exactDoubleInterval(value);
      if(range!==null)return intervalUnion(range.lower,range.upper);
    }
    return samplers[index](box);
  }
  function equation(box:ParameterBox,index:0|1|2,target:number):IntervalUnion {
    const value=coordinate(box,index);
    if(value.continuous&&value.ranges.length===1&&value.ranges[0].lower===target&&value.ranges[0].upper===target)return intervalUnion(0);
    return unionSubtract(value,intervalUnion(target));
  }
  return {ranges:box=>[coordinate(box,0),coordinate(box,1),coordinate(box,2)],polynomials,varyingSlots,equation,
    partial:(box,index,slot)=>jets[index][slot](box).first,
    constantIn:(box,index,slot)=>{
      if(!varyingSlots[index].includes(slot)||collapsedConstant(box,index,slot)!==null)return true;
      // A certified zero directional derivative throughout the connected free
      // interval proves constancy too, including trigonometric cone/pole maps.
      // The jet refuses undefined/discontinuous intervals before returning a bound.
      const derivative=jets[index][slot](box).first;
      return derivative!==null&&derivative.lower===0&&derivative.upper===0;
    }};
}
export function createSurfacePointEvaluation(input:SurfacePointWorkRequest,context:Omit<PreparedScalarMathContext,'angleUnit'>):SurfacePointEvaluation {
  if(input.known.length!==2)throw new MathInputProblem('syntax','曲面の2座標の照合には異なる2軸の値が必要です。');
  const evaluation=createSurfaceCoordinateEvaluation(input,context);
  const indices=input.known.map(item=>['X','Y','Z'].indexOf(item.axis) as 0|1|2);
  return {ranges:evaluation.ranges,
    enclosure:box=>[evaluation.equation(box,indices[0],input.known[0].value),evaluation.equation(box,indices[1],input.known[1].value)],
    jacobian:box=>{
      const a=evaluation.partial(box,indices[0],0),b=evaluation.partial(box,indices[0],1);
      const c=evaluation.partial(box,indices[1],0),d=evaluation.partial(box,indices[1],1);
      return a===null||b===null||c===null||d===null?null:[[a,b],[c,d]];
    }};
}
