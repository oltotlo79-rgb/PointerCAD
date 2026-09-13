/** Real-root restrictions must survive simplification, including an invalid root multiplied by zero. */
import {MathInputProblem,type MathNode} from './mathInputContract.js';
import {rationalOfExpression,rational,type ExactRational} from './exactRational.js';
import {validateDiscreteDomains,type DiscreteDomainContext,type DiscreteDomainObligation} from './discreteMathDomains.js';
export interface RootDomainObligation {readonly path:string;readonly expression:MathNode;readonly reason:'real-root-domain'}
export interface MathDomainContext extends DiscreteDomainContext {
  /** Return only a mathematically exact rational, never a rounded approximation to a nonrational number. */
  readonly exactValue?:(node:MathNode)=>ExactRational|null;
}
export function validateRootDomains(expression:MathNode,context:MathDomainContext={}):readonly RootDomainObligation[] {
  const pending=[{node:expression,path:'0',depth:0}],obligations:RootDomainObligation[]=[];
  let budget=4096;
  const exact=(node:MathNode):ExactRational|null=>{
    const value=rationalOfExpression(node)??context.exactValue?.(node);
    return value?rational(value.numerator,value.denominator):null;
  };
  while(pending.length>0) {
    const item=pending.pop();if(!item)break;
    if(--budget<0||item.depth>64)throw new MathInputProblem('budget','根の条件を確認する式が複雑すぎます。');
    const node=item.node;
    if(node.kind==='operation') {
      if(node.operation==='root') {
        const a=node.operands[0],b=node.operands[1];
        if(node.operands.length!==2||!a||!b)throw new MathInputProblem('syntax','根の値と次数を指定してください。');
        const radicand=exact(a),degree=exact(b);
        if(degree?.numerator===0n)throw new MathInputProblem('domain','根の次数は0以外で指定してください。');
        if(radicand&&degree) {
          if(radicand.numerator<0n&&(degree.denominator!==1n||degree.numerator%2n===0n)) {
            throw new MathInputProblem('domain','負の値の実数の根は奇数の整数次数で指定してください。');
          }
          if(radicand.numerator===0n&&degree.numerator<0n)throw new MathInputProblem('domain','0の負の次数の根は有限になりません。');
        }else obligations.push({path:item.path,expression:node,reason:'real-root-domain'});
      }
      node.operands.forEach((child,index)=>pending.push({node:child,path:`${item.path}.${index}`,depth:item.depth+1}));
    }else if(node.kind==='binder') {
      pending.push({node:node.body,path:`${item.path}.body`,depth:item.depth+1});
      node.bindings.forEach((binding,index)=>{
        const domain=binding.domain;
        if(domain.kind==='set')pending.push({node:domain.value,path:`${item.path}.set${index}`,depth:item.depth+1});
        else if(domain.kind==='range') {
          pending.push({node:domain.lower,path:`${item.path}.lower${index}`,depth:item.depth+1},
            {node:domain.upper,path:`${item.path}.upper${index}`,depth:item.depth+1});
          if(domain.step)pending.push({node:domain.step,path:`${item.path}.step${index}`,depth:item.depth+1});
        }
      });
    }
  }
  return obligations;
}
/** A product evaluator must discharge all obligations before evaluating, not discard the returned list. */
export function validateMathDomains(expression:MathNode,context:MathDomainContext={}):readonly (RootDomainObligation|DiscreteDomainObligation)[] {
  return [...validateDiscreteDomains(expression,context),...validateRootDomains(expression,context)];
}
