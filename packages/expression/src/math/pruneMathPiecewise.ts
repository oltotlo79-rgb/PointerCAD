/** Check only the selected branch of an explicit piecewise expression; retain unknown conditions. */
import {MathInputProblem,MATH_INPUT_LIMITS,type MathNode} from './mathInputContract.js';
import {rationalOfExpression} from './exactRational.js';
export function exactMathBoolean(node:MathNode):boolean|null {
  if(node.kind==='constant')return node.name==='true'?true:node.name==='false'?false:null;
  if(node.kind!=='operation')return null;
  const values=node.operands;
  if(node.operation==='not'&&values.length===1){const value=exactMathBoolean(values[0]);return value===null?null:!value;}
  if(node.operation==='and'||node.operation==='or') {
    let unknown=false;
    for(const child of values) {
      const value=exactMathBoolean(child);
      if(value===false&&node.operation==='and')return false;
      if(value===true&&node.operation==='or')return true;
      if(value===null)unknown=true;
    }
    return unknown?null:node.operation==='and';
  }
  if(!['equal','not-equal','less','less-equal','greater','greater-equal'].includes(node.operation)||values.length<2)return null;
  const numbers=values.map(value=>rationalOfExpression(value));
  if(numbers.some(number=>number===null))return null;
  if(node.operation==='not-equal') {
    for(let i=0;i<numbers.length;i+=1)for(let j=i+1;j<numbers.length;j+=1) {
      const a=numbers[i],b=numbers[j];if(a===null||b===null)return null;
      if(a.numerator*b.denominator===b.numerator*a.denominator)return false;
    }
    return true;
  }
  for(let index=1;index<numbers.length;index+=1) {
    const a=numbers[index-1],b=numbers[index];if(a===null||b===null)return null;
    const difference=a.numerator*b.denominator-b.numerator*a.denominator;
    const yes=node.operation==='equal'?difference===0n:node.operation==='not-equal'?difference!==0n:
      node.operation==='less'?difference<0n:node.operation==='less-equal'?difference<=0n:
        node.operation==='greater'?difference>0n:difference>=0n;
    if(!yes)return false;
  }
  return true;
}
export function pruneMathPiecewise(source:MathNode,conditionReady:(condition:MathNode)=>boolean,conditionValue:(condition:MathNode)=>boolean|null=exactMathBoolean):{readonly expression:MathNode;readonly undecided:boolean} {
  let remaining=MATH_INPUT_LIMITS.nodes,undecided=false;
  function visit(node:MathNode,depth:number):MathNode {
    if(--remaining<0||depth>MATH_INPUT_LIMITS.depth)throw new MathInputProblem('budget','場合分けの式が複雑すぎます。');
    if(node.kind==='operation') {
      if(node.operation==='which') {
        if(node.operands.length<2||node.operands.length%2!==0)throw new MathInputProblem('syntax','場合分けは条件と値を対で指定してください。');
        for(let index=0;index<node.operands.length;index+=2) {
          const condition=visit(node.operands[index],depth+1),truth=conditionReady(condition)?conditionValue(condition):null;
          if(truth===true)return visit(node.operands[index+1],depth+1);
          if(truth===null){undecided=true;return node;}
        }
        throw new MathInputProblem('domain','どの場合にも当てはまらず、値が定義されていません。');
      }
      return {...node,operands:node.operands.map(child=>visit(child,depth+1))};
    }
    if(node.kind==='binder')return {...node,body:visit(node.body,depth+1),bindings:node.bindings.map(binding=>{
      const domain=binding.domain;
      return {...binding,domain:domain.kind==='set'?{...domain,value:visit(domain.value,depth+1)}:domain.kind==='range'
        ?{...domain,lower:visit(domain.lower,depth+1),upper:visit(domain.upper,depth+1),step:domain.step===null?null:visit(domain.step,depth+1)}:domain};
    })};
    return node;
  }
  const expression=visit(source,0);return {expression,undecided};
}
