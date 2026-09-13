/** Refine interval dependency in derivatives without weakening the nonzero-gradient condition. */
import type { FunctionPoint } from './functionGeometryBounds.js';
import type { MathInterval } from './mathInterval.js';
import type { FunctionImplicitEvaluator } from './functionImplicitEvaluation.js';
import { implicitPoint } from './implicitPoint.js';

export function hasRegularImplicitAxis(partials:readonly (MathInterval|null)[]):boolean {
  return partials.some(value=>value!==null && (value.lower>0 || value.upper<0));
}
export function refinedImplicitPartials(evaluator:FunctionImplicitEvaluator,lower:FunctionPoint,upper:FunctionPoint,
  takeCell:()=>boolean,maximumDepth=6):readonly (MathInterval|null)[] {
  const coarse=evaluator.partials(lower,upper);if(hasRegularImplicitAxis(coarse)) return coarse;
  const centre=implicitPoint(axis=>lower[axis]+(upper[axis]-lower[axis])/2),gradient=evaluator.gradient(centre).gradient;
  const magnitudes=gradient?.map(Math.abs)??[0,0,0],targetAxis=magnitudes.indexOf(Math.max(...magnitudes));
  const targetSign=Math.sign(gradient?.[targetAxis]??0);
  const pending=[{lower,upper,depth:0}],ranges:(MathInterval|null)[]=[{lower:Infinity,upper:-Infinity},{lower:Infinity,upper:-Infinity},{lower:Infinity,upper:-Infinity}];
  while(pending.length>0){
    if(!takeCell()) return [null,null,null];
    const node=pending.pop();if(node===undefined) break;
    const values=evaluator.partials(node.lower,node.upper);
    const target=values[targetAxis],proved=target!==null && target!==undefined && (targetSign>0?target.lower>0:targetSign<0?target.upper<0:false);
    // Every leaf must prove the SAME direction; different axes on different leaves do not certify a global graph.
    if(node.depth<maximumDepth && !proved){
      const widths=node.lower.map((value,axis)=>node.upper[axis]-value),axis=widths.indexOf(Math.max(...widths));
      const middle=node.lower[axis]+widths[axis]/2;
      if(middle!==node.lower[axis] && middle!==node.upper[axis]){
        pending.push({lower:node.lower,upper:implicitPoint(index=>index===axis?middle:node.upper[index]),depth:node.depth+1},
          {lower:implicitPoint(index=>index===axis?middle:node.lower[index]),upper:node.upper,depth:node.depth+1});continue;
      }
    }
    for(let axis=0;axis<3;axis++){
      const previous=ranges[axis],value=values[axis];
      ranges[axis]=previous===null || value===null || value===undefined ? null : {lower:Math.min(previous.lower,value.lower),upper:Math.max(previous.upper,value.upper)};
    }
  }
  return ranges;
}
