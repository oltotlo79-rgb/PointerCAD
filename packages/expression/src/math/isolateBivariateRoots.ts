/** Finite U/V search. Every excluded rectangle requires interval evidence; unfinished boxes stay visible. */
import {MathInputProblem} from './mathInputContract.js';
import type {IntervalUnion} from './mathIntervalUnion.js';
import {bivariateIntervalNewton,intersectParameterBoxes,parameterBoxContains,
  type ParameterBox,type IntervalJacobian} from './bivariateIntervalNewton.js';

export interface BivariateRootEvaluator {
  readonly enclosure:(box:ParameterBox)=>readonly [IntervalUnion,IntervalUnion];
  readonly jacobian:(box:ParameterBox)=>IntervalJacobian|null;
}
export interface BivariateRootOptions {
  readonly box:ParameterBox;readonly tolerance:number;
  readonly maximumEvaluations:number;readonly maximumRegions:number;readonly maximumDepth:number;
  readonly shouldStop?:()=> 'cancelled'|'deadline'|undefined;
}
export interface IsolatedBivariateRoot {
  readonly box:ParameterBox;readonly certificate:ParameterBox;readonly unique:true;
}
export interface UnresolvedBivariateRegion {
  readonly box:ParameterBox;readonly reason:'domain'|'singular'|'resolution'|'continuum';
}
export type BivariateRootResult={readonly status:'complete'|'unresolved';readonly roots:readonly IsolatedBivariateRoot[];
  readonly unresolved:readonly UnresolvedBivariateRegion[];readonly evaluations:number}
  |{readonly status:'cancelled'|'deadline'|'budget';readonly evaluations:number};
interface Pending {readonly box:ParameterBox;readonly depth:number;readonly certificate?:ParameterBox}
class Stop extends Error {constructor(readonly status:'cancelled'|'deadline'|'budget'){super(status);}}
const width=(box:ParameterBox)=>Math.max(...box.map(value=>value.upper-value.lower));
const regular=(value:IntervalUnion)=>value.continuous&&value.ranges.length===1;
const exactZero=(value:IntervalUnion)=>regular(value)&&value.ranges[0].lower===0&&value.ranges[0].upper===0;
const excludesZero=(value:IntervalUnion)=>value.ranges.length===0
  ||value.ranges.every(range=>range.lower>0||range.upper<0);
function pointBox(point:readonly [number,number]):ParameterBox {
  return [{lower:point[0],upper:point[0]},{lower:point[1],upper:point[1]}];
}
function validate(options:BivariateRootOptions):void {
  if(options.box.length!==2||options.box.some(range=>!Number.isFinite(range.lower)||!Number.isFinite(range.upper)
    ||range.lower>=range.upper||!Number.isFinite(range.upper-range.lower))
    ||!Number.isFinite(options.tolerance)||options.tolerance<=0)throw new MathInputProblem('domain','U・Vの有限な範囲と正の精度を指定してください。');
  for(const [value,limit] of [[options.maximumEvaluations,200_000],[options.maximumRegions,4096],[options.maximumDepth,64]]){
    if(!Number.isSafeInteger(value)||value<1||value>limit)throw new MathInputProblem('budget','曲面の解探索の上限が不正です。');
  }
}

