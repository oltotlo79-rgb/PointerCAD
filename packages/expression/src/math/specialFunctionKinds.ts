import { MathInputProblem, type MathNode } from './mathInputContract.js';
import { rationalOfExpression } from './exactRational.js';
import type { AiryKind } from './airyNumeric.js';
import type { RealLambertBranch } from './lambertWNumeric.js';

export function airyFunction(operation:string):{family:AiryKind;prime:boolean}|null {
  switch(operation) {
    case 'airyai':return {family:'Ai',prime:false};case 'airybi':return {family:'Bi',prime:false};
    case 'airyaiprime':return {family:'Ai',prime:true};case 'airybiprime':return {family:'Bi',prime:true};
    default:return null;
  }
}

export type BesselKind = 'J' | 'Y' | 'I' | 'K';
export function besselKind(operation: string): BesselKind | null {
  switch (operation) {
    case 'besselj': return 'J'; case 'bessely': return 'Y';
    case 'besseli': return 'I'; case 'besselk': return 'K';
    default: return null;
  }
}

export function realLambertBranch(node: MathNode): RealLambertBranch {
  const branch=rationalOfExpression(node);
  if(branch===null||branch.denominator!==1n||(branch.numerator!==0n&&branch.numerator!==-1n)) {
    throw new MathInputProblem('unsupported','実数のLambert Wの枝は0または-1で指定してください。');
  }
  return branch.numerator===0n?0:-1;
}

export function zetaOrder(operation:string):number|null {
  if(operation==='zeta')return 0;
  const match=/^zeta-derivative:([1-9][0-9]?)$/u.exec(operation);
  if(match===null)return null;const order=Number(match[1]);return order<=17?order:null;
}
export function zetaDerivativeOrder(node:MathNode):number|null {
  const value=rationalOfExpression(node);
  return value!==null&&value.denominator===1n&&value.numerator>=0n&&value.numerator<=17n?Number(value.numerator):null;
}
