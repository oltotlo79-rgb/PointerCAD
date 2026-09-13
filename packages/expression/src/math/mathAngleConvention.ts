/** Express degree semantics in the AST so integration and differentiation use the same mathematics. */
import {MathInputProblem,type MathNode,type MathOperationDefinition} from './mathInputContract.js';
import {encodeMathJson,type EngineMathJson} from './encodeMathJson.js';
const FORWARD=new Set(['sin','cos','tan','cot','sec','csc']);
const INVERSE=new Set(['arcsin','arccos','arctan','arccot','arcsec','arccsc','arctan-two','argument']);
function operation(operation:string,...operands:MathNode[]):MathNode{return {kind:'operation',operation,operands};}
export function mathInRadians(expression:MathNode,angleUnit:'degree'|'radian'):MathNode {
  return convertMathAngleConvention(expression, angleUnit, 'radian');
}
/** Convert a closed coefficient into its consumer's convention without changing either saved source. */
export function convertMathAngleConvention(expression:MathNode,from:'degree'|'radian',to:'degree'|'radian'):MathNode {
  if(from===to)return expression;
  const pi:MathNode={kind:'constant',name:'pi'},degrees:MathNode={kind:'number',decimal:'180'};
  const toRadians=operation('divide',pi,degrees),toDegrees=operation('divide',degrees,pi);
  const forward=to==='radian'?toRadians:toDegrees,inverse=to==='radian'?toDegrees:toRadians;
  let remaining=4096;
  function visit(node:MathNode,depth:number):MathNode {
    if(--remaining<0||depth>64)throw new MathInputProblem('budget','角度の規約を適用する式が複雑すぎます。');
    if(node.kind==='operation') {
      const operands=node.operands.map(child=>visit(child,depth+1));
      if(FORWARD.has(node.operation)&&operands.length===1)return operation(node.operation,operation('multiply',operands[0],forward));
      const value:MathNode={...node,operands};
      return INVERSE.has(node.operation)?operation('multiply',value,inverse):value;
    }
    if(node.kind==='binder')return {...node,body:visit(node.body,depth+1),bindings:node.bindings.map(binding=>{
      const domain=binding.domain;
      return {...binding,domain:domain.kind==='set'?{...domain,value:visit(domain.value,depth+1)}:domain.kind==='range'
        ?{...domain,lower:visit(domain.lower,depth+1),upper:visit(domain.upper,depth+1),step:domain.step===null?null:visit(domain.step,depth+1)}:domain};
    })};
    return node;
  }
  return visit(expression,0);
}
/** The target engine must remain in radian mode. Never also set angularUnit='deg'. */
export function encodeMathInRadians(expression:MathNode,operations:ReadonlyMap<string,MathOperationDefinition>,
  angleUnit:'degree'|'radian'):EngineMathJson {
  return encodeMathJson(mathInRadians(expression,angleUnit),operations);
}