export function isolateBivariateRoots(evaluator:BivariateRootEvaluator,options:BivariateRootOptions):BivariateRootResult {
  validate(options);let evaluations=0;
  const roots:IsolatedBivariateRoot[]=[],unresolved:UnresolvedBivariateRegion[]=[];
  const pending:Pending[]=[{box:options.box,depth:0}];
  function check():void {
    const reason=options.shouldStop?.();if(reason!==undefined)throw new Stop(reason);
    if(evaluations>=options.maximumEvaluations)throw new Stop('budget');evaluations++;
  }
  function image(box:ParameterBox){check();return evaluator.enclosure(box);}
  function slope(box:ParameterBox){check();return evaluator.jacobian(box);}
  function addRoot(box:ParameterBox,certificate:ParameterBox):void {
    // A shared uniqueness region proves branch identity. Nearness/overlap alone does not.
    const index=roots.findIndex(root=>parameterBoxContains(root.certificate,box)||parameterBoxContains(certificate,root.box));
    if(index!==-1){
      const shared=intersectParameterBoxes(roots[index].box,box);
      if(shared===null)throw new Error('曲面の同じ根の証明区間が矛盾しています。');
      roots[index]={...roots[index],box:shared};
    }else roots.push({box,certificate,unique:true});
  }
  try {
    while(pending.length>0){
      if(roots.length+unresolved.length>=options.maximumRegions)throw new Stop('budget');
      const node=pending.pop();if(node===undefined)break;
      if(roots.some(root=>parameterBoxContains(root.certificate,node.box)))continue;
      const values=image(node.box);
      if(values.some(excludesZero))continue;
      if(values.every(exactZero)){unresolved.push({box:node.box,reason:'continuum'});continue;}
      const smooth=values.every(regular),jacobian=smooth?slope(node.box):null;
      const center:readonly [number,number]=[
        node.box[0].lower+(node.box[0].upper-node.box[0].lower)/2,
        node.box[1].lower+(node.box[1].upper-node.box[1].lower)/2,
      ];
      let certificate=node.certificate,contraction=false;
      if(jacobian!==null){
        const centerValue=image(pointBox(center));
        const step=centerValue.every(regular)?bivariateIntervalNewton(node.box,center,
          [centerValue[0].ranges[0],centerValue[1].ranges[0]],jacobian):null;
        if(step!==null){
          if(step.intersection===null)continue;
          const intersection=step.intersection;
          contraction=step.unique;
          if(step.unique&&centerValue.every(exactZero)){addRoot(pointBox(center),node.box);continue;}
          // Boundary roots can be certified without extending U/V beyond the user's domain.
          let cornerRoot:ParameterBox|null=null;
          if(step.unique&&!step.exists){
            for(const u of [node.box[0].lower,node.box[0].upper])for(const v of [node.box[1].lower,node.box[1].upper]){
              const corner=pointBox([u,v]);if(image(corner).every(exactZero))cornerRoot=corner;
            }
          }
          if(cornerRoot!==null){addRoot(cornerRoot,node.box);continue;}
          if(step.exists)certificate??=node.box;
          if(certificate!==undefined&&width(step.intersection)<=options.tolerance){addRoot(step.intersection,certificate);continue;}
          if(roots.some(root=>parameterBoxContains(root.certificate,intersection)))continue;
          if(node.depth<options.maximumDepth&&width(step.intersection)<width(node.box)*0.75){
            pending.push({box:step.intersection,depth:node.depth+1,certificate});continue;
          }
        }
      }
      if(certificate!==undefined&&width(node.box)<=options.tolerance){addRoot(node.box,certificate);continue;}
      const axis=node.box[0].upper-node.box[0].lower>=node.box[1].upper-node.box[1].lower?0:1;
      const range=node.box[axis],middle=center[axis];
      if(width(node.box)<=options.tolerance||node.depth>=options.maximumDepth||middle===range.lower||middle===range.upper){
        unresolved.push({box:node.box,reason:!smooth?'domain':contraction?'resolution':'singular'});continue;
      }
      // Overlapping children retain roots on artificial subdivision boundaries. A parent
      // existence certificate cannot be inherited by both children.
      const overlap=Math.min(options.tolerance/4,(range.upper-range.lower)/16);
      const left:ParameterBox=axis===0?[{lower:range.lower,upper:middle+overlap},node.box[1]]
        :[node.box[0],{lower:range.lower,upper:middle+overlap}];
      const right:ParameterBox=axis===0?[{lower:middle-overlap,upper:range.upper},node.box[1]]
        :[node.box[0],{lower:middle-overlap,upper:range.upper}];
      pending.push({box:right,depth:node.depth+1},{box:left,depth:node.depth+1});
    }
    const unknown=unresolved.filter(region=>region.reason==='domain'||!roots.some(root=>parameterBoxContains(root.certificate,region.box)));
    roots.sort((a,b)=>a.box[0].lower-b.box[0].lower||a.box[1].lower-b.box[1].lower);
    return {status:unknown.length===0?'complete':'unresolved',roots,unresolved:unknown,evaluations};
  }catch(error){if(error instanceof Stop)return {status:error.status,evaluations};throw error;}
}
