/** Preserve the original formula while replacing inputs with exact, bounded edit paths. */
import {exactDouble} from './exactDoubleInterval.js';
import {MATH_INPUT_LIMITS,MathInputProblem,type MathNode,type MathSymbolReference} from './mathInputContract.js';
import {sameMathMeaning} from './mathNotationConversion.js';

const number=(decimal:string):MathNode=>({kind:'number',decimal});
export function pointEditCoordinate(value:number):MathNode {
  const exact=exactDouble(value);if(exact===null) throw new MathInputProblem('domain','既知の座標が有限でありません。');
  return exact.denominator===1n?number(exact.numerator.toString()):{kind:'operation',operation:'divide',
    operands:[number(exact.numerator.toString()),number(exact.denominator.toString())]};
}
export function pointEditInterpolation(before:MathNode,after:MathNode,
  progress:MathSymbolReference={role:'axis',name:'Y'}):MathNode {
  return sameMathMeaning(before,after)?before:{kind:'operation',operation:'add',operands:[before,
    {kind:'operation',operation:'multiply',operands:[{kind:'operation',operation:'subtract',operands:[after,before]},
      {kind:'symbol',reference:progress}]}]};
}
export function resolvePointEditExpression(expression:MathNode,resolve:(reference:MathSymbolReference)=>MathNode|null,shouldStop:()=>boolean):MathNode {
  let remaining=MATH_INPUT_LIMITS.nodes;
  function visit(node:MathNode,depth:number):MathNode {
    if(--remaining<0 || depth>MATH_INPUT_LIMITS.depth || shouldStop()) throw new MathInputProblem('budget','点の追従を確認する計算が上限に達しました。');
    if(node.kind==='symbol') return resolve(node.reference)??node;
    if(node.kind==='operation') return {...node,operands:node.operands.map(child=>visit(child,depth+1))};
    if(node.kind==='binder') throw new MathInputProblem('unsupported','この式の同じ枝への追従は確認できません。点を選び直してください。');
    return node;
  }
  return visit(expression,0);
}
