/** Check every original closed elliptic call before algebra can discard a hole. */
import { MathInputProblem,type MathNode } from './mathInputContract.js';
import { CANDIDATE_MATH_BY_ID } from './mathOperations.js';
import { encodeMathInRadians } from './mathAngleConvention.js';
import { createNativeMathBox } from './nativeMathBackend.js';
import { resolveTypedMathProduct } from './mathProductTypes.js';
import { validateEllipticDomain,type EllipticKind } from './ellipticNumeric.js';
import { jsonRational } from './nativeMathNumber.js';
import { piRatio } from './nativeMathExact.js';
import type { EngineMathJson } from './encodeMathJson.js';

const KINDS:ReadonlyMap<string,EllipticKind>=new Map([
  ['elliptick','K'],['elliptice','E'],['ellipticf','F'],['ellipticeinc','Einc'],['ellipticpi','Pi'],['ellipticpiinc','Piinc'],
]);
export const ellipticKind=(operation:string):EllipticKind|null=>KINDS.get(operation)??null;
export function normalizeEllipticFunction(node:MathNode,angleUnit:'degree'|'radian'):MathNode {
  if(node.kind!=='operation'||ellipticKind(node.operation)===null)return node;
  const pending=[...node.operands];let dynamic=false;
  for(const argument of node.operands) {
    if(resolveTypedMathProduct('times',[argument,{kind:'number',decimal:'1'}],()=>true)!=='multiply') {
      throw new MathInputProblem('domain','楕円積分の引数は一つずつ実数の式で指定してください。');
    }
  }
  while(pending.length>0) {
    const part=pending.pop();if(part===undefined)break;
    if(part.kind==='constant'&&part.name==='infinity')throw new MathInputProblem('domain','楕円積分の引数は有限の値で指定してください。');
    if(part.kind==='constant'&&part.name==='imaginary-unit'||part.kind==='operation'&&part.operation==='complex') {
      throw new MathInputProblem('unsupported','楕円積分の複素引数の数値計算にはまだ対応していません。');
    }
    if(part.kind==='symbol')dynamic=true;
    else if(part.kind==='operation')pending.push(...part.operands);
    else if(part.kind==='binder')throw new MathInputProblem('unsupported','楕円積分の条件を先に確定してください。');
  }
  if(!dynamic) {
    const kind=ellipticKind(node.operation);
    // This JSON comes from our exact-only backend, never from an external reply.
    const exact=createNativeMathBox(encodeMathInRadians(node,CANDIDATE_MATH_BY_ID,angleUnit),()=>undefined).evaluate().json as EngineMathJson;
    if(kind===null||!Array.isArray(exact))throw new MathInputProblem('unsupported','楕円積分の条件を確認できません。');
    const raw=exact.slice(1),index=kind==='F'||kind==='Einc'?0:kind==='Piinc'?1:-1;
    const ratio=index<0?null:piRatio(raw[index]);
    const parameters=raw.map((value,i)=>i===index&&ratio!==null?ratio:jsonRational(value));
    if(!parameters.every(value=>value!==null))throw new MathInputProblem('unsupported','楕円積分の条件を整数・小数・分数（振幅はπの倍数も可）に確定してください。');
    validateEllipticDomain(kind,parameters,()=>undefined,ratio!==null);
  }
  return node;
}
