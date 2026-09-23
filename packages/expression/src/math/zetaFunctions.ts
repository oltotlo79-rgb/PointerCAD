/** Keep the original pole and numerical work bounds before simplifying an expression. */
import { MathInputProblem,type MathNode } from './mathInputContract.js';
import { validateZetaArgument } from './zetaNumeric.js';
import { rationalOfExpression } from './exactRational.js';
import { resolveTypedMathProduct } from './mathProductTypes.js';
import { compileScalarMath } from './scalarMathTape.js';
import { createScalarIntervalSampler } from './scalarMathIntervals.js';
import { exactDoubleInterval } from './exactDoubleInterval.js';

export function zetaOrder(operation:string):number|null {
  if(operation==='zeta')return 0;
  const match=/^zeta-derivative:([1-9][0-9]?)$/u.exec(operation);
  if(match===null)return null;const order=Number(match[1]);return order<=17?order:null;
}
export function zetaDerivativeOrder(node:MathNode):number|null {
  const value=rationalOfExpression(node);
  return value!==null&&value.denominator===1n&&value.numerator>=0n&&value.numerator<=17n?Number(value.numerator):null;
}
export function normalizeZetaFunction(node:MathNode,angleUnit:'degree'|'radian'):MathNode {
  if(node.kind!=='operation')return node;
  if(node.operation==='zetaderivative') {
    if(node.operands.length!==2||zetaDerivativeOrder(node.operands[0])===null) {
      throw new MathInputProblem('budget','ゼータ関数の微分は、0から17までの整数の次数と引数を指定してください。');
    }
    normalizeZetaFunction({...node,operation:'zeta',operands:[node.operands[1]]},angleUnit);return node;
  }
  if(node.operation!=='zeta')return node;
  if(node.operands.length!==1)throw new MathInputProblem('syntax','ゼータ関数には引数を一つ指定してください。');
  const argument=node.operands[0];
  if(resolveTypedMathProduct('times',[argument,{kind:'number',decimal:'1'}],()=>true)!=='multiply') {
    throw new MathInputProblem('domain','ゼータ関数の引数は一つの実数の式で指定してください。');
  }
  const pending=[argument];let dynamic=false;
  while(pending.length>0) {
    const part=pending.pop();if(part===undefined)break;
    if(part.kind==='number'&&rationalOfExpression(part)===null)throw new MathInputProblem('budget','ゼータ関数の元の引数を正確に保持できません。');
    if(part.kind==='constant'&&part.name==='infinity')throw new MathInputProblem('domain','ゼータ関数の引数は有限の値で指定してください。');
    if(part.kind==='constant'&&part.name==='imaginary-unit'||part.kind==='operation'&&part.operation==='complex') {
      throw new MathInputProblem('unsupported','ゼータ関数の複素引数の数値計算にはまだ対応していません。');
    }
    if(part.kind==='symbol')dynamic=true;
    else if(part.kind==='operation')pending.push(...part.operands);
    else if(part.kind==='binder')throw new MathInputProblem('unsupported','ゼータ関数の引数を先に確定してください。');
  }
  const exact=rationalOfExpression(argument);
  if(exact!==null)validateZetaArgument(exact);
  else if(!dynamic) {
    const tape=compileScalarMath(argument,{inputs:[],angleUnit,evaluateConstant:value=>{
      const rational=rationalOfExpression(value),range=rational===null?null:exactDoubleInterval(rational);
      if(range!==null)return range.lower/2+range.upper/2;
      if(value.kind==='constant'&&value.name==='pi')return Math.PI;
      if(value.kind==='constant'&&value.name==='e')return Math.E;
      throw new MathInputProblem('unsupported','ゼータ関数の引数を有限の実数へ確定できません。');
    }});
    const enclosure=createScalarIntervalSampler(tape)([]),range=enclosure.ranges[0];
    if(!enclosure.continuous||enclosure.ranges.length!==1||range===undefined
      ||!Number.isFinite(range.lower)||!Number.isFinite(range.upper)) {
      throw new MathInputProblem('unsupported','ゼータ関数の引数の成立を確認できません。');
    }
    if(range.lower < -32||range.upper>128)throw new MathInputProblem('budget','ゼータ関数の引数は−32〜128の範囲で指定してください。');
    if(range.lower<=1&&range.upper>=1)throw new MathInputProblem('domain','ゼータ関数の引数が発散点1でないことを確認できません。');
  }
  return node;
}
