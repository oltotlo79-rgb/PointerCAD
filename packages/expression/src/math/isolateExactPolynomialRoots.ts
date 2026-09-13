/** Sturm counts retain all distinct polynomial roots, including tangencies and finite-domain endpoints. */
import {createExactPolynomialArithmetic,type ExactScalarPolynomial} from './exactScalarPolynomial.js';
import {exactDouble} from './exactDoubleInterval.js';
import type {ExactRational} from './exactRational.js';
import {validateScalarRootOptions,type ScalarRootOptions,type ScalarRootResult,type IsolatedScalarRoot} from './isolateScalarRoots.js';
import type {MathInterval} from './mathInterval.js';

class Stop extends Error {
  constructor(readonly status:'cancelled'|'deadline'|'budget'){super(status);}
}
interface Pending extends MathInterval {readonly count:number;readonly depth:number}

export function isolateExactPolynomialRoots(polynomial:ExactScalarPolynomial,options:ScalarRootOptions):ScalarRootResult {
  validateScalarRootOptions(options);let evaluations=0;
  const exhausted=():never=>{throw new Stop('budget');};
  function check():void {
    const stopped=options.shouldStop?.();if(stopped) throw new Stop(stopped);
    if(++evaluations>options.maximumEvaluations) exhausted();
  }
  const arithmetic=createExactPolynomialArithmetic(check,exhausted);
  const exact=(value:number):ExactRational=>{const result=exactDouble(value);return result===null?exhausted():result;};
  try {
    check();const canonical=arithmetic.canonical(polynomial);
    if(canonical.length===0) return {status:'unresolved',roots:[],unresolved:[{lower:options.lower,upper:options.upper,reason:'continuum'}],evaluations};
    if(canonical.length===1) return {status:'complete',roots:[],unresolved:[],evaluations};
    const squareFree=arithmetic.squareFree(canonical),sequence=arithmetic.sturm(squareFree);
    function signAtSide(p:ExactScalarPolynomial,at:ExactRational,side:-1|1):number {
      let derivative=p,order=0;
      while(derivative.length>0){
        const value=arithmetic.evaluate(derivative,at).numerator;
        if(value!==0n) return (value<0n?-1:1)*(side===-1 && order%2===1?-1:1);
        derivative=arithmetic.derivative(derivative);order++;
      }
      return 0;
    }
    function variations(value:number,side:-1|1):number {
      const at=exact(value);let previous=0,count=0;
      for(const part of sequence){const sign=signAtSide(part,at,side);if(sign===0) continue;if(previous!==0 && previous!==sign) count++;previous=sign;}
      return count;
    }
    const countOpen=(lower:number,upper:number)=>variations(lower,1)-variations(upper,-1);
    const isRoot=(value:number)=>arithmetic.evaluate(squareFree,exact(value)).numerator===0n;
    const roots:IsolatedScalarRoot[]=[],unresolved:MathInterval[]=[];
    function add(lower:number,upper:number):void {
      if(roots.length+unresolved.length>=options.maximumRegions) exhausted();roots.push({lower,upper,unique:true});
    }
    if(isRoot(options.lower)) add(options.lower,options.lower);
    if(isRoot(options.upper)) add(options.upper,options.upper);
    const pending:Pending[]=[{lower:options.lower,upper:options.upper,count:countOpen(options.lower,options.upper),depth:0}];
    while(pending.length>0){
      check();const node=pending.pop();if(!node || node.count===0) continue;
      const {lower,upper,count,depth}=node;
      if(count<0 || count>squareFree.length-1) return exhausted();
      if(count===1 && upper-lower<=options.tolerance){
        // Give adjacent candidates disjoint closed brackets, even when their separation is smaller than tolerance.
        // An inset is accepted only after a new exact root count; it cannot trim away a boundary/tangent root.
        const margin=(upper-lower)/16,insideLower=lower+margin,insideUpper=upper-margin;
        if(insideLower>lower && insideUpper<upper && !isRoot(insideLower) && !isRoot(insideUpper)
          && countOpen(insideLower,insideUpper)===1){add(insideLower,insideUpper);continue;}
      }
      const middle=lower+(upper-lower)/2;
      if(depth>=options.maximumDepth || middle===lower || middle===upper){
        if(roots.length+unresolved.length>=options.maximumRegions) exhausted();unresolved.push({lower,upper});continue;
      }
      const middleIsRoot=isRoot(middle),left=countOpen(lower,middle),right=countOpen(middle,upper);
      if(left+right+(middleIsRoot?1:0)!==count) return exhausted();
      if(middleIsRoot) add(middle,middle);
      pending.push({lower:middle,upper,count:right,depth:depth+1},{lower,upper:middle,count:left,depth:depth+1});
    }
    roots.sort((a,b)=>a.lower-b.lower);
    return {status:unresolved.length===0?'complete':'unresolved',roots,
      unresolved:unresolved.map(region=>({...region,reason:'resolution'})),evaluations};
  } catch(error){if(error instanceof Stop) return {status:error.status,evaluations};throw error;}
}
