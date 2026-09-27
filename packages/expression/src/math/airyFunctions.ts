/** Validate the original real Airy input before algebra can discard it. */
import { MathInputProblem, type MathNode } from './mathInputContract.js';
import { AIRY_ARGUMENT_LIMIT, type AiryKind } from './airyNumeric.js';
import { rationalOfExpression } from './exactRational.js';
import { resolveTypedMathProduct } from './mathProductTypes.js';
import { compileScalarMath } from './scalarMathTape.js';
import { createScalarIntervalSampler } from './scalarMathIntervals.js';
import { exactDoubleInterval } from './exactDoubleInterval.js';

export function airyFunction(operation:string):{family:AiryKind;prime:boolean}|null {
  switch(operation) {
    case 'airyai':return {family:'Ai',prime:false};case 'airybi':return {family:'Bi',prime:false};
    case 'airyaiprime':return {family:'Ai',prime:true};case 'airybiprime':return {family:'Bi',prime:true};
    default:return null;
  }
}
export function normalizeAiryFunction(node:MathNode,angleUnit:'degree'|'radian'):MathNode {
  if(node.kind!=='operation'||airyFunction(node.operation)===null)return node;
  if(node.operands.length!==1)throw new MathInputProblem('syntax','Airy関数には引数を一つ指定してください。');
  const argument=node.operands[0];
  if(resolveTypedMathProduct('times',[argument,{kind:'number',decimal:'1'}],()=>true)!=='multiply') {
    throw new MathInputProblem('domain','Airy関数の引数は一つの実数の式で指定してください。');
  }
  const pending=[argument];let dynamic=false;
  while(pending.length>0) {
    const part=pending.pop();if(part===undefined)break;
    if(part.kind==='number'&&rationalOfExpression(part)===null)throw new MathInputProblem('budget','Airy関数の引数を正確に保持できません。');
    if(part.kind==='constant'&&part.name==='infinity')throw new MathInputProblem('domain','Airy関数の引数は有限の値で指定してください。');
    if(part.kind==='constant'&&part.name==='imaginary-unit'||part.kind==='operation'&&part.operation==='complex') {
      throw new MathInputProblem('unsupported','Airy関数の複素引数の数値計算にはまだ対応していません。');
    }
    if(part.kind==='symbol')dynamic=true;
    else if(part.kind==='operation')pending.push(...part.operands);
    else if(part.kind==='binder')throw new MathInputProblem('unsupported','Airy関数の引数の計算を先に確定してください。');
  }
  const exact=rationalOfExpression(argument);
  const limit=BigInt(AIRY_ARGUMENT_LIMIT);
  if(exact!==null) {
    if(exact.numerator>limit*exact.denominator||exact.numerator < -limit*exact.denominator) {
      throw new MathInputProblem('budget','Airy関数の計算では、引数の絶対値を32以下にしてください。');
    }
  } else if(!dynamic) {
    const tape=compileScalarMath(argument,{inputs:[],angleUnit,evaluateConstant:value=>{
      const rational=rationalOfExpression(value),range=rational===null?null:exactDoubleInterval(rational);
      if(range!==null)return range.lower/2+range.upper/2;
      if(value.kind==='constant'&&value.name==='pi')return Math.PI;
      if(value.kind==='constant'&&value.name==='e')return Math.E;
      throw new MathInputProblem('unsupported','Airy関数の引数を有限の実数へ確定できません。');
    }});
    const enclosure=createScalarIntervalSampler(tape)([]),range=enclosure.ranges[0];
    if(!enclosure.continuous||enclosure.ranges.length!==1||range===undefined||!Number.isFinite(range.lower)||!Number.isFinite(range.upper)) {
      throw new MathInputProblem('unsupported','Airy関数の引数を有限の実数へ確定できません。');
    }
    if(range.lower < -AIRY_ARGUMENT_LIMIT||range.upper>AIRY_ARGUMENT_LIMIT) {
      throw new MathInputProblem('budget','Airy関数の計算では、引数の絶対値を32以下にしてください。');
    }
  }
  return node;
}
