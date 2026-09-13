/** One contraction valid for every intermediate edit certifies a common surface branch. */
import {coordinatePolynomialInterval} from './coordinatePolynomialInterval.js';
import {substituteCoordinatePolynomial} from './substituteCoordinatePolynomial.js';
import {exactDouble} from './exactDoubleInterval.js';
import {bivariateIntervalNewton,parameterBoxContains,type ParameterBox,type IntervalJacobian,type BivariateNewtonResult} from './bivariateIntervalNewton.js';
import type {CoordinatePolynomial} from './exactCoordinatePolynomial.js';
import type {MathInterval} from './mathInterval.js';

export function proveBivariatePointPath(polynomials:readonly [CoordinatePolynomial,CoordinatePolynomial],
  input:{readonly before:ParameterBox;readonly after:ParameterBox;readonly domain:ParameterBox;readonly tolerance:number;
    readonly contains?:(box:ParameterBox,progress:MathInterval)=>boolean},
  shouldStop:()=> 'cancelled'|'deadline'|undefined):boolean|'cancelled'|'deadline' {
  const wholeProgress:MathInterval={lower:0,upper:1},zero:MathInterval={lower:0,upper:0};
  function prove(box:ParameterBox,progress:MathInterval,exactFixed=false):BivariateNewtonResult|null {
    const middleOf=(index:0|1)=>box[index].lower+(box[index].upper-box[index].lower)/2;
    const center:readonly [number,number]=[middleOf(0),middleOf(1)];
    const middle:ParameterBox=[{lower:center[0],upper:center[0]},{lower:center[1],upper:center[1]}];
    const at=(index:0|1)=>exactFixed?zero:coordinatePolynomialInterval(polynomials[index],[...middle,progress]);
    const derivative=(index:0|1,axis:0|1)=>coordinatePolynomialInterval(polynomials[index],[...box,progress],axis);
    const a=derivative(0,0),b=derivative(0,1),c=derivative(1,0),d=derivative(1,1),f=at(0),g=at(1);
    if(a===null||b===null||c===null||d===null||f===null||g===null)return null;
    const jacobian:IntervalJacobian=[[a,b],[c,d]];
    return bivariateIntervalNewton(box,center,[f,g],jacobian);
  }
  const fixed=input.before.every((range,index)=>range.lower===range.upper&&range.lower===input.after[index].lower
    &&range.upper===input.after[index].upper);
  if(fixed&&parameterBoxContains(input.domain,input.before)){
    const along=polynomials.map(polynomial=>substituteCoordinatePolynomial(polynomial,2,
      [exactDouble(input.before[0].lower),exactDouble(input.before[1].lower),null],()=>shouldStop()!==undefined));
    if(along.every(value=>value!==null&&value.every(coefficient=>coefficient.numerator===0n))
      &&(input.contains?.(input.before,wholeProgress)??true)&&prove(input.before,wholeProgress,true)?.exists)return true;
  }
  const lower=input.before.map((range,index)=>Math.min(range.lower,input.after[index].lower));
  const upper=input.before.map((range,index)=>Math.max(range.upper,input.after[index].upper));
  // The linear prediction only proposes rectangles. A proof is needed throughout
  // each complete progress interval, plus uniqueness across each shared boundary.
  for(const slices of [1,4,16,64])for(const factor of [1/16,1/8,1/4,1/2,1,2,4]){
    let previous:ParameterBox|null=null,complete=true;
    for(let index=0;index<slices;index++){
      const stopped=shouldStop();if(stopped!==undefined)return stopped;
      const progress={lower:index/slices,upper:(index+1)/slices};
      const ranges=lower.map((value,axis)=>{
        const at=(t:number,endpoint:'lower'|'upper')=>input.before[axis][endpoint]
          +(input.after[axis][endpoint]-input.before[axis][endpoint])*t;
        const low=Math.min(at(progress.lower,'lower'),at(progress.upper,'lower'));
        const high=Math.max(at(progress.lower,'upper'),at(progress.upper,'upper'));
        const padding=Math.max(upper[axis]-value,input.tolerance)*factor;
        return {lower:Math.max(input.domain[axis].lower,low-padding),upper:Math.min(input.domain[axis].upper,high+padding)};
      });
      const box:ParameterBox=[ranges[0],ranges[1]];
      if(box.some(range=>!Number.isFinite(range.lower)||!Number.isFinite(range.upper)||range.lower>=range.upper)
        ||index===0&&!parameterBoxContains(box,input.before)||index===slices-1&&!parameterBoxContains(box,input.after)
        ||!(input.contains?.(box,progress)??true)||!prove(box,progress)?.exists){complete=false;break;}
      if(previous!==null){
        const preceding=previous;
        const joined=(axis:0|1)=>({lower:Math.min(preceding[axis].lower,box[axis].lower),upper:Math.max(preceding[axis].upper,box[axis].upper)});
        const union:ParameterBox=[joined(0),joined(1)];
        if(!prove(union,{lower:progress.lower,upper:progress.lower})?.unique){complete=false;break;}
      }
      previous=box;
    }
    if(complete)return true;
  }
  return false;
}
