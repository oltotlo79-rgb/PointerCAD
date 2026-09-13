/** Preserve undefined arithmetic even when the surrounding expression would simplify to zero. */
import {MathInputProblem,MATH_INPUT_LIMITS,type MathNode} from './mathInputContract.js';
import {rationalOfExpression} from './exactRational.js';
import {validateElementaryFunction} from './elementaryFunctionDomains.js';
export function validateElementaryDomains(expression:MathNode,angleUnit:'degree'|'radian'='radian'):void {
  const pending=[{node:expression,depth:0}];let remaining=MATH_INPUT_LIMITS.nodes;
  while(pending.length>0) {
    const entry=pending.pop();if(!entry)break;
    if(--remaining<0||entry.depth>MATH_INPUT_LIMITS.depth)throw new MathInputProblem('budget','定義域を調べる式が大きすぎます。');
    const {node,depth}=entry;
    if(node.kind==='operation') {
      validateElementaryFunction(node,angleUnit);
      if(node.operation==='divide'||node.operation==='modulo') {
        const denominator=node.operands[1];
        if(denominator&&rationalOfExpression(denominator)?.numerator===0n)throw new MathInputProblem('domain','0では割れません。');
      }
      if(node.operation==='power') {
        const base=node.operands[0],exponent=node.operands[1];
        const a=base?rationalOfExpression(base):null,b=exponent?rationalOfExpression(exponent):null;
        if(a?.numerator===0n&&b&&b.numerator<=0n)throw new MathInputProblem('domain','0の0乗または負の累乗はこの規約では定義しません。');
      }
      pending.push(...node.operands.map(node=>({node,depth:depth+1})));
    }else if(node.kind==='binder') {
      pending.push({node:node.body,depth:depth+1});
      for(const binding of node.bindings) {
        const domain=binding.domain;
        if(domain.kind==='set')pending.push({node:domain.value,depth:depth+1});
        else if(domain.kind==='range') {
          pending.push({node:domain.lower,depth:depth+1},{node:domain.upper,depth:depth+1});
          if(domain.step)pending.push({node:domain.step,depth:depth+1});
        }
      }
    }
  }
}
