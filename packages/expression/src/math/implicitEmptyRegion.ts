/** Prove absence inside a same-sign cell; never equate equal corner signs with no interior component. */
import type { FunctionPoint } from './functionGeometryBounds.js';
import type { FunctionImplicitEvaluator } from './functionImplicitEvaluation.js';
import { intervalAdd, intervalMultiply, intervalSubtract, type MathInterval } from './mathInterval.js';
import { implicitPoint } from './implicitPoint.js';

export function implicitMonotoneExtrema(lower:FunctionPoint,upper:FunctionPoint,partials:readonly (MathInterval|null)[]) {
  const direction=(axis:number):number=>{
    const value=partials[axis];return value===null || value===undefined ? 0 : value.lower>=0 ? 1 : value.upper<=0 ? -1 : 0;
  };
  return {minimumLow:implicitPoint(axis=>direction(axis)<0?upper[axis]:lower[axis]),
    minimumHigh:implicitPoint(axis=>direction(axis)>0?lower[axis]:upper[axis]),
    maximumLow:implicitPoint(axis=>direction(axis)>0?upper[axis]:lower[axis]),
    maximumHigh:implicitPoint(axis=>direction(axis)<0?lower[axis]:upper[axis])};
}
export function proveImplicitRegionEmpty(evaluator:FunctionImplicitEvaluator,lower:FunctionPoint,upper:FunctionPoint,
  takeCell:()=>boolean,maximumDepth=8):boolean {
  const pending=[{lower,upper,depth:0}];
  while(pending.length>0){
    if(!takeCell()) return false;
    const node=pending.pop();if(node===undefined) break;
    const range=evaluator.enclosure(node.lower,node.upper);
    if(range.ranges.every(value=>value.lower>0 || value.upper<0)) continue;
    if(!range.continuous || range.ranges.length!==1) return false;
    const partials=evaluator.partials(node.lower,node.upper);
    const centre=implicitPoint(axis=>node.lower[axis]+(node.upper[axis]-node.lower[axis])/2);
    const atCentre=evaluator.enclosure(centre,centre);
    let centred:MathInterval|null=atCentre.continuous && atCentre.ranges.length===1 ? atCentre.ranges[0] : null;
    for(let axis=0;axis<3 && centred!==null;axis++){
      const partial=partials[axis];
      if(partial===null || partial===undefined){centred=null;break;}
      const offset=intervalSubtract({lower:node.lower[axis],upper:node.upper[axis]},{lower:centre[axis],upper:centre[axis]});
      const delta=offset.status==='range'?intervalMultiply(partial,offset.interval):null;
      const next=delta?.status==='range'?intervalAdd(centred,delta.interval):null;
      centred=next?.status==='range'?next.interval:null;
    }
    if(centred!==null && (centred.lower>0 || centred.upper<0)) continue;
    const bounds=implicitMonotoneExtrema(node.lower,node.upper,partials);
    const min=evaluator.enclosure(bounds.minimumLow,bounds.minimumHigh),max=evaluator.enclosure(bounds.maximumLow,bounds.maximumHigh);
    if(min.continuous && min.ranges.length>0 && min.ranges.every(value=>value.lower>0)
      || max.continuous && max.ranges.length>0 && max.ranges.every(value=>value.upper<0)) continue;
    if(node.depth>=maximumDepth) return false;
    const widths=node.lower.map((value,axis)=>node.upper[axis]-value);
    const axis=widths.indexOf(Math.max(...widths)),middle=node.lower[axis]+widths[axis]/2;
    if(middle===node.lower[axis] || middle===node.upper[axis]) return false;
    pending.push({lower:node.lower,upper:implicitPoint(index=>index===axis?middle:node.upper[index]),depth:node.depth+1},
      {lower:implicitPoint(index=>index===axis?middle:node.lower[index]),upper:node.upper,depth:node.depth+1});
  }
  return true;
}
