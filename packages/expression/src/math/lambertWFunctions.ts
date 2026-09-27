/** Preserve the selected real branch and original domain before scalar rewrites. */
import { MathInputProblem, type MathNode } from './mathInputContract.js';
import { rationalOfExpression } from './exactRational.js';
import { validateLambertArgument, type RealLambertBranch } from './lambertWNumeric.js';
import { resolveTypedMathProduct } from './mathProductTypes.js';
import { compileScalarMath } from './scalarMathTape.js';
import { createScalarIntervalSampler } from './scalarMathIntervals.js';
import { exactDouble, exactDoubleInterval } from './exactDoubleInterval.js';

export function realLambertBranch(node: MathNode): RealLambertBranch {
  const branch=rationalOfExpression(node);
  if(branch===null||branch.denominator!==1n||(branch.numerator!==0n&&branch.numerator!==-1n)) {
    throw new MathInputProblem('unsupported','実数のLambert Wの枝は0または-1で指定してください。');
  }
  return branch.numerator===0n?0:-1;
}
const number=(decimal:string):MathNode=>({kind:'number',decimal});
function isE(node:MathNode):boolean { return node.kind==='constant'&&node.name==='e'; }
function equals(node:MathNode,value:bigint):boolean {
  const exact=rationalOfExpression(node);return exact!==null&&exact.numerator===value*exact.denominator;
}
function isInverseE(node:MathNode):boolean {
  if(node.kind!=='operation')return false;
  const [a,b]=node.operands;
  return node.operation==='exponential'&&equals(a,-1n)
    ||node.operation==='divide'&&equals(a,1n)&&isE(b)
    ||node.operation==='power'&&isE(a)&&equals(b,-1n);
}
export function knownLambertValue(branch:RealLambertBranch,argument:MathNode):MathNode|null {
  if(branch===0&&equals(argument,0n))return number('0');
  if(branch===0&&(isE(argument)||argument.kind==='operation'&&argument.operation==='exponential'&&equals(argument.operands[0],1n)))return number('1');
  if(argument.kind==='operation') {
    const [a,b]=argument.operands;
    if(argument.operation==='negate'&&isInverseE(a)
      ||argument.operation==='divide'&&equals(a,-1n)&&isE(b)
      ||argument.operation==='multiply'&&argument.operands.length===2&&(equals(a,-1n)&&isInverseE(b)||equals(b,-1n)&&isInverseE(a)))return number('-1');
  }
  return null;
}
export function normalizeLambertW(node:MathNode,angleUnit:'degree'|'radian'):MathNode {
  if(node.kind!=='operation'||node.operation!=='lambertw')return node;
  if(node.operands.length!==2)throw new MathInputProblem('syntax','Lambert Wには枝と引数を指定してください。');
  const branch=realLambertBranch(node.operands[0]),argument=node.operands[1];
  if(resolveTypedMathProduct('times',[argument,number('1')],()=>true)!=='multiply') {
    throw new MathInputProblem('domain','Lambert Wの引数は一つの実数の式で指定してください。');
  }
  let dynamic=false;const pending=[argument];
  while(pending.length>0) {
    const part=pending.pop();if(part===undefined)break;
    if(part.kind==='constant'&&part.name==='infinity')throw new MathInputProblem('domain','Lambert Wの引数は有限の値で指定してください。');
    if(part.kind==='constant'&&part.name==='imaginary-unit'||part.kind==='operation'&&part.operation==='complex') {
      throw new MathInputProblem('unsupported','Lambert Wの複素引数にはまだ対応していません。');
    }
    if(part.kind==='number'&&rationalOfExpression(part)===null)throw new MathInputProblem('budget','Lambert Wの引数を正確に保持できません。');
    if(part.kind==='symbol')dynamic=true;
    else if(part.kind==='operation')pending.push(...part.operands);
    else if(part.kind==='binder')throw new MathInputProblem('unsupported','Lambert Wの引数の計算を先に確定してください。');
  }
  const known=knownLambertValue(branch,argument);if(known!==null)return known;
  const exact=rationalOfExpression(argument);
  if(exact!==null)validateLambertArgument(branch,exact,()=>undefined);
  else if(!dynamic) {
    const tape=compileScalarMath(argument,{inputs:[],angleUnit,evaluateConstant:value=>{
      const rational=rationalOfExpression(value),range=rational===null?null:exactDoubleInterval(rational);
      if(range!==null)return range.lower/2+range.upper/2;
      if(value.kind==='constant'&&value.name==='pi')return Math.PI;
      if(value.kind==='constant'&&value.name==='e')return Math.E;
      throw new MathInputProblem('unsupported','Lambert Wの実数の引数を確定できません。');
    }});
    const enclosure=createScalarIntervalSampler(tape)([]);
    if(!enclosure.continuous||enclosure.ranges.length!==1)throw new MathInputProblem('unsupported','Lambert Wの引数の成立範囲を確定できません。');
    for(const endpoint of [enclosure.ranges[0].lower,enclosure.ranges[0].upper]) {
      const rational=exactDouble(endpoint);
      if(rational===null)throw new MathInputProblem('domain','Lambert Wの引数は有限の値で指定してください。');
      validateLambertArgument(branch,rational,()=>undefined);
    }
  }
  return node;
}
